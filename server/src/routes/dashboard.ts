import { Router } from 'express';
import { pool } from '../db';
import { wrap } from '../http';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  wrap(async (req, res) => {
    // полные списки (страница «Сроки годности») просят больше строк; панель по умолчанию компактна
    const expiryLimit = Math.min(500, Number(req.query.expiryLimit) || 30);
    const [stock, today, low, recentBatches, waybills, pendingOrders, nearExpiry] = await Promise.all([
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
      // Ожидают обработки: позиции ближайшего листа каждого магазина, ещё не принятые производством
      // (synced / placed). Отмены и собранное не считаем.
      pool.query(`
        select o.store_id as "storeId", st.name as "storeName",
               max(o.date_tab)::text as "dateTab", count(*)::int as cnt
          from orders o
          join stores st on st.id = o.store_id and st.active
         where o.status in ('synced', 'placed')
           and o.date_tab = (select max(o2.date_tab) from orders o2
                              where o2.store_id = o.store_id and o2.status in ('synced', 'placed'))
         group by o.store_id, st.name
        order by count(*) desc`),
      // Сроки годности по партиям (FIFO). Партий в хранении нет, поэтому остаток склада
      // раскладываем по приходам от самых ранних: расход (и отрицательные корректировки)
      // сначала «съедает» самую старую партию. Так новая партия не продлевает старую и
      // просрочка не показывается на уже выбранное сырьё. Только чтение — модель не меняем.
      pool.query(
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
           join products p on p.id = bt.product_id and p.active
           join units u on u.id = p.unit_id
          where p.shelf_life_days is not null
            and bt.remaining > 0
            and bt.d + make_interval(days => p.shelf_life_days) <= current_date + 3
          order by bt.d + make_interval(days => p.shelf_life_days) asc
          limit $1`,
        [expiryLimit]
      ),
    ]);
    res.json({
      stock: stock.rows[0],
      today: today.rows[0],
      lowStock: low.rows,
      recentBatches: recentBatches.rows,
      monthWaybills: waybills.rows[0],
      pendingOrders: pendingOrders.rows,
      nearExpiry: nearExpiry.rows,
    });
  })
);
