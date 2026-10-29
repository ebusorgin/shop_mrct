/**
 * Проверка чистой логики раздела «Полуфабрикаты» (client/src/app/core/semi-calc.ts).
 *
 * Запуск:  npx tsx verify/semis-verify.ts        (из каталога server/)
 *
 * Проверяется:
 *  1) формулы раскрытия состава — зеркалом серверной resolveSemi (expansion.ts), включая
 *    расчёт выхода после обработки по массе, когда выход заготовки в штуках (applyYield);
 *  2) шкала добавок ×1000 и её обратимость (загрузка → сохранение = те же числа в БД);
 *  3) пересчёт размерностей и предупреждения о недостающих коэффициентах;
 *  4) вложенные полуфабрикаты, группировка/слияние сырья, защита от циклов;
 *  5) поиск/сортировка/фильтры каталога и клиентская валидация;
 *  6) предупреждения как ссылки на поле (быстрая правка коэффициента из блока E).
 *
 * Фреймворка юнит-тестов в репозитории нет — отсюда self-contained скрипт с кодом выхода.
 */
import assert from 'node:assert/strict';
import {
  Product,
  Semi,
  SemiInput,
  Unit,
} from '../../client/src/app/core/models';
import { toBaseClient, Conv, NO_CONV } from '../../client/src/app/core/units';
import {
  CONV_FIELD_LABEL,
  ExpWarn,
  SemiCtx,
  SemiDraft,
  batchPresets,
  convValueOf,
  dedupeWarnings,
  dependsOn,
  draftWarnings,
  edgesOfDraft,
  edgesOfSemi,
  expandComposition,
  fixableWarn,
  incompleteOf,
  norm,
  outDenom,
  pickableAsInput,
  productConvBody,
  semiBodyOf,
  semiMatches,
  sortSemis,
  toInputQty,
  trimNum,
  usedBySemis,
  validateDraft,
  warnKey,
  warnText,
} from '../../client/src/app/core/semi-calc';

/* ------------------------------- каркас проверок ------------------------------- */

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`  FAIL ${name}\n       ${msg.split('\n').join('\n       ')}`);
  }
}

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const near = (name: string, a: number, b: number, eps = 1e-9) =>
  check(name, () => assert.ok(approx(a, b, eps), `ожидалось ${b}, получили ${a} (±${eps})`));

/** Предупреждения — объекты (кликабельные), для текстовых проверок сводим в строку. */
const wtext = (list: ExpWarn[]): string => list.map(warnText).join(' | ');

/* ---------------------------------- справочники --------------------------------- */

const UNITS: Unit[] = [
  { id: 1, code: 'г', name: 'граммы', dimension: 'mass', baseFactor: 1 },
  { id: 2, code: 'мл', name: 'миллилитры', dimension: 'volume', baseFactor: 1 },
  { id: 3, code: 'шт', name: 'штуки', dimension: 'count', baseFactor: 1 },
  { id: 4, code: 'кг', name: 'килограммы', dimension: 'mass', baseFactor: 1000 },
];

/** Базовая единица массы — откуда оракул переводит граммы входа при выходе по массе. */
const MASS_UNIT = UNITS.find((u) => u.dimension === 'mass')!.id;

const prod = (
  id: number,
  name: string,
  unitId: number,
  unitCode: string,
  conv: Partial<Conv> = {}
): Product => ({
  id,
  name,
  category: 'Овощи',
  unitId,
  unitCode,
  dimension: unitCode,
  baseFactor: 1,
  minStock: 0,
  active: true,
  shelfLifeDays: null,
  gPerPcs: conv.gPerPcs ?? null,
  mlPerPcs: conv.mlPerPcs ?? null,
  gPerMl: conv.gPerMl ?? null,
  stockQty: 0,
  avgCost: 0,
});

const inp = (
  sourceType: 'raw' | 'semi',
  refId: number,
  role: 'base' | 'additive',
  yieldPct: number | null,
  qtyPerOutput: number | null,
  name: string
): SemiInput => ({ sourceType, refId, role, yieldPct, qtyPerOutput, name });

const semi = (
  id: number,
  name: string,
  unitId: number,
  unitCode: string,
  inputs: SemiInput[],
  conv: Partial<Conv> = {},
  note = ''
): Semi => ({
  id,
  name,
  note,
  unitId,
  unitCode,
  shelfLifeDays: null,
  gPerPcs: conv.gPerPcs ?? null,
  mlPerPcs: conv.mlPerPcs ?? null,
  gPerMl: conv.gPerMl ?? null,
  inputs,
});

const PRODUCTS: Product[] = [
  prod(101, 'Картофель', 1, 'г'),
  prod(102, 'Масло растительное', 2, 'мл'),
  prod(103, 'Соль', 1, 'г'),
  prod(104, 'Луковица', 1, 'г'),
  prod(105, 'Яйцо', 3, 'шт'), // без коэффициентов: г → шт непреложим
  prod(106, 'Фарш', 1, 'г', { gPerPcs: 50 }),
  prod(107, 'Молоко', 2, 'мл', { gPerMl: 1.03 }),
  prod(109, 'Сироп (в г)', 1, 'г', { gPerMl: 1.25 }),
];

