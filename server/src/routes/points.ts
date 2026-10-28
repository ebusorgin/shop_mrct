/**
 * API раздела «Точки продаж» — управление торговыми точками (stores) + карточки
 * для директора с агрегатами по заказам.
 *
 *   GET    /api/points            — список точек с профилем, здоровьем и трендом
 *   GET    /api/points/:id        — одна точка (там же состав карточки)
 *   POST   /api/points            — создать точку
 *   PATCH  /api/points/:id        — редактировать точку
 *   POST   /api/points/:id/deactivate — мягко деактивировать (история цела)
 *   DELETE /api/points/:id        — удалить навсегда (только если по точке нет заказов)
 *
 * Логику заказов (orders/order_tabs/order_changes, синхронизацию) не меняем —
 * здесь только читаем из них read-only агрегаты.
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, reqInt, reqNum, wrap } from '../http';
import { printedQty } from '../services/order-match';

export const pointsRouter = Router();

/** Порог «зависла» — столько дней без заказа считается признаком отставания (≈ окно между доставками). */
const DAYS_STALE = 4;
/** Сколько последних листов-дат показывать на графике тренда. */
const TREND_TABS = 10;

type Badge = 'inactive' | 'none' | 'missed' | 'stale' | 'ok';

interface TrendPoint {
  tabDate: string;
  positions: number;
  totalCost: number | null;
}

interface PointCard {
  id: number;
  code: string;
  name: string;
  active: boolean;
  position: number;
  address: string;
  phone: string;
  email: string;
  contactPerson: string;
  openingHours: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  health: {
    lastOrderDate: string | null;
    daysSince: number | null;
    lastSyncAt: string | null;
    onLatestTab: number;
    latestTab: string | null;
    badge: Badge;
  };
  trend: TrendPoint[];
}

/** Optional string из тела (не строка/пусто -> переданный def). */
function optStr(body: Record<string, unknown>, field: string, def = ''): string {
  const v = body[field];
  if (v === undefined || v === null) return def;
  return String(v).trim();
}

function badgeOf(active: boolean, lastOrderDate: string | null, onLatestTab: number, daysSince: number | null): Badge {
  if (!active) return 'inactive';
  if (!lastOrderDate) return 'none';
  if (onLatestTab === 0) return 'missed';
  if (daysSince !== null && daysSince > DAYS_STALE) return 'stale';
  return 'ok';
}

/** Строки последних ~TREND_TABS листов по всем точкам для расчёта стоимости (печатное × VK). */
async function loadTrend(): Promise<Map<number, TrendPoint[]>> {
  const { rows } = await pool.query(`
    with ranked as (
      select o.store_id,
             o.date_tab::text as tab_date,
             o.quantity::float8 as qty,
             o.unit_code as unit_code,
             o.vk_price::float8 as vk,
             coalesce(tc.portion_qty::float8, 0) as portion_qty,
             u.code as card_unit,
             dense_rank() over (partition by o.store_id order by o.date_tab desc) as rk
        from orders o
        left join tech_cards tc on tc.id = o.card_id
        left join units u on u.id = tc.portion_unit_id
    )
    select store_id as "storeId", tab_date as "tabDate", qty, unit_code as "unitCode",
           vk, portion_qty as "portionQty", card_unit as "cardUnit"
      from ranked where rk <= $1
     order by store_id, tab_date`,
    [TREND_TABS]
  );

  // Группируем строки по (точка, лист): позиции = число строк, стоимость = сумма vk × печатное.
  const acc = new Map<number, Map<string, { positions: number; cost: number; costLines: number }>>();
  for (const r of rows) {
    const storeId = Number(r.storeId);
    const tabDate = String(r.tabDate);
    let byTab = acc.get(storeId);
    if (!byTab) {
      byTab = new Map();
      acc.set(storeId, byTab);
    }
    let cell = byTab.get(tabDate);
    if (!cell) {
      cell = { positions: 0, cost: 0, costLines: 0 };
      byTab.set(tabDate, cell);
    }
    cell.positions += 1;
    if (r.vk !== null) {
      const printed = printedQty({
        qty: Number(r.qty),
        unitCode: r.unitCode ?? null,
        cardUnit: r.cardUnit ?? null,
        portionQty: Number(r.portionQty),
      });
      cell.cost += Number(r.vk) * printed;
      cell.costLines += 1;
    }
  }

  const out = new Map<number, TrendPoint[]>();
  for (const [storeId, byTab] of acc) {
    const pts: TrendPoint[] = [...byTab.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([tabDate, c]) => ({
        tabDate,
        positions: c.positions,
        totalCost: c.costLines ? Math.round(c.cost * 100) / 100 : null,
      }));
    out.set(storeId, pts);
  }
  return out;
}

