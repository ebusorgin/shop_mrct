/**
 * Слепки цен строк заказов.
 *
 * Пока дата доставки впереди, отчёт и каталог показывают живые цены фасовок:
 * офис ещё может их менять. Как только дата наступила (delivery_date <= сегодня),
 * цены строк фиксируются в store_order_items (price/cost/basis_snapshot) и больше
 * не перезаписываются — прошлые документы не пересчитываются при смене цен.
 */
import { pool } from '../db';

/** Зафиксировать цены по всем строкам заказов, чья дата доставки уже наступила. */
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
