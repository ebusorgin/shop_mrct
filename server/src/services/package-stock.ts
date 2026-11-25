import { PoolClient } from 'pg';
import { ApiError } from '../http';
import { config } from '../config';
import type { Actor } from './audit';

export type PackageMovementType = 'receipt' | 'writeoff' | 'adjustment';

export interface PackageMoveInput {
  packageId: number;
  type: PackageMovementType;
  /** Изменение остатка в штуках (со знаком). */
  delta: number;
  unitCost?: number;
  docType?: string;
  docId?: number;
  comment?: string;
  actor?: Actor;
}

/**
 * Движение по таре: обновляет остаток и средневзвешенную себестоимость
 * в packages и пишет строку в package_movements. Вызывается внутри транзакции.
 */
export async function applyPackageMovement(client: PoolClient, m: PackageMoveInput): Promise<void> {
  const { rows } = await client.query<{ qty: number; avg_cost: number }>(
    'select qty::float8 as qty, avg_cost::float8 as avg_cost from packages where id = $1 for update',
    [m.packageId]
  );
  if (!rows.length) throw new ApiError(404, `Тара #${m.packageId} не найдена`);

  const oldQty = Number(rows[0].qty);
  const oldCost = Number(rows[0].avg_cost);
  const newQty = oldQty + m.delta;
  if (!config.allowNegativeStock && m.type !== 'receipt' && newQty < -1e-9) {
    throw new ApiError(409, `Недостаточно тары (позиция #${m.packageId}): есть ${oldQty}, нужно ${-m.delta}`);
  }

  let avgCost = oldCost;
  if (m.type === 'receipt' && m.unitCost !== undefined) {
    avgCost = newQty > 0 ? (oldQty * oldCost + m.delta * m.unitCost) / newQty : m.unitCost;
  }

  await client.query(
    'update packages set qty = $2, avg_cost = $3, updated_at = now() where id = $1',
    [m.packageId, newQty, avgCost]
  );
  await client.query(
    `insert into package_movements
       (package_id, type, qty, unit_cost, doc_type, doc_id, comment, user_id, user_login)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      m.packageId,
      m.type,
      m.delta,
      m.unitCost ?? (m.type === 'writeoff' ? oldCost : 0),
      m.docType ?? null,
      m.docId ?? null,
      m.comment ?? null,
      m.actor?.id ?? null,
      m.actor?.login ?? null,
    ]
  );
}
