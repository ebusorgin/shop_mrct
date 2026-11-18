import { PoolClient } from 'pg';
import { tx } from '../db';
import { ApiError } from '../http';
import { applyMovement } from './stock';
import { auditTx, type Actor } from './audit';
import { loadProductConv, loadUnits, toBaseCross } from './expansion';

/**
 * Операционный контур карты производства.
 * Входы операции — НЕТТО в продукте; потери на связи увеличивают брутто-расход сырья.
 * Выпуск партии и отгрузка готового списывают сырьё «в обратную сторону» по составу.
 */

interface NodeRow {
  id: number;
  kind: 'product' | 'state' | 'output';
  ref_id: number | null;
  name: string;
  unit_id: number;
}

interface OpRow {
  id: number;
  name: string;
  output_node_id: number;
  plan_qty: number | null;
  plan_unit_id: number | null;
}

interface InputRow {
  op_id: number;
  node_id: number;
  qty: number;
  loss_pct: number | null;
  in_mass: boolean;
}

interface Graph {
  nodes: Map<number, NodeRow>;
  ops: Map<number, OpRow>;
  inputsByOp: Map<number, InputRow[]>;
  producerByOut: Map<number, OpRow>;
}

type Units = Awaited<ReturnType<typeof loadUnits>>;
type Conv = Awaited<ReturnType<typeof loadProductConv>>;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

async function loadGraph(client: PoolClient): Promise<Graph> {
  const nodes = new Map<number, NodeRow>();
  for (const r of (await client.query(
    'select id, kind, ref_id, name, unit_id from prod_nodes order by position, id'
  )).rows) {
    nodes.set(r.id, { id: r.id, kind: r.kind, ref_id: r.ref_id, name: r.name, unit_id: r.unit_id });
  }
  const ops = new Map<number, OpRow>();
  const producerByOut = new Map<number, OpRow>();
  for (const r of (await client.query(
    'select id, name, output_node_id, plan_qty::float8 as plan_qty, plan_unit_id from prod_ops order by position, id'
  )).rows) {
    const op: OpRow = {
      id: r.id,
      name: r.name,
      output_node_id: r.output_node_id,
      plan_qty: r.plan_qty == null ? null : Number(r.plan_qty),
      plan_unit_id: r.plan_unit_id,
    };
    ops.set(op.id, op);
    producerByOut.set(op.output_node_id, op);
  }
  const inputsByOp = new Map<number, InputRow[]>();
  for (const r of (await client.query(
    'select op_id, node_id, qty::float8 as qty, loss_pct::float8 as loss_pct, in_mass from prod_op_inputs order by id'
  )).rows) {
    const arr = inputsByOp.get(r.op_id) ?? [];
    arr.push({
      op_id: r.op_id,
      node_id: r.node_id,
      qty: Number(r.qty),
      loss_pct: r.loss_pct == null ? null : Number(r.loss_pct),
      in_mass: r.in_mass !== false,
    });
    inputsByOp.set(r.op_id, arr);
  }
  return { nodes, ops, inputsByOp, producerByOut };
}

/** Выход операции в её единице: партия N, иначе сумма нетто-входов. */
async function outputQty(op: OpRow, g: Graph, units: Units, conv: Conv): Promise<number> {
  const out = g.nodes.get(op.output_node_id);
  if (!out) return 0;
  if (op.plan_qty != null && op.plan_qty > 0) {
    try {
      return toBaseCross(op.plan_qty, op.plan_unit_id ?? out.unit_id, out.unit_id, units);
    } catch {
      throw new ApiError(400, `«${op.name}»: единица партии не совпадает с единицей результата`);
    }
  }
  let sum = 0;
  for (const i of g.inputsByOp.get(op.id) ?? []) {
    if (!i.in_mass) continue;
    const src = g.nodes.get(i.node_id);
    if (!src) continue;
    const c = src.kind === 'product' && src.ref_id != null ? conv.get(src.ref_id) : undefined;
    try {
      sum += toBaseCross(i.qty, src.unit_id, out.unit_id, units, c);
    } catch {
      throw new ApiError(400, `«${op.name}»: ингредиенты нельзя привести к единице результата`);
    }
  }
  return sum;
}

