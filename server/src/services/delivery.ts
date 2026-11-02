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

/** Дата доставки — ближайшая (включая сегодня) дата, чей день недели есть в расписании. */
export function nextDeliveryDate(cfg: DeliverySettings, at: Date = new Date()): string | null {
  if (!cfg.weekdays.length) return null;
  for (let i = 0; i <= 7; i++) {
    const p = mskNow(cfg.tz, new Date(at.getTime() + i * DAY_MS));
    if (cfg.weekdays.includes(p.weekday)) return p.dateIso;
  }
  return null;
}

/** Следующие `count` дат доставки (прокручиваем неделю вперёд за пределы горизонтов). */
export function upcomingDeliveryDates(cfg: DeliverySettings, count = 4, at: Date = new Date()): string[] {
  if (!cfg.weekdays.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // 15 дней покрывают любой недельный ритм с запасом на count дат
  for (let i = 0; i < 15 && out.length < count; i++) {
    const p = mskNow(cfg.tz, new Date(at.getTime() + i * DAY_MS));
    if (cfg.weekdays.includes(p.weekday) && !seen.has(p.dateIso)) {
      seen.add(p.dateIso);
      out.push(p.dateIso);
    }
  }
  return out;
}

/** Активная дата доставки для магазина: сегодня, если это день доставки, иначе ближайшая вперёд. */
export function currentDeliveryDate(cfg: DeliverySettings, at: Date = new Date()): string | null {
  return nextDeliveryDate(cfg, at);
}