/* 10 — варёный картофель: 1000 г выхода ← 1111.111 г сырья (выход 90) */
const S_BOILED = semi(10, 'Картофель варёный', 1, 'г', [inp('raw', 101, 'base', 90, null, 'Картофель')]);

/* 11 — жареный из варёного + масло 50 на 1 кг выхода + выход ядра 70 */
const S_FRIED = semi(11, 'Картофель жареный', 1, 'г', [
  inp('semi', 10, 'base', 70, null, 'Картофель варёный'),
  inp('raw', 102, 'additive', null, 0.05, 'Масло растительное'),
  inp('raw', 103, 'additive', null, 0.008, 'Соль'),
]);

/* 12 — котлета в штуках (1 шт = 44 г выхода, после жарки меньше 50 г фарша — выход 88 %),
   фарш в граммах: шт → г по «грамм в 1 шт» входа (50) */
const S_CUTLET = semi(
  12,
  'Котлета',
  3,
  'шт',
  [
    inp('raw', 106, 'base', 88, null, 'Фарш'),
    inp('raw', 105, 'additive', null, 0.002, 'Яйцо'), // доля на 1 шт выхода = 2 шт на 1000 шт
  ],
  { gPerPcs: 44 }
);

/* 13 — соуса-подобный: выход в мл, сырьё в мл (одна размерность) */
const S_SAUCE = semi(13, 'Молочный соус', 2, 'мл', [inp('raw', 107, 'base', 95, null, 'Молоко')]);

/* 48 — выход в мл, сырьё в г: пересчёт только по плотности (1 мл = 1.25 г) */
const S_SYRUP = semi(48, 'Сиропный соус', 2, 'мл', [inp('raw', 109, 'base', 80, null, 'Сироп (в г)')]);

/* 20/21 — цикл A ⇄ B */
const S_A = semi(20, 'Цикл A', 1, 'г', [inp('semi', 21, 'base', 100, null, 'Цикл B')]);
const S_B = semi(21, 'Цикл B', 1, 'г', [inp('semi', 20, 'base', 100, null, 'Цикл A')]);

/* 30 — «неполная»: нет базового входа */
const S_BROKEN = semi(30, 'Заготовка без ядра', 1, 'г', [inp('raw', 103, 'additive', null, 0.01, 'Соль')]);

const SEMIS: Semi[] = [S_BOILED, S_FRIED, S_CUTLET, S_SAUCE, S_SYRUP, S_A, S_B, S_BROKEN];
const CTX: SemiCtx = { units: UNITS, products: PRODUCTS, semis: SEMIS };

/* --------------------- независимый «оракул» серверной формулы --------------------- */

/**
 * Прямая транскрипция resolveSemi (server/src/services/expansion.ts:225-259) на фикстурах:
 *   base:     q = out ÷ (yield/100)
 *   additive: q = out × qpo(БД-шкала, доля на 1 баз. ед. выхода), ÷ (yield/100) если yield задан
 * затем рубеж 2 — toBaseCross(unit выхода заготовки → каноничная единица входа).
 * Нужно именно для сравнения с expandComposition: проверяем структуру формул, а не единицы пересчёта.
 */
function oracle(
  semiId: number,
  outQty: number,
  semiUnitId: number,
  acc: Map<number, number>,
  path: Set<number>,
  convOf: (s: SemiInput) => Conv,
  unitOf: (s: SemiInput) => number,
  convOfSelf: () => Conv
): void {
  const s = SEMIS.find((x) => x.id === semiId)!;
  const base = s.inputs.find((x) => x.role === 'base');
  assert.ok(base, 'нет базового входа');
  const feed = (i: SemiInput, qOutDim: number, inGrams = false) => {
    // как клиент: если пути пересчёта размерностей нет, число остаётся в размерности
    // выхода и помечается предупреждением (сервер в этом месте бросает 400, но состав
    // с настроенными коэффициентами обязан давать те же числа)
    const fromUnit = inGrams ? MASS_UNIT : semiUnitId;
    const q = toBaseClient(UNITS, qOutDim, fromUnit, unitOf(i), convOf(i)) ?? qOutDim;
    if (i.sourceType === 'raw') {
      acc.set(i.refId, (acc.get(i.refId) ?? 0) + q);
      return;
    }
    assert.ok(!path.has(i.refId), 'цикл');
    oracle(i.refId, q, unitOf(i), acc, new Set([...path, i.refId]), convOf, unitOf, () => convOf(i));
  };
  // выход после обработки — отношение масс: при выходе в штуках делим массу (зеркало серверного applyYield).
  // inGrams=true → число в граммах входа, переводится из размерности mass (обратного /gPerPcs нет).
  const yieldApply = (qty: number, pct: number): { qty: number; inGrams: boolean } => {
    const y = pct / 100;
    const g = convOfSelf().gPerPcs;
    if (unitDim(semiUnitId) === 'count' && g != null && g > 0 && y > 0 && y < 1)
      return { qty: (qty * g) / y, inGrams: true };
    return { qty: qty / y, inGrams: false };
  };
  const baseYield = yieldApply(outQty, Number(base.yieldPct));
  feed(base, baseYield.qty, baseYield.inGrams);
  for (const a of s.inputs.filter((x) => x.role === 'additive')) {
    const q = outQty * Number(a.qtyPerOutput ?? 0);
    const own = Number(a.yieldPct);
    const ay = own > 0 && own < 100 ? yieldApply(q, own) : { qty: q, inGrams: false };
    feed(a, ay.qty, ay.inGrams);
  }
}

