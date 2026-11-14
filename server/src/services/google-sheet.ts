/**
 * Google-таблица «Микс Маркт Гастро»: чтение сервисным аккаунтом (credentials.json)
 * и хранение скачанных листов в отдельной базе.
 *
 * Таблица скачивается только на чтение, все листы сразу — их 100+, поэтому запросы
 * идут пакетами. Значения берём отформатированными, как они выглядят в Google.
 */
import * as fs from 'fs';
import * as crypto from 'crypto';
import { config } from '../config';
import { ApiError } from '../http';
import { pool } from '../db';
import { sheetsPool, sheetsTx } from '../db-sheets';
import { packagingLabel, packagingWeight } from './packagings';

export const GOOGLE_SHEET_ID = '1YL2CweT4Lxjs3lPkRmfJjdY9VQ95yh7fbRFD-EhXXtE';
export const GOOGLE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/edit`;

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** В пакете не больше стольких диапазонов — держим URL в разумной длине. */
const BATCH = 40;

export interface GoogleSheetTab {
  name: string;
  /** Строки как в таблице: значения уже отформатированы Google, длина = ширине листа. */
  rows: string[][];
  width: number;
  /** Фасовка (product_packagings.id) для каждой строки; null — позиция не сопоставлена. */
  links: (number | null)[];
  /** Название продукции (техкарта + фасовка) для каждой строки; null — позиция не сопоставлена. */
  names: (string | null)[];
  /** Индексы строк-позиций, которым не нашлось фасовки. */
  misses: number[];
}

export interface GoogleSheet {
  title: string;
  spreadsheetId: string;
  url: string;
  loadedAt: string;
  tabs: GoogleSheetTab[];
  /** Уникальные названия позиций, которых нет в «Продукции». */
  unmatched: string[];
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error_description?: string;
}

interface SheetMeta {
  properties: { title: string; index: number };
}

interface ValuesResponse {
  valueRanges?: { values?: string[][] }[];
  error?: { message?: string };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function serviceAccount(): ServiceAccount {
  if (!fs.existsSync(config.googleCredentials)) {
    throw new ApiError(500, 'Не найден ключ сервисного аккаунта Google (credentials.json)');
  }
  return JSON.parse(fs.readFileSync(config.googleCredentials, 'utf8')) as ServiceAccount;
}

/** JWT сервисного аккаунта и обмен на access token; токен живёт час. */
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${
    base64url(JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  const assertion = `${unsigned}.${signature.toString('base64url')}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await response.json() as TokenResponse;
  if (!response.ok || !data.access_token) {
    throw new ApiError(502, `Google не выдал доступ: ${data.error_description ?? response.status}`);
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

async function googleGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API}/${GOOGLE_SHEET_ID}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new ApiError(502, `Google Sheets ${response.status}: ${data.error?.message ?? 'ошибка запроса'}`);
  }
  return data;
}

function tabValues(values: string[][] | undefined): GoogleSheetTab['rows'] {
  return (values ?? []).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))));
}

/** Все листы таблицы: порядок как в документе, пустые листы тоже попадают в список. */
export async function fetchGoogleSheet(): Promise<GoogleSheet> {
  const token = await accessToken();
  const meta = await googleGet<{ properties?: { title?: string }; sheets?: SheetMeta[] }>(
    '?fields=properties.title,sheets.properties(title,index)',
    token
  );
  const sheets = [...(meta.sheets ?? [])].sort((a, b) => a.properties.index - b.properties.index);

  const ranges = sheets.map((sheet) => sheet.properties.title);
  const values: (string[][] | undefined)[] = [];
  for (let start = 0; start < ranges.length; start += BATCH) {
    const params = new URLSearchParams();
    params.set('majorDimension', 'ROWS');
    params.set('valueRenderOption', 'FORMATTED_VALUE');
    for (const title of ranges.slice(start, start + BATCH)) params.append('ranges', title);
    const batch = await googleGet<ValuesResponse>(`/values:batchGet?${params.toString()}`, token);
    for (const range of batch.valueRanges ?? []) values.push(range.values);
  }

  const tabs: GoogleSheetTab[] = sheets.map((sheet, index) => {
    const rows = tabValues(values[index]);
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    return {
      name: sheet.properties.title,
      rows: rows.map((row) => (row.length === width ? row : [...row, ...Array(width - row.length).fill('')])),
      width,
      links: [],
      names: [],
      misses: [],
    };
  });

  return {
    title: (meta.properties?.title ?? 'Google-таблица').trim(),
    spreadsheetId: GOOGLE_SHEET_ID,
    url: GOOGLE_SHEET_URL,
    loadedAt: new Date().toISOString(),
    tabs,
    unmatched: [],
  };
}

