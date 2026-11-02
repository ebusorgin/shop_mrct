/**
 * Интеграционные тесты автосписания заказов на РЕАЛЬНОМ Postgres.
 *
 * Поднимается отдельная база mixmarkt_crm_writeoff_test (рабочая не трогается), прогоняются
 * все миграции sql/, и проверяется runWriteOff — тот же код, что зовёт планировщик:
 *  • группировка строк доски по техкарте (сумма граммов / вес порции = порции) и списание
 *    сырья через postBatch на складе;
 *  • orders.written_off_at проставлен — повторный прогон того же слота скипается;
 *  • недостача по одной карточке не блокирует прочие: прогон помечается 'error', но
 *    успешные карточки всё равно списаны, а «дефицитная» строка остаётся несписанной.
 *
 * Требуется запущенный Postgres: docker compose up -d db. Если сервер недоступен — скипаемся.
 * Запуск: npm run test:integration (из server/).
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
// своя база — иначе гонка drop/create при параллельном запуске с прочими *.pg-файлами
const TEST_DB = process.env.WRITEOFF_TEST_PGDATABASE ?? 'mixmarkt_crm_writeoff_test';

const SUF = Math.random().toString(36).slice(2, 7).toUpperCase();
const P = {
  potato: `ТЕСТ WO Картофель ${SUF}`,
  scarce: `ТЕСТ WO Дефицит ${SUF}`,
  cardA: `ТЕСТ WO Блины ${SUF}`,
  cardB: `ТЕСТ WO Дефицит-карта ${SUF}`,
};
const OK_DATE = '2026-03-05';
const SHORT_DATE = '2026-03-06';

type Ctx = {
  pool: Pool;
  runWriteOff: (date: string, slot: string, actor: null) => Promise<{
    skipped: boolean; runId: number | null; linesWritten: number; batches: number;
    raw: Record<string, unknown>; error?: string;
  }>;
  products: Record<string, number>;
  cards: Record<string, number>;
};
let ctx: Ctx | null | 'unavailable' = null;

async function ensureReady(): Promise<Ctx | null> {
  if (ctx === 'unavailable') return null;
  if (ctx) return ctx;

  const probe = new Pool({ ...PG, database: 'postgres', max: 1, connectionTimeoutMillis: 2500 });
  try {
    await probe.query('select 1');
  } catch {
    await probe.end().catch(() => {});
    ctx = 'unavailable';
    return null;
  }

  const ac = await probe.connect();
  try {
    await ac.query(`drop database if exists ${TEST_DB} with (force)`);
    await ac.query(`create database ${TEST_DB}`);
  } finally {
    ac.release();
    await probe.end();
  }

  process.env.PGDATABASE = TEST_DB;
  const { migrate } = await import('../src/migrate');
  await migrate();

  const dbMod = await import('../src/db');
  const pool = dbMod.pool;
  const wo = await import('../src/services/writeoff');

  const { rows: uRows } = await pool.query("select id, code from units where code in ('г','мл','шт')");
  const U: Record<string, number> = {};
  for (const r of uRows) U[r.code] = r.id as number;

  const mkProduct = async (name: string, unitId: number, qty: number, avg: number): Promise<number> => {
    const { rows } = await pool.query(
      `insert into products (name, category, unit_id) values ($1, 'тесты WO', $2) returning id`,
      [name, unitId]
    );
    const id = rows[0].id as number;
    await pool.query('insert into stock (product_id, qty, avg_cost) values ($1, $2, $3)', [id, qty, avg]);
    return id;
  };
  const mkCard = async (name: string, portionQty: number, rawId: number, gramsPerPortion: number): Promise<number> => {
    const { rows } = await pool.query(
      'insert into tech_cards (name, portion_qty, portion_unit_id, note) values ($1, $2, $3, $4) returning id',
      [name, portionQty, U['г'], 'тесты WO']
    );
    const id = rows[0].id as number;
    await pool.query(
      'insert into tech_card_items (card_id, source_type, ref_id, qty, unit_id, position) values ($1,$2,$3,$4,$5,0)',
      [id, 'raw', rawId, gramsPerPortion, U['г']]
    );
    return id;
  };

  const products = {
    potato: await mkProduct(P.potato, U['г'], 100000, 0.2),
    scarce: await mkProduct(P.scarce, U['г'], 100, 0.1), // намеренно мало
  };
  const cards = {
    // порция 100 г, расход 100 г картофеля на порцию
    A: await mkCard(P.cardA, 100, products.potato, 100),
    // порция 100 г, расход 50 г дефицита на порцию
    B: await mkCard(P.cardB, 100, products.scarce, 50),
  };

  const insertOrder = async (store: number, cardId: number, name: string, qty: number, date: string): Promise<number> => {
    const { rows } = await pool.query(
      `insert into orders (store_id, card_id, source_name, quantity, unit_code, date_tab, status, source)
       values ($1,$2,$3,$4,'г',$5::date,'placed','manual') returning id`,
      [store, cardId, name, qty, date]
    );
    return rows[0].id as number;
  };

  // --- дата «успех»: карточка A из двух магазинов (300 + 200 г = 500 г → 5 порций) ---
  const orderA104 = await insertOrder(104, cards.A, P.cardA, 300, OK_DATE);
  const orderA105 = await insertOrder(105, cards.A, P.cardA, 200, OK_DATE);

  // --- дата «недостача»: A (списается) + B (упрётся в дефицит) ---
  const okLine = await insertOrder(104, cards.A, P.cardA, 100, SHORT_DATE); // 1 порция → 100 г картофеля
  const badLine = await insertOrder(105, cards.B, P.cardB, 1000, SHORT_DATE); // 10 порций → 500 г дефицита (нет)

  ctx = { pool, runWriteOff: wo.runWriteOff as Ctx['runWriteOff'], products, cards };
  return Object.assign(ctx, { orderA104, orderA105, okLine, badLine }) as Ctx & Record<string, number>;
}

async function stockQty(c: Ctx, pid: number): Promise<number> {
  const { rows } = await c.pool.query('select qty::float8 q from stock where product_id = $1', [pid]);
  return Number(rows[0].q);
}
async function batchFor(c: Ctx, cardId: number, date: string): Promise<{ n: number; portions: number }> {
  const { rows } = await c.pool.query(
    `select count(*)::int n, coalesce(sum(portions), 0)::float8 portions
       from production_batches where card_id = $1 and batch_date = $2::date`,
    [cardId, date]
  );
  return { n: rows[0].n, portions: Number(rows[0].portions) };
}
async function writtenOff(c: Ctx, orderId: number): Promise<boolean> {
  const { rows } = await c.pool.query('select written_off_at from orders where id = $1', [orderId]);
  return rows[0].written_off_at != null;
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

test('WO1: группировка по техкарте — 2 магазина свёрнуты в одну партию, сырьё списано, строки помечены', async (t) => {
  const c = (await ensureReady()) as (Ctx & Record<string, number>) | null;
  if (!c) return t.skip('Postgres недоступен — запустите docker compose up -d db');

  const before = await stockQty(c, c.products.potato);
  const res = await c.runWriteOff(OK_DATE, '09:00', null);

  assert.equal(res.skipped, false, 'первый прогон того же слота не скипается');
  assert.equal(res.batches, 1, 'две строки одной техкарты → одна партия');
  assert.equal(res.linesWritten, 2, 'обе строки доски помечены списанными');

  const b = await batchFor(c, c.cards.A, OK_DATE);
  assert.equal(b.n, 1);
  assert.ok(Math.abs(b.portions - 5) < 1e-6, `300+200 г / 100 г порции = 5 порций, получено ${b.portions}`);

  const after = await stockQty(c, c.products.potato);
  assert.ok(Math.abs((before - after) - 500) < 1e-6, `списано 5 порций × 100 г картофеля = 500 г (дельта ${before - after})`);

  assert.ok(await writtenOff(c, c.orderA104), 'строка 104 помечена');
  assert.ok(await writtenOff(c, c.orderA105), 'строка 105 помечена');
});

test('WO2: повторный прогон того же слота скипается (двойного списания нет)', async (t) => {
  const c = (await ensureReady()) as (Ctx & Record<string, number>) | null;
  if (!c) return t.skip('Postgres недоступен');

  // WO1 уже закрыл слот 09:00 на OK_DATE — повтор ничего не должен менять
  const before = await stockQty(c, c.products.potato);
  const again = await c.runWriteOff(OK_DATE, '09:00', null);
  assert.equal(again.skipped, true, 'слот уже занят → skipped');
  assert.equal(again.batches, 0);
  const after = await stockQty(c, c.products.potato);
  assert.equal(after, before, 'сырьё не тронуто');
});

test('WO3: недостача по одной карточке — прочие списаны, прогон помечен ошибкой, дефицитная строка не помечена', async (t) => {
  const c = (await ensureReady()) as (Ctx & Record<string, number>) | null;
  if (!c) return t.skip('Postgres недоступен');

  const beforePotato = await stockQty(c, c.products.potato);
  const res = await c.runWriteOff(SHORT_DATE, '09:00', null);

  assert.equal(res.skipped, false);
  assert.equal(res.batches, 1, 'карточка A на SHORT_DATE всё равно списана, несмотря на ошибку по B');
  assert.equal(res.linesWritten, 1, 'помечена только успешная строка A');

  const bA = await batchFor(c, c.cards.A, SHORT_DATE);
  assert.equal(bA.n, 1, 'по A есть партия');
  const bB = await batchFor(c, c.cards.B, SHORT_DATE);
  assert.equal(bB.n, 0, 'по дефицитной B партии нет (откат её транзакции)');

  const afterPotato = await stockQty(c, c.products.potato);
  assert.ok(Math.abs((beforePotato - afterPotato) - 100) < 1e-6, 'A списала ровно 1 порцию × 100 г');

  assert.ok(await writtenOff(c, c.okLine), 'успешная строка помечена');
  assert.equal(await writtenOff(c, c.badLine), false, 'строка с недостачей осталась несписанной');

  const { rows } = await c.pool.query("select status, error from writeoff_runs where delivery_date = $1::date and fired_slot = '09:00'", [SHORT_DATE]);
  assert.equal(rows[0].status, 'error', 'прогон с ошибкой помечен error');
  assert.ok(rows[0].error == null || typeof rows[0].error === 'string');
});

test('WO4: чистый прогон закрывает лист доставки (locked) и отчёт по списанию собирается', async (t) => {
  const c = (await ensureReady()) as (Ctx & Record<string, number>) | null;
  if (!c) return t.skip('Postgres недоступен');

  const LOCK_DATE = '2026-03-07';
  // лист-дата доставки (открыт) + одна линия техкарты A (200 г → 2 порции)
  await c.pool.query(
    `insert into order_tabs (sheet_name, extract_date, status) values ($1, $2::date, 'open')`,
    [`ТЕСТ-WO-Lock-${SUF}`, LOCK_DATE]
  );
  await c.pool.query(
    `insert into orders (store_id, card_id, source_name, quantity, unit_code, date_tab, status, source)
     values (104, $1, $2, 200, 'г', $3::date, 'placed', 'manual')`,
    [c.cards.A, P.cardA, LOCK_DATE]
  );

  const res = await c.runWriteOff(LOCK_DATE, '09:00', null);
  assert.equal(res.skipped, false);
  assert.equal(res.batches, 1);

  const { rows: tabRows } = await c.pool.query(
    `select status, locked_at from order_tabs where extract_date = $1::date`,
    [LOCK_DATE]
  );
  assert.equal(tabRows[0].status, 'locked', 'лист закрыт после чистого списания');
  assert.ok(tabRows[0].locked_at != null, 'locked_at проставлен');

  const wo = await import('../src/services/writeoff');
  const report = await wo.writeOffReport(LOCK_DATE);
  assert.equal(report.goods.length, 1, 'в отчёте одна выданная техкарта');
  assert.ok(Math.abs(report.goods[0].portions - 2) < 1e-6, `2 порции, получено ${report.goods[0].portions}`);
  const potatoLine = report.raw.find((r) => r.productId === c.products.potato);
  assert.ok(potatoLine, 'сырьё-картофель в отчёте');
  assert.ok(Math.abs(potatoLine!.qty - 200) < 1e-6, `списано 200 г (дельта ${potatoLine!.qty})`);
  assert.ok(report.totalCost > 0, 'итоговая себестоимость посчитана');

  const runs = await wo.recentWriteOffRuns(50);
  assert.ok(runs.some((r) => r.deliveryDate === LOCK_DATE), 'прогон попал в архив прогонов');
});
