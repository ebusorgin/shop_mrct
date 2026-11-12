import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, RequestHandler, Response, Router } from 'express';
import { pool } from '../src/db';
import { ApiError } from '../src/http';
import { cardsRouter } from '../src/routes/cards';
import { storeRouter } from '../src/routes/store';
import { productsRouter } from '../src/routes/products';
import { batchesRouter, postBatch, reverseBatch } from '../src/routes/batches';
import { expandCard } from '../src/services/expansion';
import { expandPackagedCard, loadPackagings, parsePackagings, savePackagings, validatePackagingRefs } from '../src/services/packagings';
import { emptyState, fakeTx, type FakeState } from './fake-pg';
import { PackagingPg } from './fake-packagings';

const actor = { id: 9, login: 'tech', fullName: 'Технолог' };
const errorStatus = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const definition = (overrides = {}) => ({
  name: 'Коробка 250 г', qtyBase: 250, orderStep: 3, isDefault: true,
  items: [{ productId: 2, qty: 1 }], ...overrides,
});
const cardBody = (overrides = {}) => ({
  name: 'Блюдо', portionQty: 100, portionUnitId: 1,
  items: [{ sourceType: 'raw', refId: 1, qty: 80, unitId: 1 }], ...overrides,
});

function fixture() {
  const state = emptyState();
  state.units = [
    { id: 1, code: 'г', dimension: 'mass', base_factor: 1 },
    { id: 2, code: 'шт', dimension: 'count', base_factor: 1 },
    { id: 3, code: 'мл', dimension: 'volume', base_factor: 1 },
  ];
  state.products = [
    { id: 1, name: 'Сырьё', category: '', unit_id: 1, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null, created_by: null },
    { id: 2, name: 'Коробка', category: '', unit_id: 2, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null, created_by: null },
    { id: 3, name: 'Крышка', category: '', unit_id: 2, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null, created_by: null },
  ];
  state.stock = [{ product_id: 1, qty: 10000, avg_cost: 0.2 }, { product_id: 2, qty: 100, avg_cost: 5 }, { product_id: 3, qty: 100, avg_cost: 2 }];
  state.tech_cards = [
    { id: 1, name: 'Блюдо', portion_qty: 100, portion_unit_id: 1, plu: null },
    { id: 2, name: 'Другое блюдо', portion_qty: 2, portion_unit_id: 2, plu: null },
  ];
  state.tech_card_items = [{ card_id: 1, source_type: 'raw', ref_id: 1, qty: 80, unit_id: 1, position: 0 }];
  state.product_packagings = [
    { id: 10, card_id: 1, name: 'Коробка 250 г', qty_base: 250, order_step: 3, is_default: true },
    { id: 20, card_id: 2, name: 'Чужая фасовка', qty_base: 6, order_step: 1, is_default: true },
  ];
  state.product_packaging_items = [{ packaging_id: 10, product_id: 2, qty: 1 }, { packaging_id: 20, product_id: 3, qty: 1 }];
  return new PackagingPg(state);
}

/** Call the actual wrapped route handler without a listening HTTP server/auth/network. */
function route(router: Router, method: string, path: string, input: { body?: unknown; query?: object; params?: object } = {}) {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  const handler: RequestHandler | undefined = layer?.route?.stack.at(-1)?.handle;
  assert.ok(handler, `${method} ${path}`);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    let status = 200;
    const res = { status(code: number) { status = code; return this; }, json(body: unknown) { resolve({ status, body }); } };
    handler({ body: input.body, query: input.query ?? {}, params: input.params ?? {}, user: actor } as Request,
      res as Response, reject);
  });
}

function fakeRoutes(t: TestContext, db: PackagingPg) {
  t.mock.method(pool, 'query', (sql: string, params?: unknown[]) => db.query(sql, params));
  t.mock.method(pool, 'connect', async () => {
    let snapshot: FakeState;
    return {
      query: async (sql: string, params?: unknown[]) => {
        if (sql === 'BEGIN') { snapshot = structuredClone(db.state); return { rows: [] }; }
        if (sql === 'COMMIT') return { rows: [] };
        if (sql === 'ROLLBACK') { Object.assign(db.state, snapshot); return { rows: [] }; }
        return db.query(sql, params);
      },
      release() {},
    };
  });
}

const save = (db: PackagingPg, cardId: number, raw: unknown, unitId = 1) =>
  fakeTx(db)((client) => savePackagings(client, cardId, parsePackagings(raw), unitId));
const expand = (db: PackagingPg, count = 1, id = 10) =>
  fakeTx(db)((client) => expandPackagedCard(client, 1, count, id));

