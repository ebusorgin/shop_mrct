/**
 * Окно приёма заказа магазина.
 *
 * Приём закрывается за cutoffHours до конца дня доставки: при 36 ч заказ
 * на вторник закрывается в понедельник в 12:00. Концом дня считаем полночь
 * следующего дня по времени бизнеса (Europe/Belgrade), поэтому срок не зависит
 * от часового пояса сервера БД (там UTC).
 */
import { Pool, PoolClient } from 'pg';
import { pool } from '../db';
import { deliveryDates } from './delivery-rule';
import { deliverySettings } from './settings';

/** Часовой пояс, в котором заданы дни доставки и срок приёма. */
export const ORDER_TZ = 'Europe/Belgrade';

/** Дата доставки с моментом закрытия приёма и признаком «ещё можно заказать». */
export interface DeliveryWindow {
  date: string;
  deadline: string;
  open: boolean;
}

export interface DeliveryWindows {
  today: string;
  cutoffHours: number;
  /** Даты доставки от сегодня на 120 дней вперёд, включая уже закрытые. */
  windows: DeliveryWindow[];
}

/** Все даты доставки впереди: календарь показывает и закрытые сроки, и будущие дни. */
export async function deliveryWindows(client: Pool | PoolClient = pool): Promise<DeliveryWindows> {
  const { rows } = await client.query<{ today: string }>(
    `select to_char(current_date, 'YYYY-MM-DD') as today`
  );
  const today = rows[0].today;
  const [settings, dates] = await Promise.all([deliverySettings(), deliveryDates(today, 120, client)]);
  const { rows: list } = dates.length
    ? await client.query<{ date: string; deadline: Date; open: boolean }>(
        `select to_char(d.delivery_date, 'YYYY-MM-DD') as date,
                w.deadline,
                w.deadline > now() as open
           from unnest($1::date[]) as d(delivery_date)
          cross join lateral (
            select (((d.delivery_date + 1)::timestamp at time zone $3) - make_interval(hours => $2)) as deadline
          ) w
          order by d.delivery_date`,
        [dates, settings.cutoffHours, ORDER_TZ]
      )
    : { rows: [] };
  return {
    today,
    cutoffHours: settings.cutoffHours,
    windows: list.map((row) => ({
      date: row.date,
      deadline: row.deadline.toISOString(),
      open: row.open,
    })),
  };
}
