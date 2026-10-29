import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqNum, reqStr, wrap } from '../http';
import { applyMovement } from '../services/stock';
import { auditTx } from '../services/audit';

export const stockRouter = Router();

/** Остатки склада (присоединяем имя/единицу/порог). */
stockRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      select s.product_id as "productId", p.name, p.category, u.code as "unitCode",
             s.qty::float8 as qty, s.avg_cost::float8 as "avgCost",
             p.min_stock::float8 as "minStock",
             (s.qty < p.min_stock) as low
        from stock s
        join products p on p.id = s.product_id
        join units u on u.id = p.unit_id
       where p.active
       order by p.category, p.name`);
    res.json(rows);
  })
);

/** Журнал движений: фильтры по продукту, типу, периоду. */
stockRouter.get(
  '/movements',
  wrap(async (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.productId) {
      where.push(`m.product_id = $${params.length + 1}`);
      params.push(reqNum(req.query as Record<string, unknown>, 'productId'));
    }
    if (req.query.type) {
      where.push(`m.type = $${params.length + 1}`);
      params.push(reqStr(req.query as Record<string, unknown>, 'type'));
    }
    // поиск по названию позиции: сюда приходят из «истории» остатков и с панели
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      where.push(`lower(p.name) like '%' || $${params.length + 1} || '%'`);
      params.push(req.query.q.trim().toLowerCase());
    }
    if (req.query.from) {
      where.push(`m.created_at >= $${params.length + 1}`);
      params.push(String(req.query.from));
    }
    if (req.query.to) {
      where.push(`m.created_at < $${params.length + 1}::date + 1`);
      params.push(String(req.query.to));
    }
    // по умолчанию 200 — панель показывает последние операции и просит ровно столько
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    params.push(limit);
    const { rows } = await pool.query(
      `select m.id, m.product_id as "productId", p.name as "productName", u.code as "unitCode",
              m.type, m.qty::float8 as qty, m.unit_cost::float8 as "unitCost",
              m.doc_type as "docType", m.doc_id as "docId", m.comment,
              m.user_login as "userLogin",
              coalesce(nullif(btrim(mu.full_name), ''), m.user_login) as "userName",
              to_char(m.created_at, 'YYYY-MM-DD HH24:MI') as created_at
         from movements m
         join products p on p.id = m.product_id
         join units u on u.id = p.unit_id
         left join users mu on mu.id = m.user_id
        ${where.length ? 'where ' + where.join(' and ') : ''}
        order by m.id desc limit $${params.length}`,
      params
    );
    res.json(rows);
  })
);

/** Ручная корректировка (инвентаризация): delta в базовых единицах (со знаком). */
stockRouter.post(
  '/adjustments',
  wrap(async (req, res) => {
    const productId = reqNum(req.body, 'productId');
    const delta = reqNum(req.body, 'delta');
    const comment = typeof req.body.comment === 'string' ? req.body.comment : '';
    if (delta === 0) throw new ApiError(400, 'Delta не может быть 0');
    await tx(async (client) => {
      await applyMovement(client, {
        productId,
        type: 'adjustment',
        delta,
        docType: 'manual',
        comment: comment || 'ручная корректировка',
        actor: req.user,
      });
      const { rows } = await client.query('select name from products where id = $1', [productId]);
      await auditTx(client, req.user, {
        action: 'adjust',
        entity: 'stock',
        entityId: productId,
        title: `Склад: «${rows[0]?.name ?? '#' + productId}»`,
        details: { delta, comment: comment || 'ручная корректировка' },
      });
    });
    res.json({ ok: true });
  })
);
