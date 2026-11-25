import { Router } from 'express';
import { pool } from '../db';
import { wrap } from '../http';
import { nearExpiryRows } from '../services/stock-expiry';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  wrap(async (req, res) => {
    // полные списки (страница «Сроки годности») просят больше строк; панель по умолчанию компактна
    const expiryLimit = Math.min(500, Number(req.query.expiryLimit) || 30);
    const [stock, today, low, recentWriteoffs, waybills, nearExpiry] = await Promise.all([
      pool.query(`
        select count(*) filter (where s.qty > 0)::int as "productsInStock",
               coalesce(sum(s.qty * s.avg_cost), 0)::float8 as "stockValue"
          from stock s join materials p on p.id = s.product_id and p.active`),
      // выпуск партий больше не ведётся: «отгрузки сегодня» — ручные списания по доставке
      pool.query(`
        select count(*)::int as "todayBatches",
               coalesce(sum(cost_total), 0)::float8 as "todayCost"
          from store_delivery_writeoffs
         where delivery_date = current_date`),
      pool.query(`
        select p.name, u.code as "unitCode", s.qty::float8 as qty, p.min_stock::float8 as "minStock"
          from stock s
          join materials p on p.id = s.product_id and p.active and p.min_stock > 0
          join units u on u.id = p.unit_id
         where s.qty < p.min_stock
         order by s.qty - p.min_stock
         limit 20`),
      pool.query(`
        select w.id,
               coalesce(s.code, 'Все магазины') as "cardName",
               w.positions as portions,
               to_char(w.delivery_date, 'YYYY-MM-DD') as "batchDate",
               'posted'::text as status,
               w.cost_total::float8 as "costTotal"
          from store_delivery_writeoffs w
          left join stores s on s.id = w.store_id
         order by w.delivery_date desc, w.id desc
         limit 10`),
      pool.query(`
        select count(*)::int as cnt, coalesce(sum(i.qty * i.price), 0)::float8 as total
          from waybills w left join waybill_items i on i.waybill_id = w.id
         where w.doc_date >= date_trunc('month', current_date) and w.status <> 'reversed'`),
      nearExpiryRows(expiryLimit),
    ]);
    res.json({
      stock: stock.rows[0],
      today: today.rows[0],
      lowStock: low.rows,
      recentBatches: recentWriteoffs.rows,
      monthWaybills: waybills.rows[0],
      nearExpiry,
    });
  })
);
