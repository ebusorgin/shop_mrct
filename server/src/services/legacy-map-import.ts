import type { PoolClient } from 'pg';
import { pool, tx } from '../db';

/**
 * Перенос старых техкарт и полуфабрикатов в единый граф карты производства.
 *
 * Правила:
 *  • полуфабрикат  -> state-узел + операция (партия = out_qty, yield -> loss);
 *  • техкарта      -> output-узел + операция (партия = portion_qty);
 *  • техкарта-фасовка (одна semi-строка, название совпадает с полуфабрикатом
 *    или это вариант фасовки) не создаёт узел: её фасовки переезжают на узел
 *    полуфабриката, исходное имя сохраняется в title;
 *  • сырьё -> общий product-узел (dedupe).
 */

export interface LegacySnapshot {
  products: { id: number; name: string; unit_id: number }[];
  semis: { id: number; name: string; unit_id: number; out_qty: number }[];
  semiInputs: {
    semi_id: number;
    source_type: 'raw' | 'semi';
    ref_id: number;
    qty_per_output: number;
    yield_pct: number | null;
  }[];
  cards: {
    id: number;
    name: string;
    name_en: string;
    name_sr: string;
    portion_qty: number;
    portion_unit_id: number;
    catalog_id: number | null;
  }[];
  cardItems: {
    card_id: number;
    source_type: 'raw' | 'semi' | 'product';
    ref_id: number;
    qty: number;
    unit_id: number;
    position: number;
  }[];
  packagings: {
    id: number;
    card_id: number;
    name: string;
    qty_base: number;
    min_order: number;
    is_default: boolean;
    price: number;
    price_basis: 'unit' | 'portion' | 'piece';
    cost: number;
    available: boolean;
  }[];
}

export interface PlannedPackaging {
  legacyId: number;
  name: string;
  title: string | null;
  titleEn: string | null;
  titleSr: string | null;
  qtyBase: number;
  minOrder: number;
  isDefault: boolean;
  price: number;
  priceBasis: 'unit' | 'portion' | 'piece';
  cost: number;
  available: boolean;
}

export interface PlannedNode {
  key: string;
  kind: 'product' | 'state' | 'output';
  refId: number | null;
  legacyKind: 'semi' | 'card' | null;
  legacyId: number | null;
  name: string;
  nameEn: string;
  nameSr: string;
  catalogId: number | null;
  unitId: number;
  portionQty: number;
  price: number;
  note: string;
  packagings: PlannedPackaging[];
}

export interface PlannedOp {
  key: string;
  legacySource: 'semi' | 'card' | null;
  legacyId: number | null;
  name: string;
  planQty: number;
  planUnitId: number;
  outputKey: string;
  inputs: { nodeKey: string; qty: number; inMass: boolean; lossPct: number | null }[];
}

