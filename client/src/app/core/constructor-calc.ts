import { Semi } from './models';
import { edgesOfSemi, expandComposition, SemiCtx, SourceKind } from './semi-calc';

/**
 * Прямой расчёт по «столу» конструктора блюд. В отличие от редактора полуфабрикатов
 * (там известна ЦЕЛЬ выхода и расход раскручивается назад до сырья), здесь quantities
 * текут ВПЕРЁД: у каждого блока-ингредиента есть количество, связи несут «выход после
 * обработки», а сборка (свободный блок-полуфабрикат) собирает входящие потоки.
 *
 * Две инвариантные опоры:
 *   деньги   — сохраняются: себестоимость сборки = Σ себестоимостей входящих потоков
 *              (обработка не добавляет рублей, только угнетает массу → растёт ₽/ед.);
 *   выход    = Σ (поток × выход_после_обработки %) — прямой материальный баланс.
 *
 * Выход разных размерностей (г + шт) в одно число не складываем: группируем по единице
 * и «итоговый выход / ₽ на единицу» показываем только когда все потоки в одной единице.
 * Итоговая себестоимость в ₽ корректна всегда — рубли суммируемы.
 */

/** Один входящий поток сборки: сколько влилось, что из этого вышло, сколько стоит. */
export interface Stream {
  name: string;
  sourceType: SourceKind;
  /** true — источник сам является сборкой/вложенным полуфабрикатом (идёт рекурсивно). */
  nested: boolean;
  /** количество потока на входе (в `unitCode`). */
  inQty: number;
  unitCode: string;
  /** выход после обработки, % (пусто/0 считаем 100). */
  yieldPct: number;
  /** inQty × yield% — вклад в выход сборки. */
  outQty: number;
  /** ₽, потребляемые этим потоком. */
  cost: number;
  warn: string | null;
}

/** Итог по одной сборке (свободному блоку-полуфабрикату). */
export interface Assembly {
  uid: number;
  title: string;
  streams: Stream[];
  /** Σ ₽ входящих потоков — себестоимость сборки. */
  totalCost: number;
  /** выход, сгруппированный по единице (в обход смешения г/шт). */
  outByUnit: { unit: string; qty: number }[];
  /** общая размерность выхода, если все потоки в одной — иначе null. */
  primaryUnit: string | null;
  /** суммарный выход в `primaryUnit` (null, если единиц несколько). */
  outQty: number | null;
  /** ₽ на единицу выхода (только когда выход в одной единице и выход > 0). */
  costPerUnit: number | null;
  /** есть ли хоть один посчитанный поток. */
  ready: boolean;
  warnings: string[];
}

/** Себестоимость отдельного блока-ингредиента на столе (qty × цена). */
export interface BlockCost {
  cost: number;
  ready: boolean;
  warn: string | null;
}

/** Минимальная форма блока/связи, достаточная для расчёта (структурно = PlateItem/Link). */
export interface CalcBlock {
  uid: number;
  kind: 'ingredient' | 'note';
  sourceType: SourceKind;
  refId: number;
  name: string;
  title: string;
  qty: string;
  unitCode: string;
}
export interface CalcLink {
  id: number;
  from: number;
  to: number;
  yieldPct: string;
}

export interface ConstructorCtx extends SemiCtx {}

