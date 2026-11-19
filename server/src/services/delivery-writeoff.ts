/**
 * Ручное списание склада по доставке магазинам.
 *
 * Заказы магазинов на дату состоят из фасовок узлов карты. Для каждой фасовки берём её вес/объём
 * (qty_base) и количество упаковок — получаем количество в единице узла. Дальше граф карты
 * раскрывает рецепт в чистое сырьё (с учётом полуфабрикатов и потерь), и со склада списываются
 * продукты по средней себестоимости.
 *
 * Списание фиксируется в store_delivery_writeoffs: повторно на ту же дату/магазин кнопка
 * не сработает. Пока это единственный, ручной способ — автоматику не включаем.
 */
import { PoolClient } from 'pg';
import { pool, tx } from '../db';
import { ApiError } from '../http';
import { applyMovement } from './stock';
import { expandNodeNeedTx } from './map-production';
import { auditTx, type Actor } from './audit';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number): number => Math.round((n + Number.EPSILON) * 1000) / 1000;

export interface WriteoffLine {
  productId: number;
  name: string;
  unitCode: string;
  qty: number;
  unitCost: number;
  cost: number;
  /** Текущий остаток на складе в базовых единицах (0 — нет строки/пусто). */
  stockQty: number;
  /** Хватает ли остатка на списание именно сейчас. */
  enough: boolean;
}

export interface WriteoffOrder {
  id: number;
  storeId: number;
  storeCode: string;
  storeName: string;
  number: string;
  positions: number;
}

export interface WriteoffRecord {
  id: number;
  storeId: number | null;
  storeCode: string | null;
  storeName: string | null;
  at: string;
  login: string | null;
  costTotal: number;
  positions: number;
}

export interface WriteoffPreview {
  date: string;
  storeId: number | null;
  orders: WriteoffOrder[];
  lines: WriteoffLine[];
  totalCost: number;
  /** Все списания на эту дату (для подсказки в интерфейсе). */
  records: WriteoffRecord[];
  /** Текущее списание уже перекрывает запрошенный охват — повторно нельзя. */
  blocked: boolean;
  /** Позиций, которых не хватает на складе (списание невозможно). */
  shortages: number;
  /** Можно ли проводить списание прямо сейчас. */
  canPost: boolean;
}

export interface WriteoffResult {
  id: number;
  date: string;
  storeId: number | null;
  positions: number;
  totalCost: number;
  orders: number;
}

interface OrderRow {
  orderId: number;
  storeId: number;
  storeCode: string;
  storeName: string;
  docNo: string | null;
  qty: number;
  qtyBase: number;
  nodeId: number;
  cardName: string;
}

function dateParam(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ApiError(400, 'date: требуется дата в формате YYYY-MM-DD');
  }
  return date;
}

function storeParam(storeId: number | null | undefined): number | null {
  if (storeId == null) return null;
  if (!Number.isInteger(storeId) || storeId <= 0) throw new ApiError(400, 'storeId: требуется целое положительное число');
  return storeId;
}

async function loadRecords(client: PoolClient, date: string): Promise<WriteoffRecord[]> {
  const { rows } = await client.query(
    `select w.id::int as id, w.store_id as "storeId", s.code as "storeCode", s.name as "storeName",
            w.created_at as at, w.created_login as login,
            w.cost_total::float8 as "costTotal", w.positions
       from store_delivery_writeoffs w
       left join stores s on s.id = w.store_id
      where w.delivery_date = $1::date
      order by w.store_id nulls first, w.created_at`,
    [date]
  );
  return rows as WriteoffRecord[];
}

function isBlocked(records: WriteoffRecord[], storeId: number | null): boolean {
  return records.some((r) => storeId == null || r.storeId == null || r.storeId === storeId);
}

async function loadOrderRows(client: PoolClient, date: string, storeId: number | null): Promise<OrderRow[]> {
  const { rows } = await client.query<OrderRow>(
    `select o.id as "orderId", o.store_id as "storeId", s.code as "storeCode", s.name as "storeName",
            o.doc_no::text as "docNo",
            i.qty, pk.qty_base::float8 as "qtyBase",
            n.id as "nodeId", coalesce(pk.title, n.name) as "cardName"
       from store_orders o
       join stores s on s.id = o.store_id
       join store_order_items i on i.order_id = o.id
       join prod_packagings pk on pk.id = i.packaging_id
       join prod_nodes n on n.id = pk.node_id
      where o.delivery_date = $1::date
        and ($2::int is null or o.store_id = $2)
      order by s.code, o.id, n.name`,
    [date, storeId]
  );
  return rows;
}

