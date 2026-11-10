/**
 * API заказов магазинов:
 *  GET  /api/orders/stores               — витрины 103..110
 *  GET  /api/orders/dates?store=103      — даты-листы (для переключения истории)
 *  GET  /api/orders?store=103&date=…     — заказы магазина за дату (+сводка)
 *  GET  /api/orders/board?date=…         — доска производства (пивот); офис — все точки, магазин — своя
 *  GET  /api/orders/categories           — категории строк (фильтр UI)
 *  GET  /api/orders/catalog              — каталог для оформления (техкарты)
 *  POST /api/orders/place?store=103      — оформление заказа (транзакция, проверка min)
 *  PATCH/api/orders/:id                  — статус/заметка
 *  GET  /api/orders/journal              — журнал изменений (привязан к последнему листу)
 */
import { Router, Request } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqArr, reqNum, wrap } from '../http';
import { toBase, printedQty } from '../services/order-match';
import { asUser, audit, auditTx } from '../services/audit';
import { requireOffice } from '../services/auth';
import { broadcast } from '../services/live';
import { generateOtpremniceDoc } from '../services/otpremnica';
import { deliverySettings } from '../services/settings';
import { currentDeliveryDate, closePastOrders } from '../services/delivery';
import { mskNow } from '../services/tz';

export const ordersRouter = Router();

/**
 * Точка, с которой работает запрос. Магазинному сотруднику всегда своя
 * (чужие заказы не видны и не меняются), офису — та, что пришла в запросе.
 */
function ownStore(req: Request): number | null {
  return req.user?.storeId ?? null;
}

async function getCombinedDates(storeId?: number | null) {
  const delivery = await deliverySettings();
  const todayIso = mskNow(delivery.tz).dateIso;

  const query = storeId != null
    ? `select date_tab::text as date, count(*)::int as cnt,
              coalesce(max(tab_id), 0) as "tabId",
              bool_or(exists (select 1 from order_tabs t
                               where t.extract_date = orders.date_tab
                                 and t.status in ('locked','archived'))) as locked
         from orders where store_id = $1 group by 1 order by 1 desc limit 1000`
    : `select o.date_tab::text as date, count(*)::int as cnt,
              coalesce(max(o.tab_id), 0) as "tabId",
              bool_or(exists (select 1 from order_tabs t
                               where t.extract_date = o.date_tab
                                 and t.status in ('locked','archived'))) as locked
         from orders o join stores st on st.id = o.store_id and st.active
         ${storeId != null ? 'where o.store_id = $1' : ''}
        group by 1 order by 1 desc limit 1000`;

  const { rows } = await pool.query(query, storeId != null ? [storeId] : []);
  const dbMap = new Map<string, any>();
  for (const r of rows) {
    dbMap.set(r.date, {
      date: r.date,
      cnt: Number(r.cnt),
      tabId: Number(r.tabId),
      locked: Boolean(r.locked) || r.date < todayIso,
    });
  }

  const deliveryDatesSet = new Set(delivery.dates || []);
  const resultDatesMap = new Map<string, any>();

  for (const [date, info] of dbMap.entries()) {
    if (date >= todayIso) {
      if (deliveryDatesSet.has(date) || info.cnt > 0) {
        resultDatesMap.set(date, info);
      }
    } else {
      resultDatesMap.set(date, info);
    }
  }

  for (const d of delivery.dates) {
    if (!resultDatesMap.has(d)) {
      resultDatesMap.set(d, {
        date: d,
        cnt: 0,
        tabId: 0,
        locked: d < todayIso,
      });
    }
  }

  const actualDelivery = currentDeliveryDate(delivery) || todayIso;
  if (!resultDatesMap.has(actualDelivery)) {
    resultDatesMap.set(actualDelivery, {
      date: actualDelivery,
      cnt: 0,
      tabId: 0,
      locked: false,
    });
  }

  const sorted = [...resultDatesMap.values()].sort((a, b) => b.date.localeCompare(a.date));
  return sorted;
}