/** Сколько граммов сырья даёт сервер на указанный выход (для сверки с клиентом). */
function oracleRaw(semiId: number, outQty: number): Map<number, number> {
  const acc = new Map<number, number>();
  const convOf = (i: SemiInput): Conv => {
    if (i.sourceType === 'raw') {
      const p = PRODUCTS.find((x) => x.id === i.refId)!;
      return { gPerPcs: p.gPerPcs, mlPerPcs: p.mlPerPcs, gPerMl: p.gPerMl };
    }
    const s = SEMIS.find((x) => x.id === i.refId)!;
    return { gPerPcs: s.gPerPcs, mlPerPcs: s.mlPerPcs, gPerMl: s.gPerMl };
  };
  const unitOf = (i: SemiInput): number =>
    i.sourceType === 'raw' ? PRODUCTS.find((x) => x.id === i.refId)!.unitId : SEMIS.find((x) => x.id === i.refId)!.unitId;
  const s = SEMIS.find((x) => x.id === semiId)!;
  const convOfSelf = (): Conv => ({ gPerPcs: s.gPerPcs, mlPerPcs: s.mlPerPcs, gPerMl: s.gPerMl });
  oracle(semiId, outQty, s.unitId, acc, new Set([semiId]), convOf, unitOf, convOfSelf);
  return acc;
}

/** Размерность базовой единицы выхода заготовки. */
function unitDim(unitId: number): string {
  return UNITS.find((u) => u.id === unitId)!.dimension;
}

/**
 * Раскрытие СОХРАНЁННОЙ заготовки с её собственными коэффициентами: сервер всегда знает
 * «грамм в 1 шт» заготовки, редактор передаёт их из черновика. Без этого выход после обработки в штуках
 * не перейдёт в массу и тестировалась бы старая арифметика.
 */
function expOf(s: Semi, out: number, ctx: SemiCtx = CTX) {
  return expandComposition(
    ctx,
    edgesOfSemi(s),
    out,
    s.unitId,
    new Set([s.id]),
    [],
    0,
    { gPerPcs: s.gPerPcs, mlPerPcs: s.mlPerPcs, gPerMl: s.gPerMl },
    { sourceType: 'semi', refId: s.id, name: s.name }
  );
}

/* -------------------------------- 1. простые формулы -------------------------------- */

console.log('\n1. Формулы: базовый вход и выход после обработки');

check('один продукт, выход 90 → вход = выход ÷ 0.9', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_BOILED), 1000, 1);
  near('картофель', e.raw[0].qty, 1000 / 0.9);
  assert.equal(e.raw.length, 1);
  assert.equal(e.nodes[0].name, 'Картофель');
});

check('выход ≠ сумме входов (масса меняется при варке)', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_BOILED), 900, 1);
  near('вход', e.nodes[0].qty, 1000);
});

check('выход 100% → вход = выход', () => {
  const clean = semi(40, 'Без потерь', 1, 'г', [inp('raw', 101, 'base', 100, null, 'Картофель')]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, clean] };
  const e = expandComposition(ctx2, edgesOfSemi(clean), 250, 1);
  near('вход', e.nodes[0].qty, 250);
});

check('база расчёта подписана человекомочитаемо', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_BOILED), 1000, 1);
  assert.match(e.nodes[0].basis, /весь выход 1000 г ÷ выход после обработки 90%/);
});

/* -------------------------------- 2. добавки -------------------------------- */

console.log('\n2. Добавки: шкала ×1000 и свой выход');

check('добавка 0.05 в БД = 50 на 1 кг выхода → 50 мл на 1 кг', () => {
  const edges = edgesOfSemi(S_FRIED);
  const oil = edges.find((x) => x.refId === 102)!;
  near('UI-шкала', oil.qtyPerOutput!, 50);
  const e = expandComposition(CTX, edges, 1000, 1);
  near('масло', e.nodes.find((n) => n.refId === 102)!.qty, 50);
  near('соль', e.nodes.find((n) => n.refId === 103)!.qty, 8);
});

check('свой выход добавки делит расход', () => {
  const s = semi(41, 'С пасечным выходом', 1, 'г', [
    inp('raw', 101, 'base', 100, null, 'Картофель'),
    inp('raw', 104, 'additive', 80, 0.1, 'Луковица'), // 100 г на 1 кг выхода
  ]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, s] };
  const e = expandComposition(ctx2, edgesOfSemi(s), 1000, 1);
  near('лук', e.nodes.find((n) => n.refId === 104)!.qty, 100 / 0.8);
});

