import { Product, Semi, Unit } from './models';
import { Conv, Dim, toBaseClient } from './units';

/**
 * Чистая (без Angular) логика раздела «Полуфабрикаты»: модель состава, раскрытие
 * потребности в сырье, валидация, поиск/фильтрация каталога.
 *
 * Формулы — точное зеркало серверного server/src/services/expansion.ts (resolveSemi).
 * Привязки к «базовому продукту» больше нет: все входы равны, у каждого своё количество
 * на партию (в базовых единицах самого входа) и свой необязательный выход после обработки:
 *   нужно входа = qty × (желаемый выход ÷ out_qty), дополнительно ÷ (yield_pct / 100), если выход задан
 * Выход после обработки — отношение МАСС, а не штук: для штучного входа потери считаются
 * через «грамм в 1 шт» самого входа, иначе «÷ 90 %» делил бы яйца.
 * Выход заготовки — сумма количеств входов, приведённая к единице выхода (потери влияют
 * только на расход сырья, а не на вес готовой заготовки); размерности переводятся
 * только по заданным коэффициентам (g_per_pcs / ml_per_pcs / g_per_ml).
 */

export type SourceKind = 'raw' | 'semi';

/** Ребро состава: количество входа на партию — в базовых единицах самого входа. */
export interface SemiEdge {
  sourceType: SourceKind;
  refId: number | null;
  /** количество на партию, в базовой единице входа */
  qty: number | null;
  /** выход после обработки этого входа, % (null = без потерь) */
  yieldPct: number | null;
}

/** Один ингредиент состава в редакторе. */
export interface SemiDraftInput {
  sourceType: SourceKind;
  refId: number | null;
  qty: number | null;
  yieldPct: number | null;
}

/** Черновик заготовки в редакторе (id = null — новая). */
export interface SemiDraft {
  id: number | null;
  name: string;
  note: string;
  unitId: number | null;
  /** размер партии: сколько заготовки даёт состав (в базовых единицах выхода) */
  outQty: number | null;
  shelfLifeDays: number | null;
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
  /** все входы равноправны — никакого «основного продукта» */
  inputs: SemiDraftInput[];
}

/** Справочники, достаточные для расчёта на клиенте (загружаются один раз). */
export interface SemiCtx {
  units: Unit[];
  products: Product[];
  semis: Semi[];
}

export interface RefInfo {
  name: string;
  unitId: number | null;
  unitCode: string;
  conv: Conv;
}

/** Info по входу: сырьё — products, полуфабрикат — semi_products (его выход). */
export function refInfo(ctx: SemiCtx, sourceType: SourceKind, refId: number | null): RefInfo | null {
  if (refId == null) return null;
  if (sourceType === 'raw') {
    const p = ctx.products.find((x) => x.id === refId);
    if (!p) return null;
    return { name: p.name, unitId: p.unitId, unitCode: p.unitCode, conv: convOf(p) };
  }
  const s = ctx.semis.find((x) => x.id === refId);
  if (!s) return null;
  return { name: s.name, unitId: s.unitId, unitCode: s.unitCode, conv: convOf(s) };
}

const convOf = (o: Product | Semi): Conv => ({ gPerPcs: o.gPerPcs, mlPerPcs: o.mlPerPcs, gPerMl: o.gPerMl });

/** Состав из БД → рёбра (количества уже абсолютные, на партию). */
export function edgesOfSemi(s: Semi): SemiEdge[] {
  return s.inputs.map((i) => ({
    sourceType: i.sourceType,
    refId: i.refId,
    qty: i.qty != null ? Number(i.qty) : null,
    yieldPct: i.yieldPct != null ? Number(i.yieldPct) : null,
  }));
}

/** Черновик → рёбра (строки без выбранного компонента в расчёт не входят). */
export function edgesOfDraft(d: SemiDraft): SemiEdge[] {
  return d.inputs
    .filter((i) => i.refId != null)
    .map((i) => ({ sourceType: i.sourceType, refId: i.refId, qty: i.qty, yieldPct: i.yieldPct }));
}

/* ================= единицы / предупреждения о пересчёте ================= */

const DIM_LABEL: Record<Dim, string> = { mass: 'г', volume: 'мл', count: 'шт' };