/**
 * Название позиции для сопоставления: регистр, ё/е, пометки вида «!!ЗАКАЗ КРАТНО 2 КГ!!»,
 * «в порции», дефисы («по-корейски» и «по корейски»), пробел в «3 кг» и хвостовая
 * пунктуация не должны мешать найти техкарту.
 */
function normName(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/!![^!]*!!/g, ' ')
    .replace(/(^|\s)в\s+порции(?=\s|$)/g, ' ')
    .replace(/(\p{L})-(\p{L})/gu, '$1 $2')
    .replace(/(\d)\s+(кг|гр|г|мл|л|kg|g)(?=\s|$)/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[;:,.!?+\u2013\u2014-]+$/g, '')
    .trim();
}

/** Второй ключ — без граммовки и скобок: «Борщ 350г» и «Плов 330 г» находят базовое блюдо. */
function baseName(value: string): string {
  return normName(value)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*(?:кг|гр|г|мл|л|kg|g)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[;:,.!?+\u2013\u2014-]+$/g, '')
    .trim();
}

const UNITS = new Set(['порц', 'кг', 'шт', 'л', 'г', 'мл']);

/**
 * Строка — позиция заказа, а не заголовок/итог: в A порядковый номер, в B название,
 * и есть единица измерения либо PLU. Блоки-сводки без них пропускаются.
 * В части листов хвостовой блок идёт без нумерации — там единица измерения в F, а в D цена.
 */
function itemName(row: string[]): string {
  const ordinal = (row[0] ?? '').trim();
  const name = (row[1] ?? '').trim();
  if (!name) return '';
  if (/^общее количество$/i.test(name)) return '';
  if (/^\d+$/.test(ordinal)) {
    const plu = (row[2] ?? '').trim();
    const unit = (row[3] ?? '').trim();
    if (!unit && !/^[mм]\d+$/i.test(plu)) return '';
    return name;
  }
  if (ordinal) return '';
  const measure = (row[5] ?? '').trim().toLowerCase();
  const price = (row[3] ?? '').trim();
  const hasUnit = UNITS.has(measure);
  if (hasUnit && /^\d+([.,]\d+)?$/.test(price)) return name;
  const qty = (row[2] ?? '').trim();
  // Сводный блок внизу листа: количество в C, единицы измерения нет — цена может стоять в D или F.
  if (!hasUnit && /^\d+([.,]\d+)?$/.test(qty)) return name;
  // Позиция без количества: PLU в C — блок «Заморозка» и замороженные полуфабрикаты.
  if (!hasUnit && /^[mм]\d+$/i.test(qty)) return name;
  return '';
}

/** Строка «общее количество» открывает сводный блок: всё ниже — итоги по магазинам, не позиции заказа. */
export function summaryStart(rows: string[][]): number {
  const index = rows.findIndex((row) => /^общее количество$/i.test((row[1] ?? '').trim()));
  return index < 0 ? rows.length : index;
}

interface PackagingRef {
  id: number;
  cardId: number;
  cardName: string;
  packagingName: string;
  /** Вес/объём упаковки в базовой единице выхода техкарты (г/мл/шт). */
  qtyBase: number;
  /** Единица выхода техкарты. */
  unitCode: string;
  dimension: string | null;
  isDefault: boolean;
}

/** Название в списке: «техкарта · фасовка»; если техкарта уже содержит размер — только она. */
const saleName = (p: PackagingRef): string =>
  packagingLabel(p.cardName, packagingWeight(p.qtyBase, p.unitCode));

/** Размер порции из названия позиции — для выбора фасовки того же веса. */
function sizeOf(value: string): { value: number; dimension: string } | null {
  const match = normName(value).match(/(\d+(?:[.,]\d+)?)\s*(кг|гр|г|мл|л|kg|g|шт)/);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  const unit = match[2];
  if (unit === 'кг' || unit === 'kg') return { value: amount * 1000, dimension: 'mass' };
  if (unit === 'л') return { value: amount * 1000, dimension: 'volume' };
  if (unit === 'г' || unit === 'гр' || unit === 'g') return { value: amount, dimension: 'mass' };
  if (unit === 'мл') return { value: amount, dimension: 'volume' };
  return { value: amount, dimension: 'count' };
}

interface Matchers {
  exactSale: Map<string, number>;
  /** Точное название техкарты без фасовки — берём фасовку по умолчанию. */
  exactCard: Map<string, number>;
  byBase: Map<string, PackagingRef[]>;
  nameById: Map<number, string>;
  defaultByCard: Map<number, number>;
}

/** Индексы для сопоставления: полное название (техкарта + фасовка), базовое и фасовки по id. */
async function loadMatchers(): Promise<Matchers> {
  const { rows } = await pool.query<Omit<PackagingRef, 'qtyBase'> & { qtyBase: number }>(
    `select pk.id, pk.card_id as "cardId", tc.name as "cardName", pk.name as "packagingName",
            pk.qty_base::float8 as "qtyBase", pk.is_default as "isDefault",
            u.code as "unitCode", u.dimension
       from product_packagings pk
       join tech_cards tc on tc.id = pk.card_id
       join units u on u.id = tc.portion_unit_id`
  );
  const exactSale = new Map<string, number>();
  const exactCardPick = new Map<string, { id: number; rank: number }>();
  const byBase = new Map<string, PackagingRef[]>();
  const nameById = new Map<number, string>();
  const defaultByCard = new Map<number, number>();
  for (const row of rows) {
    const ref: PackagingRef = { ...row, qtyBase: Number(row.qtyBase) };
    exactSale.set(normName(`${ref.cardName} ${ref.packagingName}`), ref.id);
    // техкарта уже содержит размер («Грибы 250г» + «250 г») — строки идут без повтора
    if (normName(ref.cardName).includes(normName(ref.packagingName))) {
      exactSale.set(normName(ref.cardName), ref.id);
    }
    // название техкарты без фасовки: предпочитаем фасовку того же веса, затем фасовку по умолчанию
    const cardKey = normName(ref.cardName);
    const cardSize = sizeOf(ref.cardName);
    const sameSize = !!cardSize && ref.dimension === cardSize.dimension && Math.abs(ref.qtyBase - cardSize.value) < 1e-6;
    const rank = sameSize ? 2 : ref.isDefault ? 1 : 0;
    const picked = exactCardPick.get(cardKey);
    if (!picked || rank > picked.rank) exactCardPick.set(cardKey, { id: ref.id, rank });
    nameById.set(ref.id, saleName(ref));
    if (ref.isDefault) defaultByCard.set(ref.cardId, ref.id);
    const base = baseName(ref.cardName);
    byBase.set(base, [...(byBase.get(base) ?? []), ref]);
  }
  const exactCard = new Map([...exactCardPick].map(([key, pick]) => [key, pick.id]));
  return { exactSale, exactCard, byBase, nameById, defaultByCard };
}

/**
 * Автоматическое сопоставление строк с фасовками — без ручных связей.
 * Сначала полное имя (техкарта + фасовка), затем базовое (без граммовки);
 * при нескольких фасовках выбираем ту же граммовку, иначе фасовку по умолчанию.
 */
function autoLinks(rows: string[][], matchers: Matchers): (number | null)[] {
  const start = summaryStart(rows);
  return rows.map((row, index) => {
    if (index >= start) return null;
    const name = itemName(row);
    if (!name) return null;
    const exact = matchers.exactSale.get(normName(name));
    if (exact) return exact;
    const card = matchers.exactCard.get(normName(name));
    if (card) return card;
    const group = matchers.byBase.get(baseName(name)) ?? [];
    if (!group.length) return null;
    if (group.length === 1) return group[0].id;
    const size = sizeOf(name);
    if (size) {
      const fits = group.filter((p) => p.dimension === size.dimension && Math.abs(p.qtyBase - size.value) < 1e-6);
      if (fits.length === 1) return fits[0].id;
      const defaults = fits.filter((p) => p.isDefault);
      return defaults.length === 1 ? defaults[0].id : null;
    }
    // Размер не указан: если все фасовки одной техкарты — берём фасовку по умолчанию.
    if (new Set(group.map((p) => p.cardId)).size === 1) {
      const defaults = group.filter((p) => p.isDefault);
      return defaults.length === 1 ? defaults[0].id : null;
    }
    return null;
  });
}

