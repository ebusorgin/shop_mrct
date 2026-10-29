import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, reqArr, reqInt, reqNum, reqStr, wrap } from '../http';
import { assertBaseUnit } from '../services/expansion';
import { audit, auditTx, diff } from '../services/audit';

export const semisRouter = Router();

/** Неотрицательное число или null (пусто/undefined -> null) — для коэффициентов пересчёта размера выхода. */
function convNum(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `Поле «${field}» — неотрицательное число или пусто`);
  return n;
}

/** Целое неотрицательное число или null (пусто/undefined -> null) — для срока годности в днях. */
function intOrNull(body: Record<string, unknown>, field: string): number | null {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, `Поле «${field}» — целое неотрицательное число или пусто`);
  return n;
}

interface SemiInputDto {
  sourceType: 'raw' | 'semi';
  refId: number;
  role: 'base' | 'additive';
  yieldPct?: number | null;
  qtyPerOutput?: number | null;
}

function parseInputs(raw: unknown): SemiInputDto[] {
  const arr = raw as Record<string, unknown>[];
  const inputs = arr.map((x) => {
    const role = String(x.role);
    if (role !== 'base' && role !== 'additive') throw new ApiError(400, 'role: base|additive');
    const sourceType = String(x.sourceType ?? 'raw');
    if (sourceType !== 'raw' && sourceType !== 'semi') throw new ApiError(400, 'sourceType: raw|semi');
    // additive yield_pct опционален: пусто/0 => null (нет уварки, расход 1:1).
    const rawAddYield = x.yieldPct;
    const addYield = rawAddYield == null || rawAddYield === '' ? NaN : Number(rawAddYield);
    return {
      sourceType: sourceType as SemiInputDto['sourceType'],
      refId: reqInt(x, 'refId'),
      role: role as SemiInputDto['role'],
      yieldPct: role === 'base' ? reqNum(x, 'yieldPct') : Number.isFinite(addYield) && addYield > 0 ? addYield : null,
      qtyPerOutput: role === 'additive' ? reqNum(x, 'qtyPerOutput') : null,
    };
  });
  const bases = inputs.filter((i) => i.role === 'base');
  if (bases.length !== 1) throw new ApiError(400, 'Нужен ровно один базовый вход (role=base)');
  for (const i of inputs) {
    if (i.role === 'base' && (i.yieldPct! <= 0 || i.yieldPct! > 100))
      throw new ApiError(400, 'Уварок/выход должен быть в (0, 100]');
    if (i.role === 'additive') {
      if (i.qtyPerOutput! <= 0) throw new ApiError(400, 'Расход добавки должен быть > 0');
      if (i.yieldPct != null && (i.yieldPct <= 0 || i.yieldPct > 100))
        throw new ApiError(400, 'Уварок/выход добавки должен быть в (0, 100] или пуст');
    }
  }
  return inputs;
}

const LIST_SQL = `
  select sp.id, sp.name, sp.note, u.code as "unitCode", sp.unit_id as "unitId",
         sp.shelf_life_days as "shelfLifeDays",
         sp.g_per_pcs::float8 as "gPerPcs", sp.ml_per_pcs::float8 as "mlPerPcs", sp.g_per_ml::float8 as "gPerMl",
     jsonb_agg(
       jsonb_build_object(
         'id', si.id, 'sourceType', si.source_type, 'refId', si.ref_id,
         'name', coalesce(p.name, sub.name), 'role', si.role,
         'yieldPct', si.yield_pct, 'qtyPerOutput', si.qty_per_output,
         'unitCode', coalesce(pu.code, su.code), 'unitId', coalesce(p.unit_id, sub.unit_id)
       ) order by (si.role = 'base') desc, si.id
     ) as inputs
    from semi_products sp
    join units u on u.id = sp.unit_id
    join semi_inputs si on si.semi_id = sp.id
    left join products p on si.source_type = 'raw'  and p.id = si.ref_id
    left join units pu on pu.id = p.unit_id
    left join semi_products sub on si.source_type = 'semi' and sub.id = si.ref_id
    left join units su on su.id = sub.unit_id
   group by sp.id, u.code
   order by sp.name`;

semisRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(LIST_SQL);
    res.json(rows.map(decodeRow));
  })
);

semisRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(`select * from (${LIST_SQL}) t where t.id = $1`, [Number(req.params.id)]);
    if (!rows.length) throw new ApiError(404, 'Полуфабрикат не найден');
    res.json(decodeRow(rows[0]));
  })
);