/** Стоимость строки заказа (печатное × VK); null, если VK не задан. */
function rowCost(r: Record<string, unknown>): number | null {
  if (r.vk === null || r.vk === undefined) return null;
  const printed = printedQty({
    qty: Number(r.qty),
    unitCode: (r.unitCode as string) ?? null,
    cardUnit: (r.cardUnit as string) ?? null,
    portionQty: Number(r.portionQty),
  });
  return Number(r.vk) * printed;
}

/** Серия объёма по листам-датам одной точки за период (months=0 — всё). */
async function loadStoreTrend(storeId: number, months: number): Promise<TrendPoint[]> {
  const { rows } = await pool.query(
    `select o.date_tab::text as "tabDate", o.quantity::float8 as qty,
            o.unit_code as "unitCode", o.vk_price::float8 as vk,
            coalesce(tc.portion_qty::float8, 0) as "portionQty", u.code as "cardUnit"
       from orders o
       left join tech_cards tc on tc.id = o.card_id
       left join units u on u.id = tc.portion_unit_id
      where o.store_id = $1
        and ($2::int = 0 or o.date_tab >= current_date - ($2::int * interval '1 month'))
      order by o.date_tab`,
    [storeId, months]
  );
  const byTab = new Map<string, { positions: number; cost: number; costLines: number }>();
  for (const r of rows) {
    const tab = String(r.tabDate);
    let cell = byTab.get(tab);
    if (!cell) {
      cell = { positions: 0, cost: 0, costLines: 0 };
      byTab.set(tab, cell);
    }
    cell.positions += 1;
    const c = rowCost(r);
    if (c !== null) {
      cell.cost += c;
      cell.costLines += 1;
    }
  }
  return [...byTab.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([tabDate, c]) => ({
      tabDate,
      positions: c.positions,
      totalCost: c.costLines ? Math.round(c.cost * 100) / 100 : null,
    }));
}

/** Список точек с профилем + health-агрегатами (trend добавляется отдельно). */
async function loadCards(): Promise<PointCard[]> {
  const { rows } = await pool.query(`
    select s.id, s.code, s.name, s.active, s.position,
           s.address, s.phone, s.email, s.contact_person as "contactPerson",
           s.opening_hours as "openingHours", s.note,
           to_char(s.created_at, 'YYYY-MM-DD') as "createdAt",
           to_char(s.updated_at, 'YYYY-MM-DD') as "updatedAt",
           (select max(o.date_tab)::text from orders o where o.store_id = s.id) as "lastOrderDate",
           (select greatest(0, current_date - max(o.date_tab)) from orders o where o.store_id = s.id) as "daysSince",
           (select count(*)::int from orders o where o.store_id = s.id
              and o.date_tab = (select max(date_tab) from orders)) as "onLatestTab",
           (select max(o2.date_tab)::text from orders o2) as "latestTab",
           (select max(ot.last_sync_at) from orders o3
              join order_tabs ot on ot.id = o3.tab_id where o3.store_id = s.id) as "lastSyncAt"
      from stores s
     order by s.position, s.id`);

  const trend = await loadTrend();
  return rows.map((r) => {
    const daysSince = r.daysSince === null ? null : Number(r.daysSince);
    const onLatestTab = Number(r.onLatestTab);
    return {
      id: Number(r.id),
      code: r.code,
      name: r.name,
      active: r.active,
      position: Number(r.position),
      address: r.address ?? '',
      phone: r.phone ?? '',
      email: r.email ?? '',
      contactPerson: r.contactPerson ?? '',
      openingHours: r.openingHours ?? '',
      note: r.note ?? '',
      createdAt: r.createdAt ?? '',
      updatedAt: r.updatedAt ?? '',
      health: {
        lastOrderDate: r.lastOrderDate ?? null,
        daysSince,
        lastSyncAt: r.lastSyncAt ?? null,
        onLatestTab,
        latestTab: r.latestTab ?? null,
        badge: badgeOf(r.active, r.lastOrderDate ?? null, onLatestTab, daysSince),
      },
      trend: trend.get(Number(r.id)) ?? [],
    } as PointCard;
  });
}

pointsRouter.get(
  '/',
  wrap(async (_req, res) => {
    res.json(await loadCards());
  })
);

/** Серия «объём заказа по доставкам» за период (мес): 1/3/6/12, 0 — всё. */
pointsRouter.get(
  '/:id/volume',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const raw = Number(req.query.months ?? 1);
    const months = Number.isFinite(raw) && raw >= 0 ? Math.min(24, Math.floor(raw)) : 1;
    res.json(await loadStoreTrend(id, months));
  })
);

