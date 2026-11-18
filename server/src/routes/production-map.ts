import { Router } from 'express';
import { PoolClient } from 'pg';
import { pool, tx } from '../db';
import { ApiError, reqInt, reqNum, reqObject, wrap } from '../http';
import { assertBaseUnit, loadProductConv, loadUnits, toBaseCross } from '../services/expansion';
import { auditTx } from '../services/audit';
import { produceMapBatch, reverseMapBatch, shipMapOutput } from '../services/map-production';

export const productionMapRouter = Router();

type NodeKind = 'product' | 'state' | 'output';

interface PackagingDto {
  name: string;
  qtyBase: number;
  minOrder: number;
  isDefault: boolean;
  price: number;
  priceBasis: 'unit' | 'portion' | 'piece';
  cost: number;
  available: boolean;
}

interface NodeDto {
  uid: number;
  kind: NodeKind;
  refId: number | null;
  name: string;
  nameEn: string;
  nameSr: string;
  catalogId: number | null;
  unitId: number;
  x: number;
  y: number;
  portionQty: number;
  price: number;
  note: string;
  packagings: PackagingDto[];
}

interface InputDto {
  nodeUid: number;
  qty: number;
  inMass: boolean;
  /** Потери на связи, % (уварка, очистки). */
  lossPct: number | null;
}

interface OpDto {
  uid: number;
  name: string;
  yieldPct: number | null;
  /** Партия (N): сколько продукции получаем. */
  planQty: number | null;
  /** Единица партии (г/мл). */
  planUnitId: number | null;
  laborHours: number;
  outputUid: number;
  note: string;
  x: number;
  y: number;
  inputs: InputDto[];
}

