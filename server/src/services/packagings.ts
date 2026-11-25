/** Выход упаковки для подписи: «3 кг», «200 г», «500 мл». */
export function packagingWeight(qtyBase: number, unitCode: string): string {
  const abs = Math.abs(qtyBase);
  const trim = (n: number) => String(Math.round(n * 1000) / 1000);
  if (unitCode === 'г') return abs >= 1000 ? `${trim(abs / 1000)} кг` : `${trim(abs)} г`;
  if (unitCode === 'мл') return abs >= 1000 ? `${trim(abs / 1000)} л` : `${trim(abs)} мл`;
  return `${trim(abs)} ${unitCode}`;
}

/**
 * Минимальный заказ в упаковках — целое число партий рецептуры.
 * Партия даёт ceil(выход / выход фасовки) упаковок; заказ поднимается
 * вверх до ближайшей целой партии, но не меньше одной.
 */
export function batchMinOrder(portionQty: number, qtyBase: number, minOrder: number): number {
  const requested = Math.max(1, Math.round(minOrder) || 1);
  if (!(portionQty > 0) || !(qtyBase > 0)) return requested;
  const batch = Math.max(1, Math.ceil(portionQty / qtyBase - 1e-9));
  return Math.max(batch, Math.ceil(requested / batch - 1e-9) * batch);
}

/** Размер из названия: граммы/миллилитры/штуки в базовой величине. */
function sizeOf(value: string): { value: number; dimension: string } | null {
  const match = value.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л|kg|g|шт)/);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  const unit = match[2];
  if (unit === 'кг' || unit === 'kg') return { value: amount * 1000, dimension: 'mass' };
  if (unit === 'л') return { value: amount * 1000, dimension: 'volume' };
  if (unit === 'г' || unit === 'гр' || unit === 'g') return { value: amount, dimension: 'mass' };
  if (unit === 'мл') return { value: amount, dimension: 'volume' };
  return { value: amount, dimension: 'count' };
}

/** Название позиции: «техкарта · фасовка», но без повтора размера, если он уже в названии техкарты. */
export function packagingLabel(cardName: string, packagingName: string): string {
  const flat = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '');
  const pk = flat(packagingName);
  if (!pk || flat(cardName).includes(pk)) return cardName;
  const cardSize = sizeOf(cardName);
  const pkSize = sizeOf(packagingName);
  if (cardSize && pkSize && cardSize.dimension === pkSize.dimension && Math.abs(cardSize.value - pkSize.value) < 1e-6) {
    return cardName;
  }
  return `${cardName} · ${packagingName}`;
}