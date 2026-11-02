/**
 * Жизненный цикл листов доставки: CRM заводит следующий «обнулённый» лист в прод-таблице.
 *
 * После списания (или по кнопке из Настроек) просим Apps Script Web App
 * (action='new_delivery_tab') скопировать самый свежий датированный лист на новую дату
 * доставки и обнулить все количества точек. Результат регистрируем в order_tabs,
 * чтобы pushManualForStore находил лист для выталкивания заказов ещё до первого синка.
 *
 * Всё зажато тем же рубильником, что и обратная запись (GSHEET_WRITE_ENABLED + URL + токен):
 * без него таблица остаётся только читаемой, а создание листа — noop.
 */
import { pool } from '../db';
import { config } from '../config';
import { postToWebApp, readWebAppJson } from './webapp';
import { writeBackActive } from './gsheet-write';

export interface NewTabResult {
  ok: boolean;
  /** рубильник выключен — к Google не обращались */
  skipped?: boolean;
  sheetName?: string;
  /** вкладка реально создана этим вызовом (false — уже существовала) */
  created?: boolean;
  note?: string;
  error?: string;
}

/** 'YYYY-MM-DD' -> имя вкладки 'dd.MM'; null, если это не дата. */
export function tabNameForDate(dateIso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso || '').trim());
  if (!m) return null;
  return `${m[3]}.${m[2]}`;
}

/** Зарегистрировать/освежить лист в order_tabs (status остаётся 'open', hash пустой — синк прочитает). */
async function registerTab(sheetName: string, dateIso: string): Promise<void> {
  await pool.query(
    `insert into order_tabs (sheet_name, extract_date)
     values ($1, $2::date)
     on conflict (sheet_name) do update set extract_date = excluded.extract_date, last_error = null`,
    [sheetName, dateIso]
  );
}

/**
 * Создать лист доставки на dateIso (dd.MM-имя) и зарегистрировать его в order_tabs.
 * Идемпотентно: вкладка уже есть в таблице — успех без пересоздания. Бросает не всегда,
 * сетевые ошибки возвращает в error — фоновый прогон списания от них не падает.
 */
export async function ensureDeliveryTab(dateIso: string): Promise<NewTabResult> {
  if (!writeBackActive()) return { ok: false, skipped: true, error: 'обратная запись в таблицу выключена' };
  const name = tabNameForDate(dateIso);
  if (!name) return { ok: false, error: `не распознана дата доставки: ${dateIso}` };

  let res: { ok: boolean; created?: boolean; note?: string; error?: string };
  try {
    const r = await postToWebApp(config.sheetWriteUrl, {
      action: 'new_delivery_tab',
      token: config.sheetHookToken,
      name,
      mode: 'clear',
      // год нужен скрипту, чтобы подставить корректную дату в строки «Заказ/Доставка …» над шапкой
      year: Number(dateIso.slice(0, 4)),
    });
    res = await readWebAppJson(r);
  } catch (e) {
    return { ok: false, sheetName: name, error: (e as Error).message };
  }
  if (!res.ok) return { ok: false, sheetName: name, error: res.error ?? 'таблица отказала' };

  if (res.created) {
    await registerTab(name, dateIso);
    return { ok: true, sheetName: name, created: true, note: res.note };
  }

  // вкладка с таким именем уже лежит в таблице: наш это лист на эту дату или прошлогодний одноименный?
  const { rows } = await pool.query(
    `select extract_date::text as d from order_tabs where sheet_name = $1`,
    [name]
  );
  if (!rows.length) {
    const sameName = await pool.query(
      `select extract_date::text as d from order_tabs where extract_date = $1::date`,
      [dateIso]
    );
    if (sameName.rows.length) {
      // на эту дату уже есть другой зарегистрированный лист — новый одноименный не нужен
      return { ok: true, sheetName: name, created: false, note: 'лист на эту дату уже зарегистрирован' };
    }
    return {
      ok: false,
      sheetName: name,
      error: `в таблице уже есть лист «${name}» (видимо, прошлого года) — заведите вручную с другим именем`,
    };
  }
  if (rows[0].d !== dateIso) {
    return {
      ok: false,
      sheetName: name,
      error: `лист «${name}» в CRM числится на дату ${rows[0].d} — имя занято другим листом`,
    };
  }
  return { ok: true, sheetName: name, created: false, note: res.note };
}
