/**
 * Тесты «умного прихода» и отката (сторно) накладной on in-memory фейке Postgres:
 * проводки, средневзвешенная себестоимость, НДС по строкам, псевдонимы из разбора,
 * отмена «как будто накладной никогда не было» и защита от отмены уже растащенного товара.
 * БД не требуется. Запуск: npm run test:fake (из server/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakePg, emptyState, fakeTx, type FakeState } from './fake-pg';
import { ApiError } from '../src/http';
import { applyMovement } from '../src/services/stock';
import { ingestWaybill, postWaybill, reverseWaybill, round2 } from '../src/routes/waybills';
import { confirmImport } from '../src/routes/import';
import type { Actor } from '../src/services/audit';

const actor: Actor = { id: 7, login: 'storekeeper', fullName: 'Кладовщик' };
const U = { g: 1, kg: 2, ml: 3, pcs: 4 };

const closeTo = (actual: number, expected: number, msg?: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''}: ожидаемо ${expected}, получено ${actual}`);
};

function fixture(): { db: FakePg; id: Record<string, number>; tx: ReturnType<typeof fakeTx> } {
  const state: FakeState = emptyState();
  state.units = [
    { id: U.g, code: 'г', dimension: 'mass', base_factor: 1 },
    { id: U.kg, code: 'кг', dimension: 'mass', base_factor: 1000 },
    { id: U.ml, code: 'мл', dimension: 'volume', base_factor: 1 },
    { id: U.pcs, code: 'шт', dimension: 'count', base_factor: 1 },
  ];
  state.products = [
    { id: 1, name: 'Картофель', category: 'овощи', unit_id: U.g, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null, created_by: null },
    { id: 2, name: 'Масло подсолнечное', category: 'масло', unit_id: U.ml, g_per_pcs: null, ml_per_pcs: null, g_per_ml: 0.93, created_by: null },
    { id: 3, name: 'Яйцо куриное', category: 'мясо', unit_id: U.g, g_per_pcs: 60, ml_per_pcs: null, g_per_ml: null, created_by: null },
    { id: 4, name: 'Мука пшеничная', category: 'бакалея', unit_id: U.g, g_per_pcs: null, ml_per_pcs: null, g_per_ml: null, created_by: null },
  ];
  state.stock = [
    { product_id: 1, qty: 0, avg_cost: 0 },
    { product_id: 2, qty: 0, avg_cost: 0 },
    { product_id: 3, qty: 0, avg_cost: 0 },
    { product_id: 4, qty: 0, avg_cost: 0 },
  ];
  const db = new FakePg(state);
  return { db, id: { potato: 1, oil: 2, eggs: 3, flour: 4 }, tx: fakeTx(db) };
}

// ==================== приход (ingestWaybill / postWaybill) ====================

test('приход: базовые г, себестоимость за базовую единицу, итоги и НДС по строкам', async () => {
  const { db, id, tx } = fixture();
  const wbId = await postWaybill(
    { number: 'T-001', supplier: 'Milkos', docDate: '2026-11-01', actor },
    [{ productId: id.potato, qty: 2000, unitId: U.g, price: 0.2, vatRate: 5 }],
    tx
  );
  const st = db.stockOf(id.potato);
  closeTo(st.qty, 2000, 'остаток в г');
  closeTo(st.avgCost, 0.2, '400 / 2000 г');
  const mv = db.movementsOf(id.potato);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].type, 'receipt');
  assert.equal(mv[0].qty, 2000);
  closeTo(mv[0].unit_cost, 0.2);
  assert.equal(mv[0].doc_type, 'waybill');
  assert.equal(mv[0].doc_id, wbId);
  assert.equal(mv[0].user_login, 'storekeeper');
  const wb = db.waybill(wbId);
  closeTo(wb.total_net, 400);
  closeTo(wb.total_vat, 20);
  closeTo(wb.total_gross, 420);
  assert.equal(wb.status, 'posted');
  assert.equal(wb.accepted_login, 'storekeeper');
  // позиция накладной хранится в тех же базовых единицах, что и склад
  const item = db.state.waybill_items.find((i) => i.waybill_id === wbId)!;
  closeTo(item.qty, 2000);
  closeTo(item.price, 0.2);
  closeTo(item.vat_amount, 20);
  assert.equal(db.state.audit_log.filter((a) => a.action === 'post').length, 1);
});

test('приход: кросс-размерный (шт по 60 г -> г), деньги строки задают себестоимость', async () => {
  const { db, id, tx } = fixture();
  await postWaybill(
    { number: 'T-002', supplier: 'Ferma', docDate: null, actor },
    [{ productId: id.eggs, qty: 10, unitId: U.pcs, price: 30 }],
    tx
  );
  const st = db.stockOf(id.eggs);
  closeTo(st.qty, 600, '10 шт × 60 г');
  closeTo(st.avgCost, 300 / 600, '300 денег / 600 г');
});

test('приход: НДС округляется по строкам, а не по сумме (иначе не бьётся с документом)', async () => {
  const { db, id, tx } = fixture();
  // три строки по 5.60 со ставкой 2%: НДС строки 0.112 -> 0.11, вместе 0.33;
  // если округлять сумму (3 × 0.112 = 0.336) получилось бы 0.34 — разминулись бы с печатным документом
  const wbId = await postWaybill(
    { number: 'T-003', supplier: 'Pekara', docDate: null, actor },
    [
      { productId: id.potato, qty: 1, unitId: U.g, price: 5.6, vatRate: 2 },
      { productId: id.flour, qty: 1, unitId: U.g, price: 5.6, vatRate: 2 },
      { productId: id.oil, qty: 1, unitId: U.ml, price: 5.6, vatRate: 2 },
    ],
    tx
  );
  const wb = db.waybill(wbId);
  closeTo(wb.total_net, 16.8);
  closeTo(wb.total_vat, 0.33, 'по строкам: 3 × 0.11 (а не round(0.336) = 0.34)');
  closeTo(wb.total_gross, 17.13);
  assert.equal(round2(0.336), 0.34, 'сумма НДС до округления по строкам была бы 0.34');
});

test('приход: отказы — нулевое количество, не-базовая складская единица, несуществующий товар', async () => {
  const { db, id, tx } = fixture();
  await assert.rejects(
    postWaybill({ number: 'T-0', supplier: '', docDate: null, actor }, [{ productId: id.potato, qty: 0, unitId: U.g, price: 1 }], tx),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /Количество/.test(e.message)
  );
  // кг как складская единица товара — приход в не-базовую запрещён
  await assert.rejects(
    postWaybill({ number: 'T-0', supplier: '', docDate: null, actor }, [{ productId: id.potato, qty: 1, unitId: U.kg, price: 1 }], tx),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /базовы/.test(e.message)
  );
  await assert.rejects(
    postWaybill({ number: 'T-0', supplier: '', docDate: null, actor }, [{ productId: 999, qty: 1, unitId: U.g, price: 1 }], tx),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /не найден/.test(e.message)
  );
  // и ни одна из неудачных транзакций не оставила следов
  assert.equal(db.state.waybills.length, 0);
  assert.equal(db.state.movements.length, 0);
  closeTo(db.stockOf(id.potato).qty, 0);
});

// ==================== умный приход: confirm (создание позиции + псевдонимы) ====================

const confirmBase = () => ({
  fileName: 'photo.jpg',
  storedFile: null,
  fileBuf: null,
  fileMime: null,
  extraFiles: null,
  currency: 'RSD',
  supplierPib: null,
  docTotals: { net: null, vat: null, gross: null },
});

test('confirm: создание новой позиции, нулевой склад и запоминается псевдоним из документа', async () => {
  const { db, tx } = fixture();
  const r = await confirmImport(
    {
      ...confirmBase(),
      number: 'T-100',
      supplier: 'GDP',
      docDate: '2026-11-01',
      items: [{ rawName: 'Krompir mladi', qty: 1000, unitId: U.g, price: 0.12, vatRate: null, create: { name: 'Картофель молодой', category: 'овощи', unitId: U.g } }],
    },
    actor,
    tx
  );
  assert.equal(r.created.length, 1);
  assert.equal(r.aliasesSaved, 1);
  const newId = r.created[0].id;
  closeTo(db.stockOf(newId).qty, 1000);
  closeTo(db.stockOf(newId).avgCost, 0.12);
  const alias = db.state.product_aliases.find((a) => a.product_id === newId);
  assert.ok(alias, 'псевдоним сохранён');
  assert.equal(alias!.alias, 'krompir mladi');
  assert.equal(alias!.alias_raw, 'Krompir mladi');
});

test('confirm: то же название в другом регистре — дописываемся к существующей позиции, а не создаём дубль', async () => {
  const { db, tx } = fixture();
  const r1 = await confirmImport(
    {
      ...confirmBase(),
      number: 'T-101',
      supplier: 'GDP',
      docDate: null,
      items: [{ rawName: 'Lavas', qty: 500, unitId: U.g, price: 0.2, vatRate: null, create: { name: 'Лаваш', category: 'бакалея', unitId: U.g } }],
    },
    actor,
    tx
  );
  assert.equal(r1.created.length, 1, 'такого названия ещё нет — создаём');
  // то же название другим регистром — существующая позиция, дубля не появляется
  const r2 = await confirmImport(
    {
      ...confirmBase(),
      number: 'T-102',
      supplier: 'GDP',
      docDate: null,
      items: [{ rawName: 'LAVAS', qty: 500, unitId: U.g, price: 0.2, vatRate: null, create: { name: 'лаваш', category: 'бакалея', unitId: U.g } }],
    },
    actor,
    tx
  );
  assert.equal(r2.created.length, 0);
  assert.equal(db.state.products.filter((p) => p.name.toLowerCase() === 'лаваш').length, 1);
  closeTo(db.stockOf(r1.created[0].id).qty, 1000, 'оба прихода легли в одну позицию');
});

test('confirm: повторное написание того же товара в новом документе — сматчится через существующий псевдоним', async () => {
  const { db, tx } = fixture();
  const r1 = await confirmImport(
    {
      ...confirmBase(),
      number: 'T-103',
      supplier: 'GDP',
      docDate: null,
      items: [{ rawName: 'Krompir', qty: 1000, unitId: U.g, price: 0.1, vatRate: null, create: { name: 'Картофель молодой', category: 'овощи', unitId: U.g } }],
    },
    actor,
    tx
  );
  assert.equal(r1.aliasesSaved, 1);
  const newId = r1.created[0].id;
  // второй приход: rawName снова «Krompir», productId берём из первого раза
  const r2 = await confirmImport(
    {
      ...confirmBase(),
      number: 'T-104',
      supplier: 'GDP',
      docDate: null,
      items: [{ rawName: 'Krompir', qty: 500, unitId: U.g, price: 0.2, vatRate: null, productId: newId }],
    },
    actor,
    tx
  );
  assert.equal(r2.aliasesSaved, 0, 'псевдоним уже был — не пересоздаём');
  assert.equal(db.state.product_aliases.filter((a) => a.alias === 'krompir').length, 1);
  closeTo(db.stockOf(newId).qty, 1500);
});

test('confirm: новая позиция с не-базовой складской единицей — отказ, транзакция ничего не пишет', async () => {
  const { db, tx } = fixture();
  await assert.rejects(
    confirmImport(
      {
        ...confirmBase(),
        number: 'T-105',
        supplier: 'GDP',
        docDate: null,
        items: [{ rawName: 'Something', qty: 1, unitId: U.g, price: 1, vatRate: null, create: { name: 'Что-то', category: 'прочее', unitId: U.kg } }],
      },
      actor,
      tx
    ),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /базовой/.test(e.message)
  );
  assert.equal(db.state.waybills.length, 0);
  assert.equal(db.state.products.length, 4, 'новый продукт не создан');
});

// ==================== откат (сторно) ====================

test('откат чистого прихода: остаток гасится в 0, сторно-движение записано, статус reversed', async () => {
  const { db, id, tx } = fixture();
  const wbId = await postWaybill(
    { number: 'T-200', supplier: 'Milkos', docDate: null, actor },
    [{ productId: id.potato, qty: 1000, unitId: U.g, price: 0.2 }],
    tx
  );
  const recalc = await reverseWaybill(wbId, actor, tx);
  assert.equal(recalc, 1);
  const st = db.stockOf(id.potato);
  closeTo(st.qty, 0);
  closeTo(st.avgCost, 0, 'пересчёт из пустого журнала -> 0');
  const mv = db.movementsOf(id.potato);
  assert.equal(mv.length, 2);
  assert.equal(mv[1].type, 'writeoff');
  closeTo(mv[1].qty, -1000);
  assert.equal(mv[1].doc_id, wbId);
  assert.match(mv[1].comment!, /Отмена накладной №T-200/);
  const wb = db.waybill(wbId);
  assert.equal(wb.status, 'reversed');
  assert.equal(wb.reversed_login, 'storekeeper');
  assert.ok(wb.reversed_at, 'reversed_at проставлен');
  assert.equal(db.state.audit_log.filter((a) => a.action === 'reverse').length, 1);
});

test('откат: средняя себестоимость пересчитывается, как будто накладной никогда не было', async () => {
  const { db, id, tx } = fixture();
  const wbA = await postWaybill(
    { number: 'T-201', supplier: 'A', docDate: null, actor },
    [{ productId: id.potato, qty: 2000, unitId: U.g, price: 0.2 }], // 2000 г по 0.2
    tx
  );
  await postWaybill(
    { number: 'T-202', supplier: 'B', docDate: null, actor },
    [{ productId: id.potato, qty: 1000, unitId: U.g, price: 0.4 }], // 1000 г по 0.4
    tx
  );
  closeTo(db.stockOf(id.potato).avgCost, (2000 * 0.2 + 1000 * 0.4) / 3000, 'avg до отмены');
  await reverseWaybill(wbA, actor, tx);
  const st = db.stockOf(id.potato);
  closeTo(st.qty, 1000);
  closeTo(st.avgCost, 0.4, 'отменённая цена 0.2 полностью вымыта из средней');
});

test('откат: движения и приход, и сторно отменённой накладной исключаются из пересчёта', async () => {
  const { db, id, tx } = fixture();
  const wbA = await postWaybill(
    { number: 'T-203', supplier: 'A', docDate: null, actor },
    [{ productId: id.potato, qty: 1000, unitId: U.g, price: 0.2 }],
    tx
  );
  const wbB = await postWaybill(
    { number: 'T-204', supplier: 'B', docDate: null, actor },
    [{ productId: id.potato, qty: 2000, unitId: U.g, price: 0.3 }],
    tx
  );
  await reverseWaybill(wbA, actor, tx);
  closeTo(db.stockOf(id.potato).qty, 2000);
  closeTo(db.stockOf(id.potato).avgCost, 0.3);
  // отменяем вторую: журнал = только движения отменённых накладных -> пустой «неотменённый» журнал
  await reverseWaybill(wbB, actor, tx);
  const st = db.stockOf(id.potato);
  closeTo(st.qty, 0);
  closeTo(st.avgCost, 0, 'сторно-движение первой отмены не отравило среднюю');
});

test('откат: кросс-размерный приход сторнуется в базовых единицах (шт -> г)', async () => {
  const { db, id, tx } = fixture();
  const wbId = await postWaybill(
    { number: 'T-205', supplier: 'Ferma', docDate: null, actor },
    [{ productId: id.eggs, qty: 10, unitId: U.pcs, price: 30 }],
    tx
  );
  await reverseWaybill(wbId, actor, tx);
  closeTo(db.stockOf(id.eggs).qty, 0, 'сторно считает те же 600 г, что и приход');
});

test('откат: товар уже частично списан в производство — 409, вся транзакция откатывается', async () => {
  const { db, id, tx } = fixture();
  // приход: картофель 2000 г + мука 300 г — мука сторнируется первой, картофель не успеет
  const wbId = await postWaybill(
    { number: 'T-206', supplier: 'Milkos', docDate: null, actor },
    [
      { productId: id.flour, qty: 300, unitId: U.g, price: 0.3 },
      { productId: id.potato, qty: 2000, unitId: U.g, price: 0.2 },
    ],
    tx
  );
  // производство съело 1500 из 2000 г картофеля — на откат не хватает
  await applyMovement(await connect(db), { productId: id.potato, type: 'writeoff', delta: -1500, docType: 'batch', docId: 1 });
  await assert.rejects(
    reverseWaybill(wbId, actor, tx),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /Недостаточно/.test(e.message)
  );
  const wb = db.waybill(wbId);
  assert.equal(wb.status, 'posted', 'накладная осталась проведена');
  closeTo(db.stockOf(id.potato).qty, 500, 'остаток не тронут отклонённым откатом');
  closeTo(db.stockOf(id.flour).qty, 300, 'частично сторнированная до ошибки мука вернулась к исходному остатку');
  assert.equal(db.movementsOf(id.flour).length, 1, 'сторно-движение откатилось вместе с транзакцией');
});

function connect(db: FakePg) {
  return { query: (sql: string, p: unknown[] = []) => db.query(sql, p) } as any;
}

test('откат: чистый сторно не должен уводить остаток в минус, даже когда avg_cost уже «грязный»', async () => {
  const { db, id, tx } = fixture();
  // ручной приход 200 г по 0.5, потом накладная 1000 г по 0.2
  await applyMovement(await connect(db), { productId: id.potato, type: 'receipt', delta: 200, unitCost: 0.5, docType: 'manual' });
  const wbId = await postWaybill(
    { number: 'T-207', supplier: 'Milkos', docDate: null, actor },
    [{ productId: id.potato, qty: 1000, unitId: U.g, price: 0.2 }],
    tx
  );
  const recalc = await reverseWaybill(wbId, actor, tx);
  assert.equal(recalc, 1);
  const st = db.stockOf(id.potato);
  closeTo(st.qty, 200, 'остался только ручной приход');
  closeTo(st.avgCost, 0.5);
});

test('откат: отказы — несуществующая и уже отменённая накладная', async () => {
  const { db, id, tx } = fixture();
  await assert.rejects(
    reverseWaybill(4242, actor, tx),
    (e: unknown) => e instanceof ApiError && e.status === 404
  );
  const wbId = await postWaybill(
    { number: 'T-208', supplier: 'A', docDate: null, actor },
    [{ productId: id.potato, qty: 1, unitId: U.g, price: 1 }],
    tx
  );
  await reverseWaybill(wbId, actor, tx);
  await assert.rejects(
    reverseWaybill(wbId, actor, tx),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /уже отменена/.test(e.message)
  );
});

test('откат: накладная без позиций — отменять нечего', async () => {
  const { db, tx } = fixture();
  // пустая накладная возникает, например, если все позиции убрали до сохранения — кладём напрямую
  const { rows } = await db.query('insert into waybills (number) values ($1) returning id', ['T-EMPTY']);
  const emptyId = rows[0].id as number;
  await assert.rejects(
    reverseWaybill(emptyId, actor, tx),
    (e: unknown) => e instanceof ApiError && e.status === 409 && /нет позиций/.test(e.message)
  );
  assert.equal(db.waybill(emptyId).status, 'posted');
});

test('приход через ingestWaybill напрямую (путь импорта): файл и реквизиты легли в шапку', async () => {
  const { db, id, tx } = fixture();
  const wbId = await tx(async (client) =>
    ingestWaybill(
      client,
      {
        number: 'T-300',
        supplier: 'GDP',
        docDate: '2026-11-02',
        actor,
        fileName: 'IMG_0001.jpg',
        storedFile: 'abc.jpg',
        fileData: Buffer.from('fakejpegbytes'),
        fileMime: 'image/jpeg',
        extraFiles: [{ stored: 'abc2.jpg', name: 'IMG_0002.jpg', mime: 'image/jpeg', data: Buffer.from('x') }],
        currency: 'RSD',
        supplierPib: '123456789',
        docTotalNet: 120,
        docTotalVat: 6,
        docTotalGross: 126,
      },
      [{ productId: id.potato, qty: 1000, unitId: U.g, price: 0.12, vatRate: 5 }]
    )
  );
  const wb = db.waybill(wbId);
  assert.equal(wb.file_name, 'IMG_0001.jpg');
  assert.ok(Buffer.isBuffer(wb.file_data));
  assert.equal((wb.file_data as Buffer).toString(), 'fakejpegbytes');
  assert.equal((wb.extra_files as any[]).length, 1);
  assert.equal((wb.extra_files as any[])[0].name, 'IMG_0002.jpg');
  closeTo(wb.doc_total_net!, 120, 'напечатанные итоги для сверки сохранены');
  closeTo(wb.total_net, 120, 'пересчёт по строкам совпал с документом');
  closeTo(wb.total_vat, 6);
});

// ==================== сквозные цепочки: умный приход -> откат ====================

test('вся цепочка умного прихода: confirm создал позицию и псевдоним, откат обнулил склад, товар и псевдоним живы', async () => {
  const { db, tx } = fixture();
  const r = await confirmImport(
    {
      ...confirmBase(),
      number: 'T-400',
      supplier: 'GDP',
      docDate: '2026-11-01',
      items: [{ rawName: 'Krompir', qty: 1000, unitId: U.g, price: 0.2, vatRate: 5, create: { name: 'Картофель молодой', category: 'овощи', unitId: U.g } }],
    },
    actor,
    tx
  );
  const newId = r.created[0].id;
  closeTo(db.stockOf(newId).qty, 1000, 'приход лёг');
  // откатываем именно импортированную накладную
  const recalc = await reverseWaybill(r.waybillId, actor, tx);
  assert.equal(recalc, 1);
  const st = db.stockOf(newId);
  closeTo(st.qty, 0);
  closeTo(st.avgCost, 0, 'журнал без движений отменённой накладной пуст -> себестоимость 0');
  assert.equal(db.waybill(r.waybillId).status, 'reversed');
  // откат не трогает ни созданную позицию, ни запомненное написание — следующий разбор сматчится сам
  assert.ok(db.state.products.some((p) => p.id === newId), 'позиция осталась');
  assert.equal(db.state.product_aliases.filter((a) => a.alias === 'krompir').length, 1, 'псевдоним не удалён');
  assert.equal(db.state.audit_log.filter((a) => a.action === 'post').length, 1);
  assert.equal(db.state.audit_log.filter((a) => a.action === 'reverse').length, 1);
});

test('confirm: productId несуществующей позиции — 400 «не найдена», транзакция ничего не пишет', async () => {
  const { db, tx } = fixture();
  await assert.rejects(
    confirmImport(
      {
        ...confirmBase(),
        number: 'T-401',
        supplier: 'GDP',
        docDate: null,
        items: [{ rawName: 'Небылицa', qty: 100, unitId: U.g, price: 0.1, vatRate: null, productId: 999 }],
      },
      actor,
      tx
    ),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /Позиция #999 не найдена/.test(e.message)
  );
  assert.equal(db.state.waybills.length, 0);
  assert.equal(db.state.movements.length, 0);
  assert.equal(db.state.product_aliases.length, 0, 'псевдоним до проверки позиции не дописывается');
});

test('кросс-размерность г -> мл (масло, g_per_ml 0.93): приход в граммах ложится в мл, сторно снимает те же мл', async () => {
  const { db, id, tx } = fixture();
  const wbId = await postWaybill(
    { number: 'T-402', supplier: 'Mlinar', docDate: null, actor },
    [{ productId: id.oil, qty: 930, unitId: U.g, price: 0.1 }], // 930 г по 0.1 = 93 денег -> 1000 мл по 0.093
    tx
  );
  const st = db.stockOf(id.oil);
  closeTo(st.qty, 1000, '930 г / 0.93 = 1000 мл');
  closeTo(st.avgCost, 0.093, 'деньги строки / базовое количество');
  await reverseWaybill(wbId, actor, tx);
  closeTo(db.stockOf(id.oil).qty, 0, 'сторно считает то же мл-количество, что и приход');
});
