import { Router } from 'express';
import { pool } from '../db';
import { wrap } from '../http';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  wrap(async (_req, res) => {
    const [stock, today, low, recentBatches, waybills, nearExpiry] = await Promise.all([
      pool.query(`
        select count(*) filter (where s.qty > 0)::int as "productsInStock",
               coalesce(sum(s.qty * s.avg_cost), 0)::float8 as "stockValue"
          from stock s join products p on p.id = s.product_id and p.active`),
      pool.query(`
        select coalesce(sum(cost_total), 0)::float8 as "todayCost",
               count(*) filter (where status = 'posted')::int as "todayBatches"
          from production_batches where batch_date = current_date`),
      pool.query(`
        select p.name, u.code as "unitCode", s.qty::float8 as qty, p.min_stock::float8 as "minStock"
          from stock s
          join products p on p.id = s.product_id and p.active and p.min_stock > 0
          join units u on u.id = p.unit_id
         where s.qty < p.min_stock
         order by s.qty - p.min_stock
         limit 20`),
      pool.query(`
        select b.id, tc.name as "cardName", b.portions,
               to_char(b.batch_date, 'YYYY-MM-DD') as "batchDate", b.status,
               b.cost_total::float8 as "costTotal"
          from production_batches b
          join tech_cards tc on tc.id = b.card_id
         order by b.id desc limit 10`),
      pool.query(`
        select count(*)::int as cnt, coalesce(sum(i.qty * i.price), 0)::float8 as total
          from waybills w left join waybill_items i on i.waybill_id = w.id
         where w.doc_date >= date_trunc('month', current_date) and w.status <> 'reversed'`),
      // Скоро истекает срок годности: по приходам из проведённых накладных берём самую раннюю
      // дату прихода на позицию, к ней прибавляем shelf_life_days и сравниваем с сегодня.
      pool.query(`
        with receipts as (
          select i.product_id, min(w.doc_date) as first_date
            from waybill_items i
            join waybills w on w.id = i.waybill_id and w.status <> 'reversed'
           group by i.product_id
        )
        select p.name,
               u.code as "unitCode",
               coalesce(s.qty, 0)::float8 as qty,
               to_char(r.first_date, 'YYYY-MM-DD') as "receiptDate",
               to_char(r.first_date + make_interval(days => p.shelf_life_days), 'YYYY-MM-DD') as "expiryDate",
               case when r.first_date + make_interval(days => p.shelf_life_days) <= current_date
                    then 'expired' else 'soon' end as status
          from receipts r
          join products p on p.id = r.product_id and p.active
          join units u on u.id = p.unit_id
          left join stock s on s.product_id = p.id
         where p.shelf_life_days is not null
           and coalesce(s.qty, 0) > 0
           and r.first_date + make_interval(days => p.shelf_life_days) <= current_date + 3
         order by r.first_date + make_interval(days => p.shelf_life_days) asc
         limit 30`),
    ]);
    res.json({
      stock: stock.rows[0],
      today: today.rows[0],
      lowStock: low.rows,
      recentBatches: recentBatches.rows,
      monthWaybills: waybills.rows[0],
      nearExpiry: nearExpiry.rows,
    });
  })
);
