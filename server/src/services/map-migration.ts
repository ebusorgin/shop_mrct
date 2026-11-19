import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db';

let applied: boolean | null = null;

export async function mapMigrationApplied(): Promise<boolean> {
  if (applied != null) return applied;
  const { rows } = await pool.query(
    "select 1 from app_migrations where name = 'legacy_to_map_v1'"
  );
  applied = rows.length > 0;
  return applied;
}

/** Эндпоинты заказов не работают, пока старые id фасовок не перенесены на карту. */
export function requireMapMigrated(_req: Request, res: Response, next: NextFunction): void {
  mapMigrationApplied()
    .then((ok) => {
      if (!ok) {
        res.status(503).json({ error: 'Требуется миграция данных на карту производства' });
        return;
      }
      next();
    })
    .catch(next);
}
