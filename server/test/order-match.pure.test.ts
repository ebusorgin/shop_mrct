/**
 * Чистые юнит-тесты заказов магазинов и «списания по расписанию»:
 *  • пересчёт печатных единиц листа (кг/порц/шт) в базовые единицы CRM и обратно (себестоимость);
 *  • нормализация названий — по ней строка таблицы ищёт свою техкарту;
 *  • разбор листа Google Таблицы и достройка годов вкладок — то, чем живёт фоновый синк.
 * Без БД и без сети: синхронизатор каждый цикл проходит ровно этот код, но на реальных
 * листах, поэтому макет листа воспроизведён здесь фикстурой.
 * Запуск: npm run test:pure (из server/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBase, printedQty, normalizeName, normalizeNameStrict } from '../src/services/order-match';
import { parseSheet, tabToDate, assignYears, type CellVal } from '../src/services/gsheet';

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

// ==================== разбор листа Google Таблицы (то, что синк делает каждый цикл) ====================

/** Актуальный макет (C): № | Наименование | PLU | EK | VK | Ед-ца | Сумма | Min | 103..110 | 109+. */
const SHEET: CellVal[][] = [
  ['№', 'Наименование', 'PLU', 'EK', 'VK', 'Ед-ца', 'Сумма', 'Min'],
  ['Доставка', 'Наименование', null, null, null, null, null, null, '103', null, '105', null, null, '38106', null, '110', '109+'],
  [null, 'Закуски:'],
  [1, 'Блины (100г)', 'M924', 40, 90, 'порц', 7.6, 2, 2, 1, 0, null, null, 0.5, null, 0.1, 2],
  [2, 'Салат Цезарь', null, 100, 250, 'кг', 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [null, 'ОБЩЕЕ КОЛИЧЕСТВО', null, null, null, null, 7.6, null, 2, 1, 0, 0, 0, 0.5, 0, 0.1, 2],
];
const STORES = [103, 104, 105, 106, 107, 108, 109, 110];

test('parseSheet: колонки магазинов достраиваются по якорям, заказ попадает в свой магазин', () => {
  const p = parseSheet(SHEET, STORES);
  assert.equal(p.layout, 'header', 'колонки определены по строке-заголовку, не позиционно');
  assert.equal(p.rows.length, 1, 'строка с нулями во всех магазинах — не заказ');
  const row = p.rows[0];
  assert.equal(row.name, 'Блины (100г)');
  assert.equal(row.category, 'закуски', 'строка раздела «Закуски:» задаёт категорию');
  assert.equal(row.plu, 'M924');
  assert.equal(row.unit, 'порц');
  closeTo(row.min!, 2, 'минималка берётся из колонки Min, а не из Суммы');
  closeTo(row.sum!, 7.6);
  closeTo(row.ek!, 40);
  closeTo(row.vk!, 90);
  closeTo(row.qty[103], 2);
  assert.ok(!(105 in row.qty), 'ноль в подписанной колонке — это не заказ: parseSheet берёт магазин в qty только при n > 0');
  assert.ok(p.storeCols.some((s) => s.store === 105 && s.col === 10), 'колонка 105 всё равно распознана — просто пустая');
  closeTo(row.qty[104]!, 1, 'колонка 104 без подписи достроена интерполяцией по якорям 103 и 105 — и заказ в ней виден');
  closeTo(row.qty[106], 0.5, 'подпись «38106» = тот же магазин 106');
  closeTo(row.qty[110], 0.1);
  closeTo(row.qty[109], 2, 'колонка «109+» — тот же магазин, а не новый');
  assert.ok(!(108 in row.qty), 'колонки без заказа в qty нет');
});

test('parseSheet: заголовок с двумя якорями — колонка между ними достраивается даже без подписи', () => {
  const two: CellVal[][] = [
    ['№', 'Наименование', 'PLU', 'EK', 'VK', 'Ед-ца', 'Сумма', 'Min'],
    ['Доставка', 'Наименование', null, null, null, null, null, null, '103', null, '105'],
    [1, 'Сок', null, 10, 20, 'л', 4, 1, 1, null, 3],
  ];
  const p = parseSheet(two, [103, 104, 105]);
  assert.equal(p.layout, 'header');
  closeTo(p.rows[0].qty[103], 1);
  closeTo(p.rows[0].qty[105], 3);
  // колонка 104 встала ровно между 103 (колонка 8) и 105 (колонка 10) — но заказа в ней нет,
  // поэтому магазина в qty нет: достройка ищет колонку, а не выдумывает заказ
  assert.ok(!(104 in p.rows[0].qty), 'пустая достроенная колонка не выдумывает заказ');
});

test('parseSheet: «109+» дотачивает тот же магазин, а не перетирает его и не плодит колонку', () => {
  const grid: CellVal[][] = [
    ['№', 'Наименование', 'PLU', 'EK', 'VK', 'Ед-ца', 'Сумма', 'Min'],
    [null, null, null, null, null, null, null, null, '103', '104', '105'],
    [1, 'Соус', null, 10, 20, 'л', 5, 1, 1, 1, 1, null, null, null, 2],
  ];
  const p = parseSheet(grid, [103, 104, 105]);
  // колонка 12 = «109+» не в списке interesting-магазинов => отбрасывается, а 105 остаётся со своим 1
  closeTo(p.rows[0].qty[105], 1);
  assert.ok(!(109 in p.rows[0].qty), 'несуществующий магазин не появляется из «+»-колонки');
});

test('parseSheet: хеш содержимого — кеш-ключ листа, синк не должен перечитывать несменённый лист', () => {
  const a = parseSheet(SHEET, STORES);
  const b = parseSheet(SHEET.map((r) => [...r]), STORES);
  assert.equal(a.hash, b.hash, 'тот же лист = тот же хеш');
  assert.match(a.hash, /^[0-9a-f]{32}$/);
  const changed = SHEET.map((r) => [...r]);
  changed[3][8] = 5; // магазин 103 заказал 5 порций вместо 2
  assert.notEqual(parseSheet(changed, STORES).hash, a.hash, 'правка в листе меняет хеш -> синк применит дифф');
});

test('parseSheet: без подписей магазинов и без контрольной суммы — позиционный разбор', () => {
  const grid: CellVal[][] = [
    ['№', 'Наименование', 'PLU', 'EK', 'VK', 'Ед-ца', 'Сумма', 'Min'],
    [1, 'Хлеб', null, 30, 60, 'шт', 6, 2, 2, 2, 2, 0],
  ];
  const p = parseSheet(grid, [103, 104, 105]);
  assert.equal(p.layout, 'sumcheck', '«Сумма» = 6 равна сумме трёх магазинов — колонки сняты по контрольной сумме');
  closeTo(p.rows[0].qty[103], 2);
  closeTo(p.rows[0].qty[105], 2);
  assert.ok(!(106 in p.rows[0].qty), 'лишняя колонка за списком магазинов отброшена');
});
// ==================== даты вкладок: синк по ним решает, какой лист «горячий» ====================

test('tabToDate: д/м с точкой или запятой, хвостовые пробелы; служебные листы — null', () => {
  assert.deepEqual(tabToDate('28.10'), { dd: 28, mm: 10 });
  assert.deepEqual(tabToDate('21,2'), { dd: 21, mm: 2 });
  assert.deepEqual(tabToDate('17.12   '), { dd: 17, mm: 12 });
  assert.equal(tabToDate('Лист4'), null);
  assert.equal(tabToDate('17+21'), null);
  assert.equal(tabToDate('31.13'), null, 'несуществующий месяц');
  assert.equal(tabToDate('0.11'), null, 'нулевой день');
});

test('assignYears: листы хронологичны, год переносится назад при переходе через новый год', () => {
  // вкладки идут oldest -> newest; самая правая — самая свежая
  const m = assignYears(['21.10', '28.10', '02.11', '04.11'], new Date(2026, 10, 2)); // сегодня 2 ноября 2026
  assert.equal(m.get('02.11'), '2026-11-02');
  assert.equal(m.get('28.10'), '2026-10-28');
  assert.equal(m.get('21.10'), '2026-10-21');
  assert.equal(m.get('04.11'), '2026-11-04', 'лист на неделю вперёд заводят заранее — год тот же');
  // декабрьский лист крайним в январе: не «будущий» по горизонту +70, а прошлого года
  const winter = assignYears(['28.10', '30.12'], new Date(2026, 0, 5));
  assert.equal(winter.get('30.12'), '2025-12-30', 'декабрьский лист в январе — прошлый год');
  assert.equal(winter.get('28.10'), '2025-10-28');
});

test('assignYears: каскад правок года упёрся в окно истории — старый лист не уносится ещё на год', () => {
  // годовая история вкладок (oldest -> newest), самая свежая — 04.03.2026.
  // Спускаемся с каскадом «год назад» до июня 2025: шаг назад вывел бы лист
  // за WINDOW_DAYS (окно начинается ~17.01.2025), и кламп его не даёт —
  // небольшая нестыковка лучше потери года.
  const names = ['05.06', '22.05', '08.05', '24.04', '10.04', '27.03', '13.03', '27.02', '13.02', '30.01', '16.01', '02.01', '19.12', '05.12', '21.11', '07.11', '24.10', '10.10', '26.09', '12.09', '29.08', '15.08', '01.08', '18.07', '04.07', '20.06', '04.03'];
  const m = assignYears(names, new Date(2026, 10, 2));
  assert.equal(m.get('04.03'), '2026-03-04', 'самый правый лист = самый свежий');
  assert.equal(m.get('04.07'), '2025-07-04');
  assert.equal(m.get('08.05'), '2025-05-08');
  assert.equal(m.get('22.05'), '2025-05-22');
  // спуск каскада дошёл до декабря 2025: следующий шаг назад — уже 2024,
  // а это за окном WINDOW_DAYS (окно ~17.01.2025) — кламп держит лист в 2025:
  assert.equal(m.get('19.12'), '2025-12-19', 'не уехал в 2024');
  assert.equal(m.get('05.12'), '2025-12-05');
  assert.equal(m.get('27.03'), '2025-03-27', 'а этот уперся в окно ещё раньше');
});

test('assignYears: служебные вкладки в результат не попадают', () => {
  const m = assignYears(['Лист4', '04.11'], new Date(2026, 10, 2));
  assert.equal(m.size, 1);
  assert.equal(m.get('04.11'), '2026-11-04');
});
