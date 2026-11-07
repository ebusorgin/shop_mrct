/**
 * Календарь доставок: какие дни недели являются датами доставки и какая доставка ближайшая.
 *
 * CRM сам вычисляет дату доставки по настройкам (модель «CRM-управляемые листы»):
 * магазины видят активную дату доставки, а прошлые (после списания) закрываются.
 * Всё считается по часовому поясу расписания (по умолчанию Москва) через mskNow из tz.
 */
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
