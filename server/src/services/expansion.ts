import { PoolClient } from 'pg';
import { ApiError } from '../http';

/** Карта единиц: unit_id -> {dimension, base_factor} */
type UnitsMap = Map<number, { dimension: string; factor: number }>;

export async function loadUnits(client: PoolClient): Promise<UnitsMap> {
  const { rows } = await client.query('select id, dimension, base_factor::float8 as f from units');
  return new Map(rows.map((r) => [r.id, { dimension: r.dimension, factor: Number(r.f) }]));
}

/** Парные коэффициенты пересчёта между размерностями одного товара (NULL = связь не задана). */
export interface ProdConv {
  gPerPcs: number | null; // грамм в 1 штуке (count<->mass)
  mlPerPcs: number | null; // мл в 1 штуке (count<->volume)
  gPerMl: number | null; // грамм в 1 мл, плотность (mass<->volume)
}

export async function loadProductConv(client: PoolClient): Promise<Map<number, ProdConv>> {
  const { rows } = await client.query(
    'select id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from products'
  );
  return new Map(
    rows.map((r) => [
      r.id as number,
      {
        gPerPcs: r.gp == null ? null : Number(r.gp),
        mlPerPcs: r.mp == null ? null : Number(r.mp),
        gPerMl: r.gm == null ? null : Number(r.gm),
      },
    ])
  );
}

/** Те же парные коэффициенты, но для ВЫХОДА полуфабриката (semi_products). */
export async function loadSemiConv(client: PoolClient): Promise<Map<number, ProdConv>> {
  const { rows } = await client.query(
    'select id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from semi_products'
  );
  return new Map(
    rows.map((r) => [
      r.id as number,
      {
        gPerPcs: r.gp == null ? null : Number(r.gp),
        mlPerPcs: r.mp == null ? null : Number(r.mp),
        gPerMl: r.gm == null ? null : Number(r.gm),
      },
    ])
  );
}

/** Контекст раскрытия техкарты: единицы + коэффициенты сырья и полуфабрикатов. */
interface ExpCtx {
  client: PoolClient;
  units: UnitsMap;
  prodConv: Map<number, ProdConv>;
  semiConv: Map<number, ProdConv>;
}

const DIM_LABEL: Record<string, string> = { mass: 'г', volume: 'мл', count: 'шт' };
const DIMS = ['mass', 'volume', 'count'] as const;
type Dim = (typeof DIMS)[number];

/** Прямое ребро графа размерностей: множитель из базовой dimFrom в базовую dimTo (или null). */
function directEdge(a: Dim, b: Dim, conv: ProdConv): number | null {
  const pos = (n: number | null) => (n != null && n > 0 && isFinite(n) ? n : null);
  if (a === 'count' && b === 'mass') return pos(conv.gPerPcs);
  if (a === 'mass' && b === 'count') { const g = pos(conv.gPerPcs); return g ? 1 / g : null; }
  if (a === 'count' && b === 'volume') return pos(conv.mlPerPcs);
  if (a === 'volume' && b === 'count') { const m = pos(conv.mlPerPcs); return m ? 1 / m : null; }
  if (a === 'mass' && b === 'volume') { const d = pos(conv.gPerMl); return d ? 1 / d : null; }
  if (a === 'volume' && b === 'mass') return pos(conv.gPerMl);
  return null;
}

/** Человекочитаемо — какого коэффициента не хватает для перевода. */
function missingConvMsg(a: Dim, b: Dim): string {
  const need =
    (a === 'count' && b === 'mass') || (a === 'mass' && b === 'count')
      ? '«грамм в 1 штуке»'
      : (a === 'count' && b === 'volume') || (a === 'volume' && b === 'count')
        ? '«мл в 1 штуке» (или «г в 1 штуке» + «г в 1 мл»)'
        : '«грамм в 1 мл (плотность)»';
  return `Нельзя перевести «${DIM_LABEL[a]}» в «${DIM_LABEL[b]}»: у товара нет коэффициента ${need} — задайте его в номенклатуре`;
}

