/**
 * Тесты списания в производство («партии») и матчера заказов on in-memory фейке Postgres:
 *  • postBatch: раскрытие техкарты в чистое сырьё (с выходом после обработки),
 *    списание по средневзвешенной, снимок состава и себестоимость партии;
 *  • reverseBatch: возврат сырья по снимку «как будто партии не было»;
 *  • CardMatcher: строка Google Таблицы ищет свою техкарту (PLU -> имя -> нечёткий).
 * БД не требуется. Запуск: npm run test:fake (из server/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakePg, emptyState, fakeTx, type FakeState } from './fake-pg';
import { ApiError } from '../src/http';
import { postBatch, reverseBatch } from '../src/routes/batches';
import { CardMatcher } from '../src/services/order-match';
import type { Actor } from '../src/services/audit';

const actor: Actor = { id: 9, login: 'tech', fullName: 'Технолог' };
const U = { g: 1, ml: 2, pcs: 3, kg: 4, des: 5 };

const closeTo = (actual: number, expected: number, msg?: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''}: ожидаемо ${expected}, получено ${actual}`);
};

/** Сырьевые продукты склада: все в базовых единицах (г/мл/шт). */
function rawState(): FakeState {
  const state = emptyState();
  state.units = [
    { id: U.g, code: 'г', dimension: 'mass', base_factor: 1 },
    { id: U.ml, code: 'мл', dimension: 'volume', base_factor: 1 },
    { id: U.pcs, code: 'шт', dimension: 'count', base_factor: 1 },
    { id: U.kg, code: 'кг', dimension: 'mass', base_factor: 1000 },
    { id: U.des, code: 'des', dimension: 'count', base_factor: 1 },
  ];
  state.products = [
    { id: 1, name: 'Картофель', category: 'овощи', unit_id: U.g, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null, created_by: null },
    { id: 2, name: 'Масло подсолнечное', category: 'масло', unit_id: U.ml, g_per_pcs: null, ml_per_pcs: null, g_per_ml: 0.93, created_by: null },
    { id: 3, name: 'Мука пшеничная', category: 'бакалея', unit_id: U.g, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null, created_by: null },
    { id: 4, name: 'Яйцо куриное', category: 'мясо', unit_id: U.g, g_per_pcs: 60, ml_per_pcs: null, g_per_ml: null, created_by: null },
  ];
  state.stock = [
    { product_id: 1, qty: 5000, avg_cost: 0.2 },
    { product_id: 2, qty: 1000, avg_cost: 0.05 },
    { product_id: 3, qty: 3000, avg_cost: 0.3 },
    { product_id: 4, qty: 3000, avg_cost: 0.5 },
  ];
  return state;
}

function mkCard(state: FakeState, id: number, name: string, portionQty: number, portionUnitId: number, plu: string | null = null): void {
  state.tech_cards.push({ id, name, portion_qty: portionQty, portion_unit_id: portionUnitId, plu });
}

// ==================== postBatch: раскрытие карты и списание сырья ====================

test('партия: простая карта из сырья — списание по средневзвешенной, снимок состава и себестоимость', async () => {
  const state = rawState();
  mkCard(state, 1, 'Блины с картошкой', 300, U.g);
  state.tech_card_items.push(
    { card_id: 1, source_type: 'raw', ref_id: 1, qty: 300, unit_id: U.g, position: 1 }, // 300 г картофеля на порцию
    { card_id: 1, source_type: 'raw', ref_id: 2, qty: 20, unit_id: U.ml, position: 2 }, // 20 мл масла на порцию
  );
  const db = new FakePg(state);
  const tx = fakeTx(db);

  const r = await postBatch({ cardId: 1, portions: 4, batchDate: '2026-11-02', note: 'смена А', actor }, tx);

  closeTo(r.items.find((i) => i.productId === 1)!.qty, 1200, '4 × 300 г картофеля');
  closeTo(r.items.find((i) => i.productId === 1)!.unitCost, 0.2, 'цена списания — текущая средневзвешенная');
  closeTo(r.items.find((i) => i.productId === 2)!.qty, 80, '4 × 20 мл масла');
  closeTo(r.costTotal, 1200 * 0.2 + 80 * 0.05, 'себестоимость = Σ qty × avg_cost');
  closeTo(db.batchCost(r.id), r.costTotal, 'снимок состава бьётся с итогом партии');

  closeTo(db.stockOf(1).qty, 3800, 'картофель списан');
  closeTo(db.stockOf(2).qty, 920);
  closeTo(db.stockOf(1).avgCost, 0.2, 'расход среднюю себестоимость не трогает');

  const mv = db.movementsOf(1);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].type, 'writeoff');
  closeTo(mv[0].qty, -1200, 'движение в базовых единицах со знаком минус');
  assert.equal(mv[0].doc_type, 'batch');
  assert.equal(mv[0].doc_id, r.id);
  assert.match(mv[0].comment!, /Расход: Блины с картошкой × 4 порц\./);
  assert.equal(mv[0].user_login, 'tech');

  const b = db.batch(r.id);
  assert.equal(b.status, 'posted');
  assert.equal(b.cost_total, r.costTotal);
  assert.equal(db.state.audit_log.filter((a) => a.action === 'post' && a.entity === 'batch').length, 1);
});