async function expand(
  g: Graph,
  op: OpRow,
  requiredOut: number,
  need: Map<number, number>,
  depth: number,
  units: Units,
  conv: Conv
): Promise<void> {
  if (depth > 50) throw new ApiError(400, 'Слишком глубокая цепочка состава');
  const produced = await outputQty(op, g, units, conv);
  if (!(produced > 0)) throw new ApiError(409, `У операции «${op.name}» нулевой выход`);
  const scale = requiredOut / produced;
  for (const i of g.inputsByOp.get(op.id) ?? []) {
    const src = g.nodes.get(i.node_id);
    if (!src) continue;
    const loss = Math.min(99.999, Math.max(0, i.loss_pct ?? 0));
    const gross = (i.qty * scale) / (1 - loss / 100);
    if (src.kind === 'product' && src.ref_id != null) {
      need.set(src.ref_id, (need.get(src.ref_id) ?? 0) + gross);
    } else {
      const producer = g.producerByOut.get(src.id);
      if (!producer) throw new ApiError(409, `У состояния «${src.name}» нет операции-производителя`);
      await expand(g, producer, gross, need, depth + 1, units, conv);
    }
  }
}

export interface MapProduceResult {
  batchId: number;
  qty: number;
  unitId: number;
  costTotal: number;
  items: { productId: number; name: string; unitCode: string; qty: number; unitCost: number; cost: number }[];
}

