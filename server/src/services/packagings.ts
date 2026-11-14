import { PoolClient } from 'pg';
import { ApiError, reqObject } from '../http';

export interface PackagingInput {
  id?: number;
  /** Выход одной упаковки в единице выхода техкарты. */
  qtyBase: number;
  /** Минимальный заказ в упаковках. */
  minOrder: number;
  /** Можно ли уже заказывать эту фасовку магазинам. */
  available: boolean;
  /** Цена за единицу измерения (кг / л / шт), RSD; 0 — не задана. */
  price: number;
}

export interface Packaging extends PackagingInput {
  id: number;
}

export function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ApiError(400, `${field}: требуется конечное число > 0`);
  }
  return value;
}

export function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ApiError(400, `${field}: требуется конечное число ≥ 0`);
  }
  return value;
}

export function positiveInt(value: unknown, field: string): number {
  const n = positiveNumber(value, field);
  if (!Number.isInteger(n) || n > 2147483647) {
    throw new ApiError(400, `${field}: требуется положительное целое в диапазоне int`);
  }
  return n;
}

export function parsePackagings(raw: unknown): PackagingInput[] {
  if (!Array.isArray(raw)) throw new ApiError(400, 'packagings: требуется массив');
  const ids = new Set<number>();
  const weights = new Set<string>();
  return raw.map((entry): PackagingInput => {
    const p = reqObject(entry);
    const id = p.id === undefined ? undefined : positiveInt(p.id, 'packaging.id');
    if (id !== undefined) {
      if (ids.has(id)) throw new ApiError(400, 'Повторный id фасовки');
      ids.add(id);
    }
    const qtyBase = positiveNumber(p.qtyBase, 'packaging.qtyBase');
    const key = String(Number(qtyBase.toFixed(6)));
    if (weights.has(key)) throw new ApiError(400, 'Фасовки с одинаковым выходом повторяются');
    weights.add(key);
    if (typeof p.available !== 'boolean') throw new ApiError(400, 'available: требуется boolean');
    return {
      ...(id === undefined ? {} : { id }),
      qtyBase,
      minOrder: positiveInt(p.minOrder, 'packaging.minOrder'),
      available: p.available,
      price: p.price === undefined || p.price === null ? 0 : nonNegativeNumber(p.price, 'packaging.price'),
    };
  });
}

/** Фасовка, которую получает техкарта без явного выбора: весь выход одной упаковкой. */
export function defaultPackaging(portionQty: number): PackagingInput {
  return { qtyBase: portionQty, minOrder: 1, available: true, price: 0 };
}

/** Внутреннее название фасовки для сопоставления: «1000 г», «3000 г». */
function packagingName(qtyBase: number, unitCode: string): string {
  return `${Number(qtyBase.toFixed(6))} ${unitCode}`;
}

/** Выход упаковки для подписи: «3 кг», «200 г», «500 мл». */
export function packagingWeight(qtyBase: number, unitCode: string): string {
  const abs = Math.abs(qtyBase);
  const trim = (n: number) => String(Math.round(n * 1000) / 1000);
  if (unitCode === 'г') return abs >= 1000 ? `${trim(abs / 1000)} кг` : `${trim(abs)} г`;
  if (unitCode === 'мл') return abs >= 1000 ? `${trim(abs / 1000)} л` : `${trim(abs)} мл`;
  return `${trim(abs)} ${unitCode}`;
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

/** Только фиксированные SQL-фрагменты; витрина фасовок не запрашивает состав. */
export function packagingsSql(): string {
  return `coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pk.id, 'qtyBase', pk.qty_base::float8,
      'minOrder', pk.min_order, 'available', pk.available,
      'price', pk.price::float8
    ) order by pk.qty_base, pk.id)
    from product_packagings pk where pk.card_id = tc.id
  ), '[]'::jsonb)`;
}

/**
 * Вызывать внутри транзакции с блокировкой техкарты. Существующие id не меняются.
 * Название фасовки выводится из выхода и единицы техкарты; по умолчанию — фасовка,
 * совпадающая с выходом (для старых связей Excel), иначе первая.
 */
export async function savePackagings(
  client: PoolClient,
  cardId: number,
  packagings: PackagingInput[],
  unitCode: string,
  portionQty: number
): Promise<void> {
  const { rows } = await client.query(
    'select id, qty_base::float8 as qty_base from product_packagings where card_id = $1 order by id',
    [cardId]
  );
  const owned = new Map<number, number>(rows.map((p) => [p.id as number, p.qty_base as number]));
  for (const p of packagings) {
    if (p.id !== undefined && !owned.has(p.id)) throw new ApiError(400, 'Фасовка не принадлежит этой техкарте');
  }
  // Клиент после создания строки может прислать фасовку без id: подхватываем существующую
  // с тем же выходом, чтобы повторное сохранение не плодило новые id (на них ссылаются связи Excel).
  const explicit = new Set(packagings.flatMap((p) => p.id === undefined ? [] : [p.id]));
  for (const p of packagings) {
    if (p.id !== undefined) continue;
    const key = Number(p.qtyBase.toFixed(6));
    const match = [...owned.entries()].find(([id, qty]) =>
      !explicit.has(id) && Math.abs(Number(qty.toFixed(6)) - key) < 1e-6
    );
    if (match) {
      p.id = match[0];
      explicit.add(match[0]);
    }
  }
  const keep = packagings.flatMap((p) => p.id === undefined ? [] : [p.id]);
  await client.query('delete from product_packagings where card_id = $1 and not (id = any($2::int[]))', [cardId, keep]);
  // Смена default не конфликтует с уникальным частичным индексом.
  await client.query('update product_packagings set is_default = false where card_id = $1', [cardId]);
  const saved: Array<{ id: number; qtyBase: number }> = [];
  for (const p of packagings) {
    const name = packagingName(p.qtyBase, unitCode);
    if (p.id === undefined) {
      const { rows: inserted } = await client.query(
        `insert into product_packagings (card_id, name, qty_base, min_order, available, is_default, price)
         values ($1,$2,$3,$4,$5,false,$6) returning id`,
        [cardId, name, p.qtyBase, p.minOrder, p.available, p.price]
      );
      saved.push({ id: Number(inserted[0].id), qtyBase: p.qtyBase });
    } else {
      await client.query(
        `update product_packagings set name=$2, qty_base=$3, min_order=$4, available=$5, price=$6
         where card_id=$1 and id=$7`,
        [cardId, name, p.qtyBase, p.minOrder, p.available, p.price, p.id]
      );
      saved.push({ id: p.id, qtyBase: p.qtyBase });
    }
  }
  const preferred = saved.find((p) => Math.abs(p.qtyBase - portionQty) < 1e-6) ?? saved[0];
  if (preferred) {
    await client.query('update product_packagings set is_default = true where id = $1', [preferred.id]);
  }
}