/**
 * Перевод количества из базовой единицы одной размерности в базовую другой по коэффициентам товара.
 * amount — уже в базовой единице dimFrom (г/мл/шт). Прямое ребро, иначе через третий узел.
 */
export function convertAcross(dimFrom: string, dimTo: string, amount: number, conv: ProdConv): number {
  if (dimFrom === dimTo) return amount;
  const a = dimFrom as Dim;
  const b = dimTo as Dim;
  const d = directEdge(a, b, conv);
  if (d != null) return amount * d;
  for (const mid of DIMS) {
    if (mid === a || mid === b) continue;
    const x = directEdge(a, mid, conv);
    const y = directEdge(mid, b, conv);
    if (x != null && y != null) return amount * x * y;
  }
  throw new ApiError(400, missingConvMsg(a, b));
}

/**
 * Перевод количества в базовые единицы целевой единицы с учётом размерности.
 * Внутри одной размерности — как раньше (qty × фактор). Кросс-размерность (шт<->г<->мл) возможна
 * только при переданном conv товара; иначе — ошибка. `conv` отсутствует => прежнее поведение toBase.
 */
export function toBaseCross(
  qty: number,
  fromUnitId: number,
  toUnitId: number,
  units: UnitsMap,
  conv?: ProdConv | null
): number {
  const u = units.get(fromUnitId);
  const b = units.get(toUnitId);
  if (!u || !b) throw new ApiError(400, `Неизвестная единица измерения`);
  const base = qty * u.factor; // в базовой единице размерности from
  if (u.dimension === b.dimension) return base / b.factor;
  if (!conv) throw new ApiError(400, `Нельзя перевести «${DIM_LABEL[u.dimension] ?? u.dimension}» в «${DIM_LABEL[b.dimension] ?? b.dimension}»`);
  return convertAcross(u.dimension, b.dimension, base, conv) / b.factor;
}

/** Обратная совместимость: старый вызов без коэффициентов = только внутри одной размерности. */
export function toBase(qty: number, unitId: number, baseUnitId: number, units: UnitsMap): number {
  return toBaseCross(qty, unitId, baseUnitId, units);
}

/**
 * Применить выход после обработки (потери при обработке) к количеству ВЫХОДА.
 *
 * Выход после обработки — это отношение масс (или объёмов): при чистке и варке уходит масса, а не «штуки».
 * Пока выход в г/мл делить можно и нужно. Если же выход заготовки — штуки, то «÷ 90 %»
 * над штуками утверждает, что 10 % яиц истаяло, и даёт абсурд вида «1.111 яйца на 1 яйцо».
 * Поэтому для штук выход после обработки применяем в массе: штуки выхода × «грамм в 1 шт» заготовки ÷ выход после обработки
 * = граммы входа (inGrams=true), и ЭТУ массу переводим в единицу входа по её собственному
 * «грамм в 1 шт». Без коэффициента честного пути нет — тогда считаем по-старому (делим штуки),
 * но расчёт помечается как требующий коэффициент.
 */
function applyYield(
  outQtyBase: number,
  yieldPct: number,
  semiUnitId: number,
  semiConv: ProdConv | undefined,
  units: UnitsMap
): { qty: number; inGrams: boolean } {
  const y = yieldPct / 100;
  const dim = units.get(semiUnitId)?.dimension;
  const gPerPcs = semiConv?.gPerPcs != null && semiConv.gPerPcs > 0 ? Number(semiConv.gPerPcs) : null;
  if (dim === 'count' && gPerPcs != null && y > 0 && y < 1) {
    // штуки выхода → граммы выхода → граммы входа (÷ выход после обработки по массе); число остаётся в г,
    // обратного деления на gPerPcs здесь нет — его делает перевод в единицу входа
    return { qty: (outQtyBase * gPerPcs) / y, inGrams: true };
  }
  return { qty: outQtyBase / y, inGrams: false };
}

/** id базовой единицы массы (г) — стартовая точка для перевода граммов входа. */
function massUnitId(units: UnitsMap): number | null {
  for (const [id, u] of units) if (u.dimension === 'mass') return id;
  return null;
}

export interface RawNeed {
  productId: number;
  qty: number; // базовые единицы продукта
}

