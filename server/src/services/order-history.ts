/**
 * Импорт истории заказов магазинов из сохранённой Google-таблицы «Микс Маркт Гастро».
 *
 * Лист — день доставки: дата берётся из названия листа (DD.MM), год — из строки
 * «Доставка DD.MM.YYYY». Колонки после «Min Заказ» подписаны кодами магазинов
 * (103, Mix 38103); служебные колонки (Сумма, Столбец 1, предзак, 109+) пропускаются.
 * Дробное количество округляется вверх: позиция заказа хранится в целых упаковках.
 */
import { pool, tx } from '../db';
import { ApiError } from '../http';
import { savedGoogleSheet, summaryStart, type GoogleSheetTab } from './google-sheet';

export interface OrderHistoryResult {
  from: string | null;
  to: string | null;
  dates: number;
  orders: number;
  positions: number;
  /** Клеток с дробным количеством — округлены вверх до целых упаковок. */
  rounded: number;
  /** Листы, которые не удалось прочитать (без даты, копии, дубли). */
  skipped: string[];
}

/** Пометка прежних запусков импорта: у новых заказов комментария нет. */
const IMPORT_COMMENT = 'Импорт из Google-таблицы';

/** Дата доставки: DD.MM из названия листа, год — из строки «Доставка …». */
function tabDate(tab: GoogleSheetTab): string | null {
  const name = tab.name.trim().match(/^(\d{1,2})[.,/](\d{1,2})$/);
  if (!name) return null;
  const title = (tab.rows[0] ?? []).join(' ');
  const delivery = title.match(/доставка\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/i);
  if (!delivery) return null;

  let year = Number(delivery[3]);
  if (year < 100) year += 2000;
  const day = Number(name[1]);
  const month = Number(name[2]);
  if (month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function storeColumns(
  tab: GoogleSheetTab,
  header: { row: number; minCol: number },
  storesById: Map<number, number>,
  storesByCode: Map<string, number>
): { col: number; storeId: number }[] {
  const headers = tab.rows[header.row];
  const columns: { col: number; storeId: number }[] = [];
  for (let col = header.minCol + 1; col < tab.width; col++) {
    const label = (headers[col] ?? '').trim();
    const match = label.match(/^(?:mix\s*)?(\d{3,})$/i);
    if (!match) continue;
    const storeId = storesById.get(Number(match[1])) ?? storesByCode.get(`Mix ${match[1]}`);
    if (storeId) columns.push({ col, storeId });
  }
  return columns;
}

function headerOf(tab: GoogleSheetTab): { row: number; minCol: number } | null {
  for (let row = 0; row < Math.min(10, tab.rows.length); row++) {
    const minCol = tab.rows[row].findIndex((value) => /min\.?\s*заказ/i.test(value ?? ''));
    if (minCol < 0) continue;
    if ((tab.rows[row][minCol] ?? '').trim().length > 24) continue;
    return { row, minCol };
  }
  return null;
}

/** Количество упаковок из клетки: пусто, «не нужен», «0» и мусор — пропускаются. */
function parseQty(value: string | undefined): { qty: number; rounded: boolean } | null {
  const compact = (value ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(',', '.');
  if (!compact || /^(не\s*нужен|не\s*нужно|не\s*надо|нет|-|—)$/.test(compact)) return null;
  const match = compact.match(/^(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    qty: Math.min(999, Math.max(1, Math.ceil(amount))),
    rounded: amount % 1 !== 0,
  };
}

interface PendingOrder {
  storeId: number;
  date: string;
  items: Map<number, number>;
}

export async function importOrderHistory(): Promise<OrderHistoryResult> {
  const sheet = await savedGoogleSheet();
  if (!sheet) {
    throw new ApiError(400, 'Google-таблица ещё не скачана — сначала нажмите «Синхронизировать»');
  }

  const [{ rows: stores }, { rows: packagings }] = await Promise.all([
    pool.query<{ id: number; code: string }>('select id, code from stores'),
    pool.query<{ id: number }>('select id from product_packagings'),
  ]);
  const storesById = new Map(stores.map((store) => [store.id, store.id]));
  const storesByCode = new Map(stores.map((store) => [store.code, store.id]));
  const knownPackagings = new Set(packagings.map((packaging) => packaging.id));

  const tabsByDate = new Map<string, GoogleSheetTab>();
  const skipped: string[] = [];
  for (const tab of sheet.tabs) {
    if (/копия/i.test(tab.name)) {
      skipped.push(tab.name);
      continue;
    }
    const date = tabDate(tab);
    if (!date) {
      skipped.push(tab.name);
      continue;
    }
    if (tabsByDate.has(date)) {
      skipped.push(tab.name);
      continue;
    }
    tabsByDate.set(date, tab);
  }

  const pending = new Map<string, PendingOrder>();
  let rounded = 0;
  for (const [date, tab] of tabsByDate) {
    const header = headerOf(tab);
    if (!header) {
      skipped.push(tab.name);
      continue;
    }
    const columns = storeColumns(tab, header, storesById, storesByCode);
    if (!columns.length) {
      skipped.push(tab.name);
      continue;
    }
    const end = Math.max(summaryStart(tab.rows), header.row + 1);
    for (let row = header.row + 1; row < end; row++) {
      const packagingId = tab.links[row];
      if (packagingId == null || !knownPackagings.has(packagingId)) continue;
      for (const { col, storeId } of columns) {
        const parsed = parseQty(tab.rows[row]?.[col]);
        if (!parsed) continue;
        if (parsed.rounded) rounded++;
        const key = `${storeId}|${date}`;
        let order = pending.get(key);
        if (!order) {
          order = { storeId, date, items: new Map() };
          pending.set(key, order);
        }
        order.items.set(packagingId, (order.items.get(packagingId) ?? 0) + parsed.qty);
      }
    }
  }

  const orders = [...pending.values()].filter((order) => order.items.size > 0);
  let positions = 0;
  for (const order of orders) {
    positions += order.items.size;
    for (const [packagingId, qty] of order.items) order.items.set(packagingId, Math.min(999, qty));
  }

  await tx(async (client) => {
    for (const order of orders) {
      const { rows } = await client.query<{ id: number }>(
        `insert into store_orders (store_id, delivery_date, comment)
         values ($1, $2, '')
         on conflict (store_id, delivery_date) do update
            set comment = case when store_orders.comment = $3 then '' else store_orders.comment end,
                updated_at = now()
          returning id`,
        [order.storeId, order.date, IMPORT_COMMENT]
      );
      const orderId = rows[0].id;
      await client.query('delete from store_order_items where order_id = $1', [orderId]);
      await client.query(
        `insert into store_order_items (order_id, packaging_id, qty)
         select $1, item.packaging_id, item.qty
           from unnest($2::int[], $3::int[]) as item(packaging_id, qty)`,
        [orderId, [...order.items.keys()], [...order.items.values()]]
      );
    }
  });

  const dates = [...new Set(orders.map((order) => order.date))].sort();
  return {
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    dates: dates.length,
    orders: orders.length,
    positions,
    rounded,
    skipped,
  };
}