const num = (s: string | number | null | undefined): number => {
  const n = Number(typeof s === 'string' ? s.trim() : s);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Выход после обработки связи: пусто/0 → 100, физически не больше 100. */
const yieldOf = (s: string): number => {
  const n = Number(s?.trim?.() ?? s);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 100;
};

/**
 * Себестоимость производства `qty` базовых единиц заготовки: раскрываем её состав до сырья
 * (это же ядро, что на странице «Полуфабрикаты») и суммируем сырьё по avgCost. Нулевой/не
 * раскрываемый состав даёт 0 — отсутствие цены не выдумываем.
 */
function semiCost(ctx: SemiCtx, semi: Semi, qty: number): number {
  if (!(qty > 0)) return 0;
  const price = new Map(ctx.products.map((p) => [p.id, p.avgCost ?? 0]));
  const exp = expandComposition(
    ctx,
    edgesOfSemi(semi),
    qty,
    Number(semi.outQty) || 1,
    new Set([semi.id]),
    [],
    0,
  );
  return exp.raw.reduce((s, r) => s + r.qty * (price.get(r.productId) ?? 0), 0);
}

/** Разрешение потока «источник → сборка»: от типизированного блока берём qty и ₽. */
function streamFromBlock(
  src: CalcBlock,
  ctx: SemiCtx,
  yieldPct: number,
  resolveNested: (uid: number) => Assembly,
): Stream {
  // свободный блок (вложенная сборка) — рекурсия; вклад в выход возможен только в одной единице
  if (src.kind === 'note') {
    const asm = resolveNested(src.uid);
    return {
      name: src.title.trim() || 'Полуфабрикат',
      sourceType: 'semi',
      nested: true,
      inQty: asm.outQty ?? 0,
      unitCode: asm.primaryUnit ?? '',
      yieldPct,
      outQty: asm.outQty == null ? 0 : (asm.outQty * yieldPct) / 100,
      cost: asm.totalCost,
      warn: asm.outQty == null ? 'вложенный выход в разных единицах — в выход не сложён' : null,
    };
  }
  const qty = num(src.qty);
  if (src.sourceType === 'semi') {
    const semi = ctx.semis.find((s) => s.id === src.refId);
    if (!semi) return blankStream(src.name, src.unitCode, yieldPct, 'заготовка не найдена в каталоге');
    return {
      name: src.name,
      sourceType: 'semi',
      nested: false,
      inQty: qty,
      unitCode: src.unitCode,
      yieldPct,
      outQty: (qty * yieldPct) / 100,
      cost: qty > 0 ? semiCost(ctx, semi, qty) : 0,
      warn: qty > 0 ? null : 'не указано количество',
    };
  }
  const p = ctx.products.find((x) => x.id === src.refId);
  if (!p) return blankStream(src.name, src.unitCode, yieldPct, 'сырьё не найдено в номенклатуре');
  return {
    name: src.name,
    sourceType: 'raw',
    nested: false,
    inQty: qty,
    unitCode: src.unitCode,
    yieldPct,
    outQty: (qty * yieldPct) / 100,
    cost: qty > 0 ? qty * (p.avgCost ?? 0) : 0,
    warn: qty > 0 ? null : 'не указано количество',
  };
}

function blankStream(name: string, unitCode: string, yieldPct: number, warn: string): Stream {
  return { name, sourceType: 'raw', nested: false, inQty: 0, unitCode, yieldPct, outQty: 0, cost: 0, warn };
}

/** Итоги по сборке из её потоков: суммарная ₽ + выход по единицам + ₽/ед. (когда однородно). */
function summarize(uid: number, title: string, streams: Stream[], warnings: string[]): Assembly {
  const totalCost = streams.reduce((s, x) => s + x.cost, 0);
  const byUnit = new Map<string, number>();
  for (const st of streams) {
    if (st.outQty > 0 && st.unitCode) byUnit.set(st.unitCode, (byUnit.get(st.unitCode) ?? 0) + st.outQty);
  }
  const outByUnit = [...byUnit.entries()]
    .map(([unit, qty]) => ({ unit, qty }))
    .sort((a, b) => b.qty - a.qty);
  const primaryUnit = outByUnit.length === 1 ? outByUnit[0].unit : null;
  const outQty = primaryUnit ? outByUnit[0].qty : null;
  const costPerUnit = primaryUnit && outByUnit[0].qty > 0 ? totalCost / outByUnit[0].qty : null;
  const ready = streams.some((x) => x.inQty > 0);
  return {
    uid,
    title,
    streams: streams.sort((a, b) => b.cost - a.cost),
    totalCost,
    outByUnit,
    primaryUnit,
    outQty,
    costPerUnit,
    ready,
    warnings,
  };
}

/**
 * Развернуть весь стол: для каждой сборки (свободного блока) — потоки, себестоимость и выход,
 * для каждого ингредиента — его собственную ₽. Вложенные сборки считаются рекурсивно с защитой
 * от циклов (создать цикл не даёт и редактор связей, но guard на месте).
 */
export function resolveConstructor(
  plate: CalcBlock[],
  links: CalcLink[],
  ctx: SemiCtx,
): { assemblies: Map<number, Assembly>; blocks: Map<number, BlockCost> } {
  const byUid = new Map(plate.map((b) => [b.uid, b]));
  const inbound = new Map<number, CalcLink[]>();
  for (const l of links) {
    const arr = inbound.get(l.to) ?? [];
    arr.push(l);
    inbound.set(l.to, arr);
  }

  const memo = new Map<number, Assembly>();
  const visiting = new Set<number>();

  const resolveAssembly = (uid: number): Assembly => {
    const cached = memo.get(uid);
    if (cached) return cached;
    const self = byUid.get(uid);
    if (!self || self.kind !== 'note') {
      return summarize(uid, '', [], []);
    }
    const ls = inbound.get(uid) ?? [];
    if (visiting.has(uid)) {
      // цикл (в норме невозможен) — не раскручиваем, но и не роняем расчёт
      return summarize(uid, self.title, [], ['цикл: сборка ссылается сама на себя']);
    }
    visiting.add(uid);
    const streams: Stream[] = [];
    const warnings: string[] = [];
    for (const l of ls) {
      const src = byUid.get(l.from);
      if (!src) continue;
      const st = streamFromBlock(src, ctx, yieldOf(l.yieldPct), resolveAssembly);
      streams.push(st);
      if (st.warn) warnings.push(`${st.name}: ${st.warn}`);
    }
    visiting.delete(uid);
    const asm = summarize(uid, self.title.trim() || 'Полуфабрикат', streams, warnings);
    memo.set(uid, asm);
    return asm;
  };

  const assemblies = new Map<number, Assembly>();
  for (const b of plate) {
    if (b.kind === 'note') assemblies.set(b.uid, resolveAssembly(b.uid));
  }

  // собственный ₽ ингредиента — для подписи прямо на блоке
  const blocks = new Map<number, BlockCost>();
  for (const b of plate) {
    if (b.kind !== 'ingredient') continue;
    const qty = num(b.qty);
    if (qty <= 0) {
      blocks.set(b.uid, { cost: 0, ready: false, warn: null });
      continue;
    }
    if (b.sourceType === 'semi') {
      const semi = ctx.semis.find((s) => s.id === b.refId);
      blocks.set(b.uid, { cost: semi ? semiCost(ctx, semi, qty) : 0, ready: !!semi, warn: semi ? null : 'заготовка не найдена' });
      continue;
    }
    const p = ctx.products.find((x) => x.id === b.refId);
    blocks.set(b.uid, { cost: p ? qty * (p.avgCost ?? 0) : 0, ready: !!p, warn: p ? null : 'сырьё не найдено' });
  }

  return { assemblies, blocks };
}

/* ============ сборка → заготовка каталога («Полуфабрикаты») ============ */

/** Тело POST /api/semis — ровно то, что принимает сервер (routes/semis.ts). */
export interface SemiCreateBody {
  name: string;
  unitId: number;
  /** размер партии: сколько заготовки (в баз. ед. выхода) даёт состав */
  outQty: number;
  note: string;
  shelfLifeDays: number | null;
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
  inputs: {
    sourceType: SourceKind;
    refId: number;
    /** количество входа НА ПАРТИЮ, в базовых единицах самого входа */
    qty: number;
    yieldPct: number | null;
  }[];
  /** стол (блоки + связи) той же заготовки — прикладывается компонентом при сохранении */
  board?: unknown;
}

export type SemiBuildResult = { ok: true; body: SemiCreateBody } | { ok: false; error: string };

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Превратить сборку (свободный блок со входящими связями) в рецепт заготовки.
 *
 * Ролей больше нет: каждый вход — равный ингредиент с АБСОЛЮТНЫМ количеством на партию
 * (в базовой единице самого входа) и своим необязательным выходом после обработки.
 * Каталог хранит qty = ЧИСТОЕ количество, вошедшее в продукт (после потерь), поэтому при
 * раскрытии need = qty ÷ (выход/100) точно воспроизводит грубое количество блока Q.
 * Единица выхода и размер партии out_qty = самый крупный по физическому выхода узел;
 * outQty = сумма чистых выходов входов в этой единице.
 *
 * Сохранить можно только сборку из типизированных блоков каталога: вложенная сборка (note)
 * не имеет refId и не может стать входом — её надо сохранить отдельно первой.
 */
export function buildSemiBody(plate: CalcBlock[], links: CalcLink[], ctx: SemiCtx, uid: number): SemiBuildResult {
  const self = plate.find((b) => b.uid === uid);
  if (!self || self.kind !== 'note') return { ok: false, error: 'Это не сборка' };
  const name = self.title.trim();
  if (!name) return { ok: false, error: 'Укажите название полуфабриката (в блоке)' };

  const inLinks = links.filter((l) => l.to === uid);
  if (!inLinks.length) return { ok: false, error: 'Нет входящих связей — соедините сырьё с блоком' };

  const byUid = new Map(plate.map((b) => [b.uid, b]));
  interface Entry { sourceType: SourceKind; refId: number; qty: number; unitId: number; unitCode: string; yieldPct: number; name: string; }
  const entries: Entry[] = [];
  for (const l of inLinks) {
    const src = byUid.get(l.from);
    if (!src) continue;
    if (src.kind === 'note') {
      return { ok: false, error: `Вложенная сборка «${src.title.trim() || 'без имени'}» — сначала сохраните её отдельно` };
    }
    const qty = num(src.qty);
    if (!(qty > 0)) return { ok: false, error: `Укажите количество для «${src.name}»` };
    if (src.sourceType === 'semi') {
      const semi = ctx.semis.find((s) => s.id === src.refId);
      if (!semi || semi.unitId == null) return { ok: false, error: `Заготовка «${src.name}» не найдена в каталоге` };
      entries.push({ sourceType: 'semi', refId: semi.id, qty, unitId: semi.unitId, unitCode: semi.unitCode, yieldPct: yieldOf(l.yieldPct), name: semi.name });
    } else {
      const p = ctx.products.find((x) => x.id === src.refId);
      if (!p || p.unitId == null) return { ok: false, error: `Сырьё «${src.name}» не найдено в номенклатуре` };
      entries.push({ sourceType: 'raw', refId: p.id, qty, unitId: p.unitId, unitCode: p.unitCode, yieldPct: yieldOf(l.yieldPct), name: p.name });
    }
  }
  if (!entries.length) return { ok: false, error: 'Нет подходящих входов для сохранения' };

  // сервер отвергает дубли sourceType:refId — склеиваем их, сохраняя и сумму сырья (rawQ),
  // и сумму чистого выхода (net); эффективный выход = net/rawQ восстановит Q при раскрытии
  interface Agg { sourceType: SourceKind; refId: number; unitId: number; unitCode: string; name: string; rawQ: number; net: number; }
  const agg = new Map<string, Agg>();
  for (const e of entries) {
    const key = `${e.sourceType}:${e.refId}`;
    const a = agg.get(key) ?? { sourceType: e.sourceType, refId: e.refId, unitId: e.unitId, unitCode: e.unitCode, name: e.name, rawQ: 0, net: 0 };
    a.rawQ += e.qty;
    a.net += (e.qty * e.yieldPct) / 100;
    agg.set(key, a);
  }

  // узел выхода = единица с наибольшим суммарным физическим выходом
  const outByUnit = new Map<number, number>();
  for (const a of agg.values()) outByUnit.set(a.unitId, (outByUnit.get(a.unitId) ?? 0) + a.net);
  let unitId = entries[0].unitId;
  let bestOut = -1;
  for (const [u, val] of outByUnit) if (val > bestOut) { bestOut = val; unitId = u; }
  if (!(bestOut > 0)) return { ok: false, error: 'Выход нулевой — проверьте количества и %' };

  const inputs: SemiCreateBody['inputs'] = [];
  for (const a of agg.values()) {
    const qty = round6(a.net);
    if (!(qty > 0)) return { ok: false, error: `Количество входа «${a.name}» получилось нулевым` };
    const eff = a.rawQ > 0 ? (a.net / a.rawQ) * 100 : 100;
    inputs.push({ sourceType: a.sourceType, refId: a.refId, qty, yieldPct: eff < 99.999 ? round6(eff) : null });
  }

  return {
    ok: true,
    body: { name, unitId, outQty: round6(bestOut), note: '', shelfLifeDays: null, gPerPcs: null, mlPerPcs: null, gPerMl: null, inputs },
  };
}
