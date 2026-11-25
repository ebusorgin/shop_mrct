import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqStr, reqNum, optNum, wrap, aiSource } from '../http';
import { assertBaseUnit } from '../services/expansion';
import { assertNameFree } from '../services/name-check';
import { assertCategoryId, defaultCategoryId } from '../services/categories';
import { auditTx, diff } from '../services/audit';

export const productsRouter = Router();

const SQL_LIST = `
  select p.id, p.name, p.category_id as "categoryId", pc.name as "categoryName",
         p.unit_id as "unitId", u.code as "unitCode",
         u.dimension as "dimension", u.base_factor as "baseFactor",
         p.min_stock as "minStock", p.active,
         p.shelf_life_days as "shelfLifeDays",
         p.g_per_pcs::float8 as "gPerPcs", p.ml_per_pcs::float8 as "mlPerPcs", p.g_per_ml::float8 as "gPerMl",
         coalesce(s.qty, 0)::float8 as "stockQty",
         coalesce(s.avg_cost, 0)::float8 as "avgCost",
         coalesce((select json_agg(a.alias_raw order by lower(a.alias_raw))
                     from product_aliases a where a.product_id = p.id), '[]'::json) as aliases
    from materials p
    join units u on u.id = p.unit_id
    join material_categories pc on pc.id = p.category_id
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

/** Нормализация псевдонима для матчинга — как normName в импорте накладных. */
function aliasKey(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]+/g, ' ').trim();
}

/** Псевдонимы из тела запроса: массив или строка через запятую/точку с запятой/перенос. */
function aliasList(body: Record<string, unknown>): string[] | null {
  if (!('aliases' in body)) return null;
  const v = body.aliases;
  let raw: unknown[] = [];
  if (Array.isArray(v)) raw = v;
  else if (typeof v === 'string') raw = v.split(/[,;\n]+/);
  else if (v == null) raw = [];
  else throw new ApiError(400, 'Поле «aliases» — массив строк');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    if (text.length > 120) throw new ApiError(400, `Псевдоним слишком длинный: «${text.slice(0, 40)}…»`);
    const key = aliasKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

productsRouter.get(
  '/',
  wrap(async (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const rawCat = req.query.categoryId;
    const categoryId = rawCat === undefined || rawCat === '' ? null : Number(rawCat);
    if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
      throw new ApiError(400, 'categoryId: требуется целое положительное число');
    }
    if (q) {
      where.push(
        `(lower(p.name) like '%' || $${params.length + 1} || '%'
          or exists (select 1 from product_aliases a
                      where a.product_id = p.id and a.alias like '%' || $${params.length + 1} || '%'))`
      );
      params.push(q);
    }
    if (categoryId !== null) {
      where.push('p.category_id = $' + (params.length + 1));
      params.push(categoryId);
    }
    if (req.query.active === 'true') where.push('p.active');
    const sql =
      SQL_LIST + (where.length ? ' where ' + where.join(' and ') : '') + ' order by pc.position, pc.name, p.name';
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

/** Где используется складское сырьё: рецептуры, в базовых единицах позиции. */
productsRouter.get(
  '/:id/usage',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new ApiError(400, 'Некорректный id');
    const { rows: cards } = await pool.query(
      `select p.id, p.name,
              pn.qty::float8 as qty,
              mu.code as "unitCode",
              p.portion_qty::float8 as "portionQty",
              pu.code as "portionUnitCode"
         from product_nodes pn
         join products p on p.id = pn.product_id
         join materials m on m.id = pn.material_id
         join units mu on mu.id = m.unit_id
         join units pu on pu.id = p.unit_id
        where pn.material_id = $1
        order by p.name`,
      [id]
    );
    // Форма ответа сохранена для страницы склада.
    res.json({ semis: [], cards });
  })
);

/** Поставщики позиции — по действующим накладным: сколько поставок, последняя дата и цена. */
productsRouter.get(
  '/:id/suppliers',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new ApiError(400, 'Некорректный id');
    const { rows } = await pool.query(
      `select w.supplier,
              count(*)::int as "deliveries",
              to_char(max(w.doc_date), 'YYYY-MM-DD') as "lastDate",
              (array_agg(i.price order by w.doc_date desc, i.id desc))[1]::float8 as "lastPrice",
              (array_agg(u.code order by w.doc_date desc, i.id desc))[1] as "unitCode"
         from waybill_items i
         join waybills w on w.id = i.waybill_id
         left join units u on u.id = i.unit_id
        where i.product_id = $1 and btrim(w.supplier) <> '' and w.status = 'posted'
        group by w.supplier
        order by max(w.doc_date) desc`,
      [id]
    );
    res.json(rows);
  })
);

/**
 * Заменить ручной список псевдонимов позиции. Псевдонимы из накладных входят в этот же
 * список, поэтому пользователь может их убрать. Чужой псевдоним не перепривязываем молча:
 * возвращаем понятную ошибку, чтобы не испортить распознавание накладных.
 */
async function saveAliases(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  productId: number,
  aliases: string[],
  productName: string
): Promise<void> {
  const nameKey = aliasKey(productName);
  const keys = [...new Set(aliases.map(aliasKey).filter((k) => k && k !== nameKey))];
  if (keys.length) {
    const { rows } = await client.query(
      `select a.alias, a.alias_raw, p.name
         from product_aliases a join materials p on p.id = a.product_id
        where a.alias = any($1) and a.product_id <> $2 limit 3`,
      [keys, productId]
    );
    if (rows.length) {
      const raw = String(rows[0].alias_raw ?? rows[0].alias);
      throw new ApiError(400, `Псевдоним «${raw}» уже привязан к товару «${rows[0].name}»`);
    }
  }
  await client.query('delete from product_aliases where product_id = $1', [productId]);
  const seen = new Set<string>();
  for (const text of aliases) {
    const key = aliasKey(text);
    if (!key || key === nameKey || seen.has(key)) continue;
    seen.add(key);
    await client.query(
      `insert into product_aliases (product_id, alias, alias_raw, source)
       values ($1,$2,$3,'manual') on conflict (alias) do nothing`,
      [productId, key, text]
    );
  }
}

productsRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name');
    const unitId = reqNum(req.body, 'unitId');
    const rawCategoryId = req.body.categoryId;
    if (rawCategoryId !== undefined && rawCategoryId !== null && rawCategoryId !== '') {
      if (!Number.isInteger(Number(rawCategoryId)) || Number(rawCategoryId) <= 0) {
        throw new ApiError(400, 'categoryId: требуется целое положительное число');
      }
    }
    const requestedCategoryId = rawCategoryId === undefined || rawCategoryId === null || rawCategoryId === ''
      ? null
      : Number(rawCategoryId);
    const minStock = optNum(req.body, 'minStock');
    const shelfLifeDays = intOrNull(req.body, 'shelfLifeDays');
    const gPerPcs = convNum(req.body, 'gPerPcs');
    const mlPerPcs = convNum(req.body, 'mlPerPcs');
    const gPerMl = convNum(req.body, 'gPerMl');
    const aliases = aliasList(req.body);
    const id = await tx(async (client) => {
      await assertBaseUnit(client, unitId, 'Продукт');
      await assertNameFree(client, name, 'materials');
      const categoryId = requestedCategoryId == null
        ? await defaultCategoryId(client)
        : await assertCategoryId(client, requestedCategoryId);
      const { rows } = await client.query(
        'insert into materials (name, category_id, unit_id, min_stock, shelf_life_days, g_per_pcs, ml_per_pcs, g_per_ml, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id',
        [name, categoryId, unitId, minStock, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl, req.user?.id ?? null]
      );
      await client.query('insert into stock (product_id, qty, avg_cost) values ($1, 0, 0)', [rows[0].id]);
      if (aliases?.length) await saveAliases(client, rows[0].id, aliases, name);
      await auditTx(client, req.user, {
        action: 'create',
        entity: 'product',
        entityId: rows[0].id,
        title: `Продукт «${name}»`,
        details: { categoryId, unitId, minStock, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl, aliases: aliases ?? [] },
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
    const newName = typeof req.body.name === 'string' ? reqStr(req.body, 'name') : null;
    if (newName) push('name', newName);
    if (req.body.unitId !== undefined) push('unit_id', reqNum(req.body, 'unitId'));
    const hasCategory = req.body.categoryId !== undefined && req.body.categoryId !== null && req.body.categoryId !== '';
    const rawCategoryId = req.body.categoryId;
    if (hasCategory && (!Number.isInteger(Number(rawCategoryId)) || Number(rawCategoryId) <= 0)) {
      throw new ApiError(400, 'categoryId: требуется целое положительное число');
    }
    if (req.body.minStock !== undefined) push('min_stock', optNum(req.body, 'minStock'));
    if ('shelfLifeDays' in req.body) push('shelf_life_days', intOrNull(req.body, 'shelfLifeDays'));
    if ('gPerPcs' in req.body) push('g_per_pcs', convNum(req.body, 'gPerPcs'));
    if ('mlPerPcs' in req.body) push('ml_per_pcs', convNum(req.body, 'mlPerPcs'));
    if ('gPerMl' in req.body) push('g_per_ml', convNum(req.body, 'gPerMl'));
    if (req.body.active !== undefined) push('active', Boolean(req.body.active));
    const aliases = aliasList(req.body);
    if (!fields.length && aliases === null && !hasCategory) throw new ApiError(400, 'Нет полей для обновления');
    if (req.body.unitId !== undefined) {
      await tx(async (client) => assertBaseUnit(client, reqNum(req.body, 'unitId'), 'Продукт'));
    }
    const id = Number(req.params.id);
    await tx(async (client) => {
      if (newName) await assertNameFree(client, newName, 'materials', id);
      if (hasCategory) push('category_id', await assertCategoryId(client, Number(rawCategoryId)));
      // снимок «до» — для журнала: видно, что именно поменяли.
      // коэффициенты (г в 1 шт, мл в 1 шт, плотность) — обязательно: от них зависят расход и себестоимость,
      // без них правка одного коэффициента попадала в журнал как пустое изменение.
      const snapCols =
        'name, category_id, unit_id, min_stock, shelf_life_days, active, g_per_pcs::float8 as g_per_pcs, ml_per_pcs::float8 as ml_per_pcs, g_per_ml::float8 as g_per_ml';
      const { rows: before } = await client.query(`select ${snapCols} from materials where id = $1`, [id]);
      if (!before.length) throw new ApiError(404, 'Продукт не найден');
      params.push(req.user?.id ?? null);
      fields.push(`updated_by = $${params.length}`);
      params.push(id);
      await client.query(`update materials set ${fields.join(', ')} where id = $${params.length}`, params);
      const { rows: after } = await client.query(`select ${snapCols} from materials where id = $1`, [id]);
      if (aliases) await saveAliases(client, id, aliases, String(after[0].name));
      const changes = diff(before[0], after[0]);
      // число мог подсказать GPT (кнопка «Спросить у ИИ») — в журнале это должно отличаться
      // от ручной правки, но только когда менять действительно было что
      const ai = aiSource(req.body ?? {});
      const details: Record<string, unknown> = { ...changes };
      if (aliases) details.aliases = aliases;
      if (ai && Object.keys(changes).length) details.ai_model = ai;
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'product',
        entityId: id,
        title: `Продукт «${after[0].name}»`,
        details,
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
      const { rows: prod } = await client.query('select name from materials where id = $1', [id]);
      const title = `Продукт «${prod[0]?.name ?? '#' + id}»`;
      // Текущий остаток на складе (в базовых единицах).
      const stockRes = await client.query(
        'select coalesce(qty, 0)::float8 as qty from stock where product_id = $1',
        [id]
      );
      const stockQty = stockRes.rows.length ? Number(stockRes.rows[0].qty) : 0;

      // Живые ссылки: состав рецептур и история склада.
      // Пока позиция где-то используется, физически удалять её нельзя — только архив.
      const usageRes = await client.query(
        `select
           (select count(*) from product_nodes where material_id = $1)::int as in_recipes,
           ((select count(*) from movements where product_id = $1)
            + (select count(*) from waybill_items where product_id = $1))::int as in_history`,
        [id]
      );
      const usage = usageRes.rows[0] as { in_recipes: number; in_history: number };
      const usedReason = usage.in_recipes > 0
        ? 'используется в рецептурах'
        : usage.in_history > 0
          ? 'есть в истории склада'
          : null;

      if (usedReason) {
        await client.query('update materials set active = false, updated_by = $2 where id = $1', [id, req.user?.id ?? null]);
        await auditTx(client, req.user, {
          action: 'delete',
          entity: 'product',
          entityId: id,
          title,
          details: { mode: 'archive', reason: usedReason, stockQty },
        });
        return { ok: true, deactivated: true, reason: 'used', stockQty, detail: usedReason };
      }

      if (stockQty !== 0) {
        // Остаток не обнулён — не удаляем физически, только в архив.
        await client.query('update materials set active = false, updated_by = $2 where id = $1', [id, req.user?.id ?? null]);
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
               d2 as (delete from waybill_items where product_id = $1 returning 1)
         select (select count(*) from d1) as mv,
                (select count(*) from d2) as wb`,
        [id]
      );
      await client.query('delete from materials where id = $1', [id]);
      const h = hist.rows[0];
      await auditTx(client, req.user, {
        action: 'delete',
        entity: 'product',
        entityId: id,
        title,
        details: {
          mode: 'hard',
          stockQty,
          cleaned: { movements: Number(h.mv), waybillItems: Number(h.wb) },
        },
      });
      return {
        ok: true,
        deleted: true,
        stockQty,
        cleaned: { movements: Number(h.mv), waybillItems: Number(h.wb) },
      };
    });

    res.json(result);
  })
);

