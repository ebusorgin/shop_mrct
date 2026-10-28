/**
 * API заказов магазинов:
 *  GET  /api/orders/stores               — витрины 103..110
 *  GET  /api/orders/dates?store=103      — даты-листы (для переключения истории)
 *  GET  /api/orders?store=103&date=…     — заказы магазина за дату (+сводка)
 *  GET  /api/orders/categories           — категории строк (фильтр UI)
 *  GET  /api/orders/catalog              — каталог для оформления (техкарты)
 *  POST /api/orders/place?store=103      — оформление заказа (транзакция, проверка min)
 *  PATCH/api/orders/:id                  — статус/заметка
 *  GET  /api/orders/journal              — журнал изменений (привязан к последнему листу)
 *  GET  /api/orders/sync                 — состояние синхронизатора
 *  POST /api/orders/sync                 — запустить прогон (full=1 — все вкладки)
 */
import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqArr, reqNum, wrap } from '../http';
import { runOrderSync, lastSyncSummary, SyncSummary } from '../services/order-sync';
import { toBase } from '../services/order-match';

export const ordersRouter = Router();

const ORDER_SELECT = `
  select o.id, o.store_id as "storeId", st.name as "storeName", o.card_id as "cardId",
         coalesce(tc.name, o.source_name) as name, o.source_name as "sourceName",
         o.plu, oc.name as category, o.min_qty::float8 as "minQty",
         o.quantity::float8 as qty, o.unit_code as "unitCode",
         u.code as "cardUnit",
         o.ek_price::float8 as ek, o.vk_price::float8 as vk,
         o.date_tab::text as "dateTab", o.status, o.source, o.note,
         o.created_at as "createdAt", o.updated_at as "updatedAt"
    from orders o
    join stores st on st.id = o.store_id
    left join tech_cards tc on tc.id = o.card_id
    left join units u on u.id = tc.portion_unit_id
    left join order_categories oc on oc.id = o.category_id`;

interface OrderItem {
  id: number;
  storeId: number;
  storeName: string;
  cardId: number | null;
  name: string;
  sourceName: string;
  plu: string | null;
  category: string | null;
  minQty: number | null;
  qty: number;
  unitCode: string | null;
  cardUnit: string | null;
  ek: number | null;
  vk: number | null;
  dateTab: string;
  status: string;
  source: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

const dec = (r: Record<string, unknown>): OrderItem =>
  ({
    ...r,
    minQty: r.minQty === null ? null : Number(r.minQty),
    qty: Number(r.qty),
    ek: r.ek === null ? null : Number(r.ek),
    vk: r.vk === null ? null : Number(r.vk),
  }) as OrderItem;

ordersRouter.get(
  '/stores',
  wrap(async (_req, res) => {
    const { rows } = await pool.query('select id, code, name from stores where active order by position');
    res.json(rows);
  })
);

/** Даты, по которым у магазина есть заказы (источник — листы и ручные даты). */
ordersRouter.get(
  '/dates',
  wrap(async (req, res) => {
    const store = Number(req.query.store);
    if (!Number.isInteger(store)) throw new ApiError(400, 'store обязателен');
    const { rows } = await pool.query(
      `select date_tab::text as date, count(*)::int as cnt,
              coalesce(max(tab_id), 0) as "tabId",
              bool_or(source = 'g_sheet') as synced,
              bool_or(source = 'manual') as manual
         from orders where store_id = $1 group by 1 order by 1 desc limit 400`,
      [store]
    );
    res.json(rows);
  })
);

ordersRouter.get(
  '/categories',
  wrap(async (_req, res) => {
    const { rows } = await pool.query('select lower(name) as name from order_categories order by name');
    res.json(rows.map((r) => r.name as string));
  })
);

/** Каталог для оформления: готовая продукция (техкарты) с единицей выхода. */
ordersRouter.get(
  '/catalog',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      select tc.id, tc.name, tc.plu, u.code as "unitCode", tc.portion_qty::float8 as "portionQty"
        from tech_cards tc join units u on u.id = tc.portion_unit_id
       order by tc.name`);
    res.json(rows.map((r) => ({ ...r, portionQty: Number(r.portionQty) })));
  })
);

ordersRouter.get(
  '/',
  wrap(async (req, res) => {
    const store = Number(req.query.store);
    if (!Number.isInteger(store)) throw new ApiError(400, 'store обязателен');
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : null;
    const cat = typeof req.query.category === 'string' && req.query.category ? req.query.category.toLowerCase() : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : null;

    const conds: string[] = ['o.store_id = $1'];
    const params: unknown[] = [store];
    if (date) { params.push(date); conds.push(`o.date_tab = $${params.length}::date`); }
    else {
      // без даты — ближайший лист (текущий день магазина)
      params.push(store);
      conds.push(`o.date_tab = (select max(date_tab) from orders where store_id = $${params.length})`);
    }
    if (cat) { params.push(cat); conds.push(`oc.name = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conds.push(`lower(coalesce(tc.name, o.source_name)) like $${params.length}`); }

