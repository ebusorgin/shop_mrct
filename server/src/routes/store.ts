/**
 * API магазинного сотрудника: он видит и меняет только свою точку.
 *
 *   GET   /api/store — карточка своей точки + сводка по заказам
 *   PATCH /api/store — правка информации о магазине (адрес, телефоны, контакты…)
 *
 * Заказы магазина живут в /api/orders — там те же ручки, что у офиса, но
 * для магазинного сотрудника они автоматически сужены до его точки.
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, wrap } from '../http';
import { requireStore } from '../services/auth';
import { audit, diff } from '../services/audit';

export const storeRouter = Router();

/** Текстовое поле точки: колонки stores not null default '', поэтому пусто -> ''. */
function optStr(v: unknown, max: number, label: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ApiError(400, `Поле «${label}» должно быть строкой`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length > max) throw new ApiError(400, `Поле «${label}»: не длиннее ${max} символов`);
  return s;
}

const CARD_SQL = `
  select s.id, s.code, s.name, s.active,
         s.address, s.phone, s.email,
         s.contact_person as "contactPerson",
         s.opening_hours as "openingHours",
         s.note,
         (select max(o.date_tab)::text from orders o where o.store_id = s.id) as "lastOrderDate",
         (select count(distinct o.date_tab)::int from orders o where o.store_id = s.id) as "orderDays",
         (select count(*)::int from orders o
           where o.store_id = s.id
             and o.date_tab = (select max(date_tab) from orders where store_id = s.id)) as "lastDateLines",
         (select count(*)::int from orders o
           where o.store_id = s.id and o.status in ('synced', 'placed', 'confirmed')) as "openLines",
         (select count(*)::int from orders o
           where o.store_id = s.id and o.date_tab = current_date) as "todayLines",
         (select count(*)::int from users u where u.store_id = s.id and u.active) as "employees"
    from stores s where s.id = $1`;

storeRouter.get(
  '/',
  requireStore,
  wrap(async (req, res) => {
    const storeId = req.user?.storeId as number;
    const { rows } = await pool.query(CARD_SQL, [storeId]);
    if (!rows.length) throw new ApiError(404, 'Магазин не найден');
    res.json(rows[0]);
  })
);

storeRouter.patch(
  '/',
  requireStore,
  wrap(async (req, res) => {
    const storeId = req.user?.storeId as number;
    const { rows } = await pool.query(
      `select id, name, address, phone, email, contact_person, opening_hours, note
         from stores where id = $1`,
      [storeId]
    );
    const cur = rows[0];
    if (!cur) throw new ApiError(404, 'Магазин не найден');

    // код/номер/активность меняет только офис: по ним заказы сходятся с таблицей
    const name = optStr(req.body?.name, 120, 'Название');
    if (!name) throw new ApiError(400, 'Название магазина не может быть пустым');

    const next = {
      name,
      address: optStr(req.body?.address, 200, 'Адрес'),
      phone: optStr(req.body?.phone, 60, 'Телефон'),
      email: optStr(req.body?.email, 120, 'E-mail'),
      contact_person: optStr(req.body?.contactPerson, 120, 'Контактное лицо'),
      opening_hours: optStr(req.body?.openingHours, 120, 'Часы работы'),
      note: optStr(req.body?.note, 500, 'Примечание'),
    };

    await pool.query(
      `update stores set name=$2, address=$3, phone=$4, email=$5, contact_person=$6,
              opening_hours=$7, note=$8, updated_at=now(), updated_by=$9
        where id=$1`,
      [
        storeId, next.name, next.address, next.phone, next.email,
        next.contact_person, next.opening_hours, next.note,
        req.user?.id ?? null,
      ]
    );
    await audit(req.user, {
      action: 'update',
      entity: 'store',
      entityId: storeId,
      title: `Магазин «${next.name}» · свои данные`,
      details: diff(cur as Record<string, unknown>, next),
    });
    res.json({ ok: true });
  })
);