check('round-trip ×1000: загрузка → черновик → payload = исходные числа БД', () => {
  for (const s of [S_FRIED, S_CUTLET, S_SAUCE]) {
    for (const edge of edgesOfSemi(s).filter((x) => x.role === 'additive')) {
      const backToDb = (edge.qtyPerOutput ?? 0) / 1000; // как в save()
      const src = s.inputs.find((i) => i.refId === edge.refId && i.role === 'additive')!;
      near(`qpo ${s.name} → ${edge.refId}`, backToDb, Number(src.qtyPerOutput));
    }
  }
});

check('старая запись читается без изменения смысла (qpo 0.008 → 8 на 1 кг)', () => {
  const e = edgesOfSemi(S_FRIED).find((x) => x.refId === 103)!;
  near('UI', e.qtyPerOutput!, 8);
  assert.equal(outDenom(CTX, 1), '1 кг');
});

/* ------------------------------ 3. вложенные полуфабрикаты ------------------------------ */

console.log('\n3. Вложенные полуфабрикаты: раскрытие до сырья');

check('жареный ← варёный ← картофель: 1000 г жареного = 1587.301587 г картофеля', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_FRIED), 1000, 1);
  const potato = e.raw.find((r) => r.productId === 101)!;
  near('картофель', potato.qty, 1000 / 0.7 / 0.9);
  assert.deepEqual(potato.via, ['Картофель варёный']);
  near('дерево: варёный на глубину 0', e.nodes[0].qty, 1000 / 0.7);
  near('дерево: картофель внутри варёного', e.nodes[0].children[0].qty, 1000 / 0.7 / 0.9);
});

check('сырьё из разных веток сливается в одну строку', () => {
  // жареный (даёт картофель) + ещё одна порция варёного напрямую как добавка
  const s = semi(42, 'Микс', 1, 'г', [
    inp('semi', 11, 'base', 100, null, 'Картофель жареный'),
    inp('semi', 10, 'additive', null, 0.5, 'Картофель варёный'), // 500 г на 1 кг выхода
  ]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, s] };
  const e = expandComposition(ctx2, edgesOfSemi(s), 1000, 1);
  const potato = e.raw.filter((r) => r.productId === 101);
  assert.equal(potato.length, 1, 'одна строка на продукт');
  near('картофель', potato[0].qty, 1000 / 0.7 / 0.9 + 500 / 0.9);
  assert.equal(potato[0].via.length, 2);
});

check('группировка: oil и salt остаются отдельными строками сырья', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_FRIED), 10000, 1);
  assert.deepEqual(e.raw.map((r) => r.productId).sort((a, b) => a - b), [101, 102, 103]);
});

/* ------------------------------- 4. сверка со «сервером» ------------------------------- */

console.log('\n4. Сверка с независимой транскрипцией resolveSemi');

for (const [semiId, out] of [
  [10, 1000],
  [10, 1],
  [11, 1000],
  [11, 12345],
  [12, 100],
  [13, 500],
  [48, 1000],
] as const) {
  check(`raw-потребность semi#${semiId} @ ${out} совпадает с оракулом`, () => {
    const s = SEMIS.find((x) => x.id === semiId)!;
    const e = expOf(s, out);
    const mine = new Map(e.raw.map((r) => [r.productId, r.qty]));
    const oracleMap = oracleRaw(semiId, out);
    assert.deepEqual([...mine.keys()].sort(), [...oracleMap.keys()].sort(), 'набор продуктов');
    for (const [pid, q] of oracleMap) near(`продукт ${pid}`, mine.get(pid)!, q, 1e-9);
  });
}

/* ------------------------------- 5. пересчёт размерностей ------------------------------- */

console.log('\n5. Размерности: переводы и предупреждения');

check('шт → г по «грамм в 1 шт» входа: 100 котлет, выход считается по массе', () => {
  const e = expOf(S_CUTLET, 100);
  const farsh = e.nodes.find((r) => r.refId === 106)!;
  // котлета 44 г, выход 88 % → масса входа 100×44÷0.88 = 5000 г = 100 шт фарша по 50 г
  near('нужно фарша, г', farsh.qty, 5000);
  assert.equal(farsh.unitCode, 'г');
  assert.equal(farsh.warns.length, 0);
  const egg = e.nodes.find((r) => r.refId === 105)!;
  near('яйцо: 2 шт на 1000 шт выхода', egg.qty, 0.2);
});

check('выход после обработки в штуках считается по массе: 6000 г сырья на 5400 г очищенных', () => {
  // «яйцо чищенное»: выход шт (1 шт = 54 г), вход — сырое яйцо шт (60 г), потери 10 % по массе
  const peeled = semi(
    50,
    'Яйцо чищенное',
    3,
    'шт',
    [inp('raw', 111, 'base', 90, null, 'Яйцо сырое')],
    { gPerPcs: 54 }
  );
  const ctx2: SemiCtx = {
    ...CTX,
    products: [...CTX.products, prod(111, 'Яйцо сырое', 3, 'шт', { gPerPcs: 60 })],
    semis: [...CTX.semis, peeled],
  };
  const e = expOf(peeled, 100, ctx2);
  // 100 очищенных = 5400 г; с потерями 10 % по массе нужно 6000 г сырья = ровно 100 сырых
  // яиц (по 60 г). Штуки не делились: 100 ÷ 0.9 = 111.11 — это и был абсурд, теперь его нет.
  near('яиц нужно, шт', e.nodes[0].qty, 100);
  near('масса входа, г', e.nodes[0].qty * 60, 5400 / 0.9);
  assert.match(e.nodes[0].basis, /потери по массе/);
  assert.equal(e.warnings.length, 0, 'выход согласован с весом — предупреждать не о чем');
});

