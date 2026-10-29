/**
 * Фоновая синхронизация заказов из Google Таблицы.
 *  - период: каждые GSHEET_SYNC_MIN (10) минут; старт — через 20 с после подъёма сервера;
 *  - полный обгон (все вкладки) — при первом запуске, дальше только «живые» листы
 *    (последние GSHEET_RECENT_TABS дат) + ещё не синхронизированные;
 *  - кеш: content_hash листа — лист не изменился, не трогаем заказы. Обращения к Sheets:
 *    один xlsx-заголовок + по одному gviz на свежий/новый лист за цикл;
 *  - изменения (новые / изменилось количество / удалено) пишутся в order_changes
 *    триггером БД, привязка — к последнему по дате листу; сбои — retry внутри цикла
 *    и повтор на следующем прогоне (ошибка листа не валит весь прогон).
 */
import { pool, tx } from '../db';
import { PoolClient } from 'pg';
import { config } from '../config';
import { listTabs, readSheet, parseSheet, assignYears, SheetTab, SheetOrderRow } from './gsheet';
import { CardMatcher, toBase } from './order-match';

const matcher = new CardMatcher();

export interface SyncSummary {
  tabsSeen: number;
  tabsParsed: number;
  tabsFailed: number;
  unchanged: number;
  ordersCreated: number;
  ordersChanged: number;
  ordersRemoved: number;
  full: boolean;
}

let running: Promise<SyncSummary> | null = null;
let lastSummary: SyncSummary | null = null;

export function lastSyncSummary(): SyncSummary | null {
  return lastSummary;
}

/** Запуск цикла; повторный вызов во время прогона возвращает тот же промис.
 *  `tab` сужает прогон до одной вкладки — так работает синк по уведомлению из таблицы. */
export function runOrderSync(opts: { full?: boolean; tab?: string } = {}): Promise<SyncSummary> {
  if (running && !opts.full) return running;
  const p = doSync(opts.full ?? false, opts.tab).finally(() => {
    if (running === p) running = null;
  });
  if (!opts.full) running = p;
  return p;
}

async function doSync(full: boolean, onlyTab?: string): Promise<SyncSummary> {
  const summary: SyncSummary = {
    tabsSeen: 0, tabsParsed: 0, tabsFailed: 0, unchanged: 0,
    ordersCreated: 0, ordersChanged: 0, ordersRemoved: 0, full,
  };
  await pool.query("update order_sync_run set status='running', last_run_at=now(), last_error=null where id=1");
  try {
    const sheetId = config.gsheetId;
    const tabs = await withRetry(() => listTabs(sheetId), 3);
    const dates = assignYears(tabs.map((t) => t.name), new Date());
    summary.tabsSeen = tabs.length;
    await matcher.load();
    const { rows: storeRows } = await pool.query('select id from stores where active order by id');
    const wantStores = storeRows.map((r: { id: number }) => r.id as number);
    if (!wantStores.length) throw new Error('order-sync: нет активных магазинов (stores)');

    const { rows: known } = await pool.query('select sheet_name, content_hash from order_tabs');
    const hashByTab = new Map<string, string>(known.map((r: { sheet_name: string; content_hash: string | null }) => [r.sheet_name, r.content_hash ?? '']));

    const datedTabs = tabs.filter((t) => dates.has(t.name));
    let targets: SheetTab[];
    if (onlyTab) {
      // уведомление из таблицы: правим только ту вкладку, о которой сообщили
      targets = datedTabs.filter((t) => t.name === onlyTab);
    } else if (full || known.length === 0) {
      targets = datedTabs;
    } else {
      const recent = datedTabs.slice(-config.gsheetRecentTabs);
      const unsynced = datedTabs.filter((t) => !hashByTab.has(t.name));
      targets = [...new Map([...recent, ...unsynced].map((t) => [t.name, t])).values()];
    }

    for (const tab of targets) {
      try {
        const cells = await withRetry(() => readSheet(sheetId, tab), 3);
        const parsed = parseSheet(cells, wantStores);
        if (!parsed.rows.length) continue; // служебный/пустой лист — не ошибка
        summary.tabsParsed += 1;
        const dateIso = dates.get(tab.name)!;
        const tabId = await upsertTab(tab.name, dateIso, parsed.hash, parsed.rows.length);
        if (hashByTab.get(tab.name) === parsed.hash) {
          summary.unchanged += 1;
          continue; // кеш: лист не менялся с прошлого цикла
        }
        const d = await applyTab(tabId, dateIso, parsed.rows);
        summary.ordersCreated += d.created;
        summary.ordersChanged += d.changed;
        summary.ordersRemoved += d.removed;
      } catch (e) {
        summary.tabsFailed += 1;
        console.error(`[order-sync] лист «${tab.name}»:`, e);
        await pool.query('update order_tabs set last_error = $2 where sheet_name = $1', [tab.name, String((e as Error).message ?? e).slice(0, 500)]);
      }
    }

    await pool.query(
      `update order_sync_run set status='ok', finished_at=now(), tabs_synced=$1, tabs_failed=$2,
         last_error=null, next_run_at=now() + make_interval(mins => $3::int) where id=1`,
      [summary.tabsParsed, summary.tabsFailed, config.gsheetSyncMin]
    );
    lastSummary = summary;
    if (summary.ordersCreated + summary.ordersChanged + summary.ordersRemoved > 0) {
      console.log(`[order-sync]листов ${summary.tabsParsed}/${summary.tabsSeen}, без изменений ${summary.unchanged}, +${summary.ordersCreated} ~${summary.ordersChanged} -${summary.ordersRemoved}`);
    }
    return summary;
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    summary.tabsFailed += 1;
    lastSummary = summary;
    console.error('[order-sync] прогон упал:', msg);
    await pool.query("update order_sync_run set status='error', finished_at=now(), last_error=$1 where id=1", [msg]);
    return summary;
  }
}

