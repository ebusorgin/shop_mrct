import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqStr, reqNum, optNum, wrap, aiSource } from '../http';
import { assertBaseUnit } from '../services/expansion';
import { auditTx, diff } from '../services/audit';

export const productsRouter = Router();

const SQL_LIST = `
  select p.id, p.name, p.category, p.unit_id as "unitId", u.code as "unitCode",
         u.dimension as "dimension", u.base_factor as "baseFactor",
         p.min_stock as "minStock", p.active,
         p.shelf_life_days as "shelfLifeDays",
         p.g_per_pcs::float8 as "gPerPcs", p.ml_per_pcs::float8 as "mlPerPcs", p.g_per_ml::float8 as "gPerMl",
         coalesce(s.qty, 0)::float8 as "stockQty",
         coalesce(s.avg_cost, 0)::float8 as "avgCost"
    from products p
    join units u on u.id = p.unit_id
    left join stock s on s.product_id = p.id`;

/** Неотрицательное число или null (пусто/undefined -> null); для коэффициентов пересчёта. */
function convNum(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `Поле «${field}» — неотрицательное число или пусто`);
  return n;
}

/** Целое неотрицательное число или null (пусто/undefined -> null); для срока годности в днях. */
function intOrNull(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, `Поле «${field}» — целое неотрицательное число или пусто`);
  return n;
}

productsRouter.get(
  '/',
  wrap(async (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const cat = typeof req.query.category === 'string' && req.query.category ? req.query.category : null;
    if (q) {
      where.push(`lower(p.name) like '%' || $${params.length + 1} || '%'`);
      params.push(q);
    }
    if (cat) {
      where.push('p.category = $' + (params.length + 1));
      params.push(cat);
    }
    if (req.query.active === 'true') where.push('p.active');
    const sql =
      SQL_LIST + (where.length ? ' where ' + where.join(' and ') : '') + ' order by p.category, p.name';
    const { rows } = await pool.query(sql, params);
    res.json(rows.map((r) => ({ ...r, baseFactor: Number(r.baseFactor) })));
  })
);

productsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(SQL_LIST + ' where p.id = $1', [req.params.id]);
    if (!rows.length) throw new ApiError(404, 'Продукт не найден');
    res.json(rows[0]);
  })
);

productsRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name');
    const unitId = reqNum(req.body, 'unitId');
    const category = typeof req.body.category === 'string' ? req.body.category.trim() : 'прочее';
    const minStock = optNum(req.body, 'minStock');
    const shelfLifeDays = intOrNull(req.body, 'shelfLifeDays');
    const gPerPcs = convNum(req.body, 'gPerPcs');
    const mlPerPcs = convNum(req.body, 'mlPerPcs');
    const gPerMl = convNum(req.body, 'gPerMl');
    const id = await tx(async (client) => {
      await assertBaseUnit(client, unitId, 'Продукт');
      const { rows } = await client.query(
        'insert into products (name, category, unit_id, min_stock, shelf_life_days, g_per_pcs, ml_per_pcs, g_per_ml, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id',
        [name, category || 'прочее', unitId, minStock, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl, req.user?.id ?? null]
      );
      await client.query('insert into stock (product_id, qty, avg_cost) values ($1, 0, 0)', [rows[0].id]);
      await auditTx(client, req.user, {
        action: 'create',
        entity: 'product',
        entityId: rows[0].id,
        title: `Продукт «${name}»`,
        details: { category: category || 'прочее', unitId, minStock, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl },
      });
      return rows[0].id as number;
    });
    res.status(201).json({ id });
  })
);

productsRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const fields: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      fields.push(`${col} = $${params.length + 1}`);
      params.push(val);
    };
    if (typeof req.body.name === 'string') push('name', reqStr(req.body, 'name'));
    if (req.body.unitId !== undefined) push('unit_id', reqNum(req.body, 'unitId'));
    if (req.body.category !== undefined) push('category', String(req.body.category).trim() || 'прочее');
    if (req.body.minStock !== undefined) push('min_stock', optNum(req.body, 'minStock'));
    if ('shelfLifeDays' in req.body) push('shelf_life_days', intOrNull(req.body, 'shelfLifeDays'));
    if ('gPerPcs' in req.body) push('g_per_pcs', convNum(req.body, 'gPerPcs'));
    if ('mlPerPcs' in req.body) push('ml_per_pcs', convNum(req.body, 'mlPerPcs'));
    if ('gPerMl' in req.body) push('g_per_ml', convNum(req.body, 'gPerMl'));
    if (req.body.active !== undefined) push('active', Boolean(req.body.active));
    if (!fields.length) throw new ApiError(400, 'Нет полей для обновления');
    if (req.body.unitId !== undefined) {
      await tx(async (client) => assertBaseUnit(client, reqNum(req.body, 'unitId'), 'Продукт'));
    }
    const id = Number(req.params.id);
    await tx(async (client) => {
      // снимок «до» — для журнала: видно, что именно поменяли.
      // коэффициенты (г в 1 шт, мл в 1 шт, плотность) — обязательно: от них зависят расход и себестоимость,
      // без них правка одного коэффициента попадала в журнал как пустое изменение.
      const snapCols =
        'name, category, unit_id, min_stock, shelf_life_days, active, g_per_pcs::float8 as g_per_pcs, ml_per_pcs::float8 as ml_per_pcs, g_per_ml::float8 as g_per_ml';
      const { rows: before } = await client.query(`select ${snapCols} from products where id = $1`, [id]);
      if (!before.length) throw new ApiError(404, 'Продукт не найден');
      params.push(req.user?.id ?? null);
      fields.push(`updated_by = $${params.length}`);
      params.push(id);
      await client.query(`update products set ${fields.join(', ')} where id = $${params.length}`, params);
      const { rows: after } = await client.query(`select ${snapCols} from products where id = $1`, [id]);
      const changes = diff(before[0], after[0]);
      // число мог подсказать GPT (кнопка «Спросить у ИИ») — в журнале это должно отличаться
      // от ручной правки, но только когда менять действительно было что
      const ai = aiSource(req.body ?? {});
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'product',
        entityId: id,
        title: `Продукт «${after[0].name}»`,
        details: ai && Object.keys(changes).length ? { ...changes, ai_model: ai } : changes,
      });
    });
    res.json({ ok: true });
  })
);

productsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new ApiError(400, 'Некорректный id');

    const result = await tx(async (client) => {
      const { rows: prod } = await client.query('select name from products where id = $1', [id]);
      const title = `Продукт «${prod[0]?.name ?? '#' + id}»`;
      // Текущий остаток на складе (в базовых единицах).
      const stockRes = await client.query(
        'select coalesce(qty, 0)::float8 as qty from stock where product_id = $1',
        [id]
      );
      const stockQty = stockRes.rows.length ? Number(stockRes.rows[0].qty) : 0;

      // Используется ли в живых рецептурах (полуфабрикаты / техкарты) — ссылки там полиморфные (source_type, ref_id).
      const recipeRes = await client.query(
        `select (select count(*) from semi_inputs where source_type = 'raw' and ref_id = $1)
              + (select count(*) from tech_card_items where source_type = 'raw' and ref_id = $1) as used`,
        [id]
      );
      const recipeUsed = Number(recipeRes.rows[0].used);

      if (recipeUsed > 0) {
        // Физически удалять нельзя — позиция участвует в рецептурах, иначе они «сломались» бы.
        await client.query('update products set active = false, updated_by = $2 where id = $1', [id, req.user?.id ?? null]);
        await auditTx(client, req.user, {
          action: 'delete',
          entity: 'product',
          entityId: id,
          title,
          details: { mode: 'archive', reason: 'используется в рецептурах', stockQty },
        });
        return { ok: true, deactivated: true, reason: 'recipe', stockQty };
      }

      if (stockQty !== 0) {
        // Остаток не обнулён — не удаляем физически, только в архив.
        await client.query('update products set active = false, updated_by = $2 where id = $1', [id, req.user?.id ?? null]);
        await auditTx(client, req.user, {
          action: 'delete',
          entity: 'product',
          entityId: id,
          title,
          details: { mode: 'archive', reason: 'остаток на складе', stockQty },
        });
        return { ok: true, deactivated: true, reason: 'stock', stockQty };
      }

      // Остаток = 0 и нет ссылок из рецептур → удаляем физически, подчищая историю движений.
      // stock удалится каскадом (on delete cascade).
      const hist = await client.query(
        `with d1 as (delete from movements where product_id = $1 returning 1),
               d2 as (delete from waybill_items where product_id = $1 returning 1),
               d3 as (delete from production_batch_items where product_id = $1 returning 1)
         select (select count(*) from d1) as mv,
                (select count(*) from d2) as wb,
                (select count(*) from d3) as bi`,
        [id]
      );
      await client.query('delete from products where id = $1', [id]);
      const h = hist.rows[0];
      await auditTx(client, req.user, {
        action: 'delete',
        entity: 'product',
        entityId: id,
        title,
        details: {
          mode: 'hard',
          stockQty,
          cleaned: { movements: Number(h.mv), waybillItems: Number(h.wb), batchItems: Number(h.bi) },
        },
      });
      return {
        ok: true,
        deleted: true,
        stockQty,
        cleaned: { movements: Number(h.mv), waybillItems: Number(h.wb), batchItems: Number(h.bi) },
      };
    });

    res.json(result);
  })
);

