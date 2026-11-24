import { PoolClient } from 'pg';
import { ApiError } from '../http';

/** Карта единиц: unit_id -> {dimension, base_factor}. */
type UnitsMap = Map<number, { dimension: string; factor: number }>;

export async function loadUnits(client: PoolClient): Promise<UnitsMap> {
  const { rows } = await client.query('select id, dimension, base_factor::float8 as f from units');
  return new Map(rows.map((r) => [r.id, { dimension: r.dimension, factor: Number(r.f) }]));
}

/** Парные коэффициенты пересчёта между размерностями одного товара (NULL = связь не задана). */
export interface ProdConv {
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
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
 * Внутри одной размерности — qty × фактор. Кросс-размерность (шт<->г<->мл) возможна
 * только при переданном conv товара; иначе — ошибка.
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
  if (!u || !b) throw new ApiError(400, 'Неизвестная единица измерения');
  const base = qty * u.factor;
  if (u.dimension === b.dimension) return base / b.factor;
  if (!conv) {
    throw new ApiError(
      400,
      `Нельзя перевести «${DIM_LABEL[u.dimension] ?? u.dimension}» в «${DIM_LABEL[b.dimension] ?? b.dimension}»`
    );
  }
  return convertAcross(u.dimension, b.dimension, base, conv) / b.factor;
}

/** Проверка: единица — базовая для своего измерения (г/мл/шт, base_factor = 1). */
export async function assertBaseUnit(client: PoolClient, unitId: number, what: string): Promise<void> {
  const { rows } = await client.query('select code, base_factor::float8 as f from units where id = $1', [unitId]);
  if (!rows.length) throw new ApiError(400, 'Неизвестная единица измерения');
  if (Number(rows[0].f) !== 1) {
    throw new ApiError(400, `${what}: хранение только в базовых единицах (г/мл/шт), а не «${rows[0].code}»`);
  }
}