semisRouter.post(
  '/',
  wrap(async (req, res) => {
    const name = reqStr(req.body, 'name');
    const unitId = reqInt(req.body, 'unitId');
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    const shelfLifeDays = intOrNull(req.body, 'shelfLifeDays');
    const gPerPcs = convNum(req.body, 'gPerPcs');
    const mlPerPcs = convNum(req.body, 'mlPerPcs');
    const gPerMl = convNum(req.body, 'gPerMl');
    const inputs = parseInputs(reqArr(req.body, 'inputs'));
    const id = await tx(async (client) => {
      await assertBaseUnit(client, unitId, 'Полуфабрикат');
      const { rows } = await client.query(
        `insert into semi_products (name, unit_id, note, shelf_life_days, g_per_pcs, ml_per_pcs, g_per_ml, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
        [name, unitId, note, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl, req.user?.id ?? null]
      );
      await insertInputs(client, rows[0].id, inputs);
      await assertNoCycle(client, rows[0].id);
      await auditTx(client, req.user, {
        action: 'create',
        entity: 'semi',
        entityId: rows[0].id as number,
        title: `Полуфабрикат «${name}»`,
        details: { unitId, note, shelfLifeDays, inputs: inputs.length },
      });
      return rows[0].id as number;
    });
    res.status(201).json({ id });
  })
);

semisRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const name = reqStr(req.body, 'name');
    const unitId = reqInt(req.body, 'unitId');
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    const shelfLifeDays = intOrNull(req.body, 'shelfLifeDays');
    const gPerPcs = convNum(req.body, 'gPerPcs');
    const mlPerPcs = convNum(req.body, 'mlPerPcs');
    const gPerMl = convNum(req.body, 'gPerMl');
    const inputs = parseInputs(reqArr(req.body, 'inputs'));
    await tx(async (client) => {
      await assertBaseUnit(client, unitId, 'Полуфабрикат');
      const { rows: before } = await client.query(
        'select name, unit_id, note, shelf_life_days, g_per_pcs::float8 as g_per_pcs, ml_per_pcs::float8 as ml_per_pcs, g_per_ml::float8 as g_per_ml from semi_products where id = $1',
        [id]
      );
      if (!before.length) throw new ApiError(404, 'Полуфабрикат не найден');
      const { rows: beforeInputs } = await client.query('select count(*)::int as n from semi_inputs where semi_id = $1', [id]);
      await client.query(
        'update semi_products set name=$2, unit_id=$3, note=$4, shelf_life_days=$5, g_per_pcs=$6, ml_per_pcs=$7, g_per_ml=$8, updated_by=$9 where id=$1',
        [id, name, unitId, note, shelfLifeDays, gPerPcs, mlPerPcs, gPerMl, req.user?.id ?? null]
      );
      await client.query('delete from semi_inputs where semi_id = $1', [id]);
      await insertInputs(client, id, inputs);
      await assertNoCycle(client, id);
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'semi',
        entityId: id,
        title: `Полуфабрикат «${name}»`,
        details: diff(
          { ...before[0], inputs: beforeInputs[0].n },
          { name, unit_id: unitId, note, shelf_life_days: shelfLifeDays, g_per_pcs: gPerPcs, ml_per_pcs: mlPerPcs, g_per_ml: gPerMl, inputs: inputs.length }
        ),
      });
    });
    res.json({ ok: true });
  })
);

semisRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select sp.name,
         (select count(*) from tech_card_items where source_type='semi' and ref_id = $1) as cards,
         (select count(*) from semi_inputs where source_type='semi' and ref_id = $1) as semis
       from semi_products sp where sp.id = $1`,
      [req.params.id]
    );
    if (!rows.length) throw new ApiError(404, 'Полуфабрикат не найден');
    if (Number(rows[0].cards) > 0) throw new ApiError(409, 'Полуфабрикат используется в техкартах');
    if (Number(rows[0].semis) > 0) throw new ApiError(409, 'Полуфабрикат используется в составе других полуфабрикатов');
    await pool.query('delete from semi_products where id = $1', [req.params.id]);
    await audit(req.user, {
      action: 'delete',
      entity: 'semi',
      entityId: req.params.id,
      title: `Полуфабрикат «${rows[0].name}»`,
    });
    res.json({ ok: true });
  })
);

async function insertInputs(client: import('pg').PoolClient, semiId: number, inputs: SemiInputDto[]) {
  for (const i of inputs) {
    await client.query(
      `insert into semi_inputs (semi_id, source_type, ref_id, role, yield_pct, qty_per_output)
       values ($1,$2,$3,$4,$5,$6)`,
      [semiId, i.sourceType, i.refId, i.role, i.yieldPct ?? null, i.qtyPerOutput ?? null]
    );
  }
}

/** DFS по графу semi_inputs: из `startId` нельзя вернуться в `startId` через составные полуфабрикаты. */
async function assertNoCycle(client: import('pg').PoolClient, startId: number) {
  const visited = new Set<number>();
  const stack: number[] = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    const { rows } = await client.query(
      `select ref_id from semi_inputs where semi_id = $1 and source_type = 'semi'`,
      [cur]
    );
    for (const r of rows) {
      const rid = Number(r.ref_id);
      if (rid === startId) {
        throw new ApiError(400, 'Цикл: полуфабрикат не может (прямо или опосредованно) входить в собственный состав');
      }
      if (!visited.has(rid)) {
        visited.add(rid);
        stack.push(rid);
      }
    }
  }
}

function decodeRow(r: Record<string, unknown>) {
  const inputs = typeof r.inputs === 'string' ? JSON.parse(r.inputs) : r.inputs;
  return { ...r, inputs };
}
