/**
 * Интеграционные тесты умного прихода и отката накладной на РЕАЛЬНОМ Postgres.
 * Поднимает отдельную базу mixmarkt_crm_test (не трогает рабочую), прогоняет все
 * миграции sql/ и проверяет ключевые сценарии настоящим SQL: перевод единиц,
 * средневзвешенная себестоимость (numeric, а не строка), сторно «как будто не было»,
 * псевдонимы при подтверждении импорта и защиту от отката уже растащенного товара.
 *
 * Требуется запущенный Postgres: docker compose up -d db. Если сервер недоступен —
 * все тесты корректно скипаются, а не валятся. Запуск: npm run test:integration (из server/).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const PG = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
};
const TEST_DB = process.env.TEST_PGDATABASE ?? 'mixmarkt_crm_test';

// состояние, инициализируемое один раз в ensureReady()
type Ctx = {
  pool: Pool;
  postWaybill: (h: any, i: any[], c?: any) => Promise<number>;
  reverseWaybill: (id: number, actor: any, c?: any) => Promise<number>;
  ingestWaybill: (c: any, head: any, items: any[]) => Promise<number>;
  confirmImport: (input: any, actor: any, c?: any) => Promise<any>;
  U: Record<string, number>;
  products: Record<string, number>;
  actor: any;
};
let ctx: Ctx | null | 'unavailable' = null;

async function ensureReady(): Promise<Ctx | null> {
  if (ctx === 'unavailable') return null;
  if (ctx) return ctx;

  // 1) есть ли сервер вообще
  const probe = new Pool({ ...PG, database: 'postgres', max: 1, connectionTimeoutMillis: 2500 });
  try {
    await probe.query('select 1');
  } catch {
    await probe.end().catch(() => {});
    ctx = 'unavailable';
    return null;
  }

  // 2) пересоздать чистую тестовую базу
  const ac = await probe.connect();
  try {
    await ac.query(`drop database if exists ${TEST_DB} with (force)`);
    await ac.query(`create database ${TEST_DB}`);
  } finally {
    ac.release();
    await probe.end();
  }

  // 3) перевести пул приложения на тестовую базу (db.ts читает env при импорте) и прогнать миграции
  process.env.PGDATABASE = TEST_DB;
  const { migrate } = await import('../src/migrate');
  await migrate();
  const dbMod = await import('../src/db');
  const pool = dbMod.pool;
  const wbMod = await import('../src/routes/waybills');
  const impMod = await import('../src/routes/import');

  const uid = async (code: string): Promise<number> => {
    const { rows } = await pool.query('select id from units where code = $1', [code]);
    return rows[0].id as number;
  };
  // после миграции 009 в справочнике units остаются только базовые единицы (г/мл/шт) — схема это закрепляет check-констрейнтом
  const U = { g: await uid('г'), ml: await uid('мл'), pcs: await uid('шт') };

  const S = Math.random().toString(36).slice(2, 7).toUpperCase();
  const mk = async (key: string, unitId: number, conv: Partial<Record<string, number>> = {}): Promise<number> => {
    const { rows } = await pool.query(
      `insert into products (name, category, unit_id, g_per_pcs, ml_per_pcs, g_per_ml)
       values ($1, 'тесты', $2, $3, $4, $5) returning id`,
      [`ТЕСТ ${key} ${S}`, unitId, conv.g_per_pcs ?? null, conv.ml_per_pcs ?? null, conv.g_per_ml ?? null]
    );
    const id = rows[0].id as number;
    await pool.query('insert into stock (product_id, qty, avg_cost) values ($1, 0, 0)', [id]);
    return id;
  };
  const products = {
    potato: await mk('КАРТОФЕЛЬ', U.g),
    flour: await mk('МУКА', U.g),
    eggs: await mk('ЯЙЦО', U.g, { g_per_pcs: 60 }),
  };

  ctx = {
    pool,
    postWaybill: wbMod.postWaybill,
    reverseWaybill: wbMod.reverseWaybill,
    ingestWaybill: wbMod.ingestWaybill,
    confirmImport: impMod.confirmImport,
    U,
    products,
    actor: { id: null, login: 'test-actor', fullName: 'Тест' },
  };
  return ctx;
}

const closeTo = (a: number, e: number, msg?: string): void => {
  assert.ok(Math.abs(a - e) < 1e-6, `${msg ?? ''}: ожидаемо ${e}, получено ${a}`);
};

async function stockOf(c: Ctx, pid: number): Promise<{ qty: number; avg: number }> {
  const { rows } = await c.pool.query('select qty::float8 q, avg_cost::float8 a from stock where product_id = $1', [pid]);
  return { qty: Number(rows[0].q), avg: Number(rows[0].a) };
}
async function mvCount(c: Ctx, pid: number): Promise<any[]> {
  const { rows } = await c.pool.query(
    'select type, qty::float8 qty, doc_type, doc_id from movements where product_id = $1 order by id',
    [pid]
  );
  return rows;
}

after(async () => {
  if (!ctx || ctx === 'unavailable') return;
  await ctx.pool.end().catch(() => {});
  const admin = new Pool({ ...PG, database: 'postgres', max: 1 });
  const ac = await admin.connect();
  try {
    await ac.query(`drop database if exists ${TEST_DB} with (force)`);
  } finally {
    ac.release();
    await admin.end();
  }
});

test('int: приход postWaybill — базовые г, avg_cost, итоги и НДС в шапке', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен — запустите docker compose up -d db');
  const wbId = await c.postWaybill(
    { number: 'INT-1', supplier: 'Milkos', docDate: '2026-11-01', actor: c.actor },
    [{ productId: c.products.potato, qty: 2000, unitId: c.U.g, price: 0.2, vatRate: 5 }]
  );
  const st = await stockOf(c, c.products.potato);
  closeTo(st.qty, 2000, 'остаток в г');
  closeTo(st.avg, 0.2, '400 / 2000');
  const mv = await mvCount(c, c.products.potato);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].type, 'receipt');
  assert.equal(Number(mv[0].doc_id), wbId);
  const { rows } = await c.pool.query(
    "select total_net::float8 n, total_vat::float8 v, total_gross::float8 g, status, accepted_login from waybills where id = $1",
    [wbId]
  );
  closeTo(Number(rows[0].n), 400);
  closeTo(Number(rows[0].v), 20);
  closeTo(Number(rows[0].g), 420);
  assert.equal(rows[0].status, 'posted');
  assert.equal(rows[0].accepted_login, 'test-actor');
});

test('int: confirm — создание позиции, псевдоним, кросс-размерный приход, файл в БД, затем откат до нуля', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');
  const r = await c.confirmImport(
    {
      number: 'INT-2',
      supplier: 'GDP',
      docDate: '2026-11-01',
      fileName: 'test.jpg',
      storedFile: null,
      fileBuf: Buffer.from('fakejpeg'),
      fileMime: 'image/jpeg',
      extraFiles: null,
      currency: 'RSD',
      supplierPib: null,
      docTotals: { net: null, vat: null, gross: null },
      items: [
        { rawName: 'Krompil', qty: 1000, unitId: c.U.g, price: 0.15, vatRate: null, create: { name: 'ТЕСТ КРОМПИР INT', category: 'овощи', unitId: c.U.g } },
        { rawName: 'Jaja', qty: 10, unitId: c.U.pcs, price: 30, vatRate: null, productId: c.products.eggs },
      ],
    },
    c.actor
  );
  assert.equal(r.created.length, 1);
  assert.equal(r.aliasesSaved, 2, 'оба написания (Krompil, Jaja) запомнились как новые псевдонимы');
  const newId = r.created[0].id;
  closeTo((await stockOf(c, newId)).qty, 1000);
  closeTo((await stockOf(c, newId)).avg, 0.15);
  closeTo((await stockOf(c, c.products.eggs)).qty, 600, 'кросс-размерный шт->г');
  const { rows: al } = await c.pool.query('select product_id from product_aliases where alias = $1', ['krompil']);
  assert.equal(al.length, 1);
  assert.equal(Number(al[0].product_id), newId);
  const { rows: wh } = await c.pool.query('select octet_length(file_data) sz, file_mime from waybills where id = $1', [r.waybillId]);
  assert.equal(Number(wh[0].sz), 8);
  assert.equal(wh[0].file_mime, 'image/jpeg');

  const recalc = await c.reverseWaybill(r.waybillId, c.actor);
  assert.equal(recalc, 2);
  closeTo((await stockOf(c, newId)).qty, 0);
  closeTo((await stockOf(c, c.products.eggs)).qty, 0);
  const { rows: st2 } = await c.pool.query('select status from waybills where id = $1', [r.waybillId]);
  assert.equal(st2[0].status, 'reversed');
});

test('int: откат пересчитывает avg_cost (numeric), вымывая цену отменённой поставки', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');
  await c.postWaybill({ number: 'INT-3a', supplier: 'A', docDate: null, actor: c.actor }, [{ productId: c.products.flour, qty: 2000, unitId: c.U.g, price: 0.2 }]);
  const wbB = await c.postWaybill({ number: 'INT-3b', supplier: 'B', docDate: null, actor: c.actor }, [{ productId: c.products.flour, qty: 1000, unitId: c.U.g, price: 0.4 }]);
  closeTo((await stockOf(c, c.products.flour)).avg, (2000 * 0.2 + 1000 * 0.4) / 3000, 'avg до отмены');
  await c.reverseWaybill(wbB, c.actor);
  const st = await stockOf(c, c.products.flour);
  closeTo(st.qty, 2000);
  closeTo(st.avg, 0.2, 'цена 0.4 отменённой поставки вымыта');
});

test('int: откат растащенного товара — 409 и реальный ROLLBACK (статус не меняется)', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');
  const wbId = await c.postWaybill({ number: 'INT-4', supplier: 'C', docDate: null, actor: c.actor }, [{ productId: c.products.potato, qty: 2000, unitId: c.U.g, price: 0.2 }]);
  // приход 2000 г; оставим на складе лишь 300 — сторно 2000 не хватит
  await c.pool.query('update stock set qty = 300 where product_id = $1', [c.products.potato]);
  const { ApiError } = await import('../src/http');
  await assert.rejects(
    c.reverseWaybill(wbId, c.actor),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /Недостаточно/.test(e.message)
  );
  const st = await stockOf(c, c.products.potato);
  closeTo(st.qty, 300, 'остаток не тронут');
  const { rows } = await c.pool.query('select status from waybills where id = $1', [wbId]);
  assert.equal(rows[0].status, 'posted', 'транзакция откатилась целиком — накладная не помечена отменённой');
});

test('int: два отката подряд — вторая пересчитывается без сторно первой', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');
  const { rows: pi } = await c.pool.query(
    `insert into products (name, category, unit_id) values ('ТЕСТ ПОВТОР INT', 'тесты', $1) returning id`,
    [c.U.g]
  );
  const p = pi[0].id as number;
  await c.pool.query('insert into stock (product_id, qty, avg_cost) values ($1, 0, 0)', [p]);
  const w1 = await c.postWaybill({ number: 'INT-6a', supplier: 'A', docDate: null, actor: c.actor }, [{ productId: p, qty: 1000, unitId: c.U.g, price: 0.1 }]);
  const w2 = await c.postWaybill({ number: 'INT-6b', supplier: 'B', docDate: null, actor: c.actor }, [{ productId: p, qty: 1000, unitId: c.U.g, price: 0.3 }]);
  await c.reverseWaybill(w1, c.actor);
  closeTo((await stockOf(c, p)).avg, 0.3);
  await c.reverseWaybill(w2, c.actor);
  const st = await stockOf(c, p);
  closeTo(st.qty, 0);
  closeTo(st.avg, 0, 'сторно первой отмены не осталось в пересчёте второй');
});

test('int: ingestWaybill напрямую — несколько листов фото в extra_files (jsonb)', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');
  const client = await c.pool.connect();
  try {
    await client.query('BEGIN');
    const wbId = await c.ingestWaybill(
      client,
      {
        number: 'INT-5', supplier: 'D', docDate: null, actor: c.actor,
        fileName: 'a.jpg', storedFile: 'a.jpg', fileData: Buffer.from('A'), fileMime: 'image/jpeg',
        extraFiles: [{ stored: 'b.jpg', name: 'b.jpg', mime: 'image/jpeg', data: Buffer.from('BB') }],
      },
      [{ productId: c.products.potato, qty: 100, unitId: c.U.g, price: 1 }]
    );
    await client.query('COMMIT');
    const { rows } = await c.pool.query(
      "select jsonb_array_length(extra_files) n, extra_files -> 0 ->> 'name' nm from waybills where id = $1",
      [wbId]
    );
    assert.equal(Number(rows[0].n), 1);
    assert.equal(rows[0].nm, 'b.jpg');
  } finally {
    client.release();
  }
});

test('int: дубль номера накладной — 409; после отката номер свободен; частичный уникальный индекс на месте', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');
  const { ApiError } = await import('../src/http');
  const wbId = await c.postWaybill(
    { number: 'INT-DUP', supplier: 'A', docDate: '2026-11-02', actor: c.actor },
    [{ productId: c.products.flour, qty: 100, unitId: c.U.g, price: 0.1 }]
  );
  await assert.rejects(
    c.postWaybill(
      { number: 'INT-DUP', supplier: 'B', docDate: '2026-11-02', actor: c.actor },
      [{ productId: c.products.flour, qty: 200, unitId: c.U.g, price: 0.2 }]
    ),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /уже проведена/.test(e.message)
  );
  // откатили — и тот же номер снова разрешён (пере-приход ошибочной бумажки)
  await c.reverseWaybill(wbId, c.actor);
  const wb2 = await c.postWaybill(
    { number: 'INT-DUP', supplier: 'A', docDate: '2026-11-02', actor: c.actor },
    [{ productId: c.products.flour, qty: 300, unitId: c.U.g, price: 0.3 }]
  );
  assert.notEqual(wb2, wbId);
  // страховка от гонки на уровне схемы — только по непроведённым
  const { rows: ix } = await c.pool.query(
    "select indexdef from pg_indexes where tablename = 'waybills' and indexname = 'waybills_number_active_uniq'"
  );
  assert.equal(ix.length, 1, 'частичный уникальный индекс создан на чистой тестовой БД');
  assert.match(String(ix[0].indexdef), /btrim\(number\)/i);
  assert.match(String(ix[0].indexdef), /reversed/);
});