/** Строки заказа точки за конкретную дату-лист (подсказка на графике объёма). */
pointsRouter.get(
  '/:id/day/:date',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'date: YYYY-MM-DD');
    const { rows } = await pool.query(
      `select coalesce(tc.id::bigint, -o.id) as id,
              coalesce(tc.name, o.source_name) as name, oc.name as category,
              o.quantity::float8 as qty, o.unit_code as "unitCode", o.vk_price::float8 as vk,
              coalesce(tc.portion_qty::float8, 0) as "portionQty", u.code as "cardUnit"
         from orders o
         left join tech_cards tc on tc.id = o.card_id
         left join units u on u.id = tc.portion_unit_id
         left join order_categories oc on oc.id = o.category_id
        where o.store_id = $1 and o.date_tab = $2::date
        order by oc.name nulls last, name`,
      [id, date]
    );
    let total = 0;
    let costLines = 0;
    const lines = rows.map((r) => {
      const printed = printedQty({
        qty: Number(r.qty),
        unitCode: (r.unitCode as string) ?? null,
        cardUnit: (r.cardUnit as string) ?? null,
        portionQty: Number(r.portionQty),
      });
      const sum = r.vk === null || r.vk === undefined ? null : Number(r.vk) * printed;
      if (sum !== null) {
        total += sum;
        costLines += 1;
      }
      return {
        id: Number(r.id),
        name: String(r.name),
        category: (r.category as string) ?? null,
        qty: Math.round(printed * 1000) / 1000,
        unit: (r.unitCode as string) ?? (r.cardUnit as string) ?? '',
        sum: sum === null ? null : Math.round(sum * 100) / 100,
      };
    });
    res.json({
      date,
      positions: lines.length,
      lines,
      totalCost: costLines ? Math.round(total * 100) / 100 : null,
    });
  })
);

pointsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const cards = await loadCards();
    const card = cards.find((c) => c.id === id);
    if (!card) throw new ApiError(404, 'Точка не найдена');
    res.json(card);
  })
);

pointsRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Поле «name» обязательно');

    // id = номер точки; если не задан — следующий свободный после существующих.
    let id: number;
    if (req.body.id !== undefined && req.body.id !== null && req.body.id !== '') {
      id = reqInt(req.body, 'id');
      const { rows: dup } = await pool.query('select 1 from stores where id = $1', [id]);
      if (dup.length) throw new ApiError(409, `Точка с номером ${id} уже существует`);
    } else {
      const { rows } = await pool.query('select coalesce(max(id), 102) + 1 as nid from stores');
      id = Number(rows[0].nid);
    }

    const code = optStr(req.body, 'code') || `Mix 38${id}`;
    const { rows: codeDup } = await pool.query('select 1 from stores where code = $1', [code]);
    if (codeDup.length) throw new ApiError(409, `Код «${code}» уже используется`);

    const position = req.body.position === undefined || req.body.position === '' ? id : reqNum(req.body, 'position');
    const active = req.body.active === undefined ? true : Boolean(req.body.active);

    await pool.query(
      `insert into stores (id, code, name, active, position, address, phone, email, contact_person, opening_hours, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, code, name, active, position,
        optStr(req.body, 'address'), optStr(req.body, 'phone'), optStr(req.body, 'email'),
        optStr(req.body, 'contactPerson'), optStr(req.body, 'openingHours'), optStr(req.body, 'note'),
      ]
    );
    res.status(201).json({ id });
  })
);

pointsRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Поле «name» обязательно');
    const { rows: cur } = await pool.query('select id from stores where id = $1', [id]);
    if (!cur.length) throw new ApiError(404, 'Точка не найдена');

    const code = optStr(req.body, 'code') || `Mix 38${id}`;
    const { rows: codeDup } = await pool.query('select 1 from stores where code = $1 and id <> $2', [code, id]);
    if (codeDup.length) throw new ApiError(409, `Код «${code}» уже используется`);

    const position = req.body.position === undefined || req.body.position === '' ? id : reqNum(req.body, 'position');
    const active = req.body.active === undefined ? true : Boolean(req.body.active);

    await pool.query(
      `update stores set code=$2, name=$3, active=$4, position=$5, address=$6, phone=$7, email=$8,
              contact_person=$9, opening_hours=$10, note=$11, updated_at=now()
        where id=$1`,
      [
        id, code, name, active, position,
        optStr(req.body, 'address'), optStr(req.body, 'phone'), optStr(req.body, 'email'),
        optStr(req.body, 'contactPerson'), optStr(req.body, 'openingHours'), optStr(req.body, 'note'),
      ]
    );
    res.json({ ok: true });
  })
);

pointsRouter.post(
  '/:id/deactivate',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query('update stores set active = false, updated_at = now() where id = $1 returning id', [id]);
    if (!rows.length) throw new ApiError(404, 'Точка не найдена');
    res.json({ ok: true });
  })
);

pointsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query('select count(*)::int as c from orders where store_id = $1', [id]);
    if (Number(rows[0].c) > 0) {
      throw new ApiError(409, 'По точке есть заказы — удалите нельзя, можно деактивировать');
    }
    const { rows: del } = await pool.query('delete from stores where id = $1 returning id', [id]);
    if (!del.length) throw new ApiError(404, 'Точка не найдена');
    res.json({ ok: true });
  })
);
