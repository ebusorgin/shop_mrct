import type { PoolClient } from 'pg';
import { ApiError } from '../http';

export interface SavePackaging {
  uid?: number;
  name: string;
  qtyBase: number;
  minOrder: number;
  isDefault: boolean;
  price: number;
  priceBasis: 'unit' | 'portion' | 'piece';
  cost: number;
  available: boolean;
  /** Тара фасовки: несколько позиций склада без повторов. */
  tareProductIds?: number[];
}

export interface SaveNode {
  uid: number;
  kind: 'product' | 'state' | 'output';
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
  packagings: SavePackaging[];
}

export interface SaveOp {
  uid: number;
  name: string;
  yieldPct: number | null;
  planQty: number | null;
  planUnitId: number | null;
  laborHours: number;
  outputUid: number;
  note: string;
  x: number;
  y: number;
  inputs: { nodeUid: number; qty: number; inMass: boolean; lossPct: number | null }[];
}

/** Тара фасовки: заменяем набор целиком; повторные id отсекаются и здесь. */
async function saveTare(client: PoolClient, packagingId: number, ids: number[]): Promise<void> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  await client.query('delete from prod_packaging_tare where packaging_id = $1', [packagingId]);
  for (let i = 0; i < unique.length; i++) {
    await client.query(
      'insert into prod_packaging_tare (packaging_id, product_id, position) values ($1,$2,$3)',
      [packagingId, unique[i], i]
    );
  }
}

/**
 * Upsert карты. Позиции, которых нет в payload, архивируются: на их фасовки
 * ссылается история заказов, поэтому удалять их нельзя. Архивные узлы и
 * операции остаются в графе для раскрытия старых заказов.
 */export async function saveMap(
  client: PoolClient,
  nodes: SaveNode[],
  ops: SaveOp[]
): Promise<void> {
  // Только активные id: uid нового узла может совпасть с архивным id.
  const existingNodes = new Set<number>(
    (await client.query('select id from prod_nodes where not archived for update')).rows.map(
      (r) => Number(r.id)
    )
  );

  const nodeIdByUid = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (existingNodes.has(n.uid)) {
      await client.query(
        `update prod_nodes set kind=$2, ref_id=$3, name=$4, name_en=$5, name_sr=$6,
                catalog_id=$7, unit_id=$8, x=$9, y=$10, position=$11, portion_qty=$12,
                price=$13, note=$14, archived=false where id=$1`,
        [n.uid, n.kind, n.refId, n.name, n.nameEn, n.nameSr, n.catalogId, n.unitId,
         n.x, n.y, i, n.portionQty, n.price, n.note]
      );
      nodeIdByUid.set(n.uid, n.uid);
    } else {
      const { rows } = await client.query(
        `insert into prod_nodes (kind, ref_id, name, name_en, name_sr, catalog_id, unit_id,
                                 x, y, position, portion_qty, price, note, archived)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false) returning id`,
        [n.kind, n.refId, n.name, n.nameEn, n.nameSr, n.catalogId, n.unitId,
         n.x, n.y, i, n.portionQty, n.price, n.note]
      );
      nodeIdByUid.set(n.uid, Number(rows[0].id));
    }
  }

  const keep = [...nodeIdByUid.values()];
  const archivedNodes = await client.query(
    `update prod_nodes set archived = true
      where not archived and not (id = any($1::int[])) returning id`,
    [keep.length ? keep : [0]]
  );
  if (archivedNodes.rows.length) {
    const ids = archivedNodes.rows.map((r) => Number(r.id));
    await client.query(
      `update prod_packagings set archived = true, is_default = false
        where node_id = any($1::int[]) and not archived`,
      [ids]
    );
  }

  for (const n of nodes) {
    const nodeId = nodeIdByUid.get(n.uid)!;
    if (n.kind === 'product') continue;
    // Снимаем default заранее: иначе перенос default с одной фасовки на другую
    // нарушит частичный уникальный индекс.
    await client.query(
      'update prod_packagings set is_default = false where node_id = $1 and is_default',
      [nodeId]
    );
    const keepPacks: number[] = [];
    for (let j = 0; j < n.packagings.length; j++) {
      const p = n.packagings[j];
      const owned =
        p.uid != null &&
        (
          await client.query(
            'select 1 from prod_packagings where id=$1 and node_id=$2 and not archived',
            [p.uid, nodeId]
          )
        ).rows.length > 0;
      if (owned) {
        await client.query(
          `update prod_packagings set name=$3, qty_base=$4, min_order=$5, is_default=$6,
                  price=$7, price_basis=$8, cost=$9, available=$10, position=$11,
                  archived=false where id=$1 and node_id=$2`,
          [p.uid, nodeId, p.name, p.qtyBase, p.minOrder, p.isDefault, p.price,
           p.priceBasis, p.cost, p.available, j]
        );
        await saveTare(client, Number(p.uid), p.tareProductIds ?? []);
        keepPacks.push(Number(p.uid));
      } else {
        const { rows } = await client.query(
          `insert into prod_packagings (node_id, name, qty_base, min_order, is_default,
                                        price, price_basis, cost, available, position, archived)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) returning id`,
          [nodeId, p.name, p.qtyBase, p.minOrder, p.isDefault, p.price, p.priceBasis,
           p.cost, p.available, j]
        );
        const packId = Number(rows[0].id);
        await saveTare(client, packId, p.tareProductIds ?? []);
        keepPacks.push(packId);
      }
    }
    await client.query(
      `update prod_packagings set archived = true, is_default = false
        where node_id = $1 and not archived and not (id = any($2::int[]))`,
      [nodeId, keepPacks.length ? keepPacks : [0]]
    );
  }

  // Операции: обновляем/вставляем; отсутствующие сохраняем ради истории заказов.
  const existingOps = new Set<number>(
    (
      await client.query(
        `select o.id from prod_ops o join prod_nodes n on n.id = o.output_node_id
          where not n.archived for update`
      )
    ).rows.map((r) => Number(r.id))
  );

  const opIdByUid = new Map<number, number>();
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const outputNodeId = nodeIdByUid.get(o.outputUid);
    if (!outputNodeId) throw new ApiError(400, 'Выход операции не найден');
    if (existingOps.has(o.uid)) {
      await client.query(
        `update prod_ops set name=$2, yield_pct=$3, plan_qty=$4, plan_unit_id=$5,
                labor_hours=$6, output_node_id=$7, note=$8, x=$9, y=$10, position=$11
          where id=$1`,
        [o.uid, o.name, o.yieldPct, o.planQty, o.planUnitId, o.laborHours, outputNodeId,
         o.note, o.x, o.y, i]
      );
      opIdByUid.set(o.uid, o.uid);
    } else {
      const { rows } = await client.query(
        `insert into prod_ops (name, yield_pct, plan_qty, plan_unit_id, labor_hours,
                               output_node_id, note, x, y, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [o.name, o.yieldPct, o.planQty, o.planUnitId, o.laborHours, outputNodeId,
         o.note, o.x, o.y, i]
      );
      opIdByUid.set(o.uid, Number(rows[0].id));
    }
  }

  for (const o of ops) {
    const opId = opIdByUid.get(o.uid)!;
    await client.query('delete from prod_op_inputs where op_id = $1', [opId]);
    for (const inp of o.inputs) {
      const nodeId = nodeIdByUid.get(inp.nodeUid);
      if (!nodeId) throw new ApiError(400, 'Вход операции не найден');
      await client.query(
        'insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct) values ($1,$2,$3,$4,$5)',
        [opId, nodeId, inp.qty, inp.inMass, inp.lossPct]
      );
    }
  }
}
