import { Unit } from './models';

/**
 * Клиентское зеркало серверного пересчёта размерностей (server/src/services/expansion.ts).
 * Граф из трёх узлов mass(г) / volume(мл) / count(шт) с рёбрами из парных коэффициентов;
 * отсутствие прямого ребра выводится через третий узел. Используется в живых предпросмотрах
 * конструктора полуфабрикатов и выбора единиц в техкартах, чтобы не показывать неверные числа.
 */
export interface Conv {
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
}

export type Dim = 'mass' | 'volume' | 'count';

export const NO_CONV: Conv = { gPerPcs: null, mlPerPcs: null, gPerMl: null };

const DIMS: Dim[] = ['mass', 'volume', 'count'];

/** Базовая размерность единицы по её id (null — единица неизвестна). */
export function dimOf(units: Unit[], unitId: number | null | undefined): Dim | null {
  const d = unitId == null ? undefined : units.find((u) => u.id === unitId)?.dimension;
  return d === 'mass' || d === 'volume' || d === 'count' ? d : null;
}

function pos(n: number | null | undefined): number | null {
  return n != null && n > 0 && isFinite(n) ? n : null;
}

/** Прямое ребро графа: множитель из базовой dimFrom в базовую dimTo (или null). */
function directEdge(a: Dim, b: Dim, conv: Conv): number | null {
  if (a === 'count' && b === 'mass') return pos(conv.gPerPcs);
  if (a === 'mass' && b === 'count') { const g = pos(conv.gPerPcs); return g ? 1 / g : null; }
  if (a === 'count' && b === 'volume') return pos(conv.mlPerPcs);
  if (a === 'volume' && b === 'count') { const m = pos(conv.mlPerPcs); return m ? 1 / m : null; }
  if (a === 'mass' && b === 'volume') { const d = pos(conv.gPerMl); return d ? 1 / d : null; }
  if (a === 'volume' && b === 'mass') return pos(conv.gPerMl);
  return null;
}

/** Перевод между размерностями по коэффициентам; null — пути нет (без исключения, для UI). */
export function convertAcross(dimFrom: Dim, dimTo: Dim, amount: number, conv: Conv): number | null {
  if (dimFrom === dimTo) return amount;
  const d = directEdge(dimFrom, dimTo, conv);
  if (d != null) return amount * d;
  for (const mid of DIMS) {
    if (mid === dimFrom || mid === dimTo) continue;
    const x = directEdge(dimFrom, mid, conv);
    const y = directEdge(mid, dimTo, conv);
    if (x != null && y != null) return amount * x * y;
  }
  return null;
}

/**
 * Как серверный toBaseCross: qty из fromUnitId в базовые единицы toUnitId.
 * Та же размерность — только base_factor; иная — нужен conv. null, если путь не найден.
 */
export function toBaseClient(
  units: Unit[],
  qty: number,
  fromUnitId: number | null,
  toUnitId: number | null,
  conv?: Conv | null
): number | null {
  const u = fromUnitId == null ? undefined : units.find((x) => x.id === fromUnitId);
  const b = toUnitId == null ? undefined : units.find((x) => x.id === toUnitId);
  if (!u || !b) return null;
  const base = qty * u.baseFactor;
  if (u.dimension === b.dimension) return base / b.baseFactor;
  if (!conv) return null;
  const crossed = convertAcross(u.dimension, b.dimension, base, conv);
  return crossed == null ? null : crossed / b.baseFactor;
}

/** Размерности, доступные из from (каноничная + достижимые по коэффициентам). */
export function reachableDims(from: Dim, conv: Conv): Set<Dim> {
  const seen = new Set<Dim>([from]);
  const stack: Dim[] = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nb of DIMS) {
      if (nb !== cur && !seen.has(nb) && directEdge(cur, nb, conv) != null) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return seen;
}