test('save/load: stable IDs, insert, default switch, replacement items and deletion only within the card', async () => {
  const db = fixture();
  await save(db, 1, [definition({ id: 10, name: 'Переименована', isDefault: false, items: [{ productId: 3, qty: 2 }] }), definition({ name: 'Новая' })]);
  const loaded = await fakeTx(db)((client) => loadPackagings(client, 1));
  assert.deepEqual(loaded, [
    { id: 10, name: 'Переименована', qtyBase: 250, orderStep: 3, isDefault: false,
      items: [{ productId: 3, qty: 2, productName: 'Крышка', unitCode: 'шт', avgCost: 2, stockQty: 100 }] },
    { id: 21, name: 'Новая', qtyBase: 250, orderStep: 3, isDefault: true,
      items: [{ productId: 2, qty: 1, productName: 'Коробка', unitCode: 'шт', avgCost: 5, stockQty: 100 }] },
  ]);
  await save(db, 1, [definition({ id: 10 })]);
  assert.deepEqual(db.state.product_packagings.map((p) => p.id), [10, 20]);
  assert.equal(db.state.product_packagings.find((p) => p.id === 10)!.is_default, true);
  assert.ok(!db.state.product_packaging_items.some((i) => i.packaging_id === 21));
  await save(db, 1, []);
  assert.deepEqual(db.state.product_packagings.map((p) => p.id), [20]);
  assert.deepEqual(db.state.product_packaging_items, [{ packaging_id: 20, product_id: 3, qty: 1 }]);
});

test('save rejects foreign/unknown IDs and missing product/unit references with 400 without mutations', async () => {
  const db = fixture();
  const before = structuredClone(db.state);
  for (const id of [20, 999]) {
    await assert.rejects(save(db, 1, [definition({ id })]), errorStatus(400));
    assert.deepEqual(db.state, before);
  }
  await assert.rejects(save(db, 1, [definition({ items: [{ productId: 999, qty: 1 }] })]), errorStatus(400));
  await assert.rejects(save(db, 1, [definition()], 999), errorStatus(400));
  assert.deepEqual(db.state, before);
});

test('unit-specific net validation: count must be integer; mass/volume and component quantities may be fractional', async () => {
  const db = fixture();
  const defs = parsePackagings([definition({ qtyBase: 1.5, items: [{ productId: 2, qty: 0.5 }] })]);
  const tx = fakeTx(db);
  await assert.rejects(tx((client) => validatePackagingRefs(client, defs, 2)), errorStatus(400));
  await tx((client) => validatePackagingRefs(client, defs, 1));
  await tx((client) => validatePackagingRefs(client, defs, 3));
  await save(db, 2, [definition({ id: 20, qtyBase: 6, items: [{ productId: 2, qty: 0.5 }] })], 2);
});

test('expansion: N * net / card output, merged raw/container products; orderStep does not restrict preview', async () => {
  const db = fixture();
  db.state.product_packaging_items.push({ packaging_id: 10, product_id: 1, qty: 2 });
  assert.deepEqual(await expand(db, 1), {
    packaging: { name: 'Коробка 250 г', qtyBase: 250, unitCode: 'г' },
    need: [{ productId: 1, qty: 202 }, { productId: 2, qty: 1 }],
  });
  assert.deepEqual((await expand(db, 4)).need, [{ productId: 1, qty: 808 }, { productId: 2, qty: 4 }]);
});

test('expansion: nested product and semi are scaled, only the outer packaging contributes containers', async () => {
  const db = fixture();
  db.state.tech_cards[1].portion_qty = 50;
  db.state.tech_cards[1].portion_unit_id = 1;
  db.state.tech_card_items = [
    { card_id: 1, source_type: 'product', ref_id: 2, qty: 100, unit_id: 1, position: 0 },
    { card_id: 2, source_type: 'semi', ref_id: 1, qty: 50, unit_id: 1, position: 0 },
  ];
  db.state.semi_products = [{ id: 1, name: 'Заготовка', unit_id: 1, out_qty: 100, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null }];
  db.state.semi_inputs = [{ semi_id: 1, source_type: 'raw', ref_id: 1, qty_per_output: 80, yield_pct: 80 }];
  assert.deepEqual((await expand(db, 2)).need, [{ productId: 1, qty: 500 }, { productId: 2, qty: 2 }]);
  assert.ok(!db.queries.some((q) => /from product_packaging_items/.test(q.sql) && q.params[0] === 20));
  assert.deepEqual(await fakeTx(db)((client) => expandCard(client, 1, 2)), [{ productId: 1, qty: 200 }]);
});

