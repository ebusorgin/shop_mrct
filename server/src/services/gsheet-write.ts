/**
 * Обратная запись заказов из БД в прод-таблицу (Apps Script Web App, action='write_orders').
 *
 * Модель «двусторонний синк, БД приоритетнее»: строка, где БД разошлась с последним
 * сверенным с таблицей значением (sheet_qty), выталкивается в таблицу; после успеха
 * sheet_qty = актуальное базовое количество, pushed_at = now() — это и есть эхо-подавление
 * (обратный импорт увидит sheet == sheet_qty и не будет ни менять БД, ни толкать снова).
 *
 * Всё выталкивание зажато рубильником: config.sheetWriteEnabled && sheetWriteUrl &&
 * sheetHookToken, плюс позточечный allowlist (sheetWriteStores). По умолчанию выключено.
 */
import { pool } from '../db';
import { config } from '../config';
import { postToWebApp, readWebAppJson } from './webapp';
import { printedQty } from './order-match';

/** Один элементарный акт записи в ячейку/строку листа. */
interface WriteOp {
  tab: string;
  storeId: number;
  storeCode: string;
  name: string;
  plu: string | null;
  unit: string | null;
  /** печатное количество в единице листа; null — очистить ячейку (отменённый заказ) */
  value: number | null;
  /** базовое (г/мл/шт) целевое количество — пишется в sheet_qty после успеха; 0 при очистке */
  base: number;
}

interface WriteResult {
  ok: boolean;
  error?: string;
  applied?: { storeId: number; name: string; ok: boolean }[];
}

/** Настроен ли веб-апп запис + секрет (без учёта главного рубильника). */
export function writeBackConfigured(): boolean {
  return !!(config.sheetWriteUrl && config.sheetHookToken);
}
/** Активна ли обратная запись (рубильник GSHEET_WRITE_ENABLED + настроенный веб-апп). */
export function writeBackActive(): boolean {
  return config.sheetWriteEnabled && writeBackConfigured();
}

/** Точка в allowlist? Пустой список = все активные, иначе только перечисленные. */
function storeAllowed(storeId: number): boolean {
  return config.sheetWriteStores.length === 0 || config.sheetWriteStores.includes(storeId);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Вытолкнуть строки листа `tabId` (или только точек `onlyStores`), где БД разошлась
 * с таблицей. Возвращает число применённых/неудачных op. Ошибки сети не валят синк.
 */
export async function planWriteForTab(
  tabId: number,
  onlyStores?: number[]
): Promise<{ pushed: number; failed: number; skipped: boolean; error?: string }> {
  if (!writeBackActive()) return { pushed: 0, failed: 0, skipped: true };

  const { rows: tab } = await pool.query(
    `select sheet_name as "sheetName", extract_date::text as date from order_tabs where id = $1`,
    [tabId]
  );
  if (!tab.length || !tab[0].date) return { pushed: 0, failed: 0, skipped: true };
  const sheetName = String(tab[0].sheetName);
  const date = String(tab[0].date);

  // эффективный фильтр точек: allowlist, если задан; иначе — все (или только onlyStores)
  let stores: number[];
  if (onlyStores && onlyStores.length) stores = onlyStores.filter(storeAllowed);
  else stores = config.sheetWriteStores; // пусто = все точки

  if (onlyStores && onlyStores.length && !stores.length) {
    return { pushed: 0, failed: 0, skipped: true }; // запрошенные точки не в allowlist
  }

  const params: unknown[] = [date];
  let storeCond = '';
  if (stores.length) {
    params.push(stores);
    storeCond = `and o.store_id = any($${params.length}::int[])`;
  }

  const { rows } = await pool.query(
    `select o.store_id as "storeId", st.code as "storeCode", o.source_name as "sourceName",
            o.plu, o.unit_code as "unitCode", o.status,
            (case when o.status = 'cancelled' then 0 else o.quantity end)::float8 as target,
            u.code as "cardUnit", coalesce(tc.portion_qty::float8, 0) as "portionQty"
       from orders o
       join stores st on st.id = o.store_id
       left join tech_cards tc on tc.id = o.card_id
       left join units u on u.id = tc.portion_unit_id
      where o.date_tab = $1::date
        and (case when o.status = 'cancelled' then 0 else o.quantity end) is distinct from o.sheet_qty
        ${storeCond}
      order by o.store_id, o.source_name`,
    params
  );

  const ops: WriteOp[] = rows.map((r: Record<string, unknown>) => {
    const target = Number(r.target);
    const value = target <= 0 ? null : round3(printedQty({
      qty: target,
      unitCode: (r.unitCode as string) ?? null,
      cardUnit: (r.cardUnit as string) ?? null,
      portionQty: Number(r.portionQty) || 0,
    }));
    return {
      tab: sheetName,
      storeId: Number(r.storeId),
      storeCode: String(r.storeCode),
      name: String(r.sourceName),
      plu: (r.plu as string) ?? null,
      unit: (r.unitCode as string) ?? null,
      value,
      base: Math.max(0, target),
    };
  });

  if (!ops.length) return { pushed: 0, failed: 0, skipped: false };

  let res: WriteResult;
  try {
    const r = await postToWebApp(config.sheetWriteUrl, {
      action: 'write_orders',
      token: config.sheetHookToken,
      tab: sheetName,
      ops,
    });
    res = await readWebAppJson<WriteResult>(r);
  } catch (e) {
    console.error('[gsheet-write] веб-приложение недоступно:', (e as Error).message);
    return { pushed: 0, failed: ops.length, skipped: false, error: (e as Error).message };
  }

  if (!res.ok) {
    console.error('[gsheet-write] запись отклонена:', res.error);
    return { pushed: 0, failed: ops.length, skipped: false, error: res.error };
  }

  const applied = res.applied ?? [];
  let pushed = 0;
  const failed = applied.filter((a) => !a.ok).length;
  // базлайн проставляем только для применённых строк; неприменившиеся повторят в след. цикл
  for (const a of applied) {
    if (!a.ok) continue;
    const src = ops.find((o) => o.storeId === a.storeId && o.name === a.name);
    if (!src) continue;
    pushed += 1;
    await pool.query(
      `update orders set sheet_qty = $3, pushed_at = now()
        where date_tab = $1::date and store_id = $2
          and lower(btrim(source_name)) = lower(btrim($4))`,
      [date, a.storeId, src.base, a.name]
    );
  }
  if (failed) console.warn(`[gsheet-write] лист «${sheetName}»: ${failed} op не применились`);
  return { pushed, failed, skipped: false };
}

/**
 * Быстрый путь после мутации магазина: вытолкнуть текущий лист даты только для своей точки.
 * Если листа на дату ещё нет — ничего не делаем (обычный цикл синка подхватит).
 */
export async function pushManualForStore(storeId: number, date: string): Promise<{ pushed: number }> {
  if (!writeBackActive() || !storeAllowed(storeId)) return { pushed: 0 };
  const { rows } = await pool.query(
    `select id from order_tabs where extract_date = $1::date order by id desc limit 1`,
    [date]
  );
  if (!rows.length) return { pushed: 0 };
  const r = await planWriteForTab(Number(rows[0].id), [storeId]);
  return { pushed: r.pushed };
}
