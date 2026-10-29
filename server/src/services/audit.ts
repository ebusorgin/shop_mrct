/**
 * Журнал действий: кто, что, когда.
 *
 * Любая мутация в API заканчивается вызовом audit() (вне транзакции) или auditTx()
 * (внутри транзакции — тогда запись откатится вместе с изменением, и в журнале
 * не появится действий, которых не случилось).
 *
 * Отдельно есть asUser(): он кладёт логин в настройки транзакции (app.actor_id /
 * app.actor_login), откуда его читают триггеры БД — сейчас это журнал заказов
 * (order_changes), где изменение строки делает сама база, а не маршрут.
 */
import { PoolClient } from 'pg';
import { pool } from '../db';
import type { AuthUser } from './auth';

/** Вид действия — первая колонка журнала, по ней же фильтр в интерфейсе. */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'post' // проведение документа (накладная, партия)
  | 'reverse' // отмена/сторно
  | 'adjust' // корректировка склада
  | 'approve' // смена статуса заказа (принял/собрал/отменил)
  | 'login'
  | 'logout'
  | 'password'
  | 'role'
  | 'sync';

/** Сущность журнала — вторая колонка и фильтр «раздел». */
export type AuditEntity =
  | 'product'
  | 'waybill'
  | 'semi'
  | 'tech_card'
  | 'batch'
  | 'order'
  | 'store'
  | 'user'
  | 'stock'
  | 'sheet'
  | 'setting';

export interface AuditEntry {
  action: AuditAction;
  entity: AuditEntity;
  entityId?: number | string | null;
  /** Человекочитаемое название: «Накладная №1042 · Milkos», «Заказ · Магазин 103». */
  title?: string;
  details?: Record<string, unknown>;
}

/** Тот, от чьего имени пишем: пользователь сессии либо система (синхронизатор, миграция). */
export type Actor = Pick<AuthUser, 'id' | 'login' | 'fullName'> | null | undefined;

export function actorName(actor: Actor): string {
  return actor?.fullName || actor?.login || 'system';
}

function args(actor: Actor, e: AuditEntry): unknown[] {
  return [
    actor?.id ?? null,
    actor?.login ?? 'system',
    actorName(actor),
    e.action,
    e.entity,
    e.entityId === undefined || e.entityId === null ? null : String(e.entityId),
    (e.title ?? '').slice(0, 200),
    JSON.stringify(e.details ?? {}),
  ];
}

const SQL_INSERT = `insert into audit_log (user_id, user_login, user_name, action, entity, entity_id, title, details)
                    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`;

/** Запись журнала вне транзакции. Сбой журнала не должен ломать саму операцию. */
export async function audit(actor: Actor, e: AuditEntry): Promise<void> {
  try {
    await pool.query(SQL_INSERT, args(actor, e));
  } catch (err) {
    console.error('[audit] не удалось записать событие:', (err as Error).message);
  }
}

/** Запись журнала внутри транзакции — откатится вместе с изменением. */
export async function auditTx(client: PoolClient, actor: Actor, e: AuditEntry): Promise<void> {
  await client.query(SQL_INSERT, args(actor, e));
}

/**
 * Помечает транзакцию «кто действует» — для триггеров БД (журнал заказов).
 * Значение живёт до конца транзакции (set_config(..., true)).
 */
export async function asUser(client: PoolClient, actor: Actor): Promise<void> {
  await client.query(
    `select set_config('app.actor_id', $1, true),
            set_config('app.actor_login', $2, true),
            set_config('app.actor_name', $3, true)`,
    [actor ? String(actor.id) : '', actor?.login ?? 'system', actorName(actor)]
  );
}

/** Отпечаток изменения: какие поля реально поменялись — экономит место в журнале. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (a === b) continue;
    out[key] = { from: a ?? null, to: b ?? null };
  }
  return out;
}