const ORDER_SELECT = `
  select o.id, o.store_id as "storeId", st.name as "storeName", o.card_id as "cardId",
         coalesce(tc.name, o.source_name) as name, o.source_name as "sourceName",
         o.plu, oc.name as category, tcc.name as "cardCategory",
         coalesce(o.min_qty, tc.min_qty)::float8 as "minQty",
         o.quantity::float8 as qty, o.unit_code as "unitCode",
         u.code as "cardUnit", coalesce(tc.portion_qty::float8, 0) as "portionQty",
         o.ek_price::float8 as ek, o.vk_price::float8 as vk,
         o.date_tab::text as "dateTab", o.status, o.source, o.note,
         o.created_at as "createdAt", o.updated_at as "updatedAt",
         o.created_by as "createdById", cu.login as "createdByLogin",
         coalesce(nullif(btrim(cu.full_name), ''), cu.login) as "createdByName",
         coalesce(o.status_by_login, su.login) as "statusByLogin",
         coalesce(nullif(btrim(su.full_name), ''), o.status_by_login, su.login) as "statusByName",
         o.status_at as "statusAt"
    from orders o
    join stores st on st.id = o.store_id
    left join tech_cards tc on tc.id = o.card_id
    left join units u on u.id = tc.portion_unit_id
    left join order_categories oc on oc.id = o.category_id
    left join order_categories tcc on tcc.id = tc.category_id
    left join users cu on cu.id = o.created_by
    left join users su on su.id = o.status_by`;

interface OrderItem {
  id: number;
  storeId: number;
  storeName: string;
  cardId: number | null;
  name: string;
  sourceName: string;
  plu: string | null;
  category: string | null;
  /** категория техкарты (задана в Настройках) — приоритетнее листовой для доски */
  cardCategory: string | null;
  minQty: number | null;
  qty: number;
  unitCode: string | null;
  cardUnit: string | null;
  portionQty: number;
  ek: number | null;
  vk: number | null;
  dateTab: string;
  status: string;
  source: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  createdById: number | null;
  createdByLogin: string | null;
  createdByName: string | null;
  statusByLogin: string | null;
  statusByName: string | null;
  statusAt: string | null;
}

const dec = (r: Record<string, unknown>): OrderItem =>
  ({
    ...r,
    minQty: r.minQty === null ? null : Number(r.minQty),
    qty: Number(r.qty),
    ek: r.ek === null ? null : Number(r.ek),
    vk: r.vk === null ? null : Number(r.vk),
  }) as OrderItem;