/** Проверка: единица — базовая для своего измерения (г/мл/шт, base_factor = 1). */
export async function assertBaseUnit(client: PoolClient, unitId: number, what: string): Promise<void> {
  const { rows } = await client.query('select code, base_factor::float8 as f from units where id = $1', [unitId]);
  if (!rows.length) throw new ApiError(400, `Неизвестная единица измерения`);
  if (Number(rows[0].f) !== 1) {
    throw new ApiError(400, `${what}: хранение только в базовых единицах (г/мл/шт), а не «${rows[0].code}»`);
  }
}

/**
 * Раскрывает позиции техкарты (кол-во на порцию × порции) в ЧИСТОЕ сырьё со склада.
 * Рекурсия: полуфабрикат может состоять из других полуфабрикатов — разворачиваем цепочку
 * до листовых сырьевых продуктов с учётом выхода после обработки/очистки на каждом уровне.
 *   base-вход:    нужно входа = количество выхода / (yield_pct/100)
 *   additive-вход: нужно входа = количество выхода * qty_per_output
 *                  (если у добавки задан yield_pct — её собственный выход после обработки: делим на yield_pct/100)
 * Выход после обработки делит не штуки: если выход заготовки в штуках, потери считаются по массе
 * (см. applyYield). Для г/мл выхода формулы остаются ровно такими же, как были.
 */
export async function expandCard(
  client: PoolClient,
  cardId: number,
  portions: number
): Promise<RawNeed[]> {
  const units = await loadUnits(client);
  const prodConv = await loadProductConv(client);
  const semiConv = await loadSemiConv(client);
  const ctx: ExpCtx = { client, units, prodConv, semiConv };

  const { rows: itemRows } = await client.query(
    `select i.source_type, i.ref_id, i.qty::float8 as qty, i.unit_id,
            coalesce(p.unit_id, su.unit_id) as ref_unit_id
       from tech_card_items i
       left join products p on i.source_type = 'raw'  and p.id = i.ref_id
       left join semi_products su on i.source_type = 'semi' and su.id = i.ref_id
      where i.card_id = $1
      order by i.position, i.id`,
    [cardId]
  );
  if (itemRows.length === 0) throw new ApiError(400, 'В техкарте нет позиций');

  const need = new Map<number, number>();
  const add = (productId: number, qty: number) =>
    need.set(productId, (need.get(productId) ?? 0) + qty);

  for (const it of itemRows) {
    const conv = it.source_type === 'raw' ? prodConv.get(it.ref_id) : semiConv.get(it.ref_id);
    // Рубеж 1: позиция карты (в любой размерности) -> базовая единица выхода товара/полуфабриката.
    const qtyBase = toBaseCross(it.qty, it.unit_id, it.ref_unit_id, units, conv) * portions;
    if (it.source_type === 'raw') {
      add(it.ref_id, qtyBase);
    } else {
      await resolveSemi(ctx, it.ref_id, qtyBase, it.ref_unit_id, add, new Set([it.ref_id]));
    }
  }

  return [...need.entries()].map(([productId, qty]) => ({ productId, qty: round3(qty) }));
}

/** Composition of one semi (may reference raw or other semis). */
interface SemiInputRow {
  source_type: 'raw' | 'semi';
  ref_id: number;
  role: 'base' | 'additive';
  yield_pct: number | null;
  qpo: number | null;
  in_unit_id: number; // каноничная единица входа (товара или дочернего полуфабриката)
}

async function loadSemiInputs(client: PoolClient, semiId: number): Promise<SemiInputRow[]> {
  const { rows } = await client.query(
    `select si.source_type, si.ref_id, si.role,
            si.yield_pct::float8 as yield_pct, si.qty_per_output::float8 as qpo,
            coalesce(p.unit_id, sub.unit_id) as in_unit_id
       from semi_inputs si
       left join products p on si.source_type = 'raw'  and p.id = si.ref_id
       left join semi_products sub on si.source_type = 'semi' and sub.id = si.ref_id
      where si.semi_id = $1`,
    [semiId]
  );
  return rows;
}

