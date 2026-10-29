import { Product, Semi, Unit } from './models';
import { Conv, Dim, toBaseClient } from './units';

/**
 * Чистая (без Angular) логика раздела «Полуфабрикаты»: модель состава, раскрытие
 * потребности в сырье, валидация, поиск/фильтрация каталога.
 *
 * Формулы — точное зеркало серверного server/src/services/expansion.ts (resolveSemi):
 *   base:     нужно входа = количество выхода ÷ (yield_pct / 100)
 *   additive: нужно входа = количество выхода × qty_per_output ÷ (yield_pct / 100)
 * Выход после обработки — отношение МАСС, а не штук: при выходе заготовки в штуках потери считаются
 * через «грамм в 1 шт» самой заготовки (applyYield), иначе «÷ 90 %» делил бы яйца.
 * Никаких своих домыслов: выход НЕ равняется сумме входящих, размерности переводятся
 * только по заданным коэффициентам (g_per_pcs / ml_per_pcs / g_per_ml).
 *
 * Шкала добавок: БД хранит долю на 1 базовую единицу выхода; в UI — на 1000 (кг/л/1000 шт).
 * Здесь SemiEdge.qtyPerOutput — именно UI-шкала (×1000), как и в черновике компонента.
 */

export type SourceKind = 'raw' | 'semi';

/** Ребро состава в шкале редактора (qtyPerOutput — на 1000 баз. ед. выхода). */
export interface SemiEdge {
  sourceType: SourceKind;
  refId: number | null;
  role: 'base' | 'additive';
  yieldPct: number | null;
  qtyPerOutput: number | null;
}