const numOr = (v: unknown, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

function parseBody(body: Record<string, unknown>): { nodes: NodeDto[]; ops: OpDto[] } {
  const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
  const rawOps = Array.isArray(body.ops) ? body.ops : [];

  const nodeUids = new Set<number>();
  const nodes: NodeDto[] = rawNodes.map((raw) => {
    const x = reqObject(raw);
    const uid = reqInt(x, 'uid');
    if (nodeUids.has(uid)) throw new ApiError(400, 'Повторяющийся uid узла');
    nodeUids.add(uid);
    const kind = String(x.kind);
    if (kind !== 'product' && kind !== 'state' && kind !== 'output') {
      throw new ApiError(400, 'kind узла: product|state|output');
    }
    const refId = x.refId == null || x.refId === '' ? null : reqInt(x, 'refId');
    const portionQty = x.portionQty == null || x.portionQty === '' ? 0 : reqNum(x, 'portionQty');
    if (portionQty < 0) throw new ApiError(400, 'Порция не может быть отрицательной');
    const price = x.price == null || x.price === '' ? 0 : reqNum(x, 'price');
    if (price < 0) throw new ApiError(400, 'Цена не может быть отрицательной');
    const catalogId =
      x.catalogId == null || x.catalogId === '' ? null : reqInt(x, 'catalogId');

    const rawPackagings = Array.isArray(x.packagings) ? x.packagings : [];
    let defaultSeen = false;
    const packagings: PackagingDto[] = rawPackagings.map((rp) => {
      const p = reqObject(rp);
      const qtyBase = reqNum(p, 'qtyBase');
      if (!(qtyBase > 0)) throw new ApiError(400, 'Выход фасовки должен быть больше 0');
      const minOrder = p.minOrder == null || p.minOrder === '' ? 1 : reqInt(p, 'minOrder');
      if (minOrder < 1) throw new ApiError(400, 'Минимальный заказ — целое число больше 0');
      const price = p.price == null || p.price === '' ? 0 : reqNum(p, 'price');
      const cost = p.cost == null || p.cost === '' ? 0 : reqNum(p, 'cost');
      if (price < 0 || cost < 0) throw new ApiError(400, 'Цена и себестоимость фасовки не могут быть отрицательными');
      const priceBasis = String(p.priceBasis ?? 'unit');
      if (priceBasis !== 'unit' && priceBasis !== 'portion' && priceBasis !== 'piece') {
        throw new ApiError(400, 'priceBasis фасовки: unit|portion|piece');
      }
      const isDefault = p.isDefault === true && !defaultSeen;
      if (isDefault) defaultSeen = true;
      return {
        name: typeof p.name === 'string' ? p.name.trim().slice(0, 200) : '',
        qtyBase,
        minOrder,
        isDefault,
        price,
        priceBasis: priceBasis as PackagingDto['priceBasis'],
        cost,
        available: p.available !== false,
      };
    });
    if (packagings.length && !defaultSeen) packagings[0].isDefault = true;
    if (packagings.length && kind !== 'product') {
      if (packagings.some((p) => !(p.price > 0))) {
        throw new ApiError(400, 'Укажите цену для каждой фасовки');
      }
      if (catalogId == null) {
        throw new ApiError(400, 'Выберите каталог для результата с фасовкой');
      }
    }

    return {
      uid,
      kind: kind as NodeKind,
      refId,
      name: typeof x.name === 'string' ? x.name.trim().slice(0, 300) : '',
      nameEn: typeof x.nameEn === 'string' ? x.nameEn.trim().slice(0, 300) : '',
      nameSr: typeof x.nameSr === 'string' ? x.nameSr.trim().slice(0, 300) : '',
      catalogId,
      unitId: reqInt(x, 'unitId'),
      x: numOr(x.x, 0),
      y: numOr(x.y, 0),
      portionQty: kind === 'product' ? 0 : portionQty,
      price: kind === 'product' ? 0 : price,
      note: typeof x.note === 'string' ? x.note.trim().slice(0, 2000) : '',
      packagings: kind === 'product' ? [] : packagings,
    };
  });

  const opUids = new Set<number>();
  const ops: OpDto[] = rawOps.map((raw) => {
    const x = reqObject(raw);
    const uid = reqInt(x, 'uid');
    if (opUids.has(uid)) throw new ApiError(400, 'Повторяющийся uid операции');
    opUids.add(uid);
    const yieldRaw = x.yieldPct;
    const y = yieldRaw == null || yieldRaw === '' ? null : Number(yieldRaw);
    if (y != null && (!Number.isFinite(y) || y < 0 || y > 100)) {
      throw new ApiError(400, 'Выход после обработки — 0…100 или пусто');
    }
    const planRaw = x.planQty;
    const planQty = planRaw == null || planRaw === "" ? null : Number(planRaw);
    if (planQty != null && (!Number.isFinite(planQty) || planQty < 0)) {
      throw new ApiError(400, "План выхода — неотрицательное число");
    }
    const planUnitId = x.planUnitId == null || x.planUnitId === "" ? null : reqInt(x, "planUnitId");
    const labor = x.laborHours == null || x.laborHours === '' ? 0 : Number(x.laborHours);
    if (!Number.isFinite(labor) || labor < 0) {
      throw new ApiError(400, 'Человекочасы — неотрицательное число');
    }
    const rawInputs = Array.isArray(x.inputs) ? x.inputs : [];
    const seen = new Set<number>();
    const inputs: InputDto[] = rawInputs.map((ri) => {
      const i = reqObject(ri);
      const nodeUid = reqInt(i, 'nodeUid');
      if (seen.has(nodeUid)) throw new ApiError(400, 'Один и тот же вход операции указан дважды');
      seen.add(nodeUid);
      const qty = reqNum(i, 'qty');
      if (!(qty > 0)) throw new ApiError(400, 'Количество входа должно быть больше 0');
      const lossRaw = i.lossPct;
      const lossPct = lossRaw == null || lossRaw === '' ? null : Number(lossRaw);
      if (lossPct != null && (!Number.isFinite(lossPct) || lossPct < 0 || lossPct >= 100)) {
        throw new ApiError(400, 'Потери на связи — от 0 до 100 % (не включая 100)');
      }
      return { nodeUid, qty, inMass: i.inMass !== false, lossPct };
    });
    return {
      uid,
      name: typeof x.name === 'string' ? x.name.trim().slice(0, 200) : '',
      yieldPct: y != null && y > 0 ? y : null,
      planQty,
      planUnitId,
      laborHours: labor,
      outputUid: reqInt(x, 'outputUid'),
      note: typeof x.note === 'string' ? x.note.trim().slice(0, 1000) : '',
      x: numOr(x.x, 0),
      y: numOr(x.y, 0),
      inputs,
    };
  });

  return { nodes, ops };
}

/** Структурная проверка: ссылки, один производитель у состояния, без циклов. */
function validateShape(nodes: NodeDto[], ops: OpDto[]): void {
  const byUid = new Map(nodes.map((n) => [n.uid, n] as const));
  const opByUid = new Map(ops.map((o) => [o.uid, o] as const));
  const produced = new Map<number, number>();

  for (const op of ops) {
    const out = byUid.get(op.outputUid);
    if (!out) throw new ApiError(400, 'Выход операции не найден среди узлов');
    if (out.kind !== 'state' && out.kind !== 'output') {
      throw new ApiError(400, 'Выход операции должен быть состоянием или блюдом');
    }
    if (produced.has(op.outputUid)) {
      throw new ApiError(400, 'У состояния больше одной операции-производителя');
    }
    produced.set(op.outputUid, op.uid);
    for (const input of op.inputs) {
      const n = byUid.get(input.nodeUid);
      if (!n) throw new ApiError(400, 'Вход операции не найден среди узлов');
      if (input.nodeUid === op.outputUid) throw new ApiError(400, 'Операция не может потреблять собственный выход');
    }
  }

  const visiting = new Set<number>();
  const done = new Set<number>();
  const visit = (opUid: number): void => {
    if (done.has(opUid)) return;
    if (visiting.has(opUid)) throw new ApiError(400, 'Цикл в карте производства');
    visiting.add(opUid);
    const op = opByUid.get(opUid)!;
    for (const input of op.inputs) {
      const producer = produced.get(input.nodeUid);
      if (producer != null) visit(producer);
    }
    visiting.delete(opUid);
    done.add(opUid);
  };
  for (const op of ops) visit(op.uid);

  for (const n of nodes) {
    if (n.kind === 'product') {
      if (!n.refId) throw new ApiError(400, `У сырья «${n.name || n.uid}» не выбрана позиция номенклатуры`);
    } else if (n.refId != null) {
      throw new ApiError(400, 'У состояния и блюда не должно быть ссылки на сырьё');
    }
  }
}

/** Подтянуть единицы и проверить ссылки на сырьё. */
async function resolveRefs(client: PoolClient, nodes: NodeDto[]): Promise<void> {
  const productIds = [
    ...new Set(nodes.filter((n) => n.kind === 'product' && n.refId).map((n) => n.refId as number)),
  ];
  if (productIds.length) {
    const { rows } = await client.query('select id, unit_id from products where id = any($1::int[])', [productIds]);
    if (rows.length !== productIds.length) throw new ApiError(400, 'Часть сырья не найдена в номенклатуре');
    const unitOf = new Map(rows.map((r) => [Number(r.id), Number(r.unit_id)]));
    for (const n of nodes) {
      if (n.kind === 'product' && n.refId) n.unitId = unitOf.get(n.refId) ?? n.unitId;
    }
  }
  const unitIds = [...new Set(nodes.map((n) => n.unitId))];
  for (const unitId of unitIds) await assertBaseUnit(client, unitId, 'Карта производства');
}

async function replaceMap(client: PoolClient, nodes: NodeDto[], ops: OpDto[]): Promise<void> {
  await client.query('delete from prod_packagings');
  await client.query('delete from prod_op_inputs');
  await client.query('delete from prod_ops');
  await client.query('delete from prod_nodes');

  const nodeIdByUid = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const { rows } = await client.query(
      `insert into prod_nodes (kind, ref_id, name, name_en, name_sr, catalog_id, unit_id, x, y, position, portion_qty, price, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [n.kind, n.refId, n.name, n.nameEn, n.nameSr, n.catalogId, n.unitId, n.x, n.y, i, n.portionQty, n.price, n.note]
    );
    nodeIdByUid.set(n.uid, Number(rows[0].id));
  }

  for (const n of nodes) {
    if (n.kind === 'product') continue;
    const nodeId = nodeIdByUid.get(n.uid)!;
    for (let j = 0; j < n.packagings.length; j++) {
      const p = n.packagings[j];
      await client.query(
        `insert into prod_packagings (node_id, name, qty_base, min_order, is_default, price, price_basis, cost, available, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [nodeId, p.name, p.qtyBase, p.minOrder, p.isDefault, p.price, p.priceBasis, p.cost, p.available, j]
      );
    }
  }

  const opIdByUid = new Map<number, number>();
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const outputNodeId = nodeIdByUid.get(o.outputUid);
    if (!outputNodeId) throw new ApiError(400, 'Выход операции не найден');
    const { rows } = await client.query(
      `insert into prod_ops (name, yield_pct, plan_qty, plan_unit_id, labor_hours, output_node_id, note, x, y, position)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [o.name, o.yieldPct, o.planQty, o.planUnitId, o.laborHours, outputNodeId, o.note, o.x, o.y, i]
    );
    opIdByUid.set(o.uid, Number(rows[0].id));
  }

  for (const o of ops) {
    const opId = opIdByUid.get(o.uid)!;
    for (const input of o.inputs) {
      const nodeId = nodeIdByUid.get(input.nodeUid);
      if (!nodeId) throw new ApiError(400, 'Вход операции не найден');
      await client.query(
        'insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct) values ($1,$2,$3,$4,$5)',
        [opId, nodeId, input.qty, input.inMass, input.lossPct]
      );
    }
  }
}

const NODES_SQL = `
  select n.id, n.kind, n.ref_id as "refId",
         coalesce(nullif(btrim(n.name), ''), p.name, '') as name,
         n.name_en as "nameEn", n.name_sr as "nameSr", n.catalog_id as "catalogId",
         n.unit_id as "unitId", u.code as "unitCode",
         n.x::float8 as x, n.y::float8 as y,
         n.portion_qty::float8 as "portionQty", n.price::float8 as price, n.note
    from prod_nodes n
    left join products p on n.kind = 'product' and p.id = n.ref_id
    left join units u on u.id = n.unit_id
   order by n.position, n.id`;

productionMapRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows: nodes } = await pool.query(NODES_SQL);
    const { rows: ops } = await pool.query(
      `select o.id, o.name, o.yield_pct::float8 as "yieldPct", o.plan_qty::float8 as "planQty", o.plan_unit_id as "planUnitId",
              o.labor_hours::float8 as "laborHours",
              o.output_node_id as "outputNodeId", o.note, o.x::float8 as x, o.y::float8 as y
         from prod_ops o order by o.position, o.id`
    );
    const { rows: inputs } = await pool.query(
      'select op_id as "opId", node_id as "nodeId", qty::float8 as qty, in_mass as "inMass", loss_pct::float8 as "lossPct" from prod_op_inputs order by id'
    );
    const { rows: packs } = await pool.query(
      `select id, node_id as "nodeId", name, qty_base::float8 as "qtyBase", min_order as "minOrder",
              is_default as "isDefault", price::float8 as price, price_basis as "priceBasis",
              cost::float8 as cost, available
         from prod_packagings order by position, id`
    );
    const packsByNode = new Map<number, Record<string, unknown>[]>();
    for (const p of packs) {
      const arr = packsByNode.get(Number(p.nodeId)) ?? [];
      arr.push({
        id: Number(p.id),
        name: String(p.name ?? ''),
        qtyBase: Number(p.qtyBase),
        minOrder: Number(p.minOrder),
        isDefault: Boolean(p.isDefault),
        price: Number(p.price),
        priceBasis: String(p.priceBasis),
        cost: Number(p.cost),
        available: p.available !== false,
      });
      packsByNode.set(Number(p.nodeId), arr);
    }
    const byOp = new Map<number, Record<string, unknown>>();
    for (const o of ops) byOp.set(Number(o.id), { ...o, inputs: [] });
    for (const i of inputs) {
      const op = byOp.get(Number(i.opId));
      if (op) {
        (op.inputs as Record<string, unknown>[]).push({
          nodeId: Number(i.nodeId),
          qty: Number(i.qty),
          inMass: i.inMass !== false,
          lossPct: i.lossPct == null ? null : Number(i.lossPct),
        });
      }
    }
    const nodesOut = nodes.map((n) => ({
      ...n,
      packagings: packsByNode.get(Number(n.id)) ?? [],
    }));
    const { rows: meta } = await pool.query('select version from map_meta where id = 1');
    res.json({ nodes: nodesOut, ops: [...byOp.values()], version: Number(meta[0]?.version ?? 1) });
  })
);

/** Техкарта операции: нетто-ингредиенты должны ровно давать партию N (в единице результата). */
async function validatePlanBalance(client: PoolClient, nodes: NodeDto[], ops: OpDto[]): Promise<void> {
  const units = await loadUnits(client);
  const prodConv = await loadProductConv(client);
  const byUid = new Map(nodes.map((n) => [n.uid, n] as const));
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  for (const op of ops) {
    if (!(op.planQty != null && op.planQty > 0)) continue;
    // недособранную операцию (без входов) можно сохранить как черновик
    if (!op.inputs.length) continue;
    const out = byUid.get(op.outputUid);
    if (!out) continue;
    const planUnit = op.planUnitId ?? out.unitId;
    let plan: number;
    try {
      plan = toBaseCross(op.planQty, planUnit, out.unitId, units);
    } catch {
      throw new ApiError(400, `«${op.name}»: единица партии не совпадает с единицей результата`);
    }
    let net = 0;
    for (const input of op.inputs) {
      if (!input.inMass) continue;
      const src = byUid.get(input.nodeUid);
      if (!src) continue;
      const conv = src.kind === 'product' && src.refId != null ? prodConv.get(src.refId) : undefined;
      let m: number;
      try {
        m = toBaseCross(input.qty, src.unitId, out.unitId, units, conv);
      } catch {
        throw new ApiError(400, `«${op.name}»: ингредиенты нельзя привести к единице результата`);
      }
      net += m;
    }
    if (Math.abs(plan - net) > 0.01) {
      throw new ApiError(
        400,
        `«${op.name}»: сумма ингредиентов ${round3(net)} не равна партии ${round3(plan)}`
      );
    }
  }
}

productionMapRouter.put(
  '/',
  wrap(async (req, res) => {
    const { nodes, ops } = parseBody(req.body ?? {});
    validateShape(nodes, ops);
    const expected = req.body?.version == null ? null : Number(req.body.version);
    let nextVersion = 1;
    await tx(async (client) => {
      const { rows: meta } = await client.query('select version from map_meta where id = 1 for update');
      const current = Number(meta[0]?.version ?? 1);
      if (expected != null && Number.isFinite(expected) && expected !== current) {
        throw new ApiError(409, 'Карту изменил другой пользователь — обновите страницу и повторите');
      }
      await resolveRefs(client, nodes);
      await validatePlanBalance(client, nodes, ops);
      await replaceMap(client, nodes, ops);
      const { rows: upd } = await client.query(
        'update map_meta set version = version + 1, updated_at = now() where id = 1 returning version'
      );
      nextVersion = Number(upd[0]?.version ?? current + 1);
      await auditTx(client, req.user, {
        action: 'update',
        entity: 'production_map',
        title: 'Карта производства',
        details: { nodes: nodes.length, ops: ops.length },
      });
    });
    res.json({ ok: true, version: nextVersion });
  })
);

function qtyArg(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, 'Количество — положительное число');
  return n;
}

/** Выпуск партии по операции: списание сырья обратным разворотом состава. */
productionMapRouter.post(
  '/ops/:id/produce',
  wrap(async (req, res) => {
    res.json(await produceMapBatch(Number(req.params.id), qtyArg(req.body?.qty), req.user));
  })
);

/** Отгрузка готового: списание сырья «в обратную сторону» с потерями. */
productionMapRouter.post(
  '/nodes/:id/ship',
  wrap(async (req, res) => {
    res.json(await shipMapOutput(Number(req.params.id), qtyArg(req.body?.qty), req.user));
  })
);

/** История выпусков карты. */
productionMapRouter.get(
  '/batches',
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      select id, op_name as "opName", output_name as "outputName", qty::float8 as qty,
             unit_id as "unitId", cost_total::float8 as "costTotal", status,
             created_at as "createdAt", created_login as "createdLogin"
        from map_batches order by id desc limit 200`);
    res.json(rows);
  })
);

/** Отмена выпущенной партии: вернуть сырьё по снимку. */
productionMapRouter.post(
  '/batches/:id/reverse',
  wrap(async (req, res) => {
    await reverseMapBatch(Number(req.params.id), req.user);
    res.json({ ok: true });
  })
);
