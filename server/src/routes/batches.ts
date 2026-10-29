import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqInt, wrap } from '../http';
import { applyMovement } from '../services/stock';
import { expandCard } from '../services/expansion';
import { auditTx } from '../services/audit';

export const batchesRouter = Router();

/**
 * Отгрузка готовой продукции с производства:
 *  1) раскрываем техкарту (порции × состав) в чистое сырьё с учётом уварки/очистки;
 *  2) списываем со склада движениями writeoff по средневзвешенной себестоимости;
 *  3) фиксируем партию, её снимок состава и дату.
 */
batchesRouter.post(
  '/',
  wrap(async (req, res) => {
    const cardId = reqInt(req.body, 'cardId');
    const portions = reqInt(req.body, 'portions');
    const batchDate = typeof req.body.batchDate === 'string' ? req.body.batchDate : null;
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    if (portions <= 0) throw new ApiError(400, 'Порций должно быть > 0');

    const result = await tx(async (client) => {
      const { rows: cardInfo } = await client.query('select name from tech_cards where id = $1', [cardId]);
      if (!cardInfo.length) throw new ApiError(404, 'Техкарта не найдена');

      const need = await expandCard(client, cardId, portions);

      const { rows: batch } = await client.query(
        `insert into production_batches (card_id, portions, batch_date, note, created_by, created_login)
         values ($1,$2, coalesce($3::date, current_date), $4, $5, $6) returning id`,
        [cardId, portions, batchDate, note, req.user?.id ?? null, req.user?.login ?? 'system']
      );
      const batchId = batch[0].id as number;

      // блокировка строк склада (детерминированный порядок — против deadlock)
      const productIds = need.map((n) => n.productId).sort((a, b) => a - b);
      await client.query('select 1 from stock where product_id = any($1::int[]) for update', [productIds]);

      let costTotal = 0;
      const itemsOut: { productId: number; qty: number; unitCost: number; cost: number }[] = [];

      for (const n of need) {
        const { rows: st } = await client.query(
          'select avg_cost::float8 as c from stock where product_id = $1',
          [n.productId]
        );
        const unitCost: number = st[0]?.c ?? 0;
        const cost = unitCost * n.qty;
        costTotal += cost;

        await applyMovement(client, {
          productId: n.productId,
          type: 'writeoff',
          delta: -n.qty,
          unitCost,
          docType: 'batch',
          docId: batchId,
          actor: req.user,
          comment: `Расход: ${cardInfo[0].name} × ${portions} порц.`,
        });
        await client.query(
          'insert into production_batch_items (batch_id, product_id, qty, unit_cost) values ($1,$2,$3,$4)',
          [batchId, n.productId, n.qty, unitCost]
        );
        itemsOut.push({ productId: n.productId, qty: n.qty, unitCost, cost: Math.round(cost * 100) / 100 });
      }

      costTotal = Math.round(costTotal * 100) / 100;
      await client.query('update production_batches set cost_total = $2 where id = $1', [batchId, costTotal]);
      await auditTx(client, req.user, {
        action: 'post',
        entity: 'batch',
        entityId: batchId,
        title: `Партия · ${cardInfo[0].name} × ${portions}`,
        details: { cardId, portions, batchDate, costTotal, items: itemsOut.length },
      });
      return { id: batchId, costTotal, items: itemsOut };
    });

    res.status(201).json(result);
  })
);

batchesRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      select b.id, b.card_id as "cardId", tc.name as "cardName", b.portions,
             to_char(b.batch_date, 'YYYY-MM-DD') as "batchDate",
             b.cost_total::float8 as "costTotal", b.status, b.note,
             b.created_login as "createdLogin", b.created_at as "createdAt",
             coalesce(nullif(btrim(cu.full_name), ''), b.created_login) as "createdName",
             tc.portion_qty::float8 as "portionQty", pu.code as "portionUnitCode"
        from production_batches b
        join tech_cards tc on tc.id = b.card_id
        join units pu on pu.id = tc.portion_unit_id
        left join users cu on cu.id = b.created_by
       order by b.batch_date desc, b.id desc`);
    res.json(rows);
  })
);

batchesRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select i.product_id as "productId", p.name, u.code as "unitCode",
              i.qty::float8 as qty, i.unit_cost::float8 as "unitCost",
              (i.qty * i.unit_cost)::float8 as cost
         from production_batch_items i
         join products p on p.id = i.product_id
         join units u on u.id = p.unit_id
        where i.batch_id = $1
        order by p.name`,
      [Number(req.params.id)]
    );
    res.json(rows);
  })
);

/** Отмена партии: возврат сырья на склад по снимку состава. */
batchesRouter.post(
  '/:id/reverse',
  wrap(async (req, res) => {
    const batchId = Number(req.params.id);
    await tx(async (client) => {
      const { rows: st } = await client.query(
        `select tc.name, b.status, b.portions
           from production_batches b join tech_cards tc on tc.id = b.card_id
          where b.id = $1 for update of b`,
        [batchId]
      );
      if (!st.length) throw new ApiError(404, 'Партия не найдена');
      if (st[0].status === 'reversed') throw new ApiError(409, 'Партия уже отменена');

      const { rows: items } = await client.query(
        'select product_id, qty::float8 as qty from production_batch_items where batch_id = $1',
        [batchId]
      );
      const productIds = items.map((i) => i.product_id).sort((a: number, b: number) => a - b);
      await client.query('select 1 from stock where product_id = any($1::int[]) for update', [productIds]);

      for (const it of items) {
        await applyMovement(client, {
          productId: it.product_id,
          type: 'receipt',
          delta: it.qty,
          docType: 'batch',
          docId: batchId,
          actor: req.user,
          comment: 'Возврат: отмена партии',
        });
      }
      await client.query(
        "update production_batches set status = 'reversed', cost_total = 0 where id = $1",
        [batchId]
      );
      await auditTx(client, req.user, {
        action: 'reverse',
        entity: 'batch',
        entityId: batchId,
        title: `Партия · ${st[0].name} × ${st[0].portions}`,
        details: { items: items.length },
      });
    });
    res.json({ ok: true });
  })
);