test('партия: карта через заготовку — рекурсия до сырья, выход после обработки утяжеляет вход', async () => {
  const state = rawState();
  // заготовка «Яичная смесь»: выход 900 г, состав — 1200 г яйца с выходом 80 % после взбивания
  state.semi_products.push({ id: 1, name: 'Яичная смесь', unit_id: U.g, out_qty: 900, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null });
  state.semi_inputs.push(
    { semi_id: 1, source_type: 'raw', ref_id: 4, qty_per_output: 1200, yield_pct: 80 },
    { semi_id: 1, source_type: 'raw', ref_id: 1, qty_per_output: 300, yield_pct: null },
  );
  mkCard(state, 2, 'Омлет', 300, U.g);
  state.tech_card_items.push(
    { card_id: 2, source_type: 'semi', ref_id: 1, qty: 300, unit_id: U.g, position: 1 },
    { card_id: 2, source_type: 'raw', ref_id: 3, qty: 50, unit_id: U.g, position: 2 },
  );
  const db = new FakePg(state);
  const tx = fakeTx(db);

  const r = await postBatch({ cardId: 2, portions: 4, batchDate: null, note: '', actor }, tx);

  // 4 × 300 г смеси = масштаб партии k = 1200 / 900 = 4/3
  closeTo(r.items.find((i) => i.productId === 4)!.qty, 2000, 'яйцо: 1200 × 4/3 / 0.8 — потери 20 % при обработке утяжеляют вход');
  closeTo(r.items.find((i) => i.productId === 1)!.qty, 400, 'картофель внутри смеси: 300 × 4/3, без выхода');
  closeTo(r.items.find((i) => i.productId === 3)!.qty, 200, 'мука прямо из карты: 50 × 4');
  closeTo(db.stockOf(4).qty, 1000);
  assert.equal(db.batch(r.id).batch_date, new Date().toISOString().slice(0, 10), 'дата null -> сегодня, как current_date в SQL');
});

test('партия: штучный вход с выходом в заготовке — потерю считаем в граммах, в штуках выход не делим', async () => {
  const state = rawState();
  // заготовка 1000 г; вход — яйцо (60 г/шт) 540 г с выходом 90 %
  state.semi_products.push({ id: 1, name: 'Соус', unit_id: U.g, out_qty: 1000, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null });
  state.semi_inputs.push({ semi_id: 1, source_type: 'raw', ref_id: 4, qty_per_output: 540, yield_pct: 90 });
  mkCard(state, 3, 'Соусный блюдо', 200, U.g);
  state.tech_card_items.push({ card_id: 3, source_type: 'semi', ref_id: 1, qty: 200, unit_id: U.g, position: 1 });
  const db = new FakePg(state);

  const r = await postBatch({ cardId: 3, portions: 1, batchDate: '2026-11-02', note: '', actor }, fakeTx(db));
  // k = 200/1000, вход 540×0.2 = 108 г, делёж на выход 90 % -> 120 г
  closeTo(r.items[0].productId === 4 ? r.items[0].qty : -1, 120, '108 г / 0.9');
  closeTo(db.stockOf(4).qty, 3000 - 120);
});