    const { rows } = await pool.query(
      `${ORDER_SELECT} where ${conds.join(' and ')} order by oc.name nulls last, coalesce(tc.name, o.source_name)`,
      params
    );
    const items = rows.map(dec);

    // Сводка: количество позиций, стоимость (VK × «печатное» кол-во), соответствие min.
    // Стоимость считаем по тем позициям, где VK известен; если VK нет ни у одной — null.
    let totalCost = 0;
    let costLines = 0;
    let minOk = 0;
    // Количество группируем по базовой единице карточки: складывать граммы со штуками нельзя.
    const qtyByUnit: Record<string, number> = {};
    for (const it of items) {
      const printed = printedQty(it);
      if (it.vk !== null) {
        totalCost += it.vk * printed;
        costLines += 1;
      }
      if (it.minQty === null || it.qty >= it.minQty - 1e-6) minOk += 1;
      const base = it.cardUnit ?? it.unitCode ?? 'г';
      qtyByUnit[base] = (qtyByUnit[base] ?? 0) + it.qty;
    }
    res.json({
      items,
      summary: {
        lines: items.length,
        totalQty: Object.values(qtyByUnit).reduce((s, n) => s + n, 0),
        qtyByUnit: Object.fromEntries(
          Object.entries(qtyByUnit).map(([u, n]) => [u, Math.round(n * 1000) / 1000])
        ),
        baseUnit: items[0]?.cardUnit ?? items[0]?.unitCode ?? 'г',
        totalCost: costLines ? Math.round(totalCost * 100) / 100 : null,
        costLines,
        minOkLines: minOk,
        minBadLines: items.length - minOk,
      },
    });
  })
);

/** «Печатное» количество (кг/шт): qty хранится в базовой единице карточки, unit_code — как в источнике. */
function printedQty(it: OrderItem): number {
  const mult = (u: string | null): number => (u === 'кг' ? 1000 : u === 'л' ? 1000 : 1);
  const base = it.cardUnit ?? it.unitCode ?? 'г';
  const shown = it.unitCode ?? base;
  return it.qty * mult(base) / mult(shown);
}

/**
 * Оформление заказа магазином: позиции из каталога (cardId) или внешним именем.
 * min-количество проверяется сервером (force=1 — «понять и всё равно разместить»).
 * Всё одной транзакцией; аудит — триггером.
 */
ordersRouter.post(
  '/place',
  wrap(async (req, res) => {
    const store = Number(req.query.store ?? req.body.store);
    if (!Number.isInteger(store)) throw new ApiError(400, 'store обязателен');
    const date = typeof req.body.date === 'string' && req.body.date ? req.body.date : new Date().toISOString().slice(0, 10);
    const force = req.body.force === true;
    const lines = reqArr(req.body, 'items');

    const result = await tx(async (client) => {
      const { rows: stRows } = await client.query('select id, name from stores where id = $1 and active', [store]);
      if (!stRows.length) throw new ApiError(404, 'Магазин не найден');

      const created: { id: number; name: string; qty: number; unit: string }[] = [];
      const merged: number[] = [];
      const violations: { name: string; qty: number; minQty: number; unit: string }[] = [];

      for (const raw of lines) {
        const cardId = raw.cardId === undefined || raw.cardId === null || raw.cardId === '' ? null : reqNum(raw, 'cardId');
        const printed = reqNum(raw, 'qty');
        if (printed <= 0) throw new ApiError(400, 'Количество должно быть больше нуля');
        const inputUnit = typeof raw.unit === 'string' ? raw.unit : null;

        let name: string;
        let unit: string;
        let baseUnit: string;
        let baseQty: number;
        let minQty: number | null = null;
        if (cardId !== null) {
          const { rows: cRows } = await client.query(
            `select tc.name, tc.plu, u.code as "unitCode", coalesce(tc.portion_qty::float8, 0) as "portionQty"
               from tech_cards tc
               join units u on u.id = tc.portion_unit_id where tc.id = $1`,
            [cardId]
          );
          if (!cRows.length) throw new ApiError(400, `Техкарта ${cardId} не найдена`);
          name = cRows[0].name;
          baseUnit = cRows[0].unitCode;
          unit = inputUnit ?? baseUnit;
          baseQty = toBase(printed, unit, baseUnit, cRows[0].portionQty);
        } else {
          name = String(raw.name ?? '').trim();
          if (!name) throw new ApiError(400, 'Для позиции без cardId нужно name');
          unit = inputUnit ?? 'кг';
          baseUnit = unit === 'шт' ? 'шт' : unit === 'л' ? 'мл' : unit === 'кг' ? 'г' : unit;
          baseQty = toBase(printed, unit, baseUnit);
        }

        // Минимум берём из СВЕЖЕЙ строки источника (последний лист по дате), а не max по всей
        // истории — иначе единичный выброс в глубоком прошлом завышает требование. Ищем по card_id
        // (у ручных позиций он есть), иначе по имени — это связывает «Борщ (порция)» с листовой строкой.
        const { rows: minRows } = await client.query(
          `select min_qty::float8 as mn
             from orders
            where min_qty is not null
              and ( ($1::int is not null and card_id = $1)
                    or ($1::int is null and source_name = $2) )
            order by date_tab desc nulls last, id desc
            limit 1`,
          [cardId, name]
        );
        minQty = minRows[0]?.mn ?? null;
        if (!force && minQty !== null && baseQty < minQty - 1e-6) {
          violations.push({ name, qty: baseQty, minQty, unit: baseUnit });
          continue;
        }

        const { rows: exRows } = await client.query(
          `select id, quantity::float8 as qty from orders
            where store_id=$1 and date_tab=$2::date and source_name=$3 and source='manual' for update`,
          [store, date, name]
        );
        if (exRows.length) {
          await client.query(
            `update orders set quantity = quantity + $2::numeric, updated_at = now() where id = $1`,
            [exRows[0].id, baseQty]
          );
          merged.push(exRows[0].id);
          created.push({ id: exRows[0].id, name, qty: Number(exRows[0].qty) + baseQty, unit: baseUnit });
        } else {
          const { rows: ins } = await client.query(
            `insert into orders (tab_id, store_id, card_id, source_name, min_qty, quantity, unit_code,
                                 date_tab, status, source, note)
             values (null, $1, $2, $3, $4, $5, $6, $7::date, 'placed', 'manual', $8)
             returning id`,
            [store, cardId, name, minQty, baseQty, unit, date, String(raw.note ?? '')]
          );
          created.push({ id: ins[0].id, name, qty: baseQty, unit: baseUnit });
        }
      }
      if (violations.length && !created.length) throw new ApiError(422, 'Минимальные количества не соблюдены', { violations });
      return { created, merged, violations };
    });

    res.status(201).json({ ok: true, ...result, message: `Заказ оформлен: ${result.created.length} позиц.` });
  })
);