test('expansion rejects invalid counts/IDs, foreign packaging, missing card and overflow', async () => {
  const db = fixture();
  for (const invalid of [NaN, Infinity, -Infinity, null, true, '1', 0, -1, 0.5, 2147483648]) {
    await assert.rejects(expand(db, invalid as number), errorStatus(400));
    await assert.rejects(expand(db, 1, invalid as number), errorStatus(400));
  }
  for (const id of [20, 999]) await assert.rejects(expand(db, 1, id), errorStatus(400));
  await assert.rejects(fakeTx(db)((client) => expandPackagedCard(client, 999, 1, 10)), errorStatus(404));
  db.state.product_packagings[0].qty_base = Number.MAX_VALUE;
  await assert.rejects(expand(db, 2), errorStatus(400));
  db.state.product_packagings[0].qty_base = 250;
  db.state.product_packaging_items[0].qty = Number.MAX_VALUE;
  await assert.rejects(expand(db, 2), errorStatus(400));
});

test('batch: raw + containers, costs, immutable definition/quantity/price snapshots and reversal after edits/deletion', async () => {
  const db = fixture();
  const tx = fakeTx(db);
  const posted = await postBatch({ cardId: 1, portions: 1, packagingId: 10, batchDate: '2026-11-02', note: '', actor }, tx);
  assert.deepEqual(posted.items, [
    { productId: 1, qty: 200, unitCost: 0.2, cost: 40 },
    { productId: 2, qty: 1, unitCost: 5, cost: 5 },
  ]);
  assert.equal(posted.costTotal, 45);
  assert.equal(db.batchCost(posted.id), 45);
  assert.equal(db.stockOf(1).qty, 9800);
  assert.equal(db.stockOf(2).qty, 99);
  const batch = structuredClone(db.batch(posted.id));
  assert.equal(batch.packaging_name, 'Коробка 250 г');
  assert.equal(batch.packaging_qty_base, 250);
  assert.equal(batch.packaging_unit_code, 'г');
  assert.equal(batch.portions, 1);
  assert.match(db.movementsOf(2)[0].comment!, /Коробка 250 г × 1 уп\./);
  const audit = JSON.parse(db.state.audit_log.find((a) => a.action === 'post')!.details);
  assert.deepEqual(audit.packaging, { name: 'Коробка 250 г', qtyBase: 250, unitCode: 'г' });

  await save(db, 1, [definition({ id: 10, name: 'Изменена', qtyBase: 999, items: [{ productId: 3, qty: 5 }] })]);
  await save(db, 1, []);
  db.state.tech_card_items[0].qty = 999;
  db.state.tech_cards[0].portion_unit_id = 2;
  db.state.tech_cards[0].portion_qty = 1;
  assert.deepEqual(db.batch(posted.id), batch, 'live definition edits do not affect historical snapshot');
  db.state.stock.find((s) => s.product_id === 2)!.avg_cost = 15;
  const snapshot = structuredClone(db.batchItems(posted.id));
  assert.equal(await reverseBatch(posted.id, actor, tx), 2);
  assert.equal(db.stockOf(1).qty, 10000);
  assert.equal(db.stockOf(2).qty, 100);
  assert.equal(db.stockOf(3).qty, 100, 'replacement container is not returned');
  close(db.stockOf(2).avgCost, (99 * 15 + 1 * 5) / 100);
  assert.equal(db.movementsOf(2)[1].unit_cost, 5, 'return uses original writeoff cost');
  assert.equal(db.batch(posted.id).status, 'reversed');
  assert.equal(db.batch(posted.id).cost_total, 0);
  assert.deepEqual(db.batchItems(posted.id), snapshot);
  await assert.rejects(reverseBatch(posted.id, actor, tx), errorStatus(409));
  assert.equal(db.movementsOf(2).length, 2);
});

test('batch: container shortage rolls back already written raw movements, batch, snapshot and audit', async () => {
  const db = fixture();
  db.state.stock.find((s) => s.product_id === 2)!.qty = 0;
  const before = structuredClone(db.state);
  await assert.rejects(postBatch({ cardId: 1, portions: 1, packagingId: 10, batchDate: null, note: '', actor }, fakeTx(db)), errorStatus(409));
  assert.deepEqual(db.state, before);
  assert.ok(db.queries.some((q) => /^insert into movements/.test(q.sql)), 'raw writeoff preceded failed container writeoff');
});

