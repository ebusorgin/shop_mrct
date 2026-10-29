/**
 * События Google Таблицы: «в таблице что-то поменяли».
 *
 * Два независимых источника, оба сводятся к одному действию:
 *  1) вебхук Apps Script (routes/hooks.ts) — настоящий push, задержка ~1 с;
 *  2) вотчер (watchTick) — страховка: раз в GSHEET_WATCH_SEC секунд читаем «горячий»
 *     лист и сравниваем хэш разобранного содержимого с order_tabs.content_hash.
 *     Нужен, когда туннель до сервера отвалился или триггер в таблице не установлен.
 *
 * Что делаем на событие: пишем строку в sheet_events, сразу рассылаем браузерам
 * `sheet-changed` (чтобы плашка появилась мгновенно), затем с задержкой-склейкой
 * запускаем внеплановый синк и рассылаем `sheet-synced` с итогом.
 */
import { config } from '../config';
import { pool } from '../db';
import { broadcast, sseClients } from './live';
import { readSheet, parseSheet } from './gsheet';
import { runOrderSync } from './order-sync';

export type SheetEventSource = 'apps_script' | 'watch' | 'manual';

export interface SheetEvent {
  source: SheetEventSource;
  tab?: string | null;
  changeType?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown>;
}

/** Склейка лавины правок: одно и то же событие не должно запускать синк на каждый символ. */
const SYNC_DEBOUNCE_MS = 800;

let syncTimer: NodeJS.Timeout | null = null;
let pendingTab: string | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let watchBusy = false;
let lastCheckAt: string | null = null;
let lastChangeAt: string | null = null;

export function watchState(): { lastCheckAt: string | null; lastChangeAt: string | null; intervalSec: number; clients: number } {
  return { lastCheckAt, lastChangeAt, intervalSec: config.sheetWatchSec, clients: sseClients() };
}

/** Журнал событий + мгновенная рассылка + отложенный синк. */
export async function notifySheetEvent(ev: SheetEvent): Promise<void> {
  try {
    await pool.query(
      `insert into sheet_events (source, sheet_name, change_type, actor, payload)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [ev.source, ev.tab ?? null, ev.changeType ?? null, ev.actor ?? null, JSON.stringify(ev.payload ?? {})]
    );
  } catch (e) {
    // журнал — вспомогательный: сбой записи не должен ломать уведомление
    console.error('[sheet-events] не удалось записать событие:', (e as Error).message);
  }

  if (ev.source === 'watch') lastChangeAt = new Date().toISOString();
  broadcast('sheet-changed', {
    source: ev.source,
    tab: ev.tab ?? null,
    changeType: ev.changeType ?? null,
    actor: ev.actor ?? null,
    at: new Date().toISOString(),
  });

  scheduleSync(ev.tab ?? null);
}

/** Внеплановый синк: правки в таблице приходят пачками, поэтому сначала ждём паузу. */
export function scheduleSync(tab: string | null): void {
  if (tab) pendingTab = tab;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const target = pendingTab;
    pendingTab = null;
    runOrderSync({ tab: target ?? undefined })
      .then((s) => {
        broadcast('sheet-synced', {
          tab: target,
          created: s.ordersCreated,
          changed: s.ordersChanged,
          removed: s.ordersRemoved,
          failed: s.tabsFailed,
          at: new Date().toISOString(),
        });
      })
      .catch((e: unknown) => {
        console.error('[sheet-events] синк после уведомления упал:', (e as Error).message);
        broadcast('sheet-synced', { tab: target, error: 'Синхронизация не удалась', at: new Date().toISOString() });
      });
  }, SYNC_DEBOUNCE_MS);
}

/**
 * «Горячий» лист = лист с самой поздней датой: именно в него пишут сейчас.
 * Новые вкладки вотчер не ищет — это делает обычный цикл синхронизации.
 */
async function hotTab(): Promise<{ name: string; hash: string } | null> {
  const { rows } = await pool.query(
    `select sheet_name as name, coalesce(content_hash, '') as hash
       from order_tabs
      order by extract_date desc nulls last
      limit 1`
  );
  return rows[0] ? { name: String(rows[0].name), hash: String(rows[0].hash) } : null;
}

async function watchTick(): Promise<void> {
  if (watchBusy) return;
  watchBusy = true;
  try {
    const hot = await hotTab();
    if (!hot) return;
    const { rows: storeRows } = await pool.query('select id from stores where active order by id');
    const wantStores = storeRows.map((r: { id: number }) => r.id as number);
    if (!wantStores.length) return;

    const cells = await readSheet(config.gsheetId, { name: hot.name, gid: '' });
    const parsed = parseSheet(cells, wantStores);
    lastCheckAt = new Date().toISOString();
    if (!parsed.rows.length || parsed.hash === hot.hash) return; // лист не менялся

    await notifySheetEvent({
      source: 'watch',
      tab: hot.name,
      changeType: 'hash_changed',
      payload: { rows: parsed.rows.length, prevHash: hot.hash, hash: parsed.hash },
    });
  } catch (e) {
    // сеть/Google недоступны — молча ждём следующий тик, ошибки видит обычный цикл синка
    console.error('[sheet-watch]', (e as Error).message);
  } finally {
    watchBusy = false;
  }
}

/** Старт вотчера. GSHEET_WATCH_SEC=0 отключает его (тогда работает только вебхук). */
export function startSheetWatch(): void {
  const sec = config.sheetWatchSec;
  if (!Number.isFinite(sec) || sec <= 0) {
    console.log('[sheet-watch] выключен (GSHEET_WATCH_SEC=0)');
    return;
  }
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(() => void watchTick(), sec * 1000);
  console.log(`[sheet-watch] проверка «горячего» листа каждые ${sec} с`);
}
