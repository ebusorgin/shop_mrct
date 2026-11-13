/**
 * Повторяющееся правило доставок: выбранные дни недели и числа месяца.
 *
 * Хранится не JSON-ом в настройках, а строками справочника delivery_schedule_period,
 * и в даты не разворачивается: в delivery_schedule остаются только ручные отметки,
 * которые с правилом могут и совпадать — это разные источники дня.
 */
import { Pool, PoolClient } from 'pg';
import { pool } from '../db';
import { ApiError } from '../http';

export interface DeliveryRule {
  /** Дни недели по ISO: 1 — понедельник … 7 — воскресенье. */
  weekdays: number[];
  /** Числа месяца 1…31; если числа в месяце нет, оно пропускается. */
  monthDays: number[];
}

/** Вид элемента справочника периодов. */
export type DeliveryPeriodKind = 'weekday' | 'monthday';

const PERIOD_FIELDS: Record<DeliveryPeriodKind, keyof DeliveryRule> = {
  weekday: 'weekdays',
  monthday: 'monthDays',
};

function dayList(value: unknown, field: string, max: number): number[] {
  const invalid = () => new ApiError(400, `Поле «${field}»: нужен массив целых чисел от 1 до ${max}`);
  if (!Array.isArray(value) || value.length > max) throw invalid();
  for (const day of value) {
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > max) throw invalid();
  }
  return [...new Set<number>(value)].sort((a, b) => a - b);
}

/** Строгий payload правила: оба поля обязательны, пустые списки означают «выключено». */
export function deliveryRuleInput(body: unknown): DeliveryRule {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Укажите дни недели и числа месяца для повторяющихся доставок');
  }
  const raw = body as Record<string, unknown>;
  for (const field of ['weekdays', 'monthDays']) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) {
      throw new ApiError(400, `Поле «${field}» обязательно`);
    }
  }
  return {
    weekdays: dayList(raw.weekdays, 'weekdays', 7),
    monthDays: dayList(raw.monthDays, 'monthDays', 31),
  };
}

/** Активные строки справочника периодов; пустой справочник означает «правило выключено». */
export async function deliveryRule(client: Pool | PoolClient = pool): Promise<DeliveryRule> {
  const { rows } = await client.query<{ kind: DeliveryPeriodKind; value: number }>(
    'select kind, value from delivery_schedule_period where enabled order by kind, value',
    []
  );
  const rule: DeliveryRule = { weekdays: [], monthDays: [] };
  for (const row of rows) rule[PERIOD_FIELDS[row.kind]].push(row.value);
  return rule;
}

/** Правило — это флаги справочника: выбранные значения включаем, остальные снимаем. */
export async function writeDeliveryRule(client: Pool | PoolClient, next: DeliveryRule): Promise<DeliveryRule> {
  await client.query(
    `update delivery_schedule_period
        set enabled = value = any (case kind when 'weekday' then $1::int[] else $2::int[] end)`,
    [next.weekdays, next.monthDays]
  );
  return next;
}

