/**
 * Слепки строк заказов.
 *
 * Пока дата доставки впереди, отчёт и каталог показывают живые данные фасовок:
 * офис ещё может менять цены и названия. Как только дата наступила
 * (delivery_date <= сегодня), строка фиксируется в store_order_items и больше
 * не перезаписывается — прошлые документы не пересчитываются.
 */
import { pool } from '../db';

/** Зафиксировать цены строк заказов, чья дата доставки уже наступила. */
export async function freezeOrderPrices(): Promise<number> {
  const { rowCount } = await pool.query(
    `update store_order_items i
        set price_snapshot = pk.price,
            cost_snapshot  = pk.cost,
            basis_snapshot = pk.price_basis,
            snapshot_at    = now()
       from store_orders o, prod_packagings pk
      where i.order_id = o.id
        and pk.id = i.packaging_id
        and o.delivery_date <= current_date
        and i.price_snapshot is null`
  );
  return rowCount ?? 0;
}

/** Дозаполнить названия и единицы для строк, где ценовой слепок уже стоит. */
export async function freezeOrderNames(): Promise<number> {
  const { rowCount } = await pool.query(
    `update store_order_items i
        set name_snapshot      = coalesce(pk.title, tc.name),
            name_en_snapshot   = coalesce(nullif(btrim(pk.title_en), ''), tc.name_en),
            name_sr_snapshot   = coalesce(nullif(btrim(pk.title_sr), ''), tc.name_sr),
            qty_base_snapshot  = pk.qty_base,
            dimension_snapshot = u.dimension
       from store_orders o, prod_packagings pk
       join prod_nodes tc on tc.id = pk.node_id
       join units u on u.id = tc.unit_id
      where i.order_id = o.id
        and pk.id = i.packaging_id
        and o.delivery_date <= current_date
        and i.name_snapshot is null`
  );
  return rowCount ?? 0;
}

/** Обе части слепка: цены и названия. Возвращает число затронутых строк. */
export async function freezeOrderSnapshots(): Promise<number> {
  const prices = await freezeOrderPrices();
  const names = await freezeOrderNames();
  return prices + names;
}