check('выход после обработки спорит с «грамм в 1 шт»: вход и выход весят одинаково при 90 %', () => {
  // тот же состав, но заготовка весит столько же, сколько сырьё: потери уже «в кармане»
  const same = semi(52, 'Яйцо чищенное (54→54)', 3, 'шт', [inp('raw', 111, 'base', 90, null, 'Яйцо сырое')], { gPerPcs: 54 });
  const ctx2: SemiCtx = {
    ...CTX,
    products: [...CTX.products, prod(111, 'Яйцо сырое', 3, 'шт', { gPerPcs: 54 })],
    semis: [...CTX.semis, same],
  };
  const e = expOf(same, 100, ctx2);
  assert.ok(e.warnings.some((w) => w.kind === 'yieldMass'), 'расхождение заметно человеку');
});

check('без «грамм в 1 шт» заготовки деление штук помечается, а не подаётся молча', () => {
  const noMass = semi(51, 'Яйцо чищенное без массы', 3, 'шт', [inp('raw', 111, 'base', 90, null, 'Яйцо сырое')]);
  const ctx2: SemiCtx = {
    ...CTX,
    products: [...CTX.products, prod(111, 'Яйцо сырое', 3, 'шт', { gPerPcs: 60 })],
    semis: [...CTX.semis, noMass],
  };
  const e = expOf(noMass, 100, ctx2);
  near('старая арифметика осталась', e.nodes[0].qty, 100 / 0.9);
  assert.ok(e.warnings.some((w) => w.kind === 'yieldPcs'), 'есть предупреждение про выход в штуках');
});

check('одноимённая размерность не требует коэффициента (шт → шт)', () => {
  const noConv = semi(46, 'Без коэффициента', 3, 'шт', [inp('raw', 105, 'base', 100, null, 'Яйцо')]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, noConv] };
  const e = expandComposition(ctx2, edgesOfSemi(noConv), 10, 3);
  assert.equal(e.nodes[0].warns.length, 0, 'шт → шт — одна размерность, пересчёт не нужен');
  near('яйцо', e.raw[0].qty, 10);
});

check('нет коэффициента г → шт: предупреждение называет нужный коэффициент', () => {
  const egg = PRODUCTS.find((p) => p.id === 105)!;
  const ref = { name: egg.name, unitId: egg.unitId, unitCode: egg.unitCode, conv: NO_CONV };
  const r = toInputQty(CTX, 100, 1, ref);
  assert.ok(r.warn, 'должно быть предупреждение');
  assert.match(r.warn!.text, /нельзя перевести «г» в «шт»/);
  assert.match(r.warn!.text, /«грамм в 1 шт»/);
  assert.equal(r.warn!.field, 'gPerPcs', 'указано поле правки');
  near('число остаётся в размерности выхода', r.qty, 100);
});

check('одна размерность — плотность не применяется (мл → мл)', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_SAUCE), 1000, 2);
  const milk = e.raw.find((r) => r.productId === 107)!;
  near('молоко, мл', milk.qty, 1000 / 0.95);
  assert.equal(milk.unitCode, 'мл');
  assert.equal(e.warnings.length, 0);
});

check('1 мл ≠ 1 г: мл → г только по плотности входа (1.25 г/мл)', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_SYRUP), 1000, 2);
  const syr = e.raw.find((r) => r.productId === 109)!;
  near('сироп, г', syr.qty, (1000 / 0.8) * 1.25);
  assert.equal(syr.unitCode, 'г');
});

check('одна размерность, не базовая единица: кг входа из г выхода', () => {
  const kg = prod(108, 'Сахар', 4, 'кг');
  const s = semi(43, 'Сироп', 1, 'г', [inp('raw', 108, 'additive', null, 0.002, 'Сахар')]);
  const ctx2: SemiCtx = { ...CTX, products: [...CTX.products, kg], semis: [...CTX.semis, s] };
  const e = expandComposition(ctx2, edgesOfSemi(s), 1000, 1);
  const sugar = e.nodes.find((n) => n.refId === 108)!;
  // 1000 г выхода × 2/1000 = 2 г → в кг входа = 0.002 кг
  near('сахар в кг', sugar.qty, 0.002);
  assert.equal(sugar.unitCode, 'кг');
});

check('дерево предупреждений поднимается в общий список', () => {
  const s = semi(44, 'Без ядра внутри', 1, 'г', [inp('semi', 30, 'base', 100, null, 'Заготовка без ядра')]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, s] };
  const e = expandComposition(ctx2, edgesOfSemi(s), 1000, 1);
  assert.match(wtext(e.warnings), /нет базового входа/);
});

/* ------------------------------------ 6. циклы ------------------------------------ */

console.log('\n6. Циклы');