test('batch: no packaging preserves legacy portions and writes null snapshot; foreign ID returns 400', async () => {
  const db = fixture();
  const before = structuredClone(db.state);
  await assert.rejects(postBatch({ cardId: 1, portions: 1, packagingId: 20, batchDate: null, note: '', actor }, fakeTx(db)), errorStatus(400));
  assert.deepEqual(db.state, before);
  const posted = await postBatch({ cardId: 1, portions: 2, batchDate: null, note: '', actor }, fakeTx(db));
  assert.deepEqual(posted.items, [{ productId: 1, qty: 160, unitCost: 0.2, cost: 32 }]);
  assert.equal(db.batch(posted.id).packaging_name, null);
  assert.equal(db.batch(posted.id).packaging_qty_base, null);
  assert.equal(db.batch(posted.id).packaging_unit_code, null);
  assert.equal(db.stockOf(2).qty, 100);
});

test('card routes: POST missing packaging => []; PATCH missing preserves IDs, explicit [] deletes', async (t) => {
  const db = fixture();
  fakeRoutes(t, db);
  const created = await route(cardsRouter, 'post', '/', { body: cardBody() });
  assert.equal(created.status, 201);
  assert.deepEqual(db.packagings(created.body.id), []);
  const before = structuredClone(db.packagings(1));
  await route(cardsRouter, 'patch', '/:id', { params: { id: '1' }, body: cardBody() });
  assert.deepEqual(db.packagings(1), before);
  const audit = JSON.parse(db.state.audit_log.at(-1)!.details);
  assert.ok(!('packagings' in audit));
  await route(cardsRouter, 'patch', '/:id', { params: { id: '1' }, body: cardBody({ packagings: [] }) });
  assert.deepEqual(db.packagings(1), []);
  assert.equal(db.packagings(2)[0].id, 20);
  assert.equal(JSON.parse(db.state.audit_log.at(-1)!.details).packagings.to.length, 0);
});

test('card routes: POST/PATCH persist packaging; GET contract and store projection omit private data', async (t) => {
  const db = fixture();
  fakeRoutes(t, db);
  const created = await route(cardsRouter, 'post', '/', { body: cardBody({ packagings: [definition()] }) });
  const id = created.body.id;
  const packagingId = db.packagings(id)[0].id;
  await route(cardsRouter, 'patch', '/:id', { params: { id }, body: cardBody({ packagings: [definition({ id: packagingId, orderStep: 6 })] }) });
  const card = await route(cardsRouter, 'get', '/:id', { params: { id } });
  assert.deepEqual(card.body.packagings, [{ id: packagingId, name: 'Коробка 250 г', qtyBase: 250, orderStep: 6, isDefault: true,
    items: [{ productId: 2, qty: 1, productName: 'Коробка', unitCode: 'шт', avgCost: 5, stockQty: 100 }] }]);
  const listed = await route(cardsRouter, 'get', '/');
  assert.deepEqual(listed.body.find((c: any) => c.id === id).packagings, card.body.packagings);
  const store = await route(storeRouter, 'get', '/order-catalog');
  assert.deepEqual(store.body.find((c: any) => c.id === id).packagings,
    [{ id: packagingId, name: 'Коробка 250 г', qtyBase: 250, orderStep: 6, isDefault: true }]);
  assert.doesNotMatch(JSON.stringify(store.body), /items|cost|stock/i);
  assert.doesNotMatch(db.queries.at(-1)!.sql, /product_packaging_items|\bstock\b|avg_cost/i);
});

test('card routes: invalid DTO/reference/foreign IDs rollback; omitted packaging is revalidated on unit change', async (t) => {
  const db = fixture();
  fakeRoutes(t, db);
  db.state.product_packagings[0].qty_base = 1.5;
  const before = structuredClone(db.state);
  const invalidBodies = [
    null, [], true,
    cardBody({ packagings: null }), cardBody({ packagings: [definition({ id: 20 })] }),
    cardBody({ packagings: [definition({ items: [{ productId: 999, qty: 1 }] })] }),
    cardBody({ packagings: [definition({ isDefault: false })] }),
    cardBody({ items: [{ sourceType: 'raw', refId: 999, qty: 1, unitId: 1 }] }),
    cardBody({ portionQty: Infinity }),
    cardBody({ portionUnitId: 2 }),
  ];
  for (const body of invalidBodies) {
    await assert.rejects(route(cardsRouter, 'patch', '/:id', { params: { id: '1' }, body }), errorStatus(400));
    assert.deepEqual(db.state, before);
  }
  await assert.rejects(route(cardsRouter, 'post', '/', { body: cardBody({ packagings: [definition({ id: 10 })] }) }), errorStatus(400));
  assert.deepEqual(db.state, before);
});

