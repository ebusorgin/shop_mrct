/**
 * Пересчёт количеств заказа между «печатной» единицей строки (кг/л/порц/шт) и
 * базовой единицей CRM (г/мл/шт). Общая для оформления заказа, доски производства,
 * сводки точек и отгрузочных документов.
 */

/** Единицы-«штуки»: порции/штуки (пересчёт в граммы — через вес порции техкарты). */
const COUNT_UNITS = new Set(['шт', 'порц', 'порция', 'порции', 'des']);

/**
 * Пересчёт «печатного» количества в базовые единицы CRM (кг->г, порц->г и т.п.).
 * portionQty — грамм/мл на одну порцию техкарты; нужен, когда заказ считает порциями,
 * а карточка хранится в г/мл.
 */
export function toBase(qty: number, printedUnit: string, baseUnitCode: string, portionQty = 0): number {
  const mass = { г: 1, кг: 1000, т: 1_000_000 } as Record<string, number>;
  const vol = { мл: 1, л: 1000 } as Record<string, number>;
  if (COUNT_UNITS.has(printedUnit)) {
    if (baseUnitCode === 'шт') return qty;
    if ((baseUnitCode === 'г' || baseUnitCode === 'мл') && portionQty > 0) return qty * portionQty;
    return qty;
  }
  if (baseUnitCode === 'шт') return qty;
  if (baseUnitCode === 'г') return qty * (mass[printedUnit] ?? 1);
  if (baseUnitCode === 'мл') return qty * (vol[printedUnit] ?? 1);
  return qty;
}

/** Минимальный набор полей, нужный для обратного пересчёта (OrderItem удовлетворяет структурно). */
export interface PrintedQtyInput {
  qty: number;
  unitCode: string | null;
  cardUnit: string | null;
  portionQty: number;
}

/**
 * Обратное к toBase: «печатное» количество из базового (г/мл/шт).
 * Нужно для стоимости: VK задаётся за печатную единицу (за кг / за порцию).
 * Общая для сводки заказов и агрегатов раздела «Точки продаж».
 */
export function printedQty(it: PrintedQtyInput): number {
  const base = it.cardUnit ?? it.unitCode ?? 'г';
  const shown = it.unitCode ?? base;
  if (COUNT_UNITS.has(shown)) {
    if (base === 'шт' || it.portionQty <= 0) return it.qty;
    return it.qty / it.portionQty; // порц: г -> кол-во порций
  }
  const massVol: Record<string, number> = { г: 1, кг: 1000, мл: 1, л: 1000 };
  if (base === 'шт') return it.qty;
  const f = massVol[shown];
  return f ? it.qty / f : it.qty;
}
