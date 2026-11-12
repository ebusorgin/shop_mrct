import { PoolClient } from 'pg';
import { ApiError, reqObject, reqStr } from '../http';
import { expandCard, RawNeed } from './expansion';

export interface PackagingInput {
  id?: number;
  name: string;
  /** Минимальный ненулевой заказ и его кратность; не ограничивает preview/производство. */
  orderStep: number;
  isDefault: boolean;
  items: { productId: number; qty: number }[];
}

export interface Packaging extends PackagingInput {
  id: number;
  items: { productId: number; qty: number; productName: string; unitCode: string; avgCost: number; stockQty: number }[];
}

export function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ApiError(400, `${field}: требуется конечное число > 0`);
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
  const result = raw.map((entry): PackagingInput => {
    const p = reqObject(entry);
    const id = p.id === undefined ? undefined : positiveInt(p.id, 'packaging.id');
    if (id !== undefined) {
      if (ids.has(id)) throw new ApiError(400, 'Повторный id фасовки');
      ids.add(id);
    }
    if (typeof p.isDefault !== 'boolean') throw new ApiError(400, 'isDefault: требуется boolean');
    if (!Array.isArray(p.items)) throw new ApiError(400, 'packaging.items: требуется массив');
    const products = new Set<number>();
    const items = p.items.map((entry) => {
      const item = reqObject(entry);
      const productId = positiveInt(item.productId, 'productId');
      if (products.has(productId)) throw new ApiError(400, 'Компонент тары повторяется в фасовке');
      products.add(productId);
      return { productId, qty: positiveNumber(item.qty, 'component.qty') };
    });
    return {
      ...(id === undefined ? {} : { id }),
      name: reqStr(p, 'name')
      orderStep: positiveInt(p.orderStep, 'orderStep'),
      isDefault: p.isDefault,
      items,
    };
  });
  if (result.length && result.filter((p) => p.isDefault).length !== 1) {
    throw new ApiError(400, 'У фасовок должна быть ровно одна фасовка по умолчанию');
  }
  return result;
}

/** Только фиксированные SQL-фрагменты. Витрина намеренно НЕ запрашивает состав/склад/цены. */
export function packagingsSql(withItems: boolean): string {
  return `coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pk.id, 'name', pk.name, pk.qty_base,
      'orderStep', pk.order_step, 'isDefault', pk.is_default
      ${withItems ? `, 'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'productId', pi.product_id, 'qty', pi.qty, 'productName', p.name,
          'unitCode', u.code, 'avgCost', coalesce(s.avg_cost, 0), 'stockQty', coalesce(s.qty, 0)
        ) order by pi.product_id)
        from product_packaging_items pi
        join products p on p.id = pi.product_id
        join units u on u.id = p.unit_id
        left join stock s on s.product_id = p.id
        where pi.packaging_id = pk.id
      ), '[]'::jsonb)` : ''}
    ) order by pk.id)
    from product_packagings pk where pk.card_id = tc.id
  ), '[]'::jsonb)`;
}

export async function loadPackagings(client: PoolClient, cardId: number): Promise<Packaging[]> {
  const { rows } = await client.query(
    `select ${packagingsSql(true)} as packagings from tech_cards tc where tc.id = $1`, [cardId]
  );
  return rows[0]?.packagings ?? [];
}

/** Снимок определения; текущие остатки/цены не являются редактированием фасовки. */
export function packagingSnapshot(packagings: Packaging[]) {
  return packagings.map((p) => ({
    ...p, items: p.items.map(({ avgCost, stockQty, ...item }) => item),
  }));
}

export async function validatePackagingRefs(client: PoolClient, packagings: PackagingInput[], unitId: number): Promise<void> {
  if (!packagings.length) return;
  const { rows: units } = await client.query('select dimension from units where id = $1', [unitId]);
  if (!units.length) throw new ApiError(400, 'Единица выхода не найдена');

  const ids = [...new Set(packagings.flatMap((p) => p.items.map((i) => i.productId)))].sort((a, b) => a - b);
  if (!ids.length) return;
  const { rows } = await client.query(
    `select id from products where id = any($1::int[]) order by id for share`, [ids]
  );
  const existing = new Set<number>(rows.map((p) => p.id));
  for (const id of ids) {
    if (!existing.has(id)) throw new ApiError(400, `Компонент тары #${id} не найден`);
  }
}