test('preview route: every row includes cost and unitCost; no writes; default N=1; old portions without ID', async (t) => {
  const db = fixture();
  fakeRoutes(t, db);
  const before = structuredClone(db.state);
  const packaged = await route(cardsRouter, 'get', '/:id/expansion', { params: { id: '1' }, query: { packagingId: '10', portions: '1' } });
  assert.deepEqual(packaged.body, [
    { productId: 1, qty: 200, name: 'Сырьё', unitCode: 'г', stockQty: 10000, unitCost: 0.2, cost: 40 },
    { productId: 2, qty: 1, name: 'Коробка', unitCode: 'шт', stockQty: 100, unitCost: 5, cost: 5 },
  ]);
  assert.deepEqual((await route(cardsRouter, 'get', '/:id/expansion', { params: { id: '1' }, query: { packagingId: '10' } })).body, packaged.body);
  const legacy = await route(cardsRouter, 'get', '/:id/expansion', { params: { id: '1' }, query: { portions: '1.5' } });
  assert.deepEqual(legacy.body, [{ productId: 1, qty: 120, name: 'Сырьё', unitCode: 'г', stockQty: 10000, unitCost: 0.2, cost: 24 }]);
  assert.deepEqual(db.state, before);
});

test('preview route: invalid query shapes/counts/IDs rejected instead of coercion', async (t) => {
  const db = fixture();
  fakeRoutes(t, db);
  for (const value of ['NaN', 'Infinity', '0', '-1', '1.5', '2147483648', '', null, true, ['1'], {}]) {
    await assert.rejects(route(cardsRouter, 'get', '/:id/expansion', { params: { id: '1' }, query: { packagingId: '10', portions: value } }), errorStatus(400));
    await assert.rejects(route(cardsRouter, 'get', '/:id/expansion', { params: { id: '1' }, query: { packagingId: value } }), errorStatus(400));
  }
  await assert.rejects(route(cardsRouter, 'get', '/:id/expansion', { params: { id: '1' }, query: { packagingId: '20' } }), errorStatus(400));
});

test('batch route: strict numeric DTO, snapshot fields in list', async (t) => {
  const db = fixture();
  fakeRoutes(t, db);
  for (const value of [NaN, Infinity, null, true, false, '1', 0, -1, 0.5, 2147483648]) {
    await assert.rejects(route(batchesRouter, 'post', '/', { body: { cardId: 1, portions: 1, packagingId: value } }), errorStatus(400));
    await assert.rejects(route(batchesRouter, 'post', '/', { body: { cardId: 1, portions: value, packagingId: 10 } }), errorStatus(400));
  }
  const posted = await route(batchesRouter, 'post', '/', { body: { cardId: 1, portions: 1, packagingId: 10 } });
  assert.equal(posted.status, 201);
  const list = await route(batchesRouter, 'get', '/');
  assert.deepEqual(list.body[0], { id: posted.body.id, cardId: 1, portions: 1,
    packagingName: 'Коробка 250 г', packagingQtyBase: 250, packagingUnitCode: 'г' });
  assert.match(db.queries.at(-1)!.sql, /b.packaging_name as "packagingName"/);
  assert.match(db.queries.at(-1)!.sql, /b.packaging_qty_base::float8 as "packagingQtyBase"/);
  assert.match(db.queries.at(-1)!.sql, /b.packaging_unit_code as "packagingUnitCode"/);
});

test('product DELETE archives containers at zero stock, including historical batch usage after packaging deletion', async (t) => {
  const db = fixture();
  fakeRoutes(t, db);
  db.state.stock.find((s) => s.product_id === 2)!.qty = 0;
  const result = await route(productsRouter, 'delete', '/:id', { params: { id: '2' } });
  assert.equal(result.body.deactivated, true);
  assert.equal((db.state.products.find((p) => p.id === 2) as { active?: boolean }).active, false);
  assert.equal(db.state.product_packaging_items.length, 2);

  db.state.stock.find((s) => s.product_id === 2)!.qty = 1;
  const posted = await postBatch({ cardId: 1, portions: 1, packagingId: 10, batchDate: null, note: '', actor }, fakeTx(db));
  await save(db, 1, []);
  const items = structuredClone(db.batchItems(posted.id));
  assert.equal((await route(productsRouter, 'delete', '/:id', { params: { id: '2' } })).body.deactivated, true);
  assert.deepEqual(db.batchItems(posted.id), items);
  await reverseBatch(posted.id, actor, fakeTx(db));
  assert.equal(db.stockOf(2).qty, 1);
});