/** Ручные связи поверх автоподбора + производные поля и общий список непознанного. */
async function applyOverridesToSheet(sheet: GoogleSheet, matchers: Matchers): Promise<void> {
  const overrides = await manualOverrides(matchers.defaultByCard);
  const unmatched = new Set<string>();
  for (const tab of sheet.tabs) {
    applyOverrides(tab, overrides.get(tab.name), matchers.nameById);
    fillTabDerived(tab, matchers.nameById);
    for (const index of tab.misses) unmatched.add(itemName(tab.rows[index] ?? []));
  }
  sheet.unmatched = [...unmatched].sort((a, b) => a.localeCompare(b, 'ru'));
}

/** id фасовки или null — «позицию не сопоставлять»; отсутствие ключа — решение не принимали. */
type ManualOverrides = Map<string, Map<string, number | null>>;

/**
 * Ручные решения: лист -> (нормализованное название строки -> id фасовки | null).
 * Старые связи хранили card_id — переводим их в фасовку по умолчанию этой техкарты.
 */
async function manualOverrides(defaultByCard: Map<number, number>): Promise<ManualOverrides> {
  const { rows } = await sheetsPool.query<{
    tab_name: string; row_name: string; card_id: number | null; packaging_id: number | null;
  }>(
    'select tab_name, row_name, card_id, packaging_id from google_sheet_manual_links where spreadsheet_id = $1',
    [GOOGLE_SHEET_ID]
  );
  const byTab: ManualOverrides = new Map();
  for (const row of rows) {
    const map = byTab.get(row.tab_name) ?? new Map<string, number | null>();
    const target = row.packaging_id ?? (row.card_id === null ? null : defaultByCard.get(row.card_id) ?? null);
    map.set(row.row_name, target);
    byTab.set(row.tab_name, map);
  }
  return byTab;
}

/**
 * Ручное решение перекрывает автоподбор: выбранная фасовка или явное «не сопоставлять».
 * Удалённую фасовку игнорируем — строка остаётся без id.
 */
function applyOverrides(
  tab: GoogleSheetTab,
  overrides: Map<string, number | null> | undefined,
  nameById: Map<number, string>
): void {
  if (!overrides) return;
  const start = summaryStart(tab.rows);
  tab.rows.forEach((row, index) => {
    if (index >= start) return;
    const name = itemName(row);
    if (!name) return;
    const packagingId = overrides.get(normName(name));
    if (packagingId === undefined) return;
    tab.links[index] = packagingId != null && nameById.has(packagingId) ? packagingId : null;
  });
}

/** Производные поля: название продукции по ссылке и индексы позиций без фасовки. */
function fillTabDerived(tab: GoogleSheetTab, nameById: Map<number, string>): void {
  tab.names = tab.links.map((id) => (id === null ? null : nameById.get(id) ?? null));
  const start = summaryStart(tab.rows);
  tab.misses = tab.links.reduce<number[]>((misses, id, index) => {
    if (index < start && id === null && itemName(tab.rows[index] ?? [])) misses.push(index);
    return misses;
  }, []);
}

/** Что уже лежит в отдельной базе; null — таблицу ещё не скачивали. */
export async function savedGoogleSheet(): Promise<GoogleSheet | null> {
  const { rows: meta } = await sheetsPool.query<{
    title: string; url: string; synced_at: Date; unmatched: string[]; links_version: number;
  }>(
    'select title, url, synced_at, unmatched, links_version from google_sheets where spreadsheet_id = $1',
    [GOOGLE_SHEET_ID]
  );
  if (!meta.length) return null;

  const { rows: tabs } = await sheetsPool.query<{
    name: string; width: number; rows: string[][]; links: (number | null)[];
  }>(
    'select name, width, rows, links from google_sheet_tabs where spreadsheet_id = $1 order by position',
    [GOOGLE_SHEET_ID]
  );
  const matchers = await loadMatchers();
  // Сохранённые до фасовок связи — это id техкарт: показываем фасовку по умолчанию.
  // После ближайшей синхронизации links перезаписываются id фасовок.
  const legacy = Number(meta[0].links_version) < 1;
  const result: GoogleSheet = {
    title: meta[0].title,
    spreadsheetId: GOOGLE_SHEET_ID,
    url: meta[0].url,
    loadedAt: meta[0].synced_at.toISOString(),
    tabs: tabs.map((tab) => ({
      name: tab.name,
      width: tab.width,
      rows: tab.rows,
      links: legacy
        ? tab.links.map((id) => (id == null ? null : matchers.defaultByCard.get(id) ?? null))
        : tab.links,
      names: [],
      misses: [],
    })),
    unmatched: [],
  };
  await applyOverridesToSheet(result, matchers);
  return result;
}