/** Поле-коэффициент, которое нужно задать у сущности, чтобы пересчёт появился. */
export type ConvField = 'gPerPcs' | 'mlPerPcs' | 'gPerMl';

export const CONV_FIELD_LABEL: Record<ConvField, string> = {
  gPerPcs: 'грамм в 1 шт',
  mlPerPcs: 'мл в 1 шт',
  gPerMl: 'грамм в 1 мл (плотность)',
};

/** Как объяснять поле при быстрой правке: что это за число + реалистичный пример. */
export const CONV_FIELD_HINT: Record<ConvField, { eq: string; example: string }> = {
  gPerPcs: { eq: 'сколько граммов в одной штуке', example: 'напр. 53 — яйцо С1' },
  mlPerPcs: { eq: 'сколько миллилитров в одной штуке', example: 'напр. 200 — стакан' },
  gPerMl: { eq: 'сколько граммов в одном миллилитре', example: 'напр. 1.03 — молоко' },
};

/**
 * Предупреждение раскрытия — не текст, а ссылка на место, где его лечат:
 * kind=conv ⇒ у `sourceType:refId` не хватает коэффициента `field`.
 * kind=yieldPcs ⇒ свой выход после обработки штучного входа повис в штуках: не хватает
 * «грамм в 1 шт» самого входа (лечится в номенклатуре/редакторе заготовки этого входа).
 */
export interface ExpWarn {
  kind: 'conv' | 'cycle' | 'noQty' | 'depth' | 'yieldPcs';
  /** Что не так (без имени сущности). */
  text: string;
  /** Чей это расход/заготовка. */
  where: string;
  sourceType: SourceKind;
  refId: number | null;
  /** Единица входа — чтобы подсказать «г → мл». */
  unitId: number | null;
  /** Какое поле правим (только conv). */
  field: ConvField | null;
}

export const warnText = (w: ExpWarn): string => `${w.where}: ${w.text}`;

/** Стабильный ключ предупреждения — для track в списке и для «какое открыто».
 * Две одинаковые по смыслу строки (один и тот же продукт в разных ветках) должны
 * давать один ключ: список показываем dedupeWarnings()'ом.
 */
export const warnKey = (w: ExpWarn): string => `${w.kind}|${w.sourceType}|${w.refId}|${w.field ?? ''}|${w.where}`;

