/**
 * Интеграционные тесты заказов магазинов и «списания по расписанию» на РЕАЛЬНОМ Postgres.
 *
 * Поднимается отдельная база mixmarkt_crm_test (рабочая не трогается), прогоняются все
 * миграции sql/, поднимается настоящее HTTP-приложение (Express) с настоящими сессиями,
 * и проверяются сквозные сценарии:
 *  • POST /api/orders/place — перевод печатных единиц (кг/порц) в базовые, проверка min,
 *    слияние линий, права (магазинная ручка жёстко привязана к своей точке);
 *  • PATCH /api/orders/:id — статусы, «магазин может только отменить», блокировка
 *    правки количества после принятия производством;
 *  • POST /api/batches + /:id/reverse — раскрытие техкарты (в т.ч. через заготовку с
 *    выходом), списание по настоящему numeric avg_cost, откат партии, боевой rollback.
 *
 * Требуется запущенный Postgres: docker compose up -d db. Если сервер недоступен —
 * тесты корректно скипаются, а не валятся. Запуск: npm run test:integration (из server/).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import type { Server } from 'node:http';

const PG = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
};
// своя тестовая база — иначе гонка при параллельном запуске с waybill-интеграцией (оба drop/create)
const TEST_DB = process.env.ORDERS_TEST_PGDATABASE ?? 'mixmarkt_crm_orders_test';

/** Один фикстурированный набор данных на весь файл: имена с суффиксом не сталкиваются с сидом миграций. */
const SUF = Math.random().toString(36).slice(2, 7).toUpperCase();
const P = {
  potato: `ТЕСТ Картофель ${SUF}`,
  oil: `ТЕСТ Масло ${SUF}`,
  flour: `ТЕСТ Мука ${SUF}`,
  egg: `ТЕСТ Яйцо ${SUF}`,
  scarce: `ТЕСТ Дефицит ${SUF}`,
  cardBliny: `ТЕСТ Блины Карт ${SUF}`,
  cardOmelet: `ТЕСТ Омлет ${SUF}`,
  cardScarce: `ТЕСТ Дефицит-карта ${SUF}`,
  cardMin: `ТЕСТ МинТест ${SUF}`,
  minAlias: `ТЕСТ МинТест Иначе ${SUF}`,
  semi: `ТЕСТ Яичная смесь ${SUF}`,
  plu: `T${SUF}`,
  lineBliny: `ТЕСТ Блины ${SUF}`,
  lineSoup: `ТЕСТ Суп ${SUF}`,
  lineCabbage: `ТЕСТ Капуста ${SUF}`,
  lineOlivie: `ТЕСТ Оливье ${SUF}`,
};
const D = {
  min: '2026-01-05',
  e0: '2026-01-06',
  e1: '2026-01-07',
  e2: '2026-01-08',
  e3: '2026-01-09',
  e4: '2026-01-10',
  e5: '2026-01-11',
  b1: '2026-01-12',
  b2: '2026-01-13',
  b3: '2026-01-14',
  b4: '2026-01-15',
  b5: '2026-01-16',
  a1: '2026-01-17',
  a2: '2026-01-18',
  brd: '2026-01-19',
};