export interface MapPlan {
  nodes: PlannedNode[];
  ops: PlannedOp[];
  warnings: string[];
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function planLegacyImport(data: LegacySnapshot): MapPlan {
  const warnings: string[] = [];
  const semiById = new Map(data.semis.map((s) => [s.id, s]));
  const cardById = new Map(data.cards.map((c) => [c.id, c]));

  const itemsByCard = new Map<number, LegacySnapshot['cardItems']>();
  for (const i of data.cardItems) {
    const arr = itemsByCard.get(i.card_id) ?? [];
    arr.push(i);
    itemsByCard.set(i.card_id, arr);
  }
  const inputBySemi = new Map<number, LegacySnapshot['semiInputs']>();
  for (const i of data.semiInputs) {
    const arr = inputBySemi.get(i.semi_id) ?? [];
    arr.push(i);
    inputBySemi.set(i.semi_id, arr);
  }
  const packagingByCard = new Map<number, PlannedPackaging[]>();
  for (const p of data.packagings) {
    const arr = packagingByCard.get(p.card_id) ?? [];
    arr.push({
      legacyId: p.id,
      name: p.name,
      title: null,
      titleEn: null,
      titleSr: null,
      qtyBase: p.qty_base,
      minOrder: p.min_order,
      isDefault: p.is_default,
      price: p.price,
      priceBasis: p.price_basis,
      cost: p.cost,
      available: p.available,
    });
    packagingByCard.set(p.card_id, arr);
  }

  /** Техкарта — только фасовка полуфабриката (в т. ч. вариант «3кг», «ведра»). */
  const collapsedToSemi = new Map<number, number>();
  for (const card of data.cards) {
    const items = itemsByCard.get(card.id) ?? [];
    if (items.length !== 1) continue;
    const item = items[0];
    if (item.source_type !== 'semi' || Number(item.qty) !== Number(card.portion_qty)) continue;
    const semi = semiById.get(item.ref_id);
    if (!semi || semi.unit_id !== card.portion_unit_id) continue;
    const c = norm(card.name);
    const s = norm(semi.name);
    if (c === s || c.startsWith(s + ' ')) collapsedToSemi.set(card.id, semi.id);
  }

  const nodes: PlannedNode[] = [];
  const ops: PlannedOp[] = [];
  const rawKeys = new Set<number>();
  const nodeByCard = new Map<number, string>();
  for (const [cardId, semiId] of collapsedToSemi) nodeByCard.set(cardId, `state:${semiId}`);
  const nodeByKey = new Map<string, PlannedNode>();

  for (const semi of data.semis) {
    const key = `state:${semi.id}`;
    const node: PlannedNode = {
      key,
      kind: 'state',
      refId: null,
      legacyKind: 'semi',
      legacyId: semi.id,
      name: semi.name,
      nameEn: '',
      nameSr: '',
      catalogId: null,
      unitId: semi.unit_id,
      portionQty: semi.out_qty,
      price: 0,
      note: '',
      packagings: [],
    };
    nodes.push(node);
    nodeByKey.set(key, node);
    ops.push({
      key: `op:semi:${semi.id}`,
      legacySource: 'semi',
      legacyId: semi.id,
      name: 'производство',
      planQty: semi.out_qty,
      planUnitId: semi.unit_id,
      outputKey: key,
      inputs: (inputBySemi.get(semi.id) ?? []).map((i) => ({
        nodeKey: i.source_type === 'raw' ? `raw:${i.ref_id}` : `state:${i.ref_id}`,
        qty: i.qty_per_output,
        inMass: true,
        lossPct:
          i.yield_pct != null && i.yield_pct > 0 && i.yield_pct < 100
            ? 100 - i.yield_pct
            : null,
      })),
    });
    for (const i of inputBySemi.get(semi.id) ?? []) {
      if (i.source_type === 'raw') rawKeys.add(i.ref_id);
    }
  }

  for (const card of data.cards) {
    if (collapsedToSemi.has(card.id)) {
      const semiNode = nodeByKey.get(nodeByCard.get(card.id)!)!;
      if (semiNode.catalogId == null) semiNode.catalogId = card.catalog_id;
      else if (card.catalog_id != null && card.catalog_id !== semiNode.catalogId) {
        warnings.push(`«${card.name}»: каталог техкарты не совпал с каталогом полуфабриката — оставлен первый`);
      }
      const sameName = norm(card.name) === norm(semiNode.name);
      if (sameName && card.name_en) semiNode.nameEn = card.name_en;
      if (sameName && card.name_sr) semiNode.nameSr = card.name_sr;
      for (const p of packagingByCard.get(card.id) ?? []) {
        semiNode.packagings.push({
          ...p,
          title: sameName ? null : card.name,
          titleEn: sameName ? null : card.name_en || null,
          titleSr: sameName ? null : card.name_sr || null,
        });
      }
      continue;
    }

    const key = `output:${card.id}`;
    nodeByCard.set(card.id, key);
    const node: PlannedNode = {
      key,
      kind: 'output',
      refId: null,
      legacyKind: 'card',
      legacyId: card.id,
      name: card.name,
      nameEn: card.name_en,
      nameSr: card.name_sr,
      catalogId: card.catalog_id,
      unitId: card.portion_unit_id,
      portionQty: card.portion_qty,
      price: 0,
      note: '',
      packagings: (packagingByCard.get(card.id) ?? []).map((p) => ({ ...p })),
    };
    nodes.push(node);
    nodeByKey.set(key, node);

    const inputs = (itemsByCard.get(card.id) ?? []).map((i) => {
      if (i.source_type === 'raw') {
        rawKeys.add(i.ref_id);
        return { nodeKey: `raw:${i.ref_id}`, qty: i.qty, inMass: true, lossPct: null };
      }
      if (i.source_type === 'semi') {
        return { nodeKey: `state:${i.ref_id}`, qty: i.qty, inMass: true, lossPct: null };
      }
      const ref = cardById.get(i.ref_id);
      if (!ref) throw new Error(`Техкарта #${card.id}: ссылка на продукт #${i.ref_id} не найдена`);
      const refKey = nodeByCard.get(i.ref_id) ?? `output:${i.ref_id}`;
      return { nodeKey: refKey, qty: i.qty, inMass: true, lossPct: null };
    });
    ops.push({
      key: `op:card:${card.id}`,
      legacySource: 'card',
      legacyId: card.id,
      name: 'сборка',
      planQty: card.portion_qty,
      planUnitId: card.portion_unit_id,
      outputKey: key,
      inputs,
    });
  }

  for (const id of [...rawKeys].sort((a, b) => a - b)) {
    const p = data.products.find((x) => x.id === id);
    if (!p) {
      warnings.push(`Сырьё #${id} не найдено в номенклатуре`);
      continue;
    }
    nodes.push({
      key: `raw:${id}`,
      kind: 'product',
      refId: id,
      legacyKind: null,
      legacyId: null,
      name: p.name,
      nameEn: '',
      nameSr: '',
      catalogId: null,
      unitId: p.unit_id,
      portionQty: 0,
      price: 0,
      note: '',
      packagings: [],
    });
  }

  // Одна фасовка по умолчанию на узел: приоритет у той, что пришла как default.
  for (const node of nodes) {
    let seen = false;
    for (const p of node.packagings) {
      if (p.isDefault && !seen) seen = true;
      else p.isDefault = false;
    }
    if (!seen && node.packagings.length) node.packagings[0].isDefault = true;
  }

  for (const node of nodes) {
    if (!node.name.trim()) warnings.push(`Узел ${node.key} без названия`);
  }
  return { nodes, ops, warnings };
}

export async function loadLegacySnapshot(client: PoolClient): Promise<LegacySnapshot> {
  const q = async (sql: string) => (await client.query(sql)).rows;
  return {
    products: await q('select id, name, unit_id from products order by id'),
    semis: await q(
      'select id, name, unit_id, out_qty::float8 as out_qty from semi_products order by id'
    ),
    semiInputs: await q(`select semi_id, source_type, ref_id,
                                qty_per_output::float8 as qty_per_output,
                                yield_pct::float8 as yield_pct
                           from semi_inputs order by id`),
    cards: await q(`select id, name, name_en, name_sr,
                           portion_qty::float8 as portion_qty, portion_unit_id, catalog_id
                      from tech_cards order by id`),
    cardItems: await q(`select card_id, source_type, ref_id, qty::float8 as qty, unit_id, position
                          from tech_card_items order by card_id, position, id`),
    packagings: await q(`select id, card_id, name, qty_base::float8 as qty_base, min_order,
                                is_default, price::float8 as price, price_basis,
                                cost::float8 as cost, available
                           from product_packagings order by id`),
  } as LegacySnapshot;
}

export interface MigrationReport {
  skipped: boolean;
  nodes: number;
  ops: number;
  packagings: number;
  ordersItems: number;
  warnings: string[];
}

export async function applyLegacyMapImport(opts: { dryRun: boolean }): Promise<MigrationReport> {
  return tx(async (client) => {
    const marker = await client.query(
      "select 1 from app_migrations where name = 'legacy_to_map_v1'"
    );
    if (marker.rows.length) {
      return { skipped: true, nodes: 0, ops: 0, packagings: 0, ordersItems: 0, warnings: [] };
    }

    const snapshot = await loadLegacySnapshot(client);
    const plan = planLegacyImport(snapshot);
    if (opts.dryRun) {
      return {
        skipped: false,
        nodes: plan.nodes.length,
        ops: plan.ops.length,
        packagings: plan.nodes.reduce((s, n) => s + n.packagings.length, 0),
        ordersItems: 0,
        warnings: plan.warnings,
      };
    }

    await client.query('delete from prod_packagings');
    await client.query('delete from prod_op_inputs');
    await client.query('delete from prod_ops');
    await client.query('delete from prod_nodes');

    const nodeIdByKey = new Map<string, number>();
    for (let i = 0; i < plan.nodes.length; i++) {
      const n = plan.nodes[i];
      const { rows } = await client.query(
        `insert into prod_nodes (kind, ref_id, name, name_en, name_sr, catalog_id, unit_id,
                                 x, y, position, portion_qty, price, note, legacy_kind, legacy_id)
         values ($1,$2,$3,$4,$5,$6,$7,0,0,$8,$9,$10,$11,$12,$13) returning id`,
        [n.kind, n.refId, n.name, n.nameEn, n.nameSr, n.catalogId, n.unitId, i,
         n.portionQty, n.price, n.note, n.legacyKind, n.legacyId]
      );
      nodeIdByKey.set(n.key, Number(rows[0].id));
    }

    const packIdByLegacy = new Map<number, number>();
    let packCount = 0;
    for (const n of plan.nodes) {
      const nodeId = nodeIdByKey.get(n.key)!;
      for (let j = 0; j < n.packagings.length; j++) {
        const p = n.packagings[j];
        const { rows } = await client.query(
          `insert into prod_packagings (node_id, name, qty_base, min_order, is_default, price,
                                        price_basis, cost, available, position, legacy_id, title,
                                        title_en, title_sr)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
          [nodeId, p.name, p.qtyBase, p.minOrder, p.isDefault, p.price, p.priceBasis,
           p.cost, p.available, j, p.legacyId, p.title, p.titleEn, p.titleSr]
        );
        packIdByLegacy.set(p.legacyId, Number(rows[0].id));
        packCount++;
      }
    }

    for (let i = 0; i < plan.ops.length; i++) {
      const o = plan.ops[i];
      const outputNodeId = nodeIdByKey.get(o.outputKey);
      if (!outputNodeId) throw new Error(`Выход операции ${o.key} не найден`);
      const { rows } = await client.query(
        `insert into prod_ops (name, plan_qty, plan_unit_id, labor_hours, output_node_id,
                               note, x, y, position, legacy_source, legacy_id)
         values ($1,$2,$3,0,$4,'',0,0,$5,$6,$7) returning id`,
        [o.name, o.planQty, o.planUnitId, outputNodeId, i, o.legacySource, o.legacyId]
      );
      const opId = Number(rows[0].id);
      for (const inp of o.inputs) {
        const nodeId = nodeIdByKey.get(inp.nodeKey);
        if (!nodeId) throw new Error(`Вход операции ${o.key}: узел ${inp.nodeKey} не найден`);
        await client.query(
          'insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct) values ($1,$2,$3,$4,$5)',
          [opId, nodeId, inp.qty, inp.inMass, inp.lossPct]
        );
      }
    }

    const { rows: itemCount } = await client.query(
      'select count(*)::int as n from store_order_items'
    );
    const ordersItems = Number(itemCount[0].n);
    if (ordersItems > 0) {
      await client.query(
        'alter table store_order_items drop constraint if exists store_order_items_packaging_id_fkey'
      );
      await client.query(
        'alter table store_order_items drop constraint if exists store_order_items_prod_packaging_fkey'
      );
      // init.sql уже мог добавить пустую legacy-колонку: переносим в неё старые id
      await client.query(
        'update store_order_items set legacy_packaging_id = packaging_id where legacy_packaging_id is null'
      );
      await client.query(
        'alter table store_order_items drop constraint if exists store_order_items_pkey'
      );
      await client.query(
        'alter table store_order_items rename column packaging_id to packaging_legacy_tmp'
      );
      await client.query('alter table store_order_items add column packaging_id int');
      for (const [oldId, newId] of packIdByLegacy) {
        await client.query(
          'update store_order_items set packaging_id = $2 where legacy_packaging_id = $1',
          [oldId, newId]
        );
      }
      const { rows: missing } = await client.query(
        'select count(*)::int as n from store_order_items where packaging_id is null'
      );
      if (Number(missing[0].n) > 0) {
        throw new Error(`Не сопоставлено строк заказов: ${missing[0].n}`);
      }
      await client.query(
        'alter table store_order_items alter column packaging_id set not null'
      );
      await client.query(
        'alter table store_order_items add primary key (order_id, packaging_id)'
      );
      await client.query('alter table store_order_items drop column packaging_legacy_tmp');
      await client.query(
        `alter table store_order_items
           add constraint store_order_items_prod_packaging_fkey
           foreign key (packaging_id) references prod_packagings(id)`
      );
    }

    const { rows: orders } = await client.query(
      'select id, line_order from store_orders where line_order is not null'
    );
    for (const o of orders) {
      const mapped = (o.line_order as number[])
        .map((id) => packIdByLegacy.get(id))
        .filter((x): x is number => !!x);
      await client.query('update store_orders set line_order = $2::int[] where id = $1', [
        o.id,
        mapped,
      ]);
    }

    await client.query('update map_meta set version = version + 1, updated_at = now() where id = 1');
    await client.query("insert into app_migrations (name) values ('legacy_to_map_v1')");

    return {
      skipped: false,
      nodes: plan.nodes.length,
      ops: plan.ops.length,
      packagings: packCount,
      ordersItems,
      warnings: plan.warnings,
    };
  });
}
