import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqInt, reqNum, wrap } from '../http';
import { auditTx } from '../services/audit';
import { applyPackageMovement, type PackageMovementType } from '../services/package-stock';

export const packagesRouter = Router();

const TYPES: PackageMovementType[] = ['receipt', 'writeoff', 'adjustment'];
const KINDS = ['jar', 'lid', 'bag', 'container', 'other'];

/** Новая позиция тары. */
packagesRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'Название тары не может быть пустым');
    const kind = String(req.body.kind ?? 'other');
    if (!KINDS.includes(kind)) throw new ApiError(400, 'Вид тары: jar, lid, bag, container или other');
    let created: { id: number; name: string; kind: string } | null = null;
    await tx(async (client) => {
      const { rows, rowCount } = await client.query(
        `insert into packages (name, kind) values ($1, $2)
         on conflict (name) do nothing
         returning id, name, kind`,
        [name, kind]
      );
      if (!rowCount) throw new ApiError(409, 'Тара с таким названием уже есть');
      created = rows[0];
      await auditTx(client, req.user, {
        action: 'create',
        entity: 'stock',
        entityId: rows[0].id,
        title: `Тара «${name}»`,
      });
    });
    res.status(201).json(created);
  })
);

/** Удалить тару можно, только если она не используется в фасовках и без движений. */
packagesRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'Некорректный id тары');
    await tx(async (client) => {
      const { rows } = await client.query('select name from packages where id = $1', [id]);
      if (!rows.length) throw new ApiError(404, 'Тара не найдена');
      const { rows: used } = await client.query(
        'select count(*)::int as c from product_sku_packages where package_id = $1',
        [id]
      );
      if (Number(used[0]?.c) > 0) {
        throw new ApiError(409, 'Тара используется в фасовках — сначала уберите её из SKU');
      }
      const { rows: moved } = await client.query(
        'select count(*)::int as c from package_movements where package_id = $1',
        [id]
      );
      if (Number(moved[0]?.c) > 0) {
        throw new ApiError(409, 'По таре есть движения — удалить нельзя, остаётся в истории');
      }
      await client.query('delete from packages where id = $1', [id]);
      await auditTx(client, req.user, {
        action: 'delete',
        entity: 'stock',
        entityId: id,
        title: `Тара «${rows[0].name}» удалена`,
      });
    });
    res.json({ ok: true });
  })
);

/** Остатки тары. */
packagesRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select id, name, kind,
              qty::float8 as qty,
              avg_cost::float8 as "avgCost",
              (qty * avg_cost)::float8 as value,
              to_char(updated_at, 'YYYY-MM-DD HH24:MI') as "updatedAt"
         from packages
        order by kind, name`
    );
    res.json(rows);
  })
);

/** Журнал движений тары. */
packagesRouter.get(
  '/movements',
  wrap(async (req, res) => {
    const packageId = req.query.packageId == null || req.query.packageId === ''
      ? null
      : reqNum(req.query as Record<string, unknown>, 'packageId');
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const { rows } = await pool.query(
      `select m.id, m.package_id as "packageId", p.name as "packageName",
              m.type, m.qty::float8 as qty, m.unit_cost::float8 as "unitCost",
              m.comment, m.user_login as "userLogin",
              coalesce(nullif(btrim(u.full_name), ''), m.user_login) as "userName",
              to_char(m.created_at, 'YYYY-MM-DD HH24:MI') as "createdAt"
         from package_movements m
         join packages p on p.id = m.package_id
         left join users u on u.id = m.user_id
        where ($1::int is null or m.package_id = $1)
        order by m.id desc
        limit $2`,
      [packageId, limit]
    );
    res.json(rows);
  })
);

/** Приход, списание или корректировка тары. */
packagesRouter.post(
  '/movements',
  wrap(async (req, res) => {
    const packageId = reqInt(req.body, 'packageId');
    const type = String(req.body.type ?? '');
    if (!(TYPES as string[]).includes(type)) {
      throw new ApiError(400, 'type: receipt, writeoff или adjustment');
    }
    const qty = reqNum(req.body, 'qty');
    if (type === 'adjustment' ? qty === 0 : !(qty > 0)) {
      throw new ApiError(400, type === 'adjustment' ? 'Корректировка не может быть 0' : 'Количество должно быть больше 0');
    }
    const rawCost = req.body.unitCost;
    const unitCost = rawCost == null || rawCost === '' ? 0 : Number(rawCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new ApiError(400, 'Цена за штуку не может быть отрицательной');
    }
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
    const delta = type === 'writeoff' ? -qty : qty;
    const movementType = type as PackageMovementType;

    await tx(async (client) => {
      const { rows } = await client.query('select name from packages where id = $1', [packageId]);
      if (!rows.length) throw new ApiError(404, 'Тара не найдена');
      await applyPackageMovement(client, {
        packageId,
        type: movementType,
        delta,
        unitCost: movementType === 'receipt' ? unitCost : undefined,
        comment,
        actor: req.user,
      });
      await auditTx(client, req.user, {
        action: movementType === 'adjustment' ? 'adjust' : 'post',
        entity: 'stock',
        entityId: packageId,
        title: `Тара «${rows[0].name}»`,
        details: { type: movementType, qty, unitCost },
      });
    });
    res.json({ ok: true });
  })
);