const STATUSES = ['synced', 'placed', 'confirmed', 'collected', 'cancelled'];
ordersRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query('select id from orders where id = $1', [id]);
    if (!rows.length) throw new ApiError(404, 'Заказ не найден');
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    if (req.body.status !== undefined) {
      const s = String(req.body.status);
      if (!STATUSES.includes(s)) throw new ApiError(400, `status: ${STATUSES.join('|')}`);
      params.push(s);
      sets.push(`status = $${params.length}`);
    }
    if (req.body.note !== undefined) {
      params.push(String(req.body.note));
      sets.push(`note = $${params.length}`);
    }
    if (req.body.qty !== undefined) {
      params.push(reqNum(req.body, 'qty'));
      sets.push(`quantity = $${params.length}::numeric`);
    }
    params.push(id);
    await pool.query(`update orders set ${sets.join(', ')} where id = $${params.length}`, params);
    res.json({ ok: true });
  })
);

// ---------- журнал изменений ----------
ordersRouter.get(
  '/journal',
  wrap(async (req, res) => {
    const store = Number(req.query.store) || null;
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (store) { params.push(store); conds.push(`c.store_id = $${params.length}`); }
    const where = conds.length ? `where ${conds.join(' and ')}` : '';
    params.push(limit);
    const { rows } = await pool.query(
      `select c.id, c.change_type as "changeType", c.source_name as "sourceName",
              c.store_id as "storeId", st.name as "storeName",
              ot.sheet_name as "sheetName", ot.extract_date::text as "tabDate",
              c.details, c.actor, c.created_at as "createdAt"
         from order_changes c
         left join stores st on st.id = c.store_id
         left join order_tabs ot on ot.id = c.tab_id
         ${where}
        order by c.id desc limit $${params.length}`,
      params
    );
    // «последний по дате лист» — маркер для шапки журнала
    const { rows: lastTab } = await pool.query(
      `select sheet_name as "sheetName", extract_date::text as "tabDate" from order_tabs
        order by extract_date desc nulls last limit 1`
    );
    res.json({
      lastTab: lastTab[0] ?? null,
      changes: rows.map((r) => ({ ...r, details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details })),
    });
  })
);

// ---------- синхронизатор ----------
ordersRouter.get(
  '/sync',
  wrap(async (_req, res) => {
    const { rows } = await pool.query('select * from order_sync_run where id = 1');
    const { rows: tabs } = await pool.query(
      `select sheet_name as "sheetName", extract_date::text as date, row_count as "rowCount",
              last_sync_at as "lastSyncAt", last_error as "lastError"
         from order_tabs order by extract_date desc nulls last limit 30`
    );
    res.json({ state: rows[0] ?? null, summary: lastSyncSummary(), tabs });
  })
);

ordersRouter.post(
  '/sync',
  wrap(async (req, res) => {
    const full = req.query.full === '1';
    // не ждём полного прогона — фр опрашивает /sync для прогресса
    runOrderSync({ full }).catch(() => undefined);
    res.status(202).json({ ok: true, started: true, full });
  })
);

// ---------- одна позиция (после литеральных маршрутов, чтобы не перехватывать /sync, /journal) ----------
ordersRouter.get('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Заказ не найден');
  const { rows } = await pool.query(`${ORDER_SELECT} where o.id = $1`, [id]);
  if (!rows.length) throw new ApiError(404, 'Заказ не найден');
  res.json(dec(rows[0]));
}));