check('pickableAsInput: нельзя взять заготовку, которая содержит эту', () => {
  assert.equal(pickableAsInput(CTX, 21, 20), false, 'B ← A');
  assert.equal(pickableAsInput(CTX, 20, 21), false, 'A ← B');
  assert.equal(pickableAsInput(CTX, 11, 10), true, 'жареный ← варёный разрешён');
  assert.equal(pickableAsInput(CTX, 10, 10), false, 'сама на себя');
});

check('dependsOn находит косвенную зависимость', () => {
  assert.equal(dependsOn(CTX, 11, 10), true);
  assert.equal(dependsOn(CTX, 10, 11), false);
});

check('раскрытие не зацикливается: ветка помечена, сырьё не считается', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_A), 1000, 1, new Set([20]));
  assert.equal(e.nodes.length, 1);
  const nested = e.nodes[0].children[0];
  assert.match(nested.warns.join(' '), /цикл/);
  assert.match(wtext(e.warnings), /цикл/);
  assert.equal(e.raw.length, 0);
});

check('само-ссылка заготовки на себя помечается сразу', () => {
  const loop = semi(47, 'Сам на себя', 1, 'г', [inp('semi', 47, 'base', 100, null, 'Сам на себя')]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, loop] };
  const e = expandComposition(ctx2, edgesOfSemi(loop), 1000, 1, new Set([47]));
  assert.match(e.nodes[0].warns.join(' '), /цикл/);
});

check('валидация черновика ловит цикл до отправки', () => {
  const d: SemiDraft = {
    id: 20,
    name: 'Цикл A',
    note: '',
    unitId: 1,
    shelfLifeDays: null,
    gPerPcs: null,
    mlPerPcs: null,
    gPerMl: null,
    base: { sourceType: 'semi', refId: 21, yieldPct: 100 },
    additives: [],
  };
  assert.ok(validateDraft(CTX, d).some((i) => /Цикл/.test(i.message)));
});

/* ------------------------------- 7. валидация черновика ------------------------------- */

console.log('\n7. Валидация (зеркало серверных правил)');

const draft = (over: Partial<SemiDraft> = {}): SemiDraft => ({
  id: null,
  name: 'Тест',
  note: '',
  unitId: 1,
  shelfLifeDays: null,
  gPerPcs: null,
  mlPerPcs: null,
  gPerMl: null,
  base: { sourceType: 'raw', refId: 101, yieldPct: 90 },
  additives: [],
  ...over,
});

check('корректный черновик не даёт ошибок (описание необязательно)', () => {
  assert.deepEqual(validateDraft(CTX, draft()), []);
});

check('пустое имя / нет продукта / выход вне (0,100]', () => {
  assert.equal(validateDraft(CTX, draft({ name: '  ' }))[0].field, 'name');
  assert.equal(validateDraft(CTX, draft({ base: { sourceType: 'raw', refId: null, yieldPct: 90 } }))[0].field, 'base');
  assert.equal(validateDraft(CTX, draft({ base: { sourceType: 'raw', refId: 101, yieldPct: 0 } }))[0].field, 'baseYield');
  assert.equal(validateDraft(CTX, draft({ base: { sourceType: 'raw', refId: 101, yieldPct: 120 } }))[0].field, 'baseYield');
});

check('хранение только в базовых единицах (кг запрещён)', () => {
  assert.equal(validateDraft(CTX, draft({ unitId: 4 }))[0].field, 'unitId');
});

check('добавка: расход > 0, свой выход в (0,100] или пусто, дубликаты', () => {
  const a = (over: object = {}) => ({ sourceType: 'raw', refId: 103, qtyPerOutput: 8, yieldPct: null, ...over });
  assert.equal(validateDraft(CTX, draft({ additives: [a({ qtyPerOutput: 0 })] as never }))[0].field, 'add0:qty');
  assert.equal(validateDraft(CTX, draft({ additives: [a({ yieldPct: 150 })] as never }))[0].field, 'add0:yield');
  assert.deepEqual(validateDraft(CTX, draft({ additives: [a({ yieldPct: null })] as never })), []);
  assert.equal(validateDraft(CTX, draft({ additives: [a(), a()] as never }))[0].field, 'add1:dup');
  // дубликат основного продукта
  assert.equal(validateDraft(CTX, draft({ additives: [a({ refId: 101 })] as never }))[0].field, 'add0:dup');
});

check('несовместимые размерности — предупреждение, а не блокировка сохранения', () => {
  const d = draft({
    unitId: 1,
    additives: [{ sourceType: 'raw', refId: 105, qtyPerOutput: 1, yieldPct: null }],
  });
  assert.deepEqual(validateDraft(CTX, d), [], 'ошибок нет');
  assert.ok(draftWarnings(CTX, d).length > 0, 'предупреждение есть');
});

/* ------------------------------ 8. каталог: поиск / сортировка ------------------------------ */

console.log('\n8. Каталог');