/**
 * Раскрывает все заказы даты в потребность чистого сырья.
 * Возвращает и заказы (для подписи), и потребность productId -> количество в базовых единицах.
 */
async function buildNeeds(
  client: PoolClient,
  date: string,
  storeId: number | null
): Promise<{ orders: WriteoffOrder[]; need: Map<number, number> }> {
  const rows = await loadOrderRows(client, date, storeId);
  if (!rows.length) {
    throw new ApiError(
      404,
      storeId == null ? 'На эту дату нет заказов магазинов' : 'У этого магазина нет заказа на эту дату'
    );
  }

  const byNode = new Map<number, { name: string; out: number }>();
  const orders = new Map<number, WriteoffOrder>();
  for (const r of rows) {
    const out = r.qty * r.qtyBase;
    if (!(out > 0)) {
      throw new ApiError(400, `Не удалось посчитать количество для «${r.cardName}»: проверьте вес фасовки`);
    }
    const node = byNode.get(r.nodeId) ?? { name: r.cardName, out: 0 };
    node.out += out;
    byNode.set(r.nodeId, node);

    let order = orders.get(r.orderId);
    if (!order) {
      order = {
        id: r.orderId,
        storeId: r.storeId,
        storeCode: r.storeCode,
        storeName: r.storeName,
        number: `${date.slice(0, 4)}-${r.docNo ?? r.orderId}`,
        positions: 0,
      };
      orders.set(r.orderId, order);
    }
    order.positions++;
  }

  const need = new Map<number, number>();
  for (const [nodeId, info] of byNode) {
    let raw: { productId: number; qty: number }[];
    try {
      raw = await expandNodeNeedTx(client, nodeId, round3(info.out));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiError(400, `Не удалось раскрыть рецепт «${info.name}»: ${msg}`);
    }
    for (const n of raw) need.set(n.productId, (need.get(n.productId) ?? 0) + n.qty);
  }

  return { orders: [...orders.values()], need };
}

async function productLines(client: PoolClient, need: Map<number, number>): Promise<WriteoffLine[]> {
  const ids = [...need.keys()];
  if (!ids.length) return [];
  const { rows } = await client.query(
    `select p.id, p.name, u.code as "unitCode", coalesce(st.avg_cost, 0)::float8 as "avgCost",
            coalesce(st.qty, 0)::float8 as "stockQty", (st.product_id is not null) as "hasStock"
       from products p
       join units u on u.id = p.unit_id
       left join stock st on st.product_id = p.id
      where p.id = any($1::int[])`,
    [ids]
  );
  const byId = new Map<number, { name: string; unitCode: string; avgCost: number; stockQty: number; hasStock: boolean }>(
    rows.map((r: { id: number; name: string; unitCode: string; avgCost: number; stockQty: number; hasStock: boolean }) => [
      r.id,
      {
        name: r.name,
        unitCode: r.unitCode,
        avgCost: Number(r.avgCost),
        stockQty: Number(r.stockQty),
        hasStock: !!r.hasStock,
      },
    ])
  );
  const lines: WriteoffLine[] = [];
  for (const [productId, qty] of need) {
    const info = byId.get(productId);
    if (!info) throw new ApiError(400, `Продукт #${productId} из техкарты не найден в номенклатуре`);
    const q = round3(qty);
    const cost = round2(q * info.avgCost);
    lines.push({
      productId,
      name: info.name,
      unitCode: info.unitCode,
      qty: q,
      unitCost: info.avgCost,
      cost,
      stockQty: round3(info.stockQty),
      enough: info.hasStock && info.stockQty + 1e-9 >= q,
    });
  }
  lines.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return lines;
}