/** Вызывать внутри транзакции с блокировкой техкарты. Существующие id не меняются. */
export async function savePackagings(client: PoolClient, cardId: number, packagings: PackagingInput[], unitId: number): Promise<void> {
  const { rows } = await client.query('select id from product_packagings where card_id = $1 order by id', [cardId]);
  const owned = new Set<number>(rows.map((p) => p.id));
  for (const p of packagings) {
    if (p.id !== undefined && !owned.has(p.id)) throw new ApiError(400, 'Фасовка не принадлежит этой техкарте');
  }
  await validatePackagingRefs(client, packagings, unitId);
  const keep = packagings.flatMap((p) => p.id === undefined ? [] : [p.id]);
  await client.query('delete from product_packagings where card_id = $1 and not (id = any($2::int[]))', [cardId, keep]);
  // Смена default не конфликтует с уникальным частичным индексом.
  await client.query('update product_packagings set is_default = false where card_id = $1', [cardId]);
  for (const p of packagings) {
    let id = p.id;
    const values = [cardId, p.name, p.orderStep, p.isDefault];
    if (id === undefined) {
      const { rows: added } = await client.query(
        `insert into product_packagings (card_id, name, qty_base, order_step, is_default)
         values ($1,$2,$3,$4,$5) returning id`, values
      );
      id = added[0].id;
    } else {
      await client.query(
        `update product_packagings set name=$2, qty_base=$3, order_step=$4, is_default=$5
         where card_id=$1 and id=$6`, [...values, id]
      );
      await client.query('delete from product_packaging_items where packaging_id = $1', [id]);
    }
    for (const item of p.items) {
      await client.query(
        'insert into product_packaging_items (packaging_id, product_id, qty) values ($1,$2,$3)',
        [id, item.productId, item.qty]
      );
    }
  }
}

export interface PackagingSnapshot {
  name: string;
  qtyBase: number;
  unitCode: string;
}

/** Только внешняя фасовка: рекурсивные tech_card остаются без тары. */
export async function expandPackagedCard(client: PoolClient, cardId: number, count: number, packagingId: number): Promise<{
  need: RawNeed[]; packaging: PackagingSnapshot;
}> {
  positiveInt(count, 'Количество упаковок');
  positiveInt(packagingId, 'packagingId');
  // PATCH карточки использует FOR UPDATE: определение и его состав читаются согласованно.
  const { rows: cards } = await client.query(
    `select tc.portion_qty::float8 as "portionQty", u.code as "unitCode"
       from tech_cards tc join units u on u.id = tc.portion_unit_id
      where tc.id = $1 for share of tc`, [cardId]
  );
  if (!cards.length) throw new ApiError(404, 'Продукт не найден');
  const { rows } = await client.query(
    `select name, qty_base::float8 as "qtyBase" from product_packagings where id = $1 and card_id = $2`,
    [packagingId, cardId]
  );
  if (!rows.length) throw new ApiError(400, 'Фасовка не принадлежит этой техкарте');
  const packaging = { name: rows[0].name, qtyBase: Number(rows[0].qtyBase), unitCode: cards[0].unitCode };
  const portions = count * packaging.qtyBase / positiveNumber(Number(cards[0].portionQty), 'Выход техкарты');
  positiveNumber(portions, 'Пересчитанное количество порций');
  const ingredients = await expandCard(client, cardId, portions);
  const { rows: components } = await client.query(
    'select product_id as "productId", qty::float8 as qty from product_packaging_items where packaging_id = $1 order by product_id',
    [packagingId]
  );
  const need = new Map<number, number>();
  for (const item of [...ingredients, ...components.map((i) => ({ productId: i.productId, qty: i.qty * count }))]) {
    const qty = (need.get(item.productId) ?? 0) + item.qty;
    if (!Number.isFinite(qty)) throw new ApiError(400, 'Расход фасовки вне допустимого диапазона');
    need.set(item.productId, qty);
  }
  return { packaging, need: [...need].map(([productId, qty]) => ({ productId, qty })) };
}