async function upsertTab(name: string, dateIso: string, hash: string, rowCount: number): Promise<number> {
  const { rows } = await pool.query(
    `insert into order_tabs (sheet_name, extract_date, content_hash, row_count, last_sync_at)
     values ($1, $2::date, $3, $4, now())
     on conflict (sheet_name) do update
        set content_hash = excluded.content_hash, row_count = excluded.row_count,
            last_sync_at = now(), last_error = null
     returning id`,
    [name, dateIso, hash, rowCount]
  );
  return rows[0].id as number;
}

/** Кеш id категорий прогона (имя источника -> order_categories.id). */
const catCache = new Map<string, number | null>();
async function categoryId(client: PoolClient, name: string): Promise<number | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (catCache.has(key)) return catCache.get(key) ?? null;
  const { rows } = await client.query(
    `insert into order_categories (name) values ($1) on conflict (name) do update set name = excluded.name returning id`,
    [key]
  );
  const id = rows[0]?.id ?? null;
  catCache.set(key, id);
  return id;
}

/**
 * Дифф-применение листа: линия = (tab, store, source_name) — уникальна.
 * Всё изменение листа — одной транзакцией; триггер orders_audit сам кладёт
 * created/qty_changed/removed в журнал.
 */
async function applyTab(
  tabId: number,
  dateIso: string,
  rows: SheetOrderRow[]
): Promise<{ created: number; changed: number; removed: number }> {
  let created = 0;
  let changed = 0;
  let removed = 0;
  await tx(async (client) => {
    const { rows: existing } = await client.query(
      `select id, store_id, source_name, quantity::float8 as qty from orders where tab_id = $1 and source='g_sheet'`,
      [tabId]
    );
    const exMap = new Map<string, { id: number; qty: number }>();
    for (const e of existing) exMap.set(`${e.store_id}|${e.source_name}`, { id: e.id, qty: Number(e.qty) });

    const seen = new Set<string>();
    for (const row of rows) {
      const m = await matcher.match(row.name, row.plu);
      const card = m.cardId ? matcher.byId(m.cardId) : undefined;
      const catId = await categoryId(client, row.category);
      for (const [storeKey, printedQty] of Object.entries(row.qty)) {
        const storeId = Number(storeKey); // parsed.qty уже ключён store_id (103..110)
        if (!Number.isFinite(storeId)) continue;
        const key = `${storeId}|${row.name}`;
        seen.add(key);
        const baseQty = card ? toBase(printedQty, row.unit, card.baseUnitCode, card.portionQty) : printedQty;
        const minBase = row.min !== null ? (card ? toBase(row.min, row.unit, card.baseUnitCode, card.portionQty) : row.min) : null;
        const ex = exMap.get(key);
        if (ex) {
          if (Math.abs(ex.qty - baseQty) > 1e-6) {
            await client.query(
              `update orders set quantity=$2, card_id=coalesce($3, card_id), plu=coalesce($4, plu),
                 min_qty=$5, ek_price=$6, vk_price=$7, unit_code=$8, date_tab=$9::date,
                 category_id=coalesce($10, category_id), updated_at=now()
               where id=$1`,
              [ex.id, baseQty, m.cardId, row.plu, minBase, row.ek, row.vk, row.unit, dateIso, catId]
            );
            changed += 1;
          }
        } else {
          // on conflict — защита от повтора после частичного сбоя прогона
          await client.query(
            `insert into orders (tab_id, store_id, card_id, source_name, plu, min_qty, ek_price, vk_price,
                                 quantity, unit_code, date_tab, category_id, status, source)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,'synced','g_sheet')
             on conflict (tab_id, store_id, source_name) do update
                set quantity = excluded.quantity, card_id = excluded.card_id, plu = excluded.plu,
                    min_qty = excluded.min_qty, ek_price = excluded.ek_price, vk_price = excluded.vk_price,
                    unit_code = excluded.unit_code, date_tab = excluded.date_tab,
                    category_id = excluded.category_id, updated_at = now()`,
            [tabId, storeId, m.cardId, row.name, row.plu, minBase, row.ek, row.vk, baseQty, row.unit, dateIso, catId]
          );
          created += 1;
        }
      }
    }
    for (const [key, ex] of exMap) {
      if (!seen.has(key)) {
        await client.query('delete from orders where id = $1', [ex.id]);
        removed += 1;
      }
    }
  });
  return { created, changed, removed };
}

/** Retry с экспоненциальной паузой — сетевые сбои Google не должны валить цикл. */
async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let delay = 1500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      console.warn(`[order-sync] попытка ${i} не удалась:`, (e as Error).message ?? e);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

/** Фоновый цикл (вызывается из index.ts после миграций). */
export function startOrderSyncLoop(): void {
  const ms = config.gsheetSyncMin * 60_000;
  setTimeout(() => void runOrderSync(), 20_000).unref?.();
  setInterval(() => void runOrderSync(), ms).unref?.();
  console.log(`[order-sync] цикл каждые ${config.gsheetSyncMin} мин (лист: ${config.gsheetId.slice(0, 8)}…)`);
}