/** Предпросмотр: что именно уйдёт со склада и во сколько это оценивается по средней. */
export async function deliveryWriteoffPreview(
  rawDate: string,
  rawStoreId: number | null | undefined
): Promise<WriteoffPreview> {
  const date = dateParam(rawDate);
  const storeId = storeParam(rawStoreId);
  const client = await pool.connect();
  try {
    const records = await loadRecords(client, date);
    const { orders, need } = await buildNeeds(client, date, storeId);
    const lines = await productLines(client, need);
    const totalCost = round2(lines.reduce((s, l) => s + l.cost, 0));
    const shortages = lines.filter((l) => !l.enough).length;
    const blocked = isBlocked(records, storeId);
    return { date, storeId, orders, lines, totalCost, records, blocked, shortages, canPost: !blocked && lines.length > 0 && shortages === 0 };
  } finally {
    client.release();
  }
}

/** Статус списаний на дату — для бейджа в архиве, без расчёта рецептов. */
export async function deliveryWriteoffStatus(rawDate: string): Promise<{ date: string; records: WriteoffRecord[] }> {
  const date = dateParam(rawDate);
  const client = await pool.connect();
  try {
    return { date, records: await loadRecords(client, date) };
  } finally {
    client.release();
  }
}

/**
 * Списание: фиксируем запись, блокируем склад, пишем движения writeoff по средней себестоимости.
 * Повтор на ту же дату/магазин невозможен; недостаток остатка откатывает всё.
 */
export async function postDeliveryWriteoff(
  rawDate: string,
  rawStoreId: number | null | undefined,
  actor: Actor,
  note = '',
  runTx: typeof tx = tx
): Promise<WriteoffResult> {
  const date = dateParam(rawDate);
  const storeId = storeParam(rawStoreId);

  return runTx(async (client) => {
    // конкурентные нажатия: блокируем существующие записи даты
    await client.query('select 1 from store_delivery_writeoffs where delivery_date = $1::date for update', [date]);
    const records = await loadRecords(client, date);
    if (isBlocked(records, storeId)) {
      throw new ApiError(409, 'На эту дату списание уже сделано — повторно списывать нельзя');
    }

    const { orders, need } = await buildNeeds(client, date, storeId);
    const productIds = [...need.keys()].sort((a, b) => a - b);
    const lines = await productLines(client, need);
    if (!lines.length) throw new ApiError(400, 'В заказах нет позиций для списания');
    const shorts = lines.filter((l) => !l.enough);
    if (shorts.length) {
      const detail = shorts
        .slice(0, 5)
        .map((l) => `${l.name}: нужно ${l.qty} ${l.unitCode}, есть ${l.stockQty} ${l.unitCode}`)
        .join('; ');
      throw new ApiError(
        409,
        `На складе не хватает сырья для ${shorts.length} ${shorts.length === 1 ? 'позиции' : 'позиций'}: ${detail}${shorts.length > 5 ? ' …' : ''}. Сначала оформите приход.`
      );
    }

    const { rows: head } = await client.query(
      `insert into store_delivery_writeoffs (delivery_date, store_id, note, created_by, created_login, positions)
       values ($1::date, $2, $3, $4, $5, $6) returning id`,
      [date, storeId, note, actor?.id ?? null, actor?.login ?? 'system', lines.length]
    );
    const writeoffId = Number(head[0].id);

    // строки склада блокируем в детерминированном порядке — против deadlock
    await client.query('select 1 from stock where product_id = any($1::int[]) for update', [productIds]);

    let totalCost = 0;
    for (const line of lines) {
      totalCost += line.cost;
      await applyMovement(client, {
        productId: line.productId,
        type: 'writeoff',
        delta: -line.qty,
        unitCost: line.unitCost,
        docType: 'store_delivery',
        docId: writeoffId,
        comment: `Доставка ${date}${storeId == null ? ' · все магазины' : ` · магазин #${storeId}`}`,
        actor,
      });
    }
    totalCost = round2(totalCost);
    await client.query('update store_delivery_writeoffs set cost_total = $2 where id = $1', [writeoffId, totalCost]);

    const stores = new Set(orders.map((o) => o.storeId));
    await auditTx(client, actor, {
      action: 'post',
      entity: 'store_order',
      entityId: writeoffId,
      title: `Списание склада по доставке ${date}${storeId == null ? ' · все магазины' : ` · магазин #${storeId}`}`,
      details: { date, storeId, writeoffId, orders: orders.length, stores: stores.size, positions: lines.length, totalCost },
    });

    return { id: writeoffId, date, storeId, positions: lines.length, totalCost, orders: orders.length };
  });
}