/**
 * Рекурсивно разворачивает полуфабрикат `semiId` (нужно `outQtyBase` баз. ед. его ВЫХОДА `semiUnitId`)
 * в листовые сырьевые продукты через колбэк `add`.
 * Рубеж 2: доля входа в размерности выхода переводится в каноничную единицу входа
 * (сырьё — conv продукта, вложенный semi — conv дочернего semi) через toBaseCross.
 * `path` — множество semi_products на текущей ветке (защита от циклов).
 */
async function resolveSemi(
  ctx: ExpCtx,
  semiId: number,
  outQtyBase: number,
  semiUnitId: number,
  add: (productId: number, qty: number) => void,
  path: Set<number>
): Promise<void> {
  const inputs = await loadSemiInputs(ctx.client, semiId);
  const base = inputs.find((x) => x.role === 'base');
  if (!base) throw new ApiError(400, `У полуфабриката #${semiId} не задан базовый вход с выходом после обработки`);
  // коэффициенты самой заготовки — они переводят «штуки выхода» в массу, на которую и вешается выход после обработки
  const selfConv = ctx.semiConv.get(semiId);

  const feed = async (inp: SemiInputRow, qOutDim: number, inGrams = false) => {
    if (!inp.in_unit_id) {
      throw new ApiError(400, `У полуфабриката #${semiId}: вход #${inp.ref_id} не связан с единицей измерения`);
    }
    const tConv = inp.source_type === 'raw' ? ctx.prodConv.get(inp.ref_id) : ctx.semiConv.get(inp.ref_id);
    // число в граммах (выход после обработки по массе) → переводим из размерности mass, а не из единицы выхода
    const fromUnitId = inGrams ? massUnitId(ctx.units) ?? semiUnitId : semiUnitId;
    const qTarget = toBaseCross(qOutDim, fromUnitId, inp.in_unit_id, ctx.units, tConv);
    if (inp.source_type === 'raw') {
      add(inp.ref_id, qTarget);
      return;
    }
    if (path.has(inp.ref_id)) {
      throw new ApiError(400, 'Обнаружен цикл в составе полуфабрикатов');
    }
    await resolveSemi(ctx, inp.ref_id, qTarget, inp.in_unit_id, add, new Set([...path, inp.ref_id]));
  };

  const baseY = Number(base.yield_pct);
  if (!(baseY > 0)) throw new ApiError(400, `У полуфабриката #${semiId}: не задан выход после обработки базового входа`);
  const baseYield = applyYield(outQtyBase, baseY, semiUnitId, selfConv, ctx.units);
  await feed(base, baseYield.qty, baseYield.inGrams);
  for (const inp of inputs.filter((x) => x.role === 'additive')) {
    const q = outQtyBase * Number(inp.qpo);
    const own = Number(inp.yield_pct);
    // свой выход добавки — тоже потери массы, считаем его в той же размерности выхода
    const ay = own > 0 && own < 100 ? applyYield(q, own, semiUnitId, selfConv, ctx.units) : { qty: q, inGrams: false };
    await feed(inp, ay.qty, ay.inGrams);
  }
}

/**
 * Раскрытие одного полуфабриката в чистое сырьё (для предпросмотра в конструкторе).
 * `outputQtyBase` — сколько базовых единиц заготовки хотим получить (в единице выхода semi).
 */
export async function expandSemi(
  client: PoolClient,
  semiId: number,
  outputQtyBase: number
): Promise<RawNeed[]> {
  const units = await loadUnits(client);
  const prodConv = await loadProductConv(client);
  const semiConv = await loadSemiConv(client);
  const ctx: ExpCtx = { client, units, prodConv, semiConv };
  const { rows } = await client.query('select unit_id from semi_products where id = $1', [semiId]);
  if (!rows.length) throw new ApiError(404, 'Полуфабрикат не найден');
  const need = new Map<number, number>();
  const add = (productId: number, qty: number) =>
    need.set(productId, (need.get(productId) ?? 0) + qty);
  await resolveSemi(ctx, semiId, outputQtyBase, rows[0].unit_id, add, new Set([semiId]));
  return [...need.entries()].map(([productId, qty]) => ({ productId, qty: round3(qty) }));
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
