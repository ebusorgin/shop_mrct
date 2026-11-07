/**
 * Чистые юнит-тесты заказов магазинов:
 *  • пересчёт печатных единиц листа (кг/порц/шт) в базовые единицы CRM и обратно (себестоимость);
 *  • нормализация названий — по ней строка таблицы ищёт свою техкарту.
 * Запуск: npm run test:pure (из server/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBase, printedQty, normalizeName, normalizeNameStrict } from '../src/services/order-match';

const closeTo = (actual: number, expected: number, msg?: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} ожидаемо ${expected}, получено ${actual}`);
};

// ==================== toBase: лист -> склад ====================

test('toBase: весовые и объёмные единицы листа пересчитываются в базовые г/мл', () => {
  closeTo(toBase(2, 'кг', 'г'), 2000);
  closeTo(toBase(1.5, 'л', 'мл'), 1500);
  closeTo(toBase(250, 'г', 'г'), 250, 'базовая единица — без пересчёта');
  closeTo(toBase(0.25, 'т', 'г'), 250000);
  // мимолётно: базу не знаем — количество не трогаем, а не крутим наугад
  closeTo(toBase(3, 'кг', 'шт'), 3, 'выход техкарты в штуках');
  closeTo(toBase(4, 'дюймы', 'г'), 4, 'неизвестная печатная единица — 1:1');
});

test('toBase: «порц» — это порции техкарты, они переводятся по весу порции', () => {
  closeTo(toBase(4, 'порц', 'г', 300), 1200, '4 порции по 300 г');
  closeTo(toBase(4, 'порция', 'г', 300), 1200);
  closeTo(toBase(4, 'порции', 'мл', 250), 1000);
  closeTo(toBase(4, 'des', 'г', 60), 240, 'десяток — тоже счётная единица');
  // выхода в г/мл нет или вес порции не задан — считаем штуками, как напечатано
  closeTo(toBase(4, 'порц', 'г', 0), 4, 'вес порции не задан — не выдумываем');
  closeTo(toBase(4, 'шт', 'шт'), 4);
});

test('toBase: счётный источник и счётный выход остаются счётными', () => {
  closeTo(toBase(7, 'шт', 'шт'), 7);
  closeTo(toBase(7, 'порц', 'шт', 300), 7, 'порции техкарты в штуках — то же число');
});

// ==================== printedQty: склад -> лист (для стоимости и выталкивания) ====================

test('printedQty: обратный к toBase перевод, VK в листе задан за печатную единицу', () => {
  // порции: 1200 г базы при порции 300 г = 4 порции
  closeTo(printedQty({ qty: 1200, unitCode: 'порц', cardUnit: 'г', portionQty: 300 }), 4);
  closeTo(printedQty({ qty: 2000, unitCode: 'кг', cardUnit: 'г', portionQty: 0 }), 2);
  closeTo(printedQty({ qty: 1500, unitCode: 'л', cardUnit: 'мл', portionQty: 0 }), 1.5);
  closeTo(printedQty({ qty: 250, unitCode: 'г', cardUnit: 'г', portionQty: 0 }), 250);
  closeTo(printedQty({ qty: 30, unitCode: 'des', cardUnit: 'шт', portionQty: 0 }), 30, 'штуки остаются штуками');
  closeTo(printedQty({ qty: 7, unitCode: 'шт', cardUnit: null, portionQty: 0 }), 7);
});

test('printedQty: порции без веса порции не делим наугад, единицу берём из карточки, иначе из строки', () => {
  closeTo(printedQty({ qty: 4, unitCode: 'порц', cardUnit: 'г', portionQty: 0 }), 4, 'на что делить — неизвестно');
  closeTo(printedQty({ qty: 2000, unitCode: null, cardUnit: 'г', portionQty: 0 }), 2000, 'базовая единица карточки');
  closeTo(printedQty({ qty: 2000, unitCode: 'кг', cardUnit: null, portionQty: 0 }), 2, 'печатная единица строки');
});

test('сквозной круг: toBase и printedQty взаимно обратны на всех единицах листа', () => {
  const cases: [number, string, string, number][] = [
    [2, 'кг', 'г', 0],
    [1.5, 'л', 'мл', 0],
    [4, 'порц', 'г', 300],
    [7, 'шт', 'шт', 0],
    [250, 'г', 'г', 0],
  ];
  for (const [printed, unit, base, portion] of cases) {
    const back = printedQty({ qty: toBase(printed, unit, base, portion), unitCode: unit, cardUnit: base, portionQty: portion });
    closeTo(back, printed, `${printed} ${unit} -> ${base} -> обратно`);
  }
});

// ==================== нормализация названий (матчинг строки листа с каталогом) ====================

test('normalizeName: регистр, ё/е, пунктуация и диакритика не мешают, фасовка вырезается', () => {
  assert.equal(normalizeName('  БЛИНЫ (100г)!! '), 'блины');
  assert.equal(normalizeName('Блины 100 g'), 'блины');
  assert.equal(normalizeName('Спаржа по-корейски 250g'), 'спаржа по корейски');
  assert.equal(normalizeName('Борщ с говядиной.'), 'борщ с говядиной');
  assert.equal(normalizeName('Mr.no 1000'), 'mr no 1000');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName('!!аннотация!!'), '', 'аннотация без названия — пусто');
});

test('normalizeNameStrict: фасовка остаётся — иначе «Спаржа» и «Спаржа 250g» схлопнулись бы в одну карту', () => {
  assert.equal(normalizeNameStrict('Спаржа по-корейски 250g'), 'спаржа по корейски 250g');
  assert.notEqual(normalizeNameStrict('Спаржа 250g'), normalizeNameStrict('Спаржа'));
  assert.equal(normalizeName('Спаржа 250g'), normalizeName('Спаржа'), 'а терпимая норма их всё же сравнивает');
});