/** Строка доски-пивота: товар × количество по магазинам + деньги. */
interface BoardPivotRow {
  key: string;
  name: string;
  category: string | null;
  plu: string | null;
  /** печатная единица строки: 'порц' | 'шт' | 'кг' | 'л' | базовая */
  unit: string;
  totalQty: number;
  pricePer: number | null;
  fullPrice: number;
  byStore: Record<number, number>;
  /** id линии заказа — правится на доске, если строка = ровно одна линия в статусе synced/placed */
  orderId: number | null;
  /** можно ли редактировать количество прямо на доске (одна линия, не принята производством) */
  editable: boolean;
  /** id техкарты — для строк из каталога без линии заказа (магазин может добавить через POST /place) */
  cardId?: number | null;
  /** id товара (техкарты) в БД — показывается рядом с наименованием; заполняется и для строк заказа, не только каталога */
  productId?: number | null;
  /** минимальный заказ = кратность строки в печатной единице (из orders.min_qty); null — не задан */
  minOrder: number | null;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

ordersRouter.get(
  '/export-otpremnice',
  requireOffice,
  wrap(async (req, res) => {
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : new Date().toISOString().slice(0, 10);
    const buf = await generateOtpremniceDoc(date);
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="otpremnice_${date}.doc"`);
    res.send(buf);
  })
);

ordersRouter.get(
  '/stores',
  requireOffice,
  wrap(async (_req, res) => {
    const { rows } = await pool.query('select id, code, name from stores where active order by position');
    res.json(rows);
  })
);

/** Даты, по которым у магазина есть заказы (источник — листы и ручные даты). */
ordersRouter.get(
  '/dates',
  wrap(async (req, res) => {
    const store = ownStore(req) ?? Number(req.query.store);
    if (!Number.isInteger(store)) throw new ApiError(400, 'store обязателен');
    const dates = await getCombinedDates(store);
    res.json(dates);
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
    const store = ownStore(req) ?? Number(req.query.store);
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

/**
 * Доска производства (вид «как в Excel»): позиции-товары по всем активным магазинам за
 * один лист-дату. Строки = товар; колонки = магазины (печатное кол-во: порции/шт/кг),
 * плюс итого количество, цена за единицу (VK) и полная цена (Σ VK×кол-во). Отменённые строки исключаем.
 * date пустой — самый свежий лист с позициями в работе (synced/placed).
 */
ordersRouter.get(
  '/board',
  wrap(async (req, res) => {
    // магазинный сотрудник видит доску только по своей точке (колонка одна), офис — все витрины.
    const scope = ownStore(req);
    const qDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : null;
    const cat = typeof req.query.category === 'string' && req.query.category ? req.query.category.toLowerCase() : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : null;

    // активные витрины — фиксированные колонки доски (103..110 и т.д.); магазину — только своя
    const { rows: storeRows } = await pool.query(
      scope
        ? 'select id, code, name from stores where active and id = $1 order by position, id'
        : 'select id, code, name from stores where active order by position, id',
      scope ? [scope] : []
    );
    const stores = storeRows as { id: number; code: string; name: string }[];

    const delivery = await deliverySettings();
    const todayIso = mskNow(delivery.tz).dateIso;
    const actualDelivery = currentDeliveryDate(delivery) || todayIso;

    // Закрываем все незакрытые заказы на прошедшие даты и блокируем листы доставки
    await closePastOrders(delivery.tz);

    // список листов-дат с заказами у активных магазинов — для переключателя
    const dates = await getCombinedDates(scope);

    // дата по умолчанию: запрошенная дата либо актуальная дата доставки
    let date = qDate;
    if (!date) {
      date = actualDelivery;
    }

    const conds: string[] = ['st.active'];
    const params: unknown[] = [];
    if (scope) { params.push(scope); conds.push(`o.store_id = $${params.length}`); }
    if (date) { params.push(date); conds.push(`o.date_tab = $${params.length}::date`); }
    if (cat) { params.push(cat); conds.push(`coalesce(tcc.name, oc.name) = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conds.push(`lower(coalesce(tc.name, o.source_name)) like $${params.length}`); }

    const { rows } = await pool.query(
      `${ORDER_SELECT} where ${conds.join(' and ')}
        order by st.name, coalesce(tcc.name, oc.name) nulls last, coalesce(tc.name, o.source_name)`,
      params
    );

    // пивот: товар × магазин (кол-во в печатной единице); отмены не считаем
    const map = new Map<string, BoardPivotRow>();
    const byStoreTotal: Record<number, number> = {};
    // правка на доске допустима, если строка = одна линия заказа и она не принята производством
    const lineIds = new Map<string, Set<number>>();
    const lockedKeys = new Set<string>();
    for (const raw of rows) {
      const it = dec(raw);
      if (it.status === 'cancelled') continue;
      const printed = printedQty(it);
      // кратность (минимальный заказ) в печатной единице: orders.min_qty хранится в базовых
      const printedMin = it.minQty != null && it.minQty > 0
        ? printedQty({ qty: it.minQty, unitCode: it.unitCode, cardUnit: it.cardUnit, portionQty: it.portionQty })
        : null;
      const base = it.cardUnit ?? it.unitCode ?? 'г';
      const key = it.cardId != null ? `c${it.cardId}` : `n${(it.sourceName || it.name).toLowerCase().trim()}`;
      let row = map.get(key);
      if (!row) {
        row = {
          key, name: it.name, category: it.cardCategory ?? it.category, plu: it.plu,
          unit: it.unitCode ?? (base === 'шт' ? 'шт' : base),
          totalQty: 0, pricePer: null, fullPrice: 0, byStore: {}, orderId: null, editable: false,
          productId: it.cardId ?? null, minOrder: null,
        };
        map.set(key, row);
      }
      if (printedMin != null) row.minOrder = row.minOrder == null ? printedMin : Math.min(row.minOrder, printedMin);
      row.totalQty += printed;
      row.fullPrice += (it.vk ?? 0) * printed;
      if (row.pricePer === null && it.vk !== null) row.pricePer = it.vk;
      row.byStore[it.storeId] = (row.byStore[it.storeId] ?? 0) + printed;
      byStoreTotal[it.storeId] = (byStoreTotal[it.storeId] ?? 0) + printed;
      let idset = lineIds.get(key);
      if (!idset) { idset = new Set(); lineIds.set(key, idset); }
      idset.add(it.id);
      if (it.status !== 'synced' && it.status !== 'placed') lockedKeys.add(key);
    }

    // дозаполняем доску ВСЕЙ продукцией каталога: незаказанные позиции идут с 0 по умолчанию.
    // Офис видит их справочно (без правки), магазину строка доступна для добавления в заказ.
    const catConds: string[] = [];
    const catParams: unknown[] = [];
    if (cat) { catParams.push(cat); catConds.push(`lower(tcc.name) = $${catParams.length}`); }
    if (q) { catParams.push(`%${q}%`); catConds.push(`lower(tc.name) like $${catParams.length}`); }
    const { rows: catRows } = await pool.query(
      `select tc.id, coalesce(tc.name, '') as name, tc.plu, u.code as unit,
              coalesce(tc.portion_qty::float8, 0) as "portionQty", tcc.name as category
         from tech_cards tc
         join units u on u.id = tc.portion_unit_id
         left join order_categories tcc on tcc.id = tc.category_id
         ${catConds.length ? 'where ' + catConds.join(' and ') : ''}`,
      catParams
    );
    for (const c of catRows) {
      const key = `c${c.id}`;
      if (map.has(key)) continue;
      const portion = Number(c.portionQty) > 0 && (c.unit === 'г' || c.unit === 'мл');
      map.set(key, {
        key, name: c.name, category: c.category ?? null, plu: c.plu ?? null,
        unit: portion ? 'порц' : c.unit,
        totalQty: 0, pricePer: null, fullPrice: 0, byStore: {},
        orderId: null, editable: true, cardId: c.id, productId: c.id, minOrder: null,
      });
    }

    // округление «в месте»: порции до тысячных, деньги до копеек
    const pivotRows = [...map.values()];
    for (const r of pivotRows) {
      r.totalQty = round3(r.totalQty);
      if (r.minOrder != null) r.minOrder = round3(r.minOrder);
      if (r.pricePer !== null) r.pricePer = Math.round(r.pricePer * 100) / 100;
      r.fullPrice = Math.round(r.fullPrice * 100) / 100;
      for (const k of Object.keys(r.byStore)) r.byStore[Number(k)] = round3(r.byStore[Number(k)]);
      const set = lineIds.get(r.key);
      if (set && set.size === 1 && !lockedKeys.has(r.key)) {
        r.editable = true;
        r.orderId = [...set][0];
      }
    }
    for (const k of Object.keys(byStoreTotal)) byStoreTotal[Number(k)] = round3(byStoreTotal[Number(k)]);
    // группировка на доске: сначала категория (без неё — в конце), внутри — по товару
    pivotRows.sort((a, b) => {
      if (a.category !== b.category) {
        if (!a.category) return 1;
        if (!b.category) return -1;
        return a.category.localeCompare(b.category, 'ru');
      }
      return a.name.localeCompare(b.name, 'ru');
    });

    res.json({
      date,
      dates,
      stores,
      rows: pivotRows,
      totals: {
        positions: pivotRows.length,
        full: Math.round(pivotRows.reduce((s, r) => s + r.fullPrice, 0) * 100) / 100,
        stores: Object.keys(byStoreTotal).length,
        byStore: byStoreTotal,
      },
    });
  })
);

