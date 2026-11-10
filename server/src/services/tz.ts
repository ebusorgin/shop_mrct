/**
 * Часы по таймзоне — общий helper для расписаний (списание, доставка).
 *
 * Живет отдельно от writeoff, чтобы delivery не зацикливал импорты
 * (writeoff → delivery → writeoff).
 */

const WD_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface TzNow {
  dateIso: string;
  weekday: number; // 0=Вс … 6=Сб (конвенция JS getDay)
  hhmm: string;
}

/** Текущие «дата / день недели / HH:MM» в указанной таймзоне (по умолчанию Москва). */
export function mskNow(tz = 'Europe/Moscow', at: Date = new Date()): TzNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    dateIso: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WD_MAP[get('weekday')] ?? at.getUTCDay(),
    hhmm: `${get('hour').padStart(2, '0')}:${get('minute')}`,
  };
}