/**
 * Ручное решение по строке листа: выбрать фасовку или оставить без неё (packagingId = null).
 * Ключ — нормализованное название позиции: переживает повторную синхронизацию таблицы.
 */
export async function setSheetRowLink(
  tabName: string,
  rowIndex: number,
  packagingId: number | null
): Promise<{ id: number; name: string; rowName: string } | null> {
  const { rows: tabs } = await sheetsPool.query<{ rows: string[][] }>(
    'select rows from google_sheet_tabs where spreadsheet_id = $1 and name = $2',
    [GOOGLE_SHEET_ID, tabName]
  );
  if (!tabs.length) throw new ApiError(404, 'Лист не найден — синхронизируйте таблицу заново');
  if (rowIndex >= summaryStart(tabs[0].rows)) {
    throw new ApiError(400, 'Сводный блок «общее количество» — сопоставление не требуется');
  }
  const row = tabs[0].rows[rowIndex];
  const rowName = row ? itemName(row) : '';
  if (!rowName) throw new ApiError(400, 'В этой строке нет названия позиции');
  const key = normName(rowName);

  if (packagingId === null) {
    await sheetsPool.query(
      `insert into google_sheet_manual_links (spreadsheet_id, tab_name, row_name, card_id, packaging_id)
       values ($1, $2, $3, null, null)
       on conflict (spreadsheet_id, tab_name, row_name)
         do update set card_id = null, packaging_id = null, updated_at = now()`,
      [GOOGLE_SHEET_ID, tabName, key]
    );
    return null;
  }

  const { rows: packagings } = await pool.query<{ cardName: string; qtyBase: number; unitCode: string }>(
    `select tc.name as "cardName", pk.qty_base::float8 as "qtyBase", u.code as "unitCode"
       from product_packagings pk
       join tech_cards tc on tc.id = pk.card_id
       join units u on u.id = tc.portion_unit_id
      where pk.id = $1`,
    [packagingId]
  );
  if (!packagings.length) throw new ApiError(400, 'Фасовка не найдена');
  await sheetsPool.query(
    `insert into google_sheet_manual_links (spreadsheet_id, tab_name, row_name, card_id, packaging_id)
     values ($1, $2, $3, null, $4)
     on conflict (spreadsheet_id, tab_name, row_name)
       do update set card_id = null, packaging_id = excluded.packaging_id, updated_at = now()`,
    [GOOGLE_SHEET_ID, tabName, key, packagingId]
  );
  const { cardName, qtyBase, unitCode } = packagings[0];
  return { id: packagingId, name: packagingLabel(cardName, packagingWeight(qtyBase, unitCode)), rowName };
}

/**
 * «Синхронизировать»: скачать таблицу заново, сопоставить позиции и заменить сохранённые листы.
 * В базе храним только автоподбор — ручные связи применяются поверх при каждом чтении.
 */
export async function syncGoogleSheet(): Promise<GoogleSheet> {
  const sheet = await fetchGoogleSheet();
  const matchers = await loadMatchers();
  for (const tab of sheet.tabs) tab.links = autoLinks(tab.rows, matchers);
  await applyOverridesToSheet(sheet, matchers);
  await sheetsTx(async (client) => {
    await client.query(
      `insert into google_sheets (spreadsheet_id, title, url, synced_at, unmatched, links_version)
       values ($1, $2, $3, $4, $5, 1)
       on conflict (spreadsheet_id) do update
         set title = excluded.title, url = excluded.url, synced_at = excluded.synced_at,
             unmatched = excluded.unmatched, links_version = 1`,
      [sheet.spreadsheetId, sheet.title, sheet.url, sheet.loadedAt, JSON.stringify(sheet.unmatched)]
    );
    await client.query('delete from google_sheet_tabs where spreadsheet_id = $1', [sheet.spreadsheetId]);
    for (const [position, tab] of sheet.tabs.entries()) {
      await client.query(
        `insert into google_sheet_tabs (spreadsheet_id, position, name, width, rows, links)
         values ($1, $2, $3, $4, $5, $6)`,
        [sheet.spreadsheetId, position, tab.name, tab.width, JSON.stringify(tab.rows),
          JSON.stringify(autoLinks(tab.rows, matchers))]
      );
    }
  });
  return sheet;
}