check('поиск по названию и по компонентам, регистр/ё-е не важны', () => {
  assert.ok(semiMatches(S_BOILED, 'КАРТОФЕЛ'));
  assert.ok(semiMatches(S_BOILED, 'картофель вареный') || semiMatches(S_BOILED, 'Картофель варёный'));
  assert.ok(semiMatches(S_FRIED, 'масло'), 'по компоненту состава');
  assert.equal(semiMatches(S_BOILED, 'соус'), false);
  assert.equal(norm('  Ёлкин   '), 'елкин');
});

check('сортировки: имя, обратное, по числу компонентов, сперва неполные', () => {
  const list = [S_FRIED, S_BOILED, S_A];
  assert.deepEqual(sortSemis(list, 'name').map((s) => s.id), [10, 11, 20]);
  assert.deepEqual(sortSemis(list, 'name-desc').map((s) => s.id), [20, 11, 10]);
  assert.deepEqual(sortSemis(list, 'components').map((s) => s.id), [11, 10, 20]);
  assert.equal(sortSemis([S_BOILED, S_BROKEN], 'incomplete')[0].id, 30);
});

check('фильтр «неполные» объясняет, чего не хватает', () => {
  assert.equal(incompleteOf(S_BOILED), null);
  assert.equal(incompleteOf(S_BROKEN), 'нет базового входа');
});

check('обратные ссылки: кто использует заготовку', () => {
  assert.deepEqual(usedBySemis(CTX, 10).map((s) => s.id), [11]);
});

/* --------------------------------- 9. партия и пресеты --------------------------------- */

check('расчёт пересчитывается пропорционально партии (1/10/100 кг)', () => {
  const at = (q: number) => expandComposition(CTX, edgesOfSemi(S_FRIED), q, 1).raw.find((r) => r.productId === 101)!.qty;
  near('1 кг', at(1000), 1000 / 0.7 / 0.9);
  near('10 кг', at(10000), (1000 / 0.7 / 0.9) * 10);
  near('100 кг', at(100000), (1000 / 0.7 / 0.9) * 100);
});

check('пресеты партии зависят от размерности единицы выхода', () => {
  assert.deepEqual(batchPresets(CTX, 1).map((p) => p.qty), [1000, 10000, 100000]);
  assert.deepEqual(batchPresets(CTX, 3).map((p) => p.label), ['10 шт', '100 шт', '1000 шт']);
  assert.equal(outDenom(CTX, 2), '1 л');
});

check('нулевая/отрицательная партия не считается', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_BOILED), 0, 1);
  assert.equal(e.ready, false);
});

check('edgesOfDraft игнорирует незаполненные строки добавок', () => {
  const d = draft({ additives: [{ sourceType: 'raw', refId: null, qtyPerOutput: 5, yieldPct: null }] });
  assert.equal(edgesOfDraft(d).length, 1, 'только базовый вход');
});

check('выход после обработки не задан: вместо Infinity — узел с причиной', () => {
  const s = semi(49, 'Без выхода', 1, 'г', [{ sourceType: 'raw', refId: 101, role: 'base', yieldPct: null, qtyPerOutput: null, name: 'Картофель' }]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, s] };
  const e = expandComposition(ctx2, edgesOfSemi(s), 1000, 1);
  assert.ok(Number.isFinite(e.nodes[0].qty), 'без бесконечности');
  assert.equal(e.raw.length, 0, 'нулевой расход не попадает в потребность');
  assert.match(wtext(e.warnings), /выход после обработки/);
});

check('норма добавки не задана: предупреждение, строка сырья не создаётся', () => {
  const s = semi(50, 'С пустой добавкой', 1, 'г', [
    inp('raw', 101, 'base', 90, null, 'Картофель'),
    { sourceType: 'raw', refId: 103, role: 'additive', yieldPct: null, qtyPerOutput: null, name: 'Соль' },
  ]);
  const ctx2: SemiCtx = { ...CTX, semis: [...CTX.semis, s] };
  const e = expandComposition(ctx2, edgesOfSemi(s), 1000, 1);
  assert.match(wtext(e.warnings), /расход добавки/);
  assert.deepEqual(e.raw.map((r) => r.productId), [101]);
});

check('trimNum не показывает шум хвостами двойной точности', () => {
  assert.equal(trimNum(1587.3015873015873), '1587.302');
  assert.equal(trimNum(50), '50');
});

/* --------------------- 10. быстрая правка коэффициента из предупреждения --------------------- */

console.log('\n10. Клик по предупреждению: правка коэффициента');

const milkNoD = prod(110, 'Молоко (без плотности)', 2, 'мл');
const milkWithD = prod(110, 'Молоко (без плотности)', 2, 'мл', { gPerMl: 1.03 });
const puree = (milk: Product): Semi =>
  semi(51, 'Пюре картофельное', 1, 'г', [
    inp('raw', 101, 'base', 90, null, 'Картофель'),
    inp('raw', 110, 'additive', null, 0.2, milk.name),
  ]);
const ctxNoD: SemiCtx = { units: UNITS, products: [...PRODUCTS, milkNoD], semis: [...SEMIS, puree(milkNoD)] };
const ctxWithD: SemiCtx = { units: UNITS, products: [...PRODUCTS, milkWithD], semis: [...SEMIS, puree(milkWithD)] };

