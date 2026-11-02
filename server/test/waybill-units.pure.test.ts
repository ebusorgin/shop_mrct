/**
 * Чистые юнит-тесты «умного прихода»: переводы размерностей (шт<->г<->мл),
 * распознавание фасовки/единиц и отсев не-товарных строк накладной.
 * Без БД и без GPT — только детерминированная арифметика из expansion.ts / import.ts.
 * Запуск: npm run test:pure (из server/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/http';
import { toBaseCross, convertAcross, type ProdConv } from '../src/services/expansion';
import { classifyNonProduct, normName, pkgFromName, baseLine, type LineRead } from '../src/routes/import';

const U = { g: 1, kg: 2, ml: 3, l: 4, pcs: 5, des: 6 };
const units = new Map<number, { dimension: string; factor: number }>([
  [U.g, { dimension: 'mass', factor: 1 }],
  [U.kg, { dimension: 'mass', factor: 1000 }],
  [U.ml, { dimension: 'volume', factor: 1 }],
  [U.l, { dimension: 'volume', factor: 1000 }],
  [U.pcs, { dimension: 'count', factor: 1 }],
  [U.des, { dimension: 'count', factor: 10 }],
]);

const closeTo = (actual: number, expected: number, msg?: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} ожидаемо ${expected}, получено ${actual}`);
};

// ==================== toBaseCross ====================

test('toBaseCross: перевод внутри размерности по base_factor', () => {
  closeTo(toBaseCross(2, U.kg, U.g, units), 2000);
  closeTo(toBaseCross(1.5, U.l, U.ml, units), 1500);
  closeTo(toBaseCross(3, U.des, U.pcs, units), 30);
  closeTo(toBaseCross(250, U.g, U.g, units), 250);
});

test('toBaseCross: кросс-размерность по коэффициентам товара', () => {
  const eggs: ProdConv = { gPerPcs: 60, mlPerPcs: null, gPerMl: null };
  closeTo(toBaseCross(5, U.pcs, U.g, units, eggs), 300, 'яйца 5 шт -> г');
  const milk: ProdConv = { gPerPcs: null, mlPerPcs: 250, gPerMl: null };
  closeTo(toBaseCross(4, U.pcs, U.ml, units, milk), 1000, 'сок 4 упак -> мл');
  const water: ProdConv = { gPerPcs: null, mlPerPcs: null, gPerMl: 1.05 };
  closeTo(toBaseCross(100, U.g, U.ml, units, water), 100 / 1.05, 'мл из г через плотность');
  closeTo(toBaseCross(100, U.ml, U.g, units, water), 105, 'г из мл через плотность');
  // двутактовый путь: шт -> г -> мл (прямой mlPerPcs нет, есть gPerMl)
  const jam: ProdConv = { gPerPcs: 300, mlPerPcs: null, gPerMl: 1.2 };
  closeTo(toBaseCross(2, U.pcs, U.ml, units, jam), (2 * 300) / 1.2, 'шт -> мл через г');
});

test('toBaseCross: без коэффициента — 400 с подсказкой, что задать', () => {
  assert.throws(
    () => toBaseCross(5, U.pcs, U.g, units, { gPerPcs: null, mlPerPcs: null, gPerMl: null }),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /грамм в 1 штуке/.test(e.message)
  );
  assert.throws(
    () => toBaseCross(5, U.pcs, U.g, units), // conv не передан вовсе — прежнее поведение
    (e: unknown) => e instanceof ApiError && e.status === 400
  );
  assert.throws(
    () => toBaseCross(1, 999, U.g, units),
    (e: unknown) => e instanceof ApiError && e.status === 400 && /Неизвестная единица/.test(e.message)
  );
});

test('convertAcross: невалные коэффициенты (0, отрицательные) игнорируются как отсутствующие', () => {
  assert.throws(
    () => convertAcross('count', 'mass', 5, { gPerPcs: 0, mlPerPcs: null, gPerMl: null }),
    (e: unknown) => e instanceof ApiError && e.status === 400
  );
  closeTo(convertAcross('mass', 'mass', 5, { gPerPcs: null, mlPerPcs: null, gPerMl: null }), 5);
});

// ==================== не-товарные строки ====================

test('classifyNonProduct: скидки, сервисы и итоги не становятся товарами', () => {
  assert.equal(classifyNonProduct('POPUST'), 'discount');
  assert.equal(classifyNonProduct('POUPST: Kupi više, plati manje!'), 'discount');
  assert.equal(classifyNonProduct('Akcija -20%'), 'discount');
  assert.equal(classifyNonProduct('скидка на бакалею'), 'discount');
  assert.equal(classifyNonProduct('Dostava'), 'service');
  assert.equal(classifyNonProduct('Naplata za karticu'), 'service');
  assert.equal(classifyNonProduct('Povrat za karticu'), 'service'); // возврат по карте — не товар
  assert.equal(classifyNonProduct('Заокруживание'), 'service'); // кириллическое написание ловится регуляркой
  assert.equal(classifyNonProduct('Ukupno'), 'total');
  assert.equal(classifyNonProduct('PDV'), 'total');
  assert.equal(classifyNonProduct('Итого к оплате'), 'total');
  assert.equal(classifyNonProduct('Kravlje mleto'), null);
  assert.equal(classifyNonProduct('Картофель резаный'), null);
});

// ==================== нормализация и фасовка в названии ====================

test('normName: регистр, ё/е, пунктуация и сербские диакритики не мешают матчингу', () => {
  assert.equal(normName('  КАРТОФЕЛЬ,  РЕЗАНЫЙ!! '), 'картофель резаный');
  assert.equal(normName('Ёлка'), 'елка');
  assert.equal(normName('Mr.no 1000'), 'mr no 1000');
});

test('pkgFromName: фасовка, написанная внутри названия', () => {
  assert.deepEqual(pkgFromName('лист лавровый 15 грамм'), { code: 'г', per: 15 });
  assert.deepEqual(pkgFromName('jogurt 1%MM PET 1.5kg'), { code: 'г', per: 1500 });
  assert.deepEqual(pkgFromName('сок 1 л'), { code: 'мл', per: 1000 });
  assert.deepEqual(pkgFromName('масло 0,9 л'), { code: 'мл', per: 900 });
  assert.equal(pkgFromName('Мука пшеничная'), null);
});

// ==================== baseLine: строка документа -> базовые единицы ====================

type UnitRow = { id: number; code: string; factor: number; dimension: string };
const unitRows = new Map<string, UnitRow>([
  ['г', { id: U.g, code: 'г', factor: 1, dimension: 'mass' }],
  ['мл', { id: U.ml, code: 'мл', factor: 1, dimension: 'volume' }],
  ['шт', { id: U.pcs, code: 'шт', factor: 1, dimension: 'count' }],
]);

const line = (over: Partial<LineRead>): LineRead => ({
  name: 'position', unitCode: null, qty: null, price: null, lineSum: null,
  countAs: null, packQty: null, packUnit: null, baseUnit: null, doubt: null, ...over,
});

test('baseLine: kg с бумаги -> г на склад, цена делится — деньги строки не меняются', () => {
  const r = baseLine(line({ name: 'Морковь', unitCode: 'kg', qty: 2, price: 100 }), {
    units: unitRows,
    printed: { code: 'г', factor: 1000 },
  });
  closeTo(r.qty!, 2000);
  closeTo(r.price!, 0.1);
  closeTo(r.qty! * r.price!, 200, 'сумма строки сохранена');
  assert.equal(r.unitCode, 'г');
});

test('baseLine: countAs=contents с фасовкой модели — упаковки превращаются в содержимое', () => {
  const r = baseLine(
    line({ name: 'jogurt', unitCode: 'kom', qty: 4, lineSum: 600, countAs: 'contents', packQty: 500, packUnit: 'g' }),
    { units: unitRows }
  );
  closeTo(r.qty!, 2000, '4 упак × 500 г');
  closeTo(r.price!, 0.3, '600 / 2000');
  assert.equal(r.unitCode, 'г');
  assert.equal(r.forecast, true);
  assert.ok(r.notes.some((n) => /на склад/.test(n)));
});

test('baseLine: весовая строка с countAs=contents не удваивается', () => {
  const r = baseLine(
    line({ name: 'Meso', unitCode: 'kg', qty: 5, price: 800, countAs: 'contents', packQty: 1, packUnit: 'kg' }),
    { units: unitRows, printed: { code: 'г', factor: 1000 } }
  );
  closeTo(r.qty!, 5000, 'остается весовым');
  assert.equal(r.forecast, false);
});

test('baseLine: countAs=contents без фасовки — страховка по названию', () => {
  const r = baseLine(
    line({ name: 'лист лавровый 15 грамм', unitCode: 'szt', qty: 10, lineSum: 300, countAs: 'contents' }),
    { units: unitRows }
  );
  closeTo(r.qty!, 150, '10 пакетов × 15 г из названия');
  closeTo(r.price!, 2, '300 / 150');
});

test('baseLine: countAs=contents, а фасовку не назвала и в названии нет — сомнение человеку, числа не трогает', () => {
  const r = baseLine(
    line({ name: 'Jogurt', unitCode: 'kom', qty: 4, lineSum: 600, countAs: 'contents' }),
    { units: unitRows, printed: { code: 'шт', factor: 1 } }
  );
  assert.ok(r.doubt && /размер упаковки/.test(r.doubt), 'должно отдать сомнением, а не выдумывать фасовку');
  closeTo(r.qty!, 4, 'количество осталось как напечатано (упаковки)');
  assert.equal(r.forecast, false);
  assert.ok(r.notes.some((n) => /размер упаковки/.test(n)));
});

test('baseLine: countAs=pieces, но в названии фасовка — подсказка человеку как doubt, числа не меняются', () => {
  const r = baseLine(
    line({ name: 'лаваш 500 грамм', unitCode: 'шт', qty: 3, price: 40, countAs: 'pieces' }),
    { units: unitRows, printed: { code: 'шт', factor: 1 } }
  );
  assert.ok(r.doubt && /фасовка 500 г/.test(r.doubt));
  closeTo(r.qty!, 3, 'штуки как и решила модель');
  assert.ok(r.notes.some((n) => /проверьте/.test(n)));
});

test('baseLine: мультиупаковка счётным содержимым (яйца 180/1, пришли 2 коробки) — перемножается, per>1', () => {
  const r = baseLine(
    line({ name: 'Jaja 180/1', unitCode: 'kom', qty: 2, lineSum: 900, countAs: 'contents', packQty: 180, packUnit: 'kom' }),
    { units: unitRows, printed: { code: 'шт', factor: 1 } }
  );
  closeTo(r.qty!, 360, '2 коробки × 180 шт');
  closeTo(r.price!, 2.5, '900 / 360');
  assert.equal(r.unitCode, 'шт');
  assert.equal(r.forecast, true);
});

test('baseLine: фасовку назвали, единицу — нет — верим baseUnit модели (мл)', () => {
  const r = baseLine(
    line({ name: 'Sock', qty: 3, lineSum: 900, countAs: 'contents', packQty: 1000, baseUnit: 'мл' }),
    { units: unitRows }
  );
  closeTo(r.qty!, 3000, '3 упаковки × 1000 мл');
  closeTo(r.price!, 0.3, '900 / 3000');
  assert.equal(r.unitCode, 'мл');
});

test('baseLine: кросс-размерный приход — заметка «по коэффициенту», если у товара есть пересчёт', () => {
  const r = baseLine(
    line({ name: 'Масло', unitCode: 'g', qty: 930, price: 0.1 }),
    {
      units: unitRows,
      printed: { code: 'г', factor: 1 },
      productUnitCode: 'мл',
      productConv: { gPerPcs: null, mlPerPcs: null, gPerMl: 0.93 },
    }
  );
  assert.ok(r.notes.some((n) => /по коэффициенту/.test(n)), 'приход законен — пересчёт по коэффициенту товара');
  assert.ok(!r.notes.some((n) => /смените единицу/.test(n)));
});

test('baseLine: кросс-размерный приход без коэффициента — предупреждаем «смените единицу товара»', () => {
  const r = baseLine(
    line({ name: 'Масло', unitCode: 'g', qty: 930, price: 0.1 }),
    {
      units: unitRows,
      printed: { code: 'г', factor: 1 },
      productUnitCode: 'мл',
      productConv: { gPerPcs: null, mlPerPcs: null, gPerMl: null },
    }
  );
  assert.ok(r.notes.some((n) => /смените единицу товара/.test(n)), 'иначе ingestWaybill упадёт с 400 — человек должен увидеть заранее');
});