/**
 * Оформление заказа магазином: позиции из каталога (cardId) или внешним именем.
 * min-количество проверяется сервером (force=1 — «понять и всё равно разместить»).
 * Всё одной транзакцией; аудит — триггером.
 */
ordersRouter.post(
  '/place',
  wrap(async (req, res) => {
    const store = ownStore(req) ?? Number(req.query.store ?? req.body.store);
    if (!Number.isInteger(store)) throw new ApiError(400, 'store обязателен');
    const date = typeof req.body.date === 'string' && req.body.date ? req.body.date : new Date().toISOString().slice(0, 10);
    const force = req.body.force === true;
    const lines = reqArr(req.body, 'items');

    const result = await tx(async (client) => {
      // автор транзакции — для триггера журнала заказов (order_changes)
      await asUser(client, req.user);
      const { rows: stRows } = await client.query('select id, name from stores where id = $1 and active', [store]);
      if (!stRows.length) throw new ApiError(404, 'Магазин не найден');
      // лист закрыт после автосписания — магазинному сотруднику правки на закрытую доставку нет
      if (ownStore(req) !== null) {
        const { rows: lockRows } = await client.query(
          `select 1 from order_tabs where extract_date = $1::date and status in ('locked','archived') limit 1`,
          [date]
        );
        if (lockRows.length) throw new ApiError(409, 'Лист доставки закрыт (после списания) — заказ добавить нельзя');
      }

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
            `select tc.name, tc.plu, tc.min_qty::float8 as "minQty", u.code as "unitCode", coalesce(tc.portion_qty::float8, 0) as "portionQty"
               from tech_cards tc
               join units u on u.id = tc.portion_unit_id where tc.id = $1`,
            [cardId]
          );
          if (!cRows.length) throw new ApiError(400, `Техкарта ${cardId} не найдена`);
          name = cRows[0].name;
          baseUnit = cRows[0].unitCode;
          unit = inputUnit ?? baseUnit;
          baseQty = toBase(printed, unit, baseUnit, cRows[0].portionQty);
          minQty = cRows[0].minQty ?? null;
        } else {
          name = String(raw.name ?? '').trim();
          if (!name) throw new ApiError(400, 'Для позиции без cardId нужно name');
          unit = inputUnit ?? 'кг';
          baseUnit = unit === 'шт' ? 'шт' : unit === 'л' ? 'мл' : unit === 'кг' ? 'г' : unit;
          baseQty = toBase(printed, unit, baseUnit);
          minQty = null;
        }

        if (!force && minQty !== null && baseQty < minQty - 1e-6) {
          violations.push({ name, qty: baseQty, minQty, unit: baseUnit });
          continue;
        }

        const { rows: exRows } = await client.query(
          `select id, quantity::float8 as qty, status from orders
            where store_id=$1 and date_tab=$2::date and lower(btrim(source_name))=lower(btrim($3)) for update`,
          [store, date, name]
        );
        if (exRows.length) {
          if (exRows[0].status === 'cancelled') {
            // отменённую линию кладём заново: ставим новое количество и возвращаем в работу,
            // иначе строка останется скрытой доской (qty слился, а status — нет)
            await client.query(
              `update orders set quantity = $2::numeric, status = 'placed', db_edited_at = now(), updated_at = now() where id = $1`,
              [exRows[0].id, baseQty]
            );
          } else {
            await client.query(
              `update orders set quantity = quantity + $2::numeric, db_edited_at = now(), updated_at = now() where id = $1`,
              [exRows[0].id, baseQty]
            );
          }
          merged.push(exRows[0].id);
          created.push({ id: exRows[0].id, name, qty: Number(exRows[0].qty) + baseQty, unit: baseUnit });
        } else {
          const { rows: ins } = await client.query(
            `insert into orders (tab_id, store_id, card_id, source_name, min_qty, quantity, unit_code,
                                 date_tab, status, source, note, created_by, db_edited_at)
             values (null, $1, $2, $3, $4, $5, $6, $7::date, 'placed', 'manual', $8, $9, now())
             returning id`,
            [store, cardId, name, minQty, baseQty, unit, date, String(raw.note ?? ''), req.user?.id ?? null]
          );
          created.push({ id: ins[0].id, name, qty: baseQty, unit: baseUnit });
        }
      }
      if (violations.length && !created.length) throw new ApiError(422, 'Минимальные количества не соблюдены', { violations });
      await auditTx(client, req.user, {
        action: 'create',
        entity: 'order',
        entityId: created[0]?.id ?? null,
        title: `Заказ · ${stRows[0].name} на ${date}`,
        details: { lines: created.length, merged: merged.length, violations: violations.length, date },
      });
      return { created, merged, violations };
    });

    res.status(201).json({ ok: true, ...result, message: `Заказ оформлен: ${result.created.length} позиц.` });
    broadcast('orders-changed', { store, date, at: new Date().toISOString() });
  })
);