check('случай пользователя: пюре в г, молоко в мл — предупреждение называет продукт и поле gPerMl', () => {
  const e = expandComposition(ctxNoD, edgesOfSemi(puree(milkNoD)), 1000, 1);
  const w = e.warnings.find((x) => x.kind === 'conv');
  assert.ok(w, 'предупреждение есть');
  assert.equal(warnText(w), 'Молоко (без плотности): нельзя перевести «г» в «мл» — задайте коэффициент «грамм в 1 мл (плотность)»');
  assert.equal(w.field, 'gPerMl', 'поле, которое подсвечивает редактор');
  assert.equal(w.refId, 110, 'править вот эту запись');
  assert.equal(w.sourceType, 'raw', 'это продукт номенклатуры');
  assert.equal(fixableWarn(w), true, 'кликабельно');
});

check('после правки предупреждение уходит, расход считается по плотности', () => {
  const e = expandComposition(ctxWithD, edgesOfSemi(puree(milkWithD)), 1000, 1);
  assert.equal(e.warnings.length, 0, 'больно не за что цепляться');
  const milk = e.raw.find((r) => r.productId === 110)!;
  near('200 г выхода ÷ 1.03 г/мл', milk.qty, 200 / 1.03);
  assert.equal(milk.unitCode, 'мл');
});

check('правка предзаполняется текущим значением (пусто = не задан, а не 0)', () => {
  assert.equal(convValueOf(ctxNoD, 'raw', 110, 'gPerMl'), null);
  assert.equal(convValueOf(ctxWithD, 'raw', 110, 'gPerMl'), 1.03);
  assert.equal(convValueOf(CTX, 'semi', 12, 'gPerPcs'), 44);
});

check('payload продукта = ровно одно поле (карточка больше не перезаписывается)', () => {
  assert.deepEqual(productConvBody('gPerMl', 1.03), { gPerMl: 1.03 });
});

check('payload заготовки: коэффициент точечно, состав остаётся в шкале БД', () => {
  const src = SEMIS.find((s) => s.id === 11)!;
  const body = semiBodyOf(src, { gPerMl: 1.03 }) as {
    gPerMl: number;
    name: string;
    inputs: { role: string; qtyPerOutput: number | null }[];
  };
  assert.equal(body.gPerMl, 1.03);
  assert.equal(body.name, src.name, 'остальные поля едут как в БД');
  const adds = body.inputs.filter((i) => i.role === 'additive');
  near('масло: доля на 1 базовую единицу выхода, без ×1000', Number(adds[0].qtyPerOutput), 0.05);
});

check('то же предупреждение в нескольких ветках показывается один раз', () => {
  const nested = semi(52, 'Пюре слоёное', 1, 'г', [
    inp('semi', 51, 'base', 100, null, 'Пюре картофельное'),
    inp('raw', 110, 'additive', null, 0.1, 'Молоко (без плотности)'),
  ]);
  const ctx2: SemiCtx = { ...ctxNoD, semis: [...ctxNoD.semis, nested] };
  const e = expandComposition(ctx2, edgesOfSemi(nested), 1000, 1);
  const conv = e.warnings.filter((w) => w.kind === 'conv');
  assert.ok(conv.length >= 2, `раскрытие даёт повторы (${conv.length})`);
  assert.equal(dedupeWarnings(conv).length, 1, 'в списке — одна строка');
  const uniq = dedupeWarnings(e.warnings);
  assert.equal(new Set(uniq.map(warnKey)).size, uniq.length, 'ключи уникальны → track стабилен');
});

check('нечинимые предупреждения (цикл) не кликабельны', () => {
  const e = expandComposition(CTX, edgesOfSemi(S_A), 1000, 1, new Set([20]));
  assert.ok(e.warnings.length > 0);
  assert.equal(e.warnings.some(fixableWarn), false, 'цикл коэффициентом не лечится');
});

check('метка поля совпадает с полем в номенклатуре', () => {
  assert.equal(CONV_FIELD_LABEL.gPerMl, 'грамм в 1 мл (плотность)');
  assert.equal(CONV_FIELD_LABEL.gPerPcs, 'грамм в 1 шт');
});

check('строка дерева тоже кликабельна: узел несёт то же предупреждение структурированно', () => {
  const e = expandComposition(ctxNoD, edgesOfSemi(puree(milkNoD)), 1000, 1);
  const milkNode = e.nodes.find((n) => n.refId === 110)!;
  assert.equal(milkNode.warns.length, 1, 'текст предупреждения в строке есть');
  assert.equal(milkNode.fixes.length, 1, 'и ссылка на поле тоже');
  const fx = milkNode.fixes.find(fixableWarn);
  assert.ok(fx, 'кликабельно');
  assert.equal(warnKey(fx), warnKey(e.warnings.find((w) => w.kind === 'conv')!), 'открывает ту же панель, что и список внизу');
  // узел без проблем не кликабелен
  assert.equal(e.nodes.find((n) => n.refId === 101)!.fixes.length, 0);
});

/* --------------------------------------- итог --------------------------------------- */

console.log(`\nПройдено проверок: ${passed}, сбоев: ${failures.length}`);
if (failures.length) {
  console.log('\nСБОИ:');
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('Все проверки semi-calc прошли.');