/** Убрать повторы (одна и та же сущность встречается в нескольких ветках раскрытия). */
export function dedupeWarnings(list: ExpWarn[]): ExpWarn[] {
  const seen = new Set<string>();
  const out: ExpWarn[] = [];
  for (const w of list) {
    const k = warnKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

/**
 * Предупреждение лечится прямо здесь: не хватает конкретного коэффициента
 * у конкретной записи (продукта или вложенной заготовки).
 */
export function fixableWarn(w: ExpWarn): w is ExpWarn & { field: ConvField; refId: number } {
  return w.kind === 'conv' && w.field != null && w.refId != null;
}

/** Текущее значение коэффициента у записи — чтобы правка начиналась с него, а не с нуля. */
export function convValueOf(ctx: SemiCtx, sourceType: SourceKind, refId: number, field: ConvField): number | null {
  const o = sourceType === 'raw' ? ctx.products.find((p) => p.id === refId) : ctx.semis.find((s) => s.id === refId);
  return o ? o[field] ?? null : null;
}

/**
 * Тело PATCH /api/products/:id — ровно одно поле (роут делает частичный update и пишет в журнал).
 * `aiModel` — имя модели, подсказавшей число: роут кладёт его в журнал, чтобы правка от ИИ
 * отличалась от правки от руки. Без него тело остаётся прежним.
 */
export const productConvBody = (field: ConvField, value: number | null, aiModel?: string | null): Record<string, unknown> =>
  aiModel ? { [field]: value, aiModel } : { [field]: value };

/** Какого коэффициента не хватает (человочитаемо, как на сервере) + какое поле править. */
function missingConvHint(from: Dim, to: Dim): { text: string; field: ConvField } {
  const direct =
    (from === 'count' && to === 'mass') || (from === 'mass' && to === 'count')
      ? { field: 'gPerPcs' as ConvField, need: '«грамм в 1 шт»' }
      : (from === 'count' && to === 'volume') || (from === 'volume' && to === 'count')
        ? { field: 'mlPerPcs' as ConvField, need: '«мл в 1 шт» (или «г в 1 шт» + «г в 1 мл»)' }
        : { field: 'gPerMl' as ConvField, need: '«грамм в 1 мл (плотность)»' };
  return { text: `нельзя перевести «${DIM_LABEL[from]}» в «${DIM_LABEL[to]}» — задайте коэффициент ${direct.need}`, field: direct.field };
}

/**
 * Дыра в пересчёте к единице ВЫХОДА: такой вход не свести к «выходу по составу»,
 * пока у записи (или у самой заготовки) не задан коэффициент.
 * `target=self` — выход в штуках, коэффициент живёт в самой заготовке (блок A);
 * `target=input` — коэффициент живёт в записи входа (продукт/вложенная заготовка).
 */
export interface OutGap {
  /** Стабильный ключ: одна и та же запись в составе даёт одну правку. */
  key: string;
  /** Чья это запись (или сама заготовка) — что показываем в предупреждении. */
  name: string;
  text: string;
  field: ConvField;
  target: { kind: 'input'; sourceType: SourceKind; refId: number } | { kind: 'self' };
}

/**
 * Почему «Выход по составу» не считается: для каждого входа без пути пересчёта
 * к единице выхода отдаём место, где задаётся недостающий коэффициент.
 */
export function outputGaps(ctx: SemiCtx, d: SemiDraft): OutGap[] {
  const outU = d.unitId == null ? undefined : ctx.units.find((u) => u.id === d.unitId);
  if (!outU) return [];
  const seen = new Set<string>();
  const out: OutGap[] = [];
  for (const a of d.inputs) {
    if (a.refId == null) continue;
    const q = Number(a.qty ?? 0);
    if (!(q > 0)) continue;
    const ref = refInfo(ctx, a.sourceType, a.refId);
    const inU = ref?.unitId == null ? undefined : ctx.units.find((u) => u.id === ref.unitId);
    if (!ref || !inU || inU.dimension === outU.dimension) continue;
    // зеркало compositionOut: для штучного выхода коэффициенты берём у самой заготовки
    const conv =
      outU.dimension === 'count'
        ? { ...ref.conv, gPerPcs: d.gPerPcs ?? ref.conv.gPerPcs, mlPerPcs: d.mlPerPcs ?? ref.conv.mlPerPcs }
        : ref.conv;
    if (toBaseClient(ctx.units, q, ref.unitId, d.unitId, conv) != null) continue;
    const hint = missingConvHint(inU.dimension as Dim, outU.dimension as Dim);
    const self = outU.dimension === 'count';
    const key = self
      ? `out|self|${hint.field}`
      : `out|input|${a.sourceType}|${a.refId}|${hint.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      name: self ? 'Выход заготовки в штуках' : ref.name,
      text: self ? `${hint.text} — коэффициент нужен у самой заготовки` : hint.text,
      field: hint.field,
      target: self ? { kind: 'self' } : { kind: 'input', sourceType: a.sourceType, refId: a.refId },
    });
  }
  return out;
}

/**
 * Перевести количество ВХОДА в каноничную единицу этого входа.
 * Возвращает { qty, warn } — warn ставится, когда пути пересчёта нет (число остаётся
 * в исходной размерности; молча подменять коэффициент не будем).
 */
export function toInputQty(
  ctx: SemiCtx,
  qty: number,
  fromUnitId: number | null,
  ref: RefInfo,
  inGrams = false
): { qty: number; warn: { text: string; field: ConvField | null } | null } {
  // выход после обработки по массе: число уже в граммах, поэтому переводим из размерности mass,
  // а не из единицы входа (иначе граммы читались бы как штуки).
  const from = inGrams ? massUnitId(ctx) ?? fromUnitId : fromUnitId;
  const converted = toBaseClient(ctx.units, qty, from, ref.unitId, ref.conv);
  if (converted != null) return { qty: converted, warn: null };
  const dFrom = (inGrams ? 'mass' : ctx.units.find((u) => u.id === from)?.dimension) as Dim | undefined;
  const dTo = ctx.units.find((u) => u.id === ref.unitId)?.dimension as Dim | undefined;
  if (dFrom && dTo && dFrom !== dTo) {
    const hint = missingConvHint(dFrom, dTo);
    return { qty, warn: { text: hint.text, field: hint.field } };
  }
  return { qty, warn: { text: 'единица входа не задана', field: null } };
}

/** id базовой единицы массы (г) — стартовая точка для перевода граммов входа. */
function massUnitId(ctx: SemiCtx): number | null {
  return ctx.units.find((u) => u.dimension === 'mass')?.id ?? null;
}

/**
 * Потери при обработке штучного входа: штуки делить на «÷ 90 %» нельзя («10 % яиц истаяло»),
 * поэтому потеря вешается на МАССУ входа: штуки × «грамм в 1 шт» входа ÷ выход = граммы входа.
 * Возвращаем и то, в какой размерности число, чтобы toInputQty не читал граммы как штуки.
 */
export function inputYield(
  ctx: SemiCtx,
  qty: number,
  yieldPct: number,
  inUnitId: number | null,
  inConv: Conv | null
): { qty: number; inGrams: boolean; needed: boolean } {
  const y = yieldPct / 100;
  const dim = inUnitId == null ? undefined : ctx.units.find((u) => u.id === inUnitId)?.dimension;
  const needed = dim === 'count' && y > 0 && y < 1;
  const g = inConv?.gPerPcs != null && Number(inConv.gPerPcs) > 0 ? Number(inConv.gPerPcs) : null;
  if (needed && g != null) return { qty: (qty * g) / y, inGrams: true, needed };
  return { qty: qty / y, inGrams: false, needed };
}

/* ================= раскрытие состава ================= */

/** Узел дерева потребности (один вход заготовки; для semi — со своими детьми). */
export interface ExpNode {
  key: string;
  sourceType: SourceKind;
  refId: number | null;
  name: string;
  unitCode: string;
  /** Количество в каноничной единице входа (или в размерности выхода, если пересчёта нет). */
  qty: number;
  /** Как считалось — явная база расчёта для пользователя. */
  basis: string;
  /** Цепочка вложенных заготовок, через которые встал этот расход. */
  via: string[];
  children: ExpNode[];
  /** Предупреждение по узлу: цикл, нет пересчёта размерности, не задано количество. */
  warns: string[];
  /**
   * То же самое структурированно: узел умеет открывать правку поля
   * (в tree-строке предупреждение кликабельно наравне со списком внизу).
   */
  fixes: ExpWarn[];
  depth: number;
}

/** Итоговая потребность листового сырья, сгруппированная по продукту. */
export interface RawLine {
  productId: number;
  name: string;
  unitCode: string;
  qty: number;
  /** Названия заготовок, расход которых дал эту строку (пусто — прямое сырьё). */
  via: string[];
}

export interface Expansion {
  nodes: ExpNode[];
  raw: RawLine[];
  /** Плоский список предупреждений по всему раскрытию (структурированные — кликабельные). */
  warnings: ExpWarn[];
  /** Есть ли хоть одно числовое значение (для показа «нужно заполнить состав»). */
  ready: boolean;
}

const MAX_DEPTH = 12;

/**
 * Полное раскрытие состава. Состав хранится АБСОЛЮТНЫМИ количествами на партию:
 * вход `qty` — в базовой единице самого входа, партия даёт `batchOut` баз. ед. выхода.
 * Чтобы получить `outQty` баз. ед. выхода, каждый вход умножаем на масштаб партии
 * `k = outQty / batchOut`; если у входа задан свой выход после обработки — количество
 * дополнительно делится на него (для штучного входа потери вешаем на массу через его
 * «грамм в 1 шт»). Привязки к «основному продукту» нет — все входы равноправны.
 * `pathIds` — id заготовок на текущей ветке (защита от циклов), `via` — их названия.
 */
export function expandComposition(
  ctx: SemiCtx,
  edges: SemiEdge[],
  outQty: number,
  batchOut: number,
  pathIds: Set<number> = new Set(),
  via: string[] = [],
  depth = 0
): Expansion {
  const nodes: ExpNode[] = [];
  const warnings: ExpWarn[] = [];
  const raw = new Map<number, RawLine>();
  const push = (kind: ExpWarn['kind'], ref: RefInfo, sourceType: SourceKind, refId: number | null, text: string, field: ConvField | null = null): ExpWarn => {
    const w: ExpWarn = { kind, text, where: ref.name, sourceType, refId, unitId: ref.unitId, field };
    warnings.push(w);
    return w;
  };

  const addRaw = (pid: number, q: number, lineVia: string[]) => {
    if (!(q > 0)) return; // нулевой/неизвестный расход не засоряет итоговую потребность
    const p = ctx.products.find((x) => x.id === pid);
    const cur = raw.get(pid);
    if (cur) {
      cur.qty += q;
      for (const v of lineVia) if (!cur.via.includes(v)) cur.via.push(v);
      return;
    }
    raw.set(pid, { productId: pid, name: p?.name ?? `#${pid}`, unitCode: p?.unitCode ?? '', qty: q, via: [...lineVia] });
  };

  // масштаб партии: сколько «заготовочных партий» нужно, чтобы получить outQty выхода
  const k = batchOut > 0 ? outQty / batchOut : 0;

  const walk = (edge: SemiEdge, key: string) => {
    const ref = refInfo(ctx, edge.sourceType, edge.refId);
    if (!ref) return;
    const q0 = Number(edge.qty ?? 0);
    if (!(q0 > 0)) {
      nodes.push({
        key,
        sourceType: edge.sourceType,
        refId: edge.refId,
        name: ref.name,
        unitCode: ref.unitCode,
        qty: 0,
        basis: 'количество входа не задано — расход неизвестен',
        via,
        children: [],
        warns: ['укажите количество входа в составе'],
        fixes: [],
        depth,
      });
      push('noQty', ref, edge.sourceType, edge.refId, 'не задано количество входа — расход неизвестен');
      return;
    }
    // количество входа в его собственной базовой единице
    let q = q0 * k;
    let inGrams = false;
    let basis = `на партию ${trimNum(q0)} ${ref.unitCode}`;
    if (k !== 1) basis += ` × (${trimNum(outQty)} ÷ партия ${trimNum(batchOut)})`;
    const y = Number(edge.yieldPct ?? 0);
    if (y > 0 && y < 100) {
      const dim = ref.unitId == null ? undefined : ctx.units.find((u) => u.id === ref.unitId)?.dimension;
      const g = ref.conv.gPerPcs != null && Number(ref.conv.gPerPcs) > 0 ? Number(ref.conv.gPerPcs) : null;
      if (dim === 'count' && g != null) {
        // потери при обработке штучного входа — отношение масс: штуки делить на «÷ 90 %» нельзя
        q = (q * g) / (y / 100);
        inGrams = true;
        basis += ` ÷ свой выход ${trimNum(y)} % (потери по массе)`;
      } else {
        if (dim === 'count' && g == null) {
          // вход штучный, «грамм в 1 шт» нет — честное деление штук, молчать нельзя
          warnings.push({
            kind: 'yieldPcs',
            text: 'свой выход после обработки при штучном входе считается по массе — задайте «грамм в 1 шт» входа, иначе расход делит штуки',
            where: ref.name,
            sourceType: edge.sourceType,
            refId: edge.refId,
            unitId: ref.unitId,
            field: 'gPerPcs',
          });
        }
        q = q / (y / 100);
        basis += ` ÷ свой выход ${trimNum(y)} %`;
      }
    }
    // число уже в базовой единице входа (или в граммах) → toInputQty сводит к канону входа
    const conv = toInputQty(ctx, q, ref.unitId, ref, inGrams);
    const warns: string[] = [];
    const fixes: ExpWarn[] = [];
    if (conv.warn) {
      warns.push(conv.warn.text);
      fixes.push(push('conv', ref, edge.sourceType, edge.refId, conv.warn.text, conv.warn.field));
    }
    const node: ExpNode = {
      key,
      sourceType: edge.sourceType,
      refId: edge.refId,
      name: ref.name,
      unitCode: ref.unitCode,
      qty: conv.qty,
      basis,
      via,
      children: [],
      warns,
      fixes,
      depth,
    };
    nodes.push(node);

    if (edge.sourceType === 'raw') {
      if (edge.refId != null) addRaw(edge.refId, conv.qty, via);
      return;
    }
    if (edge.refId == null) return;
    if (pathIds.has(edge.refId)) {
      node.warns.push('цикл: заготовка уже в этой цепочке — не раскрываем');
      push('cycle', ref, edge.sourceType, edge.refId, 'цикл в составе — не раскрываем');
      return;
    }
    const sub = ctx.semis.find((s) => s.id === edge.refId);
    if (!sub) {
      node.warns.push('вложенная заготовка не найдена');
      return;
    }
    if (depth + 1 >= MAX_DEPTH) {
      node.warns.push(`слишком глубокая вложенность (>${MAX_DEPTH} уровней) — раскрытие остановлено`);
      push('depth', ref, edge.sourceType, edge.refId, `слишком глубокая вложенность (>${MAX_DEPTH} уровней)`);
      return;
    }
    const subEdges = edgesOfSemi(sub);
    const child = expandComposition(
      ctx,
      subEdges,
      conv.qty,
      Number(sub.outQty) || 1,
      new Set([...pathIds, edge.refId]),
      [...via, sub.name],
      depth + 1
    );
    node.children = child.nodes;
    for (const [, line] of childRaw(child)) {
      addRaw(line.productId, line.qty, [...via, sub.name]);
    }
    for (const w of child.warnings) warnings.push(w);
  };

  edges.forEach((e, i) => walk(e, `e${i}`));

  return {
    nodes,
    raw: [...raw.values()].sort((x, y) => x.name.localeCompare(y.name, 'ru')),
    warnings,
    ready: nodes.length > 0 && outQty > 0,
  };
}

/** Сырьевые строки раскрытия (для всплывающего объединения по веткам). */
function childRaw(exp: Expansion): Map<number, RawLine> {
  const m = new Map<number, RawLine>();
  for (const r of exp.raw) m.set(r.productId, r);
  return m;
}

/* ================= поиск / фильтры / сортировка ================= */

/** Нормализация для поиска: регистр, ё/е, диакритика, лишние пробелы. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Первый вход состава — только для показа в каталоге (ролей больше нет). */
export function semiPrimary(s: Semi): Semi['inputs'][number] | undefined {
  return s.inputs[0];
}

/** Поиск по названию, компонентам состава и описанию. */
export function semiMatches(s: Semi, q: string): boolean {
  const nq = norm(q);
  if (!nq) return true;
  if (norm(s.name).includes(nq)) return true;
  if (norm(s.note || '').includes(nq)) return true;
  return s.inputs.some((i) => norm(i.name || '').includes(nq));
}

export type SortMode = 'name' | 'name-desc' | 'components' | 'incomplete';

export const SORT_LABELS: Record<SortMode, string> = {
  name: 'по названию (А→Я)',
  'name-desc': 'по названию (Я→А)',
  components: 'больше компонентов сначала',
  incomplete: 'сначала неполные ⚠',
};

export function sortSemis(list: Semi[], mode: SortMode): Semi[] {
  const arr = [...list];
  switch (mode) {
    case 'name-desc':
      return arr.sort((a, b) => b.name.localeCompare(a.name, 'ru'));
    case 'components':
      return arr.sort((a, b) => b.inputs.length - a.inputs.length || a.name.localeCompare(b.name, 'ru'));
    case 'incomplete':
      return arr.sort((a, b) => (incompleteOf(b) ? 1 : 0) - (incompleteOf(a) ? 1 : 0) || a.name.localeCompare(b.name, 'ru'));
    default:
      return arr.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }
}

/** Чем заготовка «неполна» — для бейджа в каталоге и фильтра. */
export function incompleteOf(s: Semi): string | null {
  if (!s.inputs.length) return 'пустой состав';
  if (!(Number(s.outQty) > 0)) return 'не задан размер партии';
  const gone = s.inputs.find((i) => !i.name);
  if (gone) return 'компонент удалён из номенклатуры';
  const bad = s.inputs.find((i) => !(Number(i.qty) > 0));
  if (bad) return `у входа «${bad.name || '?'}» не задано количество`;
  return null;
}

/* ================= циклы ================= */

/**
 * Можно ли ссылаться на заготовку `targetId` из заготовки `draftId`:
 * false, если target прямо или опосредованно содержит draft (иначе — цикл).
 */
export function pickableAsInput(ctx: SemiCtx, draftId: number | null, targetId: number): boolean {
  if (draftId != null && (targetId === draftId || dependsOn(ctx, targetId, draftId))) return false;
  return true;
}

/** Зависит ли `semiId` (в составе, с любой глубиной) от `targetId`. */
export function dependsOn(ctx: SemiCtx, semiId: number, targetId: number): boolean {
  if (semiId === targetId) return false;
  const visited = new Set<number>();
  const stack: number[] = [semiId];
  while (stack.length) {
    const cur = stack.pop()!;
    const s = ctx.semis.find((x) => x.id === cur);
    if (!s) continue;
    for (const i of s.inputs) {
      if (i.sourceType !== 'semi' || i.refId == null) continue;
      if (i.refId === targetId) return true;
      if (!visited.has(i.refId)) {
        visited.add(i.refId);
        stack.push(i.refId);
      }
    }
  }
  return false;
}

/** Кто использует заготовку `semiId` в своём составе. */
export function usedBySemis(ctx: SemiCtx, semiId: number): Semi[] {
  return ctx.semis.filter((s) => s.id !== semiId && s.inputs.some((i) => i.sourceType === 'semi' && i.refId === semiId));
}

/* ================= валидация ================= */

export interface Issue {
  /** Ключ поля: name | unitId | outQty | in{i}:ref | in{i}:qty | in{i}:yield | in{i}:dup */
  field: string;
  message: string;
}

/**
 * Клиентские правила = серверным (routes/semis.ts parseInputs) + модели БД: блокируем
 * только то, что отверг бы сервер. Все входы равноправны — нет «основного продукта»,
 * у каждого своё количество на партию и свой необязательный выход после обработки.
 */
export function validateDraft(ctx: SemiCtx, d: SemiDraft): Issue[] {
  const out: Issue[] = [];
  if (!d.name.trim()) out.push({ field: 'name', message: 'Укажите название заготовки' });
  if (!d.unitId) out.push({ field: 'unitId', message: 'Выберите единицу выхода' });
  else {
    const u = ctx.units.find((x) => x.id === d.unitId);
    if (u && u.baseFactor !== 1) out.push({ field: 'unitId', message: 'Хранение только в базовых единицах (г/мл/шт)' });
  }
  if (!(Number(d.outQty) > 0)) out.push({ field: 'outQty', message: 'Размер партии должен быть больше 0' });

  const seen = new Map<string, number>();
  d.inputs.forEach((a, i) => {
    if (a.refId == null) {
      if (Number(a.qty) > 0) out.push({ field: `in${i}:ref`, message: 'Укажите компонент для этой строки' });
      return;
    }
    if (!refInfo(ctx, a.sourceType, a.refId)) {
      out.push({ field: `in${i}:ref`, message: 'Компонент не найден в справочнике — выберите заново' });
      return;
    }
    const key = `${a.sourceType}:${a.refId}`;
    if (seen.has(key)) {
      out.push({ field: `in${i}:dup`, message: 'Такой компонент уже в составе — объедините строки' });
    } else seen.set(key, i);

    const q = Number(a.qty);
    if (!(q > 0)) out.push({ field: `in${i}:qty`, message: 'Количество на партию должно быть больше 0' });
    if (a.yieldPct != null && Number(a.yieldPct) !== 0) {
      const y = Number(a.yieldPct);
      if (y <= 0 || y > 100) out.push({ field: `in${i}:yield`, message: 'Выход после обработки — в (0, 100] или пусто' });
    }
    if (a.sourceType === 'semi' && d.id != null && !pickableAsInput(ctx, d.id, a.refId)) {
      out.push({ field: `in${i}:ref`, message: 'Цикл: эта заготовка уже входит в состав выбранной' });
    }
  });
  return out;
}

/** Только предупреждения, не блокирующие сохранение (несовместимые размерности и т.п.). */
export function draftWarnings(ctx: SemiCtx, d: SemiDraft): string[] {
  if (!d.unitId || !(Number(d.outQty) > 0)) return [];
  const warns: string[] = [];
  const edges = edgesOfDraft(d);
  const batchOut = Number(d.outQty) || 1;
  const exp = expandComposition(
    ctx,
    edges,
    batchOut,
    batchOut,
    d.id != null ? new Set([d.id]) : new Set(),
    [],
    0
  );
  for (const w of exp.warnings) warns.push(warnText(w));
  return [...new Set(warns)];
}

/**
 * Сохранённая заготовка → payload для PATCH /api/semis/:id с точечной правкой коэффициента.
 * Состав отдаётся как есть (абсолютные количества на партию), чтобы правка плотности
 * не могла изменить рецептуру.
 */
export function semiBodyOf(
  s: Semi,
  patch: Partial<Record<ConvField, number | null>> = {},
  aiModel?: string | null
): Record<string, unknown> {
  return {
    name: s.name,
    note: s.note,
    unitId: s.unitId,
    outQty: Number(s.outQty) || 1,
    shelfLifeDays: s.shelfLifeDays ?? null,
    gPerPcs: patch.gPerPcs !== undefined ? patch.gPerPcs : s.gPerPcs ?? null,
    mlPerPcs: patch.mlPerPcs !== undefined ? patch.mlPerPcs : s.mlPerPcs ?? null,
    gPerMl: patch.gPerMl !== undefined ? patch.gPerMl : s.gPerMl ?? null,
    inputs: s.inputs.map((i) => ({
      sourceType: i.sourceType,
      refId: i.refId,
      qty: Number(i.qty),
      yieldPct: i.yieldPct != null && Number(i.yieldPct) > 0 && Number(i.yieldPct) < 100 ? Number(i.yieldPct) : null,
    })),
    ...(aiModel ? { aiModel } : {}),
  };
}

/* ================= форматирование ================= */

export const trimNum = (n: number): string => String(Math.round(n * 1000) / 1000);

export function unitCodeOf(ctx: SemiCtx, unitId: number | null): string {
  return unitId == null ? '' : ctx.units.find((u) => u.id === unitId)?.code ?? '';
}

/** Знаменатель удобной шкалы добавок: 1 кг / 1 л / 1000 шт — по размерности единицы выхода. */
export function outDenom(ctx: SemiCtx, unitId: number | null): string {
  const u = unitId == null ? undefined : ctx.units.find((x) => x.id === unitId);
  if (!u) return '1000 ед.';
  if (u.dimension === 'mass') return '1 кг';
  if (u.dimension === 'volume') return '1 л';
  return '1000 шт';
}

/** Быстрые пресеты целевого объёма партии — в базовых единицах выхода. */
export function batchPresets(ctx: SemiCtx, unitId: number | null): { label: string; qty: number }[] {
  const u = unitId == null ? undefined : ctx.units.find((x) => x.id === unitId);
  if (u && u.dimension === 'count') {
    return [
      { label: '10 шт', qty: 10 },
      { label: '100 шт', qty: 100 },
      { label: '1000 шт', qty: 1000 },
    ];
  }
  const unit = u && u.dimension === 'volume' ? 'л' : 'кг';
  return [
    { label: `1 ${unit}`, qty: 1000 },
    { label: `10 ${unit}`, qty: 10000 },
    { label: `100 ${unit}`, qty: 100000 },
  ];
}

/** Человекочитаемое количество из базовых единиц (только отображение). */
export function fmtBase(qty: number, unitCode: string): string {
  const abs = Math.abs(qty);
  if (unitCode === 'г') return abs >= 1000 ? `${trimNum(abs / 1000)} кг` : `${trimNum(abs)} г`;
  if (unitCode === 'мл') return abs >= 1000 ? `${trimNum(abs / 1000)} л` : `${trimNum(abs)} мл`;
  return `${trimNum(abs)} ${unitCode}`;
}

/** Количество ровно как посчитано, в базовой единице — без укрупнения в кг/л. */
export function fmtExact(qty: number, unitCode: string): string {
  return `${trimNum(qty)} ${unitCode}`.trim();
}