const STATUSES = ['synced', 'placed', 'confirmed', 'collected', 'cancelled'];
/** Человекочитаемые статусы — для журнала: «подтвердил заказ», «собрал», «отменил». */
const STATUS_RU: Record<string, string> = {
  synced: 'синхронизирован',
  placed: 'оформлен',
  confirmed: 'подтверждён',
  collected: 'собран',
  cancelled: 'отменён',
};
ordersRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const audit_ = await tx(async (client) => {
      const { rows } = await client.query(
        `select o.id, o.store_id as "storeId", o.status, o.date_tab::text as "dateTab",
                coalesce(tc.name, o.source_name) as name, st.name as "storeName"
           from orders o join stores st on st.id = o.store_id
           left join tech_cards tc on tc.id = o.card_id
          where o.id = $1 for update of o`,
        [id]
      );
      if (!rows.length) throw new ApiError(404, 'Заказ не найден');
      // магазинный сотрудник меняет только свои заказы и только отменяет их
      const scope = ownStore(req);
      if (scope !== null) {
        if (Number(rows[0].storeId) !== scope) throw new ApiError(404, 'Заказ не найден');
        // закрытый после списания лист — магазинная правка уже бессмысленна (данные погашены на склад)
        const { rows: lockRows } = await client.query(
          `select 1 from order_tabs where extract_date = $1::date and status in ('locked','archived') limit 1`,
          [rows[0].dateTab]
        );
        if (lockRows.length) throw new ApiError(409, 'Лист доставки закрыт (после списания) — править заказ нельзя');
        if (req.body.status !== undefined && String(req.body.status) !== 'cancelled') {
          throw new ApiError(403, 'Магазин может только отменить свой заказ');
        }
        if (req.body.qty !== undefined && !['synced', 'placed'].includes(String(rows[0].status))) {
          throw new ApiError(409, 'Заказ уже принят производством — количество менять нельзя');
        }
      }
      // автор транзакции — для триггера журнала заказов (order_changes)
      await asUser(client, req.user);
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [];
      let status: string | null = null;
      if (req.body.status !== undefined) {
        const s = String(req.body.status);
        if (!STATUSES.includes(s)) throw new ApiError(400, `status: ${STATUSES.join('|')}`);
        status = s;
        params.push(s);
        sets.push(`status = $${params.length}`);
        // кто и когда сменил статус — видно прямо в строке заказа (принял/собрал/отменил)
        params.push(req.user?.id ?? null, req.user?.login ?? 'system');
        sets.push(`status_by = $${params.length - 1}`, `status_by_login = $${params.length}`, 'status_at = now()');
        sets.push('db_edited_at = now()');
      }
      if (req.body.note !== undefined) {
        params.push(String(req.body.note));
        sets.push(`note = $${params.length}`);
      }
      if (req.body.qty !== undefined) {
        const printed = reqNum(req.body, 'qty');
        const unitIn = typeof req.body.unit === 'string' ? req.body.unit : null;
        // если передана единица — qty печатное, пересчитываем в базовое (как в /place);
        // иначе qty уже базовое (обратная совместимость с прежними вызовами)
        let base = printed;
        if (unitIn) {
          const { rows: cu } = await client.query(
            `select coalesce(u.code, o.unit_code) as "baseUnit", coalesce(tc.portion_qty::float8, 0) as "portionQty"
               from orders o left join tech_cards tc on tc.id = o.card_id
               left join units u on u.id = tc.portion_unit_id where o.id = $1`,
            [id]
          );
          const baseUnit = cu[0]?.baseUnit ?? unitIn;
          base = toBase(printed, unitIn, baseUnit, Number(cu[0]?.portionQty) || 0);
        }
        params.push(base);
        sets.push(`quantity = $${params.length}::numeric`);
        sets.push('db_edited_at = now()');
      }
      params.push(id);
      await client.query(`update orders set ${sets.join(', ')} where id = $${params.length}`, params);
      return { order: rows[0], status };
    });
    const item = audit_.order as Record<string, unknown>;
    await audit(req.user, {
      action: audit_.status ? 'approve' : 'update',
      entity: 'order',
      entityId: id,
      title: `Заказ · ${item.name} · ${item.storeName}`,
      details: audit_.status
        ? { status: audit_.status, statusRu: STATUS_RU[audit_.status] ?? audit_.status, from: item.status }
        : { note: req.body.note, qty: req.body.qty },
    });
    res.json({ ok: true });
    if (item.storeId && item.dateTab) {
      broadcast('orders-changed', { store: Number(item.storeId), date: String(item.dateTab), at: new Date().toISOString() });
    }
  })
);

// ---------- журнал изменений ----------
ordersRouter.get(
  '/journal',
  wrap(async (req, res) => {
    const store = ownStore(req) ?? (Number(req.query.store) || null);
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
              c.details, c.actor, c.user_login as "userLogin",
              coalesce(c.user_name, cu.full_name, c.user_login) as "userName",
              c.created_at as "createdAt"
         from order_changes c
         left join stores st on st.id = c.store_id
         left join order_tabs ot on ot.id = c.tab_id
         left join users cu on cu.id = c.user_id
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

// ---------- одна позиция ----------
ordersRouter.get('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Заказ не найден');
  const { rows } = await pool.query(`${ORDER_SELECT} where o.id = $1`, [id]);
  if (!rows.length) throw new ApiError(404, 'Заказ не найден');
  const scope = ownStore(req);
  if (scope !== null && Number(rows[0].storeId) !== scope) throw new ApiError(404, 'Заказ не найден');
  res.json(dec(rows[0]));
}));
