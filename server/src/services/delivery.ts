/**
 * Календарь доставок: какие дни недели являются датами доставки и какая доставка ближайшая.
 *
 * CRM сам вычисляет дату доставки по настройкам (модель «CRM-управляемые листы»):
 * магазины видят активную дату доставки, а прошлые (после списания) закрываются.
 * Всё считается по часовому поясу расписания (по умолчанию Москва) через mskNow из tz.
 */
import { pool } from '../db';
import { mskNow } from './tz';
import type { DeliverySettings } from './settings';

const DAY_MS = 86_400_000;

/** Дата доставки — ближайшая (включая сегодня) дата из списка выбранных. */
export function nextDeliveryDate(cfg: DeliverySettings, at: Date = new Date()): string | null {
  if (!cfg.dates || !cfg.dates.length) return null;
  const todayIso = mskNow(cfg.tz, at).dateIso;
  for (const d of cfg.dates) {
    if (d >= todayIso) return d;
  }
  return null;
}

/** Следующие `count` дат доставки (начиная с сегодняшней или ближайшей будущей). */
export function upcomingDeliveryDates(cfg: DeliverySettings, count = 4, at: Date = new Date()): string[] {
  if (!cfg.dates || !cfg.dates.length) return [];
  const todayIso = mskNow(cfg.tz, at).dateIso;
  return cfg.dates.filter((d) => d >= todayIso).slice(0, count);
}

/** Активная дата доставки для магазина: сегодня, если это день доставки, иначе ближайшая вперёд. */
export function currentDeliveryDate(cfg: DeliverySettings, at: Date = new Date()): string | null {
  return nextDeliveryDate(cfg, at);
}

/** Закрывает все незакрытые заказы на прошедшие даты и блокирует их листы доставки. */
export async function closePastOrders(tz = 'Europe/Moscow'): Promise<number> {
  const todayIso = mskNow(tz).dateIso;

  // 1. Блокируем открытые листы доставки в прошлом
  await pool.query(
    "update order_tabs set status = 'locked', locked_at = coalesce(locked_at, now()) where extract_date < $1::date and status = 'open'",
    [todayIso]
  );

  // 2. Гарантируем закрытый лист в order_tabs для прошлых дат с заказами
  await pool.query(
    `insert into order_tabs (sheet_name, extract_date, status, locked_at)
     select distinct to_char(date_tab, 'YYYY-MM-DD'), date_tab, 'locked', now()
       from orders
      where date_tab < $1::date
        and not exists (select 1 from order_tabs t where t.extract_date = orders.date_tab)
     on conflict do nothing`,
    [todayIso]
  );

  // 3. Закрываем незакрытые заказы на прошедшие даты
  const res = await pool.query(
    `update orders
        set status = 'collected',
            status_at = coalesce(status_at, now())
      where date_tab < $1::date
        and status in ('synced', 'placed')`,
    [todayIso]
  );
  return res.rowCount ?? 0;
}