type Ctx = {
  pool: Pool;
  srv: Server;
  base: string;
  office: string;
  store103: string;
  U: Record<string, number>;
  products: Record<string, number>;
  cards: Record<string, number>;
  semi: number;
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
  const { createApp } = await import('../src/app');
  const authMod = await import('../src/services/auth');

  const uid = async (code: string): Promise<number> => {
    const { rows } = await pool.query('select id from units where code = $1', [code]);
    return rows[0].id as number;
  };
  // после 009 в справочнике остаются только базовые единицы (кг в слое данных нет)
  const U = { g: await uid('г'), ml: await uid('мл'), pcs: await uid('шт') };

  const pid = async (name: string, unitId: number, conv: Partial<Record<string, number>> = {}, qty = 0, avg = 0): Promise<number> => {
    const { rows } = await pool.query(
      `insert into products (name, category, unit_id, g_per_pcs, ml_per_pcs, g_per_ml)
       values ($1, 'тесты', $2, $3, $4, $5) returning id`,
      [name, unitId, conv.g_per_pcs ?? null, conv.ml_per_pcs ?? null, conv.g_per_ml ?? null]
    );
    const id = rows[0].id as number;
    await pool.query('insert into stock (product_id, qty, avg_cost) values ($1, $2, $3)', [id, qty, avg]);
    return id;
  };
  const products = {
    potato: await pid(P.potato, U.g, {}, 5000, 0.2),
    oil: await pid(P.oil, U.ml, { g_per_ml: 0.93 }, 1000, 0.05),
    flour: await pid(P.flour, U.g, {}, 3000, 0.3),
    egg: await pid(P.egg, U.g, { g_per_pcs: 60 }, 3000, 0.5),
    scarce: await pid(P.scarce, U.g, {}, 100, 0.1),
  };

  const cardId = async (name: string, portionQty: number, portionUnitId: number, plu: string | null = null): Promise<number> => {
    const { rows } = await pool.query(
      'insert into tech_cards (name, portion_qty, portion_unit_id, plu, note) values ($1, $2, $3, $4, $5) returning id',
      [name, portionQty, portionUnitId, plu, 'тесты']
    );
    return rows[0].id as number;
  };
  const cardItem = async (card: number, source_type: 'raw' | 'semi', ref: number, qty: number, unitId: number, position: number): Promise<void> => {
    await pool.query(
      'insert into tech_card_items (card_id, source_type, ref_id, qty, unit_id, position) values ($1,$2,$3,$4,$5,$6)',
      [card, source_type, ref, qty, unitId, position]
    );
  };

  const cards = {
    bliny: await cardId(P.cardBliny, 100, U.g, P.plu),
    omelet: await cardId(P.cardOmelet, 300, U.g),
    scarce: await cardId(P.cardScarce, 100, U.g),
    // полигон для min: отдельная техкарта без состава — её листовые min-строки не просачиваются
    // в прочие тесты (min в /place ищется без привязки к магазину)
    min: await cardId(P.cardMin, 100, U.g),
  };
  await cardItem(cards.bliny, 'raw', products.potato, 900, U.g, 0);
  await cardItem(cards.bliny, 'raw', products.oil, 100, U.ml, 1);
  await cardItem(cards.bliny, 'raw', products.flour, 50, U.g, 2);
  await cardItem(cards.scarce, 'raw', products.scarce, 300, U.g, 0);

  // заготовка: партия 900 г выхода, состав — 1200 г яйца с выходом 80 % после взбивания + 300 г картофеля
  const { rows: semiRow } = await pool.query(
    'insert into semi_products (name, unit_id, out_qty, note) values ($1, $2, $3, $4) returning id',
    [P.semi, U.g, 900, 'тесты']
  );
  const semi = semiRow[0].id as number;
  await pool.query(
    'insert into semi_inputs (semi_id, source_type, ref_id, qty_per_output, yield_pct) values ($1,$2,$3,$4,$5)',
    [semi, 'raw', products.egg, 1200, 80]
  );
  await pool.query(
    'insert into semi_inputs (semi_id, source_type, ref_id, qty_per_output, yield_pct) values ($1,$2,$3,$4,$5)',
    [semi, 'raw', products.potato, 300, null]
  );
  await cardItem(cards.omelet, 'semi', semi, 300, U.g, 0);
  await cardItem(cards.omelet, 'raw', products.flour, 50, U.g, 1);

  // пользователи: офис (store_id null) и сотрудник точки 103
  const mkUser = async (login: string, storeId: number | null): Promise<{ token: string }> => {
    const { rows } = await pool.query(
      'insert into users (login, password_hash, is_admin, store_id) values ($1, $2, $3, $4) returning id',
      [login, 'scrypt$00$00', storeId === null, storeId]
    );
    return authMod.createSession(Number(rows[0].id), 'integration-test');
  };
  const officeSess = await mkUser(`test-office-${SUF}`, null);
  const storeSess = await mkUser(`test-store103-${SUF}`, 103);

  const srv = createApp().listen(0);
  await new Promise<void>((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  ctx = {
    pool, srv, base,
    office: authMod.SESSION_COOKIE + '=' + officeSess.token,
    store103: authMod.SESSION_COOKIE + '=' + storeSess.token,
    U, products, cards, semi,
  };
  return ctx;
}

// ---------- HTTP-помощники ----------
type Resp = { status: number; body: any };

async function http(c: Ctx, cookie: string, method: string, p: string, body?: unknown): Promise<Resp> {
  const res = await fetch(c.base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* не JSON — оставляем текст */
  }
  return { status: res.status, body: parsed };
}
const post = (c: Ctx, cookie: string, p: string, body?: unknown): Promise<Resp> => http(c, cookie, 'POST', p, body);
const patch = (c: Ctx, cookie: string, p: string, body: unknown): Promise<Resp> => http(c, cookie, 'PATCH', p, body);
const get = (c: Ctx, cookie: string, p: string): Promise<Resp> => http(c, cookie, 'GET', p);

/** Первичная вставка заказа через /place (одна строка). */
const placeOne = async (c: Ctx, cookie: string, body: unknown): Promise<Resp> => post(c, cookie, '/api/orders/place', body);

async function orderOf(c: Ctx, id: number): Promise<any> {
  const { rows } = await c.pool.query(
    `select id, store_id as "storeId", card_id as "cardId", source_name as "sourceName", unit_code as "unitCode",
            quantity::float8 as qty, min_qty::float8 as "minQty", status, source, note,
            db_edited_at as "dbEdited",
            date_tab::text as "dateTab", status_by_login as "statusByLogin", category_id as "categoryId",
            ek_price::float8 as ek, vk_price::float8 as vk
       from orders where id = $1`,
    [id]
  );
  return rows[0] ?? null;
}
async function orderByKey(c: Ctx, store: number, date: string, name: string): Promise<any> {
  const { rows } = await c.pool.query(
    'select id from orders where store_id = $1 and date_tab = $2::date and source_name = $3',
    [store, date, name]
  );
  return rows.length ? orderOf(c, Number(rows[0].id)) : null;
}
async function stockOf(c: Ctx, pid: number): Promise<{ qty: number; avg: number }> {
  const { rows } = await c.pool.query('select qty::float8 q, avg_cost::float8 a from stock where product_id = $1', [pid]);
  return { qty: Number(rows[0].q), avg: Number(rows[0].a) };
}
async function insertOrder(c: Ctx, f: Record<string, any>): Promise<number> {
  const { rows } = await c.pool.query(
    `insert into orders (tab_id, store_id, card_id, source_name, plu, min_qty, ek_price, vk_price,
                         quantity, unit_code, date_tab, status, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13) returning id`,
    [
      f.tabId ?? null, f.store, f.cardId ?? null, f.name, f.plu ?? null, f.minQty ?? null,
      f.ek ?? null, f.vk ?? null, f.qty, f.unit ?? 'г', f.date, f.status ?? 'synced', f.source ?? 'g_sheet',
    ]
  );
  return Number(rows[0].id);
}
async function upsertTab(c: Ctx, name: string, date: string): Promise<number> {
  const { rows } = await c.pool.query(
    `insert into order_tabs (sheet_name, extract_date, status)
     values ($1, $2::date, 'open')
     on conflict (sheet_name) do update set extract_date = excluded.extract_date
     returning id`,
    [name, date]
  );
  return Number(rows[0].id);
}
/** Строка источника, задающая min для последующих имени (cardId null) или техкарты. */
async function seedMin(c: Ctx, f: { name: string; date: string; min: number; cardId?: number | null }): Promise<number> {
  return insertOrder(c, {
    store: 104, name: f.name, date: f.date, qty: 10, unit: 'г', cardId: f.cardId ?? null,
    minQty: f.min, status: 'synced', source: 'g_sheet',
  });
}

const closeTo = (a: number, e: number, msg?: string): void => {
  assert.ok(Math.abs(a - e) < 1e-6, `${msg ?? ''}: ожидаемо ${e}, получено ${a}`);
};

after(async () => {
  if (!ctx || ctx === 'unavailable') return;
  await new Promise<void>((r) => ctx!.srv.close(() => r()));
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

// ==================== A. Оформление заказа магазином: права и единицы ====================

test('A1: офис оформляет заказ — перевод кг в граммы, статус placed, источник manual', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен — запустите docker compose up -d db');

  const r = await placeOne(c, c.office, {
    store: 104,
    date: D.e0,
    items: [
      { name: P.lineBliny, qty: 1.5, unit: 'кг' },
      { cardId: c.cards.bliny, qty: 2, unit: 'порц' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created.length, 2);

  const kgLine = await orderByKey(c, 104, D.e0, P.lineBliny);
  closeTo(kgLine.qty, 1500, '1.5 кг -> 1500 г в базовых единицах');
  assert.equal(kgLine.unitCode, 'кг', 'печатная единица источника сохранена');
  assert.equal(kgLine.status, 'placed');
  assert.equal(kgLine.source, 'manual');
  assert.ok(kgLine.dbEdited, 'ручная правка отмечает db_edited_at');

  const porLine = await orderOf(c, r.body.created[1].id);
  closeTo(porLine.qty, 200, '2 порции × 100 г порции техкарты');
  assert.equal(porLine.cardId, c.cards.bliny);
});

test('A2: min-количество — 422 без единой созданной позиции, force=1 и частичное размещение', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  // min сервер берут из последней листовой строки источника
  await seedMin(c, { name: P.lineSoup, date: D.min, min: 400 });

  const r422 = await placeOne(c, c.office, { store: 104, date: D.e1, items: [{ name: P.lineSoup, qty: 0.3, unit: 'кг' }] });
  assert.equal(r422.status, 422, JSON.stringify(r422.body));
  assert.equal(r422.body.details.violations.length, 1);
  closeTo(r422.body.details.violations[0].qty, 300, 'наружение в базовых единицах');
  closeTo(r422.body.details.violations[0].minQty, 400);
  assert.equal(await orderByKey(c, 104, D.e1, P.lineSoup), null, 'страница не записана');

  const mixed = await placeOne(c, c.office, {
    store: 104,
    date: D.e1,
    items: [{ name: P.lineSoup, qty: 0.3, unit: 'кг' }, { name: P.lineCabbage, qty: 1, unit: 'кг' }],
  });
  assert.equal(mixed.status, 201);
  assert.equal(mixed.body.created.length, 1, 'нарушившая min линия отброшена');
  assert.equal(mixed.body.violations.length, 1);
  assert.equal(mixed.body.violations[0].name, P.lineSoup);
  closeTo((await orderByKey(c, 104, D.e1, P.lineCabbage)).qty, 1000);

  const forced = await placeOne(c, c.office, { store: 104, date: D.e1, force: true, items: [{ name: P.lineSoup, qty: 0.3, unit: 'кг' }] });
  assert.equal(forced.status, 201, 'force=1 — «понять и всё равно разместить»');
  closeTo((await orderByKey(c, 104, D.e1, P.lineSoup)).qty, 300);
});

test('A2b: min — по техкарте и по СВЕЖЕЙ строке листа, а не по историческому выбросу', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  // полигон — отдельная техкарта cards.min: её min-строки не влияют на прочие тесты
  // единичный выброс 900 г в глубоком прошлом (D.min) + свежая норма 100 г (D.e5 — последний лист)
  await seedMin(c, { name: P.cardMin, date: D.min, min: 900, cardId: c.cards.min });
  await seedMin(c, { name: P.cardMin, date: D.e5, min: 100, cardId: c.cards.min });

  // 0.5 кг = 500 г: больше свежей нормы (100), но меньше выброса (900) — берутся 100, а не 900
  const mid = await placeOne(c, c.office, { store: 104, date: D.e0, items: [{ cardId: c.cards.min, qty: 0.5, unit: 'кг' }] });
  assert.equal(mid.status, 201, JSON.stringify(mid.body));

  // 0.05 кг = 50 г < 100 г — нарушение ровно по свежему минимуму
  const low = await placeOne(c, c.office, { store: 104, date: D.e0, items: [{ cardId: c.cards.min, qty: 0.05, unit: 'кг' }] });
  assert.equal(low.status, 422, JSON.stringify(low.body));
  closeTo(low.body.details.violations[0].qty, 50, 'нарушение в базовых единицах');
  closeTo(low.body.details.violations[0].minQty, 100, 'свежая строка важнее выброса');

  // min тянется по card_id, даже если у листовой строки другое написание имени
  await seedMin(c, { name: P.minAlias, date: D.e5, min: 700, cardId: c.cards.min });
  const byCard = await placeOne(c, c.office, { store: 104, date: D.e0, items: [{ cardId: c.cards.min, qty: 1, unit: 'порц' }] });
  assert.equal(byCard.status, 422, 'min по card_id, а не по имени строки');
  closeTo(byCard.body.details.violations[0].qty, 100, '1 порция × 100 г порции техкарты');
  closeTo(byCard.body.details.violations[0].minQty, 700);
});

test('A2c: доска производства — печатные единицы по точкам, деньги и снятие строки с доски', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const a = await placeOne(c, c.office, { store: 104, date: D.brd, items: [{ cardId: c.cards.bliny, qty: 1.5, unit: 'кг' }] });
  const b = await placeOne(c, c.office, { store: 105, date: D.brd, items: [{ cardId: c.cards.bliny, qty: 4, unit: 'порц', vk: 99 }] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  // VK приходит из листа; /place ручного заказа его не пишет — берём из источника
  await c.pool.query('update orders set vk_price = 2.5 where id = $1', [b.body.created[0].id]);

  const board = await get(c, c.office, `/api/orders/board?date=${D.brd}`);
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.deepEqual(board.body.stores.map((s: any) => s.id).filter((id: number) => id === 104 || id === 105), [104, 105]);
  const row = board.body.rows.find((r: any) => r.key === `c${c.cards.bliny}`);
  assert.ok(row, 'строка техкарты на доске есть');
  closeTo(row.byStore[104], 1.5, 'колонка точки — в печатных кг');
  closeTo(row.byStore[105], 4, 'колонка точки — в печатных порциях');
  closeTo(row.totalQty, 5.5);
  closeTo(row.pricePer, 2.5);
  closeTo(row.fullPrice, 10, 'VK за печатную единицу × количество');

  // PATCH принимает только status/note/qty: посторонние поля не должны менять данные
  const noop = await patch(c, c.office, `/api/orders/${b.body.created[0].id}`, { vkPrice: 7 });
  assert.equal(noop.status, 200);
  closeTo((await orderOf(c, b.body.created[0].id)).vk!, 2.5, 'VK остался из источника');

  const storeBoard = await get(c, c.store103, `/api/orders/board?date=${D.brd}`);
  assert.deepEqual(storeBoard.body.stores.map((s: any) => s.id), [103], 'магазин видит на доске только свою точку');

  const cancel = await patch(c, c.office, `/api/orders/${a.body.created[0].id}`, { status: 'cancelled' });
  assert.equal(cancel.status, 200);
  const after = await get(c, c.office, `/api/orders/board?date=${D.brd}`);
  const gone = after.body.rows.find((r: any) => r.key === `c${c.cards.bliny}`);
  assert.ok(!gone || !gone.byStore[104], 'отменённая линия уходит из колонки доски');
});

test('A3: повтор того же заказа сливает количество, отменённую линию возвращает в работу', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  await placeOne(c, c.office, { store: 105, date: D.e2, items: [{ name: P.lineCabbage, qty: 1.5, unit: 'кг' }] });
  const again = await placeOne(c, c.office, { store: 105, date: D.e2, items: [{ name: P.lineCabbage, qty: 0.5, unit: 'кг' }] });
  assert.equal(again.status, 201);
  assert.equal(again.body.merged.length, 1);
  const merged = await orderByKey(c, 105, D.e2, P.lineCabbage);
  closeTo(merged.qty, 2000, '1500 + 500 в одну линию');

  const cancel = await patch(c, c.office, `/api/orders/${merged.id}`, { status: 'cancelled' });
  assert.equal(cancel.status, 200);
  const rePlace = await placeOne(c, c.office, { store: 105, date: D.e2, items: [{ name: P.lineCabbage, qty: 0.7, unit: 'кг' }] });
  assert.equal(rePlace.status, 201);
  const revived = await orderOf(c, merged.id);
  closeTo(revived.qty, 700, 'отменённую линию кладём заново, а не суммируем');
  assert.equal(revived.status, 'placed', 'отменённая строка возвращается в работу');
});

test('A4: сотрудник магазина пишет и читает только свою точку', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  // запрос «на 104» от лица точки 103 всё равно уходит в 103
  const r = await post(c, c.store103, '/api/orders/place?store=104', { date: D.e3, items: [{ name: P.lineOlivie, qty: 1, unit: 'кг' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const mine = await orderByKey(c, 103, D.e3, P.lineOlivie);
  closeTo(mine.qty, 1000);
  assert.equal(await orderByKey(c, 104, D.e3, P.lineOlivie), null, 'чужая точка не тронута');

  const list = await get(c, c.store103, `/api/orders?store=104&date=${D.e3}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1, 'витрина показывает только свои строки');
  assert.equal(list.body.items[0].storeId, 103);

  const office = await get(c, c.office, `/api/orders?store=104&date=${D.e3}`);
  assert.equal(office.status, 200);
  assert.equal(office.body.items.length, 0, 'офис видит точку 104 — там на эту дату пусто');

  const absent = await placeOne(c, c.office, { store: 999, date: D.e3, items: [{ name: P.lineCabbage, qty: 1 }] });
  assert.equal(absent.status, 404, 'магазина 999 не существует');
});

test('A5: отказы валидации — количество <= 0, имя без cardId, несуществующая техкарта, неактивный магазин', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const zero = await placeOne(c, c.office, { store: 106, date: D.e4, items: [{ name: P.lineSoup, qty: 0 }] });
  assert.equal(zero.status, 400);
  const noName = await placeOne(c, c.office, { store: 106, date: D.e4, items: [{ qty: 1 }] });
  assert.equal(noName.status, 400);
  const badCard = await placeOne(c, c.office, { store: 106, date: D.e4, items: [{ cardId: 999999, qty: 1, unit: 'порц' }] });
  assert.equal(badCard.status, 400);
  assert.match(badCard.body.error, /Техкарта/);
  const noStore = await placeOne(c, c.office, { date: D.e4, items: [{ name: P.lineCabbage, qty: 1 }] });
  assert.equal(noStore.status, 400, 'store обязателен офису');

  // магазин выключен -> оформить в него нельзя
  await c.pool.query('update stores set active = false where id = 106');
  const inactive = await placeOne(c, c.office, { store: 106, date: D.e4, items: [{ name: P.lineCabbage, qty: 1 }] });
  assert.equal(inactive.status, 404, 'неактивный магазин — 404');
  await c.pool.query('update stores set active = true where id = 106');

  const { rows } = await c.pool.query('select count(*)::int c from orders where store_id = 106');
  assert.equal(Number(rows[0].c), 0, 'ни одна строка не записана');
});

// ==================== B. PATCH: статусы и права ====================

test('B1: офис меняет статус, журнал отмечает кто принял заказ', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const r = await placeOne(c, c.office, { store: 104, date: D.b1, items: [{ name: P.lineBliny, qty: 1, unit: 'кг' }] });
  const id = r.body.created[0].id;

  assert.equal((await patch(c, c.office, `/api/orders/${id}`, { status: 'confirmed' })).status, 200);
  let o = await orderOf(c, id);
  assert.equal(o.status, 'confirmed');
  assert.match(String(o.statusByLogin), /test-office/, 'кто принял — видно в строке');

  assert.equal((await patch(c, c.office, `/api/orders/${id}`, { status: 'bogus' })).status, 400);
  assert.equal((await patch(c, c.office, '/api/orders/999999', { status: 'placed' })).status, 404);

  const { rows } = await c.pool.query("select change_type, actor, user_login from order_changes where order_id = $1 and change_type = 'status_changed'", [id]);
  assert.ok(rows.length >= 1, 'триггер журнала записал смену статуса');
  assert.match(String(rows[0].user_login), /test-office/, 'в журнале видно, кто правил');

  const journal = await get(c, c.office, `/api/orders/journal?store=104&limit=50`);
  assert.equal(journal.status, 200, JSON.stringify(journal.body));
  assert.ok(journal.body.changes.some((ch: any) => Number(ch.orderId ?? 0) === id || ch.changeType === 'status_changed'), 'журнал отдаёт историю изменений');
});

test('B2: магазин может только отменить свой заказ и не лезет в чужие', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const mine = await placeOne(c, c.store103, { date: D.b2, items: [{ name: P.lineOlivie, qty: 1, unit: 'кг' }] });
  const myId = mine.body.created[0].id;
  const officePlaced = await placeOne(c, c.office, { store: 105, date: D.b2, items: [{ name: P.lineCabbage, qty: 1, unit: 'кг' }] });
  const foreignId = officePlaced.body.created[0].id;

  assert.equal((await patch(c, c.store103, `/api/orders/${foreignId}`, { status: 'cancelled' })).status, 404, 'чужой заказ не виден');
  assert.equal((await patch(c, c.store103, `/api/orders/${myId}`, { status: 'confirmed' })).status, 403, 'магазин не подтверждает');
  // офис принимает заказ в производство — статус становится «подтверждён»
  assert.equal((await patch(c, c.office, `/api/orders/${myId}`, { status: 'confirmed' })).status, 200);
  assert.equal((await patch(c, c.store103, `/api/orders/${myId}`, { qty: 200 })).status, 409, 'после принятия производством количество не меняется');

  const cancel = await patch(c, c.store103, `/api/orders/${myId}`, { status: 'cancelled' });
  assert.equal(cancel.status, 200);
  assert.equal((await orderOf(c, myId)).status, 'cancelled');
});

test('B3: правка количества — печатные единицы и обход блокировки для офиса', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const id = await insertOrder(c, { store: 103, name: P.lineBliny, date: D.b3, qty: 300, unit: 'г', status: 'confirmed', source: 'manual' });
  assert.equal((await patch(c, c.store103, `/api/orders/${id}`, { qty: 500 })).status, 409);

  const r = await patch(c, c.office, `/api/orders/${id}`, { qty: 0.8, unit: 'кг' });
  assert.equal(r.status, 200);
  closeTo((await orderOf(c, id)).qty, 800, '0.8 кг -> 800 г');

  const plain = await patch(c, c.office, `/api/orders/${id}`, { qty: 450 });
  assert.equal(plain.status, 200);
  closeTo((await orderOf(c, id)).qty, 450, 'без единицы количество базовое (обратная совместимость)');
});

// ==================== D. Списывание по расписанию: партии производства ====================

test('D1: партия — раскрытие техкарты, списание по numeric avg_cost, снимок состава', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const before = { potato: await stockOf(c, c.products.potato), oil: await stockOf(c, c.products.oil), flour: await stockOf(c, c.products.flour) };
  const r = await post(c, c.office, '/api/batches', { cardId: c.cards.bliny, portions: 3, batchDate: D.b1, note: 'смена А' });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const items = new Map<number, any>(r.body.items.map((i: any) => [i.productId, i]));
  closeTo(items.get(c.products.potato)!.qty, 2700, '3 × 900 г картофеля');
  closeTo(items.get(c.products.oil)!.qty, 300, '3 × 100 мл масла');
  closeTo(items.get(c.products.flour)!.qty, 150);
  closeTo(items.get(c.products.potato)!.unitCost, 0.2, 'списание по текущей средневзвешенной');
  closeTo(r.body.costTotal, 2700 * 0.2 + 300 * 0.05 + 150 * 0.3, 'себестоимость = Σ qty × avg_cost (numeric, не строка)');

  closeTo((await stockOf(c, c.products.potato)).qty, before.potato.qty - 2700);
  closeTo((await stockOf(c, c.products.oil)).qty, before.oil.qty - 300);
  closeTo((await stockOf(c, c.products.potato)).avg, 0.2, 'расход среднюю себестоимость не трогает');

  const { rows: mv } = await c.pool.query(
    "select type, qty::float8 qty, doc_type, doc_id, unit_cost::float8 uc, user_login, comment from movements where product_id = $1 and doc_type = 'batch'",
    [c.products.potato]
  );
  assert.equal(mv.length, 1);
  assert.equal(mv[0].type, 'writeoff');
  closeTo(Number(mv[0].qty), -2700, 'движение в базовых единицах со знаком минус');
  assert.equal(Number(mv[0].doc_id), r.body.id);
  assert.match(String(mv[0].user_login), /test-office/, 'движение подписано автором партии');
  assert.match(String(mv[0].comment), /Расход: .*Блины.* × 3 порц\./);

  const { rows: b } = await c.pool.query("select status, cost_total::float8 cost, portions from production_batches where id = $1", [r.body.id]);
  assert.equal(b[0].status, 'posted');
  closeTo(Number(b[0].cost), r.body.costTotal);

  const { rows: snap } = await c.pool.query('select coalesce(sum(qty * unit_cost)::float8, 0) s from production_batch_items where batch_id = $1', [r.body.id]);
  closeTo(Number(snap[0].s), r.body.costTotal, 'снимок состава бьётся с итогом партии');
});

test('D2: отмена партии — сырьё возвращается по снимку, себестоимость обнулена', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const start = { potato: await stockOf(c, c.products.potato), oil: await stockOf(c, c.products.oil), flour: await stockOf(c, c.products.flour) };
  const r = await post(c, c.office, '/api/batches', { cardId: c.cards.bliny, portions: 2, batchDate: D.b4, note: '' });
  assert.equal(r.status, 201);
  const mid = await stockOf(c, c.products.potato);
  closeTo(mid.qty, start.potato.qty - 1800);

  const rev = await post(c, c.office, `/api/batches/${r.body.id}/reverse`, {});
  assert.equal(rev.status, 200);
  closeTo((await stockOf(c, c.products.potato)).qty, start.potato.qty, 'картофель вернулся');
  closeTo((await stockOf(c, c.products.oil)).qty, start.oil.qty);
  closeTo((await stockOf(c, c.products.flour)).qty, start.flour.qty);
  closeTo((await stockOf(c, c.products.potato)).avg, 0.2, 'возврат без цены — средневзвешенная не меняется');

  const { rows: b } = await c.pool.query("select status, cost_total::float8 cost from production_batches where id = $1", [r.body.id]);
  assert.equal(b[0].status, 'reversed');
  closeTo(Number(b[0].cost), 0);

  assert.equal((await post(c, c.office, `/api/batches/${r.body.id}/reverse`, {})).status, 409, 'повторная отмена невозможна');
  const { rows: back } = await c.pool.query("select count(*)::int c, coalesce(sum(qty)::float8,0) s from movements where doc_type='batch' and doc_id=$1 and type='receipt'", [r.body.id]);
  assert.equal(Number(back[0].c), 3, 'три возврата сырья');
  closeTo(Number(back[0].s), 1800 + 200 + 100);
});

test('D3: партия через заготовку — выход после обработки утяжеляет вход (настоящий состав semi)', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const r = await post(c, c.office, '/api/batches', { cardId: c.cards.omelet, portions: 4, batchDate: D.b5, note: '' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const items = new Map<number, any>(r.body.items.map((i: any) => [i.productId, i]));
  // партия 4 × 300 г смеси при размере партии 900 г => k = 4/3; яйцо 1200 × 4/3 / 0.8
  closeTo(items.get(c.products.egg)!.qty, 2000, 'потери 20 % при взбивании утяжеляют вход');
  closeTo(items.get(c.products.potato)!.qty, 400, 'картофель внутри смеси: 300 × 4/3');
  closeTo(items.get(c.products.flour)!.qty, 200, 'мука прямо из карты: 50 × 4');
  closeTo((await stockOf(c, c.products.egg)).qty, 1000);
});

test('D4: партии — отказы и боевой откат транзакции при нехватке сырья', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  assert.equal((await post(c, c.office, '/api/batches', { cardId: c.cards.bliny, portions: 0 })).status, 400);
  assert.equal((await post(c, c.office, '/api/batches', { cardId: 999999, portions: 1 })).status, 404);
  assert.equal((await post(c, c.store103, '/api/batches', { cardId: c.cards.bliny, portions: 1 })).status, 403, 'раздел производства закрыт магазинному сотруднику');

  const { rows: cnt0 } = await c.pool.query('select count(*)::int c from production_batches');
  const { rows: itm0 } = await c.pool.query('select count(*)::int c from production_batch_items');
  const before = await stockOf(c, c.products.potato);
  const fail = await post(c, c.office, '/api/batches', { cardId: c.cards.scarce, portions: 2, batchDate: D.b2, note: '' });
  assert.equal(fail.status, 409, JSON.stringify(fail.body));
  assert.match(fail.body.error, /Недостаточно сырья/);

  const { rows: cnt1 } = await c.pool.query('select count(*)::int c from production_batches');
  assert.equal(Number(cnt1.c), Number(cnt0.c), 'партия не записана');
  const { rows: itm1 } = await c.pool.query('select count(*)::int c from production_batch_items');
  assert.equal(Number(itm1.c), Number(itm0.c), 'снимков состава не прибавилось — транзакция откатилась');
  closeTo((await stockOf(c, c.products.potato)).qty, before.qty, 'транзакция откатилась целиком');
});

// ==================== E. Журнал действий ====================

test('E1: оформление заказа, статус и партия пишутся в журнал действий под своим автором', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const office = await loginOf(c, 'office');
  const r = await placeOne(c, c.office, { store: 107, date: D.a1, items: [{ name: P.lineCabbage, qty: 1, unit: 'кг' }] });
  assert.equal(r.status, 201);
  const { rows: ao } = await c.pool.query(
    "select action, user_login, title from audit_log where entity = 'order' and entity_id = $1",
    [String(r.body.created[0].id)]
  );
  assert.equal(ao[0].action, 'create');
  assert.equal(ao[0].user_login, office, 'заказ оформлен от имени офиса');

  const id = r.body.created[0].id;
  await patch(c, c.office, `/api/orders/${id}`, { status: 'confirmed' });
  const { rows: ap } = await c.pool.query("select action, user_login from audit_log where entity = 'order' and entity_id = $1 and action = 'approve'", [String(id)]);
  assert.equal(ap[0].action, 'approve');
  assert.equal(ap[0].user_login, office);

  const b = await post(c, c.office, '/api/batches', { cardId: c.cards.bliny, portions: 1, batchDate: D.a2, note: '' });
  assert.equal(b.status, 201);
  const { rows: ab } = await c.pool.query("select action, user_login from audit_log where entity = 'batch' and entity_id = $1", [String(b.body.id)]);
  assert.equal(ab[0].action, 'post');
  assert.equal(ab[0].user_login, office, 'производство и заказы подписаны реальным пользователем');
});

// ==================== F. Закрытый после списания лист: магазин не правит ====================

test('F1: locked-лист — магазин не может ни добавить, ни отменить; офис вправе; /dates отдаёт locked', async (t) => {
  const c = await ensureReady();
  if (!c) return t.skip('Postgres недоступен');

  const LDATE = '2026-02-20';
  const tabId = await upsertTab(c, `лист-${SUF}-locked`, LDATE);

  // офис заводит линию на открытём листе для точки 103 — проходит (лист ещё open)
  const first = await placeOne(c, c.office, { store: 103, date: LDATE, items: [{ name: P.lineBliny, qty: 1, unit: 'кг' }] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const orderId = first.body.created[0].id;

  const datesOpen = await get(c, c.store103, `/api/orders/dates?store=103`);
  assert.equal(datesOpen.status, 200, JSON.stringify(datesOpen.body));
  const rowOpen = datesOpen.body.find((d: any) => d.date === LDATE);
  assert.ok(rowOpen, 'дата видна в списке листов');
  assert.equal(rowOpen.locked, false, 'открытый лист — locked=false');

  // закрываем лист (как это делает успешный прогон автосписания)
  await c.pool.query("update order_tabs set status = 'locked', locked_at = now() where id = $1", [tabId]);

  const storePlace = await post(c, c.store103, '/api/orders/place', { date: LDATE, items: [{ name: P.lineCabbage, qty: 1, unit: 'кг' }] });
  assert.equal(storePlace.status, 409, 'магазин не добавляет на закрытый лист');
  assert.match(String(storePlace.body.error), /закрыт/);

  const storeCancel = await patch(c, c.store103, `/api/orders/${orderId}`, { status: 'cancelled' });
  assert.equal(storeCancel.status, 409, 'магазин не отменяет заказ на закрытом листе');

  // офис — в обход блокировки (архивная дозапись/правка после списания)
  const officeAdd = await placeOne(c, c.office, { store: 103, date: LDATE, items: [{ name: P.lineCabbage, qty: 1, unit: 'кг' }] });
  assert.equal(officeAdd.status, 201, JSON.stringify(officeAdd.body));
  assert.equal((await patch(c, c.office, `/api/orders/${orderId}`, { status: 'confirmed' })).status, 200, 'офис правит закрытый лист');

  const datesLocked = await get(c, c.store103, `/api/orders/dates?store=103`);
  const rowLocked = datesLocked.body.find((d: any) => d.date === LDATE);
  assert.equal(rowLocked.locked, true, 'закрытый лист помечен locked=true');
});

async function loginOf(c: Ctx, whom: 'office' | 'store103'): Promise<string> {
  const like = whom === 'office' ? 'test-office-%' : 'test-store103-%';
  const { rows } = await c.pool.query('select login from users where login like $1 limit 1', [like]);
  return String(rows[0].login);
}