test('партия: позиция карты в кг при складе в г — кросс-размерность внутри массы пересчитается', async () => {
  const state = rawState();
  mkCard(state, 4, 'Салат', 1, U.kg); // выход карты в кг — не базовая единица, expandCard переводит в г
  state.tech_card_items.push({ card_id: 4, source_type: 'raw', ref_id: 1, qty: 0.5, unit_id: U.kg, position: 1 });
  const db = new FakePg(state);

  const r = await postBatch({ cardId: 4, portions: 2, batchDate: '2026-11-02', note: '', actor }, fakeTx(db));
  closeTo(r.items[0].qty, 1000, '2 × 0.5 кг = 1000 г');
});

test('партия: отказы — порции <= 0, несуществующая техкарта, пустая техкарта; фейк ничего не оставляет', async () => {
  const state = rawState();
  mkCard(state, 5, 'Пустая карта', 100, U.g); // без позиций
  const db = new FakePg(state);
  const tx = fakeTx(db);

  await assert.rejects(
    postBatch({ cardId: 1, portions: 0, batchDate: null, note: '', actor }, tx),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /Порций/.test(e.message)
  );
  await assert.rejects(
    postBatch({ cardId: 404, portions: 1, batchDate: null, note: '', actor }, tx),
    (e: unknown) => e instanceof ApiError && e.status === 404 && /Техкарта не найдена/.test(e.message)
  );
  await assert.rejects(
    postBatch({ cardId: 5, portions: 1, batchDate: null, note: '', actor }, tx),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /В техкарте нет позиций/.test(e.message)
  );
  assert.equal(db.state.production_batches.length, 0);
  assert.equal(db.state.movements.length, 0);
  closeTo(db.stockOf(1).qty, 5000, 'сырьё не тронуто');
});

test('партия: сырья не хватает — 409, вся транзакция откатывается целиком', async () => {
  const state = rawState();
  state.stock[0].qty = 1000; // картофеля на 3+ порции не хватит
  mkCard(state, 6, 'Блины с картошкой', 300, U.g);
  state.tech_card_items.push(
    { card_id: 6, source_type: 'raw', ref_id: 1, qty: 300, unit_id: U.g, position: 1 },
    { card_id: 6, source_type: 'raw', ref_id: 2, qty: 20, unit_id: U.ml, position: 2 },
  );
  const db = new FakePg(state);

  await assert.rejects(
    postBatch({ cardId: 6, portions: 4, batchDate: null, note: '', actor }, fakeTx(db)),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /Недостаточно сырья/.test(e.message)
  );
  assert.equal(db.state.production_batches.length, 0, 'партия не записана');
  assert.equal(db.state.production_batch_items.length, 0);
  assert.equal(db.state.movements.length, 0, 'и масло, списанное до ошибки, вернулось');
  closeTo(db.stockOf(1).qty, 1000);
  closeTo(db.stockOf(2).qty, 1000);
});

// ==================== reverseBatch: возврат сырья по снимку ====================

test('отмена партии: сырьё возвращается по снимку, status reversed, себестоимость обнулена', async () => {
  const state = rawState();
  mkCard(state, 7, 'Блины с картошкой', 300, U.g);
  state.tech_card_items.push(
    { card_id: 7, source_type: 'raw', ref_id: 1, qty: 300, unit_id: U.g, position: 1 },
    { card_id: 7, source_type: 'raw', ref_id: 2, qty: 20, unit_id: U.ml, position: 2 },
  );
  const db = new FakePg(state);
  const tx = fakeTx(db);

  const posted = await postBatch({ cardId: 7, portions: 4, batchDate: '2026-11-02', note: '', actor }, tx);
  const n = await reverseBatch(posted.id, actor, tx);
  assert.equal(n, 2, 'две позиции состава вернулись на склад');

  closeTo(db.stockOf(1).qty, 5000, 'картофель вернулся к исходному остатку');
  closeTo(db.stockOf(2).qty, 1000);
  closeTo(db.stockOf(1).avgCost, 0.2, 'возврат без цены — средневзвешенную не пересчитываем');

  const mv = db.movementsOf(1);
  assert.equal(mv.length, 2);
  assert.equal(mv[1].type, 'receipt');
  closeTo(mv[1].qty, 1200);
  assert.match(mv[1].comment!, /Возврат: отмена партии/);

  const b = db.batch(posted.id);
  assert.equal(b.status, 'reversed');
  assert.equal(b.cost_total, 0);
  assert.equal(db.state.audit_log.filter((a) => a.action === 'reverse' && a.entity === 'batch').length, 1);
});