/** Выпуск партии: списать сырьё по развёрнутому составу с потерями и сохранить снимок. */
export async function produceMapBatch(
  opId: number,
  qtyIn: number | null,
  actor: Actor
): Promise<MapProduceResult> {
  return tx(async (client) => {
    const g = await loadGraph(client);
    const op = g.ops.get(opId);
    if (!op) throw new ApiError(404, 'Операция не найдена');
    const out = g.nodes.get(op.output_node_id);
    if (!out) throw new ApiError(404, 'Результат операции не найден');
    const units = await loadUnits(client);
    const conv = await loadProductConv(client);
    const produced = await outputQty(op, g, units, conv);
    const qty = round3(qtyIn != null && qtyIn > 0 ? qtyIn : produced);
    if (!(qty > 0)) throw new ApiError(400, 'Не задано количество выпуска');

    const need = new Map<number, number>();
    await expand(g, op, qty, need, 0, units, conv);
    const productIds = [...need.keys()].sort((a, b) => a - b);
    if (productIds.length) {
      await client.query('select 1 from stock where product_id = any($1::int[]) for update', [productIds]);
    }

    const { rows: batchRows } = await client.query(
      `insert into map_batches (op_name, output_name, qty, unit_id, note, created_by, created_login)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [op.name, out.name, qty, out.unit_id, '', actor?.id ?? null, actor?.login ?? 'system']
    );
    const batchId: number = batchRows[0].id;

    const { rows: stockRows } = await client.query(
      'select product_id, avg_cost::float8 as c from stock where product_id = any($1::int[])',
      [productIds]
    );
    const costBy = new Map<number, number>(stockRows.map((r) => [Number(r.product_id), Number(r.c)]));
    const { rows: prodRows } = await client.query(
      'select p.id, p.name, u.code as unit_code from products p join units u on u.id = p.unit_id where p.id = any($1::int[])',
      [productIds]
    );
    const info = new Map<number, { name: string; unitCode: string }>(
      prodRows.map((r) => [Number(r.id), { name: r.name, unitCode: r.unit_code }])
    );

    let costTotal = 0;
    const items: MapProduceResult['items'] = [];
    for (const productId of productIds) {
      const rawQty = round3(need.get(productId) ?? 0);
      if (!(rawQty > 0)) continue;
      const unitCost = costBy.get(productId) ?? 0;
      const cost = Math.round(rawQty * unitCost * 100) / 100;
      costTotal += cost;
      await applyMovement(client, {
        productId,
        type: 'writeoff',
        delta: -rawQty,
        docType: 'map_batch',
        docId: batchId,
        actor,
        comment: `Выпуск: ${out.name} × ${qty}`,
      });
      await client.query(
        'insert into map_batch_items (batch_id, product_id, qty, unit_cost) values ($1,$2,$3,$4)',
        [batchId, productId, rawQty, unitCost]
      );
      const meta = info.get(productId);
      items.push({ productId, name: meta?.name ?? '', unitCode: meta?.unitCode ?? '', qty: rawQty, unitCost, cost });
    }
    costTotal = Math.round(costTotal * 100) / 100;
    await client.query('update map_batches set cost_total = $2 where id = $1', [batchId, costTotal]);
    await auditTx(client, actor, {
      action: 'post',
      entity: 'batch',
      entityId: batchId,
      title: `Карта · ${op.name} → ${out.name} × ${qty}`,
      details: { opId, qty, unitId: out.unit_id, costTotal, positions: items.length },
    });
    return { batchId, qty, unitId: out.unit_id, costTotal, items };
  });
}

/** Отгрузка готового: списать сырьё обратным разворотом состава с потерями. */
export async function shipMapOutput(
  nodeId: number,
  qtyIn: number | null,
  actor: Actor
): Promise<{ qty: number; items: { productId: number; qty: number }[] }> {
  return tx(async (client) => {
    const g = await loadGraph(client);
    const node = g.nodes.get(nodeId);
    if (!node) throw new ApiError(404, 'Результат не найден');
    if (node.kind === 'product') throw new ApiError(400, 'Нельзя отгрузить сырьё');
    const producer = g.producerByOut.get(nodeId);
    if (!producer) throw new ApiError(409, 'Для результата нет операции-производителя');
    const units = await loadUnits(client);
    const conv = await loadProductConv(client);
    const produced = await outputQty(producer, g, units, conv);
    const qty = round3(qtyIn != null && qtyIn > 0 ? qtyIn : produced);
    if (!(qty > 0)) throw new ApiError(400, 'Не задано количество отгрузки');
    const need = new Map<number, number>();
    await expand(g, producer, qty, need, 0, units, conv);
    const productIds = [...need.keys()].sort((a, b) => a - b);
    if (productIds.length) {
      await client.query('select 1 from stock where product_id = any($1::int[]) for update', [productIds]);
    }
    const items: { productId: number; qty: number }[] = [];
    for (const productId of productIds) {
      const rawQty = round3(need.get(productId) ?? 0);
      if (!(rawQty > 0)) continue;
      await applyMovement(client, {
        productId,
        type: 'writeoff',
        delta: -rawQty,
        docType: 'map_ship',
        actor,
        comment: `Отгрузка: ${node.name} × ${qty}`,
      });
      items.push({ productId, qty: rawQty });
    }
    await auditTx(client, actor, {
      action: 'adjust',
      entity: 'production_map',
      entityId: nodeId,
      title: `Отгрузка · ${node.name} × ${qty}`,
      details: { qty, positions: items.length },
    });
    return { qty, items };
  });
}

/** Отмена выпущенной партии: вернуть сырьё по снимку. */
export async function reverseMapBatch(batchId: number, actor: Actor): Promise<number> {
  return tx(async (client) => {
    const { rows } = await client.query('select status from map_batches where id = $1 for update', [batchId]);
    if (!rows.length) throw new ApiError(404, 'Партия не найдена');
    if (rows[0].status === 'reversed') throw new ApiError(409, 'Партия уже отменена');
    const { rows: items } = await client.query(
      'select product_id, qty::float8 as qty from map_batch_items where batch_id = $1 order by product_id',
      [batchId]
    );
    const ids = items.map((i) => Number(i.product_id)).sort((a, b) => a - b);
    if (ids.length) await client.query('select 1 from stock where product_id = any($1::int[]) for update', [ids]);
    for (const it of items) {
      await applyMovement(client, {
        productId: Number(it.product_id),
        type: 'receipt',
        delta: Number(it.qty),
        docType: 'map_batch',
        docId: batchId,
        actor,
        comment: 'Возврат: отмена партии карты',
      });
    }
    await client.query("update map_batches set status = 'reversed', cost_total = 0 where id = $1", [batchId]);
    await auditTx(client, actor, {
      action: 'reverse',
      entity: 'batch',
      entityId: batchId,
      title: `Отмена партии карты #${batchId}`,
      details: { positions: items.length },
    });
    return items.length;
  });
}