/** Черновик заготовки в редакторе (id = null — новая). */
export interface SemiDraft {
  id: number | null;
  name: string;
  note: string;
  unitId: number | null;
  shelfLifeDays: number | null;
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
  base: { sourceType: SourceKind; refId: number | null; yieldPct: number | null };
  additives: { sourceType: SourceKind; refId: number | null; qtyPerOutput: number | null; yieldPct: number | null }[];
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

/** Состав из БД → рёбра в UI-шкале (×1000 для qty_per_output). */
export function edgesOfSemi(s: Semi): SemiEdge[] {
  return s.inputs.map((i) => ({
    sourceType: i.sourceType,
    refId: i.refId,
    role: i.role,
    yieldPct: i.yieldPct != null ? Number(i.yieldPct) : null,
    qtyPerOutput: i.qtyPerOutput != null ? Number(i.qtyPerOutput) * 1000 : null,
  }));
}

/** Черновик → рёбра (пустые строки добавок в расчёт не входят). */
export function edgesOfDraft(d: SemiDraft): SemiEdge[] {
  const edges: SemiEdge[] = [
    { sourceType: d.base.sourceType, refId: d.base.refId, role: 'base', yieldPct: d.base.yieldPct, qtyPerOutput: null },
  ];
  for (const a of d.additives) {
    if (a.refId == null) continue;
    edges.push({ sourceType: a.sourceType, refId: a.refId, role: 'additive', yieldPct: a.yieldPct, qtyPerOutput: a.qtyPerOutput });
  }
  return edges;
}

export const baseEdge = (edges: SemiEdge[]): SemiEdge | undefined => edges.find((e) => e.role === 'base' && e.refId != null);
export const additiveEdges = (edges: SemiEdge[]): SemiEdge[] => edges.filter((e) => e.role === 'additive' && e.refId != null);

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
 * kind=yieldPcs ⇒ выход после обработки повис в штуках: не хватает «грамм в 1 шт» самой заготовки,
 * у которой выход в штуках (лечится в блоке A того же редактора, не в номенклатуре).
 */
export interface ExpWarn {
  kind: 'conv' | 'cycle' | 'noBase' | 'noYield' | 'noQty' | 'depth' | 'yieldPcs' | 'yieldMass';
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
 * Перевести количество из размерности выхода заготовки в каноничную единицу входа.
 * Возвращает { qty, warn } — warn ставится, когда пути пересчёта нет (число остаётся
 * в размерности выхода, как это делал старый превью; молча подменять коэффициент не будем).
 */
export function toInputQty(
  ctx: SemiCtx,
  qtyOutDim: number,
  semiUnitId: number | null,
  ref: RefInfo,
  inGrams = false
): { qty: number; warn: { text: string; field: ConvField | null } | null } {
  // выход после обработки по массе: число уже в граммах, поэтому переводим из размерности mass,
  // а не из единицы выхода (иначе граммы читались бы как штуки).
  const fromUnitId = inGrams ? massUnitId(ctx) ?? semiUnitId : semiUnitId;
  const converted = toBaseClient(ctx.units, qtyOutDim, fromUnitId, ref.unitId, ref.conv);
  if (converted != null) return { qty: converted, warn: null };
  const from = (inGrams ? 'mass' : ctx.units.find((u) => u.id === semiUnitId)?.dimension) as Dim | undefined;
  const to = ctx.units.find((u) => u.id === ref.unitId)?.dimension as Dim | undefined;
  if (from && to && from !== to) {
    const hint = missingConvHint(from, to);
    return { qty: qtyOutDim, warn: { text: hint.text, field: hint.field } };
  }
  return { qty: qtyOutDim, warn: { text: 'единица входа не задана', field: null } };
}

/** id базовой единицы массы (г) — стартовая точка для перевода граммов входа. */
function massUnitId(ctx: SemiCtx): number | null {
  return ctx.units.find((u) => u.dimension === 'mass')?.id ?? null;
}

/**
 * Выход после обработки к количеству в размерности выхода — зеркало серверного applyYield.
 * Пока выход в г/мл, «÷ выход после обработки» честный. Если выход в штуках, делить штуки нельзя
 * (это значит «10 % яиц истаяло»), поэтому потери вешаются на МАССУ выхода:
 * штуки × «грамм в 1 шт» заготовки ÷ выход после обработки = граммы входа, и ЭТА масса дальше
 * переводится в единицу входа (её собственный «грамм в 1 шт»). Возвращаем и то,
 * в какой размерности число, чтобы toInputQty не пытался читать граммы как штуки.
 */
export function applyYield(
  ctx: SemiCtx,
  qty: number,
  yieldPct: number,
  semiUnitId: number | null
): { qty: number; inGrams: boolean; needed: boolean } {
  const y = yieldPct / 100;
  const dim = semiUnitId == null ? undefined : ctx.units.find((u) => u.id === semiUnitId)?.dimension;
  return { qty: qty / y, inGrams: false, needed: dim === 'count' && y > 0 && y < 1 };
}

/* ================= раскрытие состава ================= */

/** Узел дерева потребности (один вход заготовки; для semi — со своими детьми). */
export interface ExpNode {
  key: string;
  sourceType: SourceKind;
  refId: number | null;
  name: string;
  role: 'base' | 'additive';
  unitCode: string;
  /** Количество в каноничной единице входа (или в размерности выхода, если пересчёта нет). */
  qty: number;
  /** Как считалось — явная база расчёта для пользователя. */
  basis: string;
  /** Цепочка вложенных заготовок, через которые встал этот расход. */
  via: string[];
  children: ExpNode[];
  /** Предупреждение по узлу: цикл, нет пересчёта размерности, нет base-входа. */
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
 * Полное раскрытие состава на `outQty` баз. ед. ВЫХОДА заготовки `semiUnitId`.
 * `pathIds` — id заготовок на текущей ветке (защита от циклов), `via` — их названия.
 * `selfConv`/`selfRef` — коэффициенты и ссылка на САМУ заготовку: они нужны, чтобы выход после обработки
 * при выходе в штуках считать по массе (для черновика их в справочнике нет — передаём вручную).
 */
export function expandComposition(
  ctx: SemiCtx,
  edges: SemiEdge[],
  outQty: number,
  semiUnitId: number | null,
  pathIds: Set<number> = new Set(),
  via: string[] = [],
  depth = 0,
  selfConv: Conv | null = null,
  selfRef: { sourceType: SourceKind; refId: number; name: string } | null = null
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

  /**
   * Предупреждение о том, что выход после обработки некуда повесить: у заготовки выход в штуках,
   * а «грамм в 1 шт» самой заготовки нет. Число остаётся старым (деление штук),
   * поэтому молчать нельзя.
   */
  const warnYieldInPcs = (fallback: RefInfo): void => {
    const target = selfRef ?? { sourceType: 'semi' as SourceKind, refId: null, name: fallback.name };
    const w: ExpWarn = {
      kind: 'yieldPcs',
      text: 'выход после обработки при выходе в штуках считается по массе — задайте «грамм в 1 шт» этой заготовки, иначе расход делит штуки',
      where: target.name,
      sourceType: target.sourceType,
      refId: target.refId,
      unitId: semiUnitId,
      field: 'gPerPcs',
    };
    warnings.push(w);
  };

  /** Выход после обработки с переходом в массу, если выход — штуки (зеркало сервера). byMass — для текста базы. */
  const yieldLoss = (qty: number, pct: number, fallback: RefInfo): { qty: number; byMass: boolean } => {
    const y = applyYield(ctx, qty, pct, semiUnitId);
    if (!y.needed) return { qty: y.qty, byMass: false };
    const g = selfConv?.gPerPcs;
    if (g == null || !(g > 0)) {
      warnYieldInPcs(fallback);
      return { qty: y.qty, byMass: false };
    }
    return { qty: (qty * g) / (pct / 100), byMass: true };
  };

  /**
   * Проверка согласованности для «шт → шт»: выход после обработки и разница «грамм в 1 шт» описывают
   * одну и ту же потерю. Если они противоречат друг другу (выход 90 %, а и сырьё, и
   * заготовка весят одинаково), потери считаются дважды и расход вырастает без смысла.
   */
  const checkMassConsistency = (edge: SemiEdge, ref: RefInfo): void => {
    if (edge.role !== 'base') return;
    const dim = semiUnitId == null ? undefined : ctx.units.find((u) => u.id === semiUnitId)?.dimension;
    if (dim !== 'count' || ref.unitId == null) return;
    if (ctx.units.find((u) => u.id === ref.unitId)?.dimension !== 'count') return;
    const semiG = selfConv?.gPerPcs;
    const inG = ref.conv.gPerPcs;
    if (!semiG || !inG) return;
    const y = Number(edge.yieldPct);
    // «грамм в 1 шт» входа и заготовки описывают одну и ту же массу. Если заготовка весит
    // столько же, сколько сырьё, потери уже сидят в весе — и объявленный выход < 100 %
    // считается второй раз. Это противоречие и показываем (число при этом остаётся верным).
    const implied = (semiG / inG) * 100;
    if (Math.abs(implied - y) <= 0.5) return;
    const target = selfRef ?? { sourceType: 'semi' as SourceKind, refId: null, name: ref.name };
    warnings.push({
      kind: 'yieldMass',
      text:
        `выход после обработки ${trimNum(y)} % не согласуется с «грамм в 1 шт»: ${trimNum(inG)} г входа дают ${trimNum(semiG)} г выхода, `
        + 'то есть потери уже учтены в весе. Либо задайте фактический вес заготовки, либо поставьте выход 100 %',
      where: target.name,
      sourceType: target.sourceType,
      refId: target.refId,
      unitId: semiUnitId,
      field: null,
    });
  };

  const walk = (edge: SemiEdge, key: string) => {
    const ref = refInfo(ctx, edge.sourceType, edge.refId);
    if (!ref) return;
    let qOut: number;
    let basis: string;
    let byMass = false;
    if (edge.role === 'base') {
      const y = Number(edge.yieldPct);
      if (!(y > 0)) {
        // выход после обработки не задан → деление на ноль; показываем причину вместо «Infinity»
        nodes.push({
          key,
          sourceType: edge.sourceType,
          refId: edge.refId,
          name: ref.name,
          role: edge.role,
          unitCode: ref.unitCode,
          qty: 0,
          basis: 'выход после обработки не задан — расход основного продукта неизвестен',
          via,
          children: [],
          warns: ['укажите выход после обработки в блоке B'],
          fixes: [],
          depth,
        });
        push('noYield', ref, edge.sourceType, edge.refId, 'не задан выход после обработки базового входа — расход неизвестен');
        return;
      }
      const yl = yieldLoss(outQty, y, ref);
      qOut = yl.qty;
      byMass = yl.byMass;
      basis = `весь выход ${trimNum(outQty)} ${unitCodeOf(ctx, semiUnitId)} ÷ ${yl.byMass ? 'потери по массе (выход после обработки ' + trimNum(y) + '%)' : 'выход после обработки ' + trimNum(y) + '%'}`;
    } else {
      qOut = (outQty * Number(edge.qtyPerOutput ?? 0)) / 1000;
      const own = Number(edge.yieldPct ?? 0);
      if (own > 0 && own < 100) {
        const yl = yieldLoss(qOut, own, ref);
        qOut = yl.qty;
        byMass = yl.byMass;
      }
      basis =
        own > 0 && own < 100
          ? `${trimNum(Number(edge.qtyPerOutput ?? 0))} на ${outDenom(ctx, semiUnitId)} × ${byMass ? 'потери по массе (' + trimNum(own) + '%)' : 'свой выход ' + trimNum(own) + '%'}`
          : `${trimNum(Number(edge.qtyPerOutput ?? 0))} на ${outDenom(ctx, semiUnitId)} выхода`;
      if (!(Number(edge.qtyPerOutput ?? 0) > 0)) {
        basis = 'норма добавки не задана — расход неизвестен';
        push('noQty', ref, edge.sourceType, edge.refId, 'не задан расход добавки');
      }
    }
    const conv = toInputQty(ctx, qOut, semiUnitId, ref, byMass);
    const warns: string[] = [];
    const fixes: ExpWarn[] = [];
    checkMassConsistency(edge, ref);
    if (conv.warn) {
      warns.push(conv.warn.text);
      fixes.push(push('conv', ref, edge.sourceType, edge.refId, conv.warn.text, conv.warn.field));
    }
    const node: ExpNode = {
      key,
      sourceType: edge.sourceType,
      refId: edge.refId,
      name: ref.name,
      role: edge.role,
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
    if (!baseEdge(subEdges)) {
      node.warns.push('у вложенной заготовки нет базового входа — расчёт невозможен');
      push('noBase', { name: sub.name, unitId: sub.unitId, unitCode: sub.unitCode, conv: convOf(sub) }, 'semi', sub.id, 'нет базового входа — расчёт невозможен');
      return;
    }
    const child = expandComposition(
      ctx,
      subEdges,
      conv.qty,
      sub.unitId,
      new Set([...pathIds, edge.refId]),
      [...via, sub.name],
      depth + 1,
      convOf(sub),
      { sourceType: 'semi', refId: sub.id, name: sub.name }
    );
    node.children = child.nodes;
    for (const [, line] of childRaw(child)) {
      addRaw(line.productId, line.qty, [...via, sub.name]);
    }
    for (const w of child.warnings) warnings.push(w);
  };

  const b = baseEdge(edges);
  if (b) walk(b, 'base');
  additiveEdges(edges).forEach((e, i) => walk(e, `a${i}`));

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

export function semiBase(s: Semi): Semi['inputs'][number] | undefined {
  return s.inputs.find((i) => i.role === 'base');
}

export function semiAdditives(s: Semi): Semi['inputs'] {
  return s.inputs.filter((i) => i.role === 'additive');
}

/** Поиск по названию, базовому входу, компонентам состава и описанию. */
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
  const b = semiBase(s);
  if (!b) return 'нет базового входа';
  if (!b.name) return 'базовый вход удалён из номенклатуры';
  const y = Number(b.yieldPct);
  if (!(y > 0 && y <= 100)) return 'не задан корректный выход';
  const bad = semiAdditives(s).find((a) => !(Number(a.qtyPerOutput) > 0));
  if (bad) return `у добавки «${bad.name || '?'}» не задан расход`;
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
  /** Ключ поля: name | unitId | base | baseYield | add{i}:qty | add{i}:yield | add{i}:ref | add{i}:dup */
  field: string;
  message: string;
}

/**
 * Клиентские правила = серверным (routes/semis.ts parseInputs) + модели БД (check-констрейнты):
 * блокируем только то, что отверг бы сервер. Выход >100% моделью не поддержан — но это
 * подсказка, а не «запрет без объяснения».
 */
export function validateDraft(ctx: SemiCtx, d: SemiDraft): Issue[] {
  const out: Issue[] = [];
  if (!d.name.trim()) out.push({ field: 'name', message: 'Укажите название заготовки' });
  if (!d.unitId) out.push({ field: 'unitId', message: 'Выберите единицу выхода' });
  else {
    const u = ctx.units.find((x) => x.id === d.unitId);
    if (u && u.baseFactor !== 1) out.push({ field: 'unitId', message: 'Хранение только в базовых единицах (г/мл/шт)' });
  }
  if (d.base.refId == null) {
    out.push({ field: 'base', message: 'Выберите основной продукт' });
  } else {
    const y = Number(d.base.yieldPct);
    if (!(y > 0)) out.push({ field: 'baseYield', message: 'Выход должен быть больше 0' });
    else if (y > 100)
      out.push({
        field: 'baseYield',
        message: 'Выход больше 100% моделью не поддерживается: добавочную влагу/массу показывайте отдельной добавкой',
      });
    if (!refInfo(ctx, d.base.sourceType, d.base.refId)) {
      out.push({ field: 'base', message: 'Основной продукт не найден в справочнике — выберите заново' });
    }
  }

  const seen = new Map<string, number>();
  const baseKey = `${d.base.sourceType}:${d.base.refId}`;
  if (d.base.refId != null) seen.set(baseKey, -1);

  d.additives.forEach((a, i) => {
    if (a.refId == null) {
      if (Number(a.qtyPerOutput) > 0) out.push({ field: `add${i}:ref`, message: 'Укажите компонент для этой строки' });
      return;
    }
    if (!refInfo(ctx, a.sourceType, a.refId)) {
      out.push({ field: `add${i}:ref`, message: 'Компонент не найден в справочнике — выберите заново' });
      return;
    }
    const key = `${a.sourceType}:${a.refId}`;
    if (seen.has(key)) {
      out.push({
        field: `add${i}:dup`,
        message: seen.get(key) === -1 ? 'Совпадает с основным продуктом — уберите строку' : 'Такой компонент уже в составе',
      });
    } else seen.set(key, i);

    const q = Number(a.qtyPerOutput);
    if (!(q > 0)) out.push({ field: `add${i}:qty`, message: 'Расход должен быть больше 0' });
    if (a.yieldPct != null && Number(a.yieldPct) !== 0) {
      const y = Number(a.yieldPct);
      if (y <= 0 || y > 100) out.push({ field: `add${i}:yield`, message: 'Свой выход после обработки — в (0, 100] или пусто' });
    }
    if (a.sourceType === 'semi' && d.id != null && !pickableAsInput(ctx, d.id, a.refId)) {
      out.push({ field: `add${i}:ref`, message: 'Цикл: эта заготовка уже входит в состав выбранной' });
    }
  });

  if (d.base.refId != null && d.base.sourceType === 'semi' && d.id != null && !pickableAsInput(ctx, d.id, d.base.refId)) {
    out.push({ field: 'base', message: 'Цикл: выбранная заготовка уже входит в состав этой' });
  }
  return out;
}

/** Только предупреждения, не блокирующие сохранение (несовместимые размерности и т.п.). */
export function draftWarnings(ctx: SemiCtx, d: SemiDraft): string[] {
  if (!d.unitId || d.base.refId == null) return [];
  const warns: string[] = [];
  const edges = edgesOfDraft(d);
  const exp = expandComposition(
    ctx,
    edges,
    1000,
    d.unitId,
    d.id != null ? new Set([d.id]) : new Set(),
    [],
    0,
    { gPerPcs: d.gPerPcs, mlPerPcs: d.mlPerPcs, gPerMl: d.gPerMl },
    d.id != null ? { sourceType: 'semi', refId: d.id, name: d.name } : null
  );
  for (const w of exp.warnings) warns.push(warnText(w));
  return [...new Set(warns)];
}

/**
 * Сохранённая заготовка → payload для PATCH /api/semis/:id с точечной правкой коэффициента.
 * Состав отдаётся как есть (шкала БД), чтобы правка плотности не могла изменить рецептуру.
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
    shelfLifeDays: s.shelfLifeDays ?? null,
    gPerPcs: patch.gPerPcs !== undefined ? patch.gPerPcs : s.gPerPcs ?? null,
    mlPerPcs: patch.mlPerPcs !== undefined ? patch.mlPerPcs : s.mlPerPcs ?? null,
    gPerMl: patch.gPerMl !== undefined ? patch.gPerMl : s.gPerMl ?? null,
    inputs: s.inputs.map((i) =>
      i.role === 'base'
        ? { sourceType: i.sourceType, refId: i.refId, role: 'base', yieldPct: Number(i.yieldPct) }
        : {
            sourceType: i.sourceType,
            refId: i.refId,
            role: 'additive',
            qtyPerOutput: Number(i.qtyPerOutput),
            yieldPct: i.yieldPct != null && Number(i.yieldPct) > 0 && Number(i.yieldPct) < 100 ? Number(i.yieldPct) : null,
          }
    ),
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