test('отмена партии: двойная отмена — 409, несуществующая партия — 404, партия без состава — 409', async () => {
  const state = rawState();
  mkCard(state, 8, 'Блины', 300, U.g);
  state.tech_card_items.push({ card_id: 8, source_type: 'raw', ref_id: 1, qty: 300, unit_id: U.g, position: 1 });
  const db = new FakePg(state);
  const tx = fakeTx(db);

  await assert.rejects(reverseBatch(4242, actor, tx), (e: unknown) => e instanceof ApiError && e.status === 404);

  const posted = await postBatch({ cardId: 8, portions: 2, batchDate: null, note: '', actor }, tx);
  await reverseBatch(posted.id, actor, tx);
  await assert.rejects(
    reverseBatch(posted.id, actor, tx),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /уже отменена/.test(e.message)
  );

  // партия без снимка состава (например, заведена напрямую) — возвращать нечего
  db.state.production_batches.push({
    id: 999, card_id: 8, portions: 1, batch_date: '2026-11-02', note: '',
    cost_total: 0, status: 'posted', created_by: null, created_login: 'seed',
  });
  await assert.rejects(
    reverseBatch(999, actor, tx),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /нет состава/.test(e.message)
  );
  assert.equal(db.batch(999).status, 'posted', 'отклонённая отмена статус не поменяла');
});

// ==================== CardMatcher: строка листа ищет свою техкарту ====================

function catalogDb(): FakePg {
  const state = rawState();
  mkCard(state, 11, 'Блины (100г)', 100, U.pcs, 'M924');
  mkCard(state, 12, 'Спаржа по-корейски 250g', 250, U.g, null);
  mkCard(state, 13, 'Спаржа по-корейски', 1000, U.kg, null);
  mkCard(state, 14, 'Борщ с говядиной', 300, U.ml, null);
  return new FakePg(state);
}

test('матчер: PLU бьёт первым, даже если имя написано латиницей и с мусором', async () => {
  const m = new CardMatcher();
  await m.load((sql, p) => catalogDb().query(sql, p));
  const r = await m.match('BLYNY 100g!!!', 'm924');
  assert.deepEqual({ ...r, sim: 1 }, { cardId: 11, via: 'plu', sim: 1 });
});

test('матчер: терпимая норма — точное имя; коллизию фасовок различает строгая норма', async () => {
  const m = new CardMatcher();
  await m.load((sql, p) => catalogDb().query(sql, p));
  const a = await m.match('  блины (100г) ', null);
  assert.equal(a.cardId, 11);
  assert.equal(a.via, 'name');
  // «Спаржа по-корейски» и «...250g» под терпимой нормой коллидируют — берёт строгая
  assert.equal((await m.match('Спаржа по корейски 250g', null)).cardId, 12);
  assert.equal((await m.match('Спаржа по-корейски', null)).cardId, 13);
});

test('матчер: опечатка ловится нечётким поиском, явный мусор — без карты', async () => {
  const m = new CardMatcher();
  await m.load((sql, p) => catalogDb().query(sql, p));
  const fuzzy = await m.match('Барщ с говядиной', null);
  assert.equal(fuzzy.cardId, 14, 'одна буква не в месте — симмя выше порога');
  assert.equal(fuzzy.via, 'fuzzy');
  const none = await m.match('Пицца Маргарита', null);
  assert.equal(none.cardId, null);
  assert.equal((await m.match('', null)).cardId, null, 'пустая строка не матчится ни на что');
});

test('матчер: byId отдаёт выход карточки для пересчёта порций в граммы', async () => {
  const m = new CardMatcher();
  await m.load((sql, p) => catalogDb().query(sql, p));
  const c = m.byId(11)!;
  assert.equal(c.unitCode, 'шт');
  closeTo(c.portionQty, 100);
});
