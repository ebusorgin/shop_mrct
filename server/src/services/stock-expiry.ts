import { pool } from '../db';

export interface NearExpiryRow {
  productId: number;
  name: string;
  unitCode: string;
  qty: number;
  receiptDate: string;
  expiryDate: string;
  expiryDays: number;
  status: 'expired' | 'soon';
}

/**
 * Сроки годности по партиям прихода: остаток склада раскладывается по накладным FIFO.
 * Только чтение; используется панелью и вкладкой «Сроки годности» склада.
 */
export async function nearExpiryRows(limit = 200): Promise<NearExpiryRow[]> {
  const { rows } = await pool.query<NearExpiryRow>(
    `with r as (
       select i.product_id, w.doc_date as d,
              coalesce(sum(i.qty), 0)::numeric as q
         from waybill_items i
         join waybills w on w.id = i.waybill_id and w.status <> 'reversed'
        group by i.product_id, w.doc_date
     ),
     m as (
       select product_id, d,
              greatest(0, -coalesce(sum(delta), 0)) as q
         from (select product_id, created_at::date as d, qty as delta
                 from movements where type = 'writeoff'
               union all
               select product_id, created_at::date as d, -qty as delta
                 from movements where type = 'adjustment' and qty < 0) x
        group by product_id, d
     ),
     u as (
       select product_id, d, q, 0::int as src from r
       union all
       select product_id, d, q, 1::int as src from m
     ),
     w as (
       select product_id, d, q, src,
              coalesce(sum(q) filter (where src = 1)
                         over (partition by product_id order by d, src
                               rows between unbounded preceding and 1 preceding), 0) as cum_before
         from u
     ),
     b as (
       select product_id, d, q, src, cum_before,
              coalesce(sum(q) filter (where src = 0)
                         over (partition by product_id order by d, src
                               rows between unbounded preceding and 1 preceding), 0) as cum_in
         from w
     ),
     batch as (
       select b.product_id, b.d, b.q,
              greatest(0, least(b.q, coalesce(s.qty, 0) - (b.cum_in - b.cum_before)))::float8 as remaining
         from b
         left join stock s on s.product_id = b.product_id
        where b.src = 0
     )
     select p.id as "productId",
            p.name,
            u.code as "unitCode",
            bt.remaining as qty,
            to_char(bt.d, 'YYYY-MM-DD') as "receiptDate",
            to_char(bt.d + make_interval(days => p.shelf_life_days), 'YYYY-MM-DD') as "expiryDate",
            (bt.d + make_interval(days => p.shelf_life_days))::date - current_date as "expiryDays",
            case when bt.d + make_interval(days => p.shelf_life_days) <= current_date
                 then 'expired' else 'soon' end as status
       from batch bt
       join materials p on p.id = bt.product_id and p.active
       join units u on u.id = p.unit_id
      where p.shelf_life_days is not null
        and bt.remaining > 0
        and bt.d + make_interval(days => p.shelf_life_days) <= current_date + 3
      order by bt.d + make_interval(days => p.shelf_life_days) asc
      limit $1`,
    [limit]
  );
  return rows;
}
