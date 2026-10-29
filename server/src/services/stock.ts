import { PoolClient } from 'pg';
import { ApiError } from '../http';
import { config } from '../config';
import type { Actor } from './audit';

export type MovementType = 'receipt' | 'writeoff' | 'adjustment';

export interface MoveInput {
  productId: number;
  type: MovementType;
  /** Изменение остатка в базовых единицах (со знаком: + приход, − расход) */
  delta: number;
  unitCost?: number;
  docType?: string;
  docId?: number;
  comment?: string;
  /** Кто сделал движение: пишется в movements.user_login — видно в журнале склада. */
  actor?: Actor;
}

/**
 * Применяет движение по складу: обновляет stock.qty и средневзвешенную себестоимость,
 * пишет строку в journal movements. Вызывается внутри транзакции.
 */
export async function applyMovement(client: PoolClient, m: MoveInput): Promise<void> {
  // строка остатков существует у каждого продукта (создаётся при POST /products)
  const { rows } = await client.query(
    'select qty::float8 as qty, avg_cost::float8 as avg_cost from stock where product_id = $1 for update',
    [m.productId]
  );
  if (rows.length === 0) throw new ApiError(404, `Нет строки склада для продукта #${m.productId}`);

  const oldQty: number = rows[0].qty;
  const oldCost: number = rows[0].avg_cost;
  const newQty = oldQty + m.delta;

  if (!config.allowNegativeStock && m.type !== 'receipt' && newQty < -1e-9) {
    throw new ApiError(409, `Недостаточно сырья на складе (продукт #${m.productId}): есть ${oldQty}, нужно ${-m.delta}`);
  }

  // средневзвешенная себестоимость: обновляется только при приходе
  let avgCost = oldCost;
  if (m.type === 'receipt' && m.unitCost !== undefined) {
    const cost = m.unitCost;
    avgCost = oldQty + m.delta > 0 ? (oldQty * oldCost + m.delta * cost) / (oldQty + m.delta) : cost;
  }

  await client.query(
    'update stock set qty = $2, avg_cost = $3, updated_at = now() where product_id = $1',
    [m.productId, newQty, avgCost]
  );
  await client.query(
    `insert into movements (product_id, type, qty, unit_cost, doc_type, doc_id, comment, user_id, user_login)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      m.productId, m.type, m.delta, m.unitCost ?? (m.type === 'writeoff' ? oldCost : 0),
      m.docType ?? null, m.docId ?? null, m.comment ?? null,
      m.actor?.id ?? null, m.actor?.login ?? null,
    ]
  );
}
