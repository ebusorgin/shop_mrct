/**
 * Интеграция с общедоступной Google Таблицей заказов (без API-ключей).
 *
 * Транспорт:
 *  - список вкладок — XLSX Export Endpoint (xl/workbook.xml), своим минимальным zip-парсером;
 *    ВАЖНО: sheetId в workbook.xml НЕ равен gid в URL, поэтому содержимое читаем по имени листа;
 *  - содержимое — gviz (JSONP). Первую строку листа gviz уносит в cols[].label,
 *    поэтому сетку восстанавливаем как [labels, ...rows].
 *
 * Макетов в истории три:
 *  A (древний):  № | Наименование | PLU | Ед-ца | Min | Mix 38102..38110
 *  B (2026-02):  № | Наименование | PLU | EK | VK | Ед-ца | Сумма | Min | 102..111
 *  C (актуальный):№ | Наименование | PLU | EK | VK | Ед-ца | Сумма | Min | 103..110 | 109+
 * Имена магазинов в строке-заголовке есть не везде (на части листов они пустые) — тогда
 * колонки снимаем позиционно, а «Сумма/Min» отделяем от магазинов контрольной суммой:
 * Сумма == сумма поFollowing-магазинам. Блок «общее количество» в хвосте — служебный, отбрасываем.
 */
import { createHash } from 'crypto';
import { inflateRawSync } from 'zlib';

export interface SheetTab {
  name: string;
  /** порядковый sheetId из workbook.xml — для diagnostiky, не gviz-gid */
  gid: string;
}

export type CellVal = string | number | null;

/** Товарная строка листа в «печатных» величинах источника. */
export interface SheetOrderRow {
  category: string;
  name: string;
  plu: string | null;
  unit: string; // 'кг' | 'шт' | 'порц' …
  min: number | null;
  ek: number | null;
  vk: number | null;
  /** сумма источника (контроль) — на случай, если部分 магазинов не подписаны */
  sum: number | null;
  /** store_id (103…110) -> заказанное количество в печатной единице */
  qty: Record<number, number>;
}

export interface ParsedSheet {
  rows: SheetOrderRow[];
  /** найденные подписи магазинных колонок */
  storeCols: { store: number; col: number; plus: boolean }[];
  /** как определили колонки: заголовок или позиционно */
  layout: 'header' | 'sumcheck' | 'positional' | 'none';
  /** md5 разобранного содержимого — кеш-ключ листа */
  hash: string;
}

const BASE = `https://docs.google.com/spreadsheets/d`;

/** Минимальный читатель zip (stored/deflate): {имя файла: содержимое}. */
function unzip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: не найден EOCD');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnLen + leLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    out[name] = method === 0 ? data : inflateRawSync(data);
    off = off + 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`google sheets: HTTP ${r.status} на ${url.slice(0, 90)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Список вкладок из xlsx-экспорта, в порядке листов. */
export async function listTabs(sheetId: string): Promise<SheetTab[]> {
  const buf = await fetchBuffer(`${BASE}/${sheetId}/export?format=xlsx`);
  const files = unzip(buf);
  const wb = files['xl/workbook.xml']?.toString('utf8');
  if (!wb) throw new Error('xlsx: нет xl/workbook.xml');
  const sheets: SheetTab[] = [];
  for (const tag of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /name="([^"]+)"/.exec(tag[0])?.[1];
    const gid = /sheetId="(\d+)"/.exec(tag[0])?.[1];
    if (name && gid) sheets.push({ name: decodeXml(name), gid });
  }
  if (!sheets.length) throw new Error('xlsx: вкладки не разобраны');
  return sheets;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Чтение вкладки по ТОЧНОМУ имени (gviz неизвестное имя молча подменяет первым листом —
 * имена берём из workbook.xml, они точные, включая хвостовые пробелы).
 */
export async function readSheet(sheetId: string, tab: SheetTab): Promise<CellVal[][]> {
  const url = `${BASE}/${sheetId}/gviz/tq?sheet=${encodeURIComponent(tab.name)}&tqx=out:json`;
  const text = (await fetchBuffer(url)).toString('utf8');
  const m = text.match(/setResponse\((\{.*\})\);?\s*$/s);
  if (!m) return [];
  const j = JSON.parse(m[1]) as {
    status?: string;
    table?: {
      cols?: { label?: string }[];
      rows?: { c?: ({ v?: string | number | null; f?: string } | null)[] }[];
    };
  };
  if (j.status !== 'ok' || !j.table?.rows) return [];
  const grid: CellVal[][] = [];
  const labels = (j.table.cols ?? []).map((c) => (c?.label ?? '').trim());
  if (labels.some((l) => l !== '')) grid.push(labels);
  for (const r of j.table.rows) {
    grid.push((r.c ?? []).map((c) => (c?.f !== undefined && c?.f !== null ? parsePrinted(c.f) : (c?.v ?? null)) as CellVal));
  }
  return grid.filter((r) => r.some((x) => x !== null && x !== ''));
}

/** gviz отдаёт форматированную строку («0,5») или число — число приводим к числу. */
function parsePrinted(f: string): CellVal {
  const t = f.trim();
  if (/^-?\d+([.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  return t;
}

/** Единицы, встречающиеся в листе (в т.ч. «порц» — порции техкарты). */
const UNIT_VALUES = new Set(['кг', 'г', 'л', 'мл', 'шт', 'des', 'порц', 'порция', 'порции']);

function num(v: CellVal): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v.trim())) return Number(v.trim().replace(',', '.'));
  return null;
}
function str(v: CellVal): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Магазинный токен из подписи колонки: «Mix 38103» -> 103, «Доставка 21.02.2026 105» -> 105,
 * «109+» -> 109 (дополнительная колонка того же магазина). Даты (23.10.2025) не трогаем.
 */
function storeToken(s: string): { store: number; plus: boolean } | null {
  for (const tok of s.replace(/\s+/g, ' ').trim().split(' ')) {
    const t = tok.replace(/\+$/, '');
    if (!t) continue;
    if (/^38\d{3}$/.test(t)) return { store: Number(t.slice(2)), plus: t.length !== tok.length };
    if (/^\d{3}$/.test(t)) {
      const id = Number(t);
      if (id >= 100 && id <= 199) return { store: id, plus: t.length !== tok.length };
    }
  }
  return null;
}

/** Все магазинные колонки строки-заголовка; строка не годится, если токенов < 5. */
function headerStores(r: CellVal[]): { store: number; col: number; plus: boolean }[] {
  const found: { store: number; col: number; plus: boolean }[] = [];
  r.forEach((c, i) => {
    if (typeof c !== 'string') return;
    const t = storeToken(c);
    if (t) found.push({ ...t, col: i });
  });
  return found.length >= 5 ? found : [];
}

interface ProductCols {
  nameCol: number;
  unitCol: number;
  pluCol: number;
  ekCol: number;
  vkCol: number;
  /** колонки «Min» и «Сумма», если удалось определить */
  minCol: number;
  sumCol: number;
  storeCols: number[];
}

function findProductCols(rows: CellVal[][]): ProductCols | null {
  for (const r of rows) {
    const unitCol = r.findIndex((c) => typeof c === 'string' && UNIT_VALUES.has(str(c).toLowerCase()));
    if (unitCol < 0) continue;
    const nameCol = r.findIndex(
      (c, i) =>
        i < unitCol && typeof c === 'string' && str(c).length > 2 && !/^\d+$/.test(str(c)) &&
        !/^Column \d+$/i.test(str(c)) && !/^(наименование|заказ|доставка|min|ед)/i.test(str(c))
    );
    if (nameCol < 0) continue;
    let pluCol = -1;
    const numsB: number[] = [];
    r.forEach((c, i) => {
      if (i >= unitCol || i === nameCol) return;
      if (c === null || c === undefined || c === '') return; // пустая ячейка
      if (num(c) === null) pluCol = i; // текст до юнита — PLU
      else numsB.push(i); // число: №, EK, VK
    });
    const ekCol = numsB.length >= 2 ? numsB[numsB.length - 2] : -1;
    const vkCol = numsB.length >= 2 ? numsB[numsB.length - 1] : -1;
    const after: number[] = [];
    for (let i = unitCol + 1; i < r.length; i++) if (num(r[i]) !== null) after.push(i);
    if (!after.length) continue;
    return { nameCol, unitCol, pluCol, ekCol, vkCol, minCol: after[0], sumCol: -1, storeCols: after.slice(1) };
  }
  return null;
}

/**
 * Разбор листа. store_id = последние 3 цифры «Mix 381NN»; нас интересуют 103..110 (см. stores).
 * Магазинные колонки, не входящие в wantStores (102, 111 и т.п.), отбрасываем, НО «Min»/«Сумма»
 * считаем от САМОЙ ЛЕВОЙ магазинной колонки (часто это 102), иначе сдвинемся на колонку заказа.
 */
export function parseSheet(rows: CellVal[][], wantStores: number[]): ParsedSheet {
  const grid = rows;
  // 1) подписи магазинов в любой строке-заголовке
  let storeCols: { store: number; col: number; plus: boolean }[] = [];
  for (const r of grid) {
    const h = headerStores(r);
    if (h.length > storeCols.length) storeCols = h;
  }
  const pc = findProductCols(grid);
  if (!pc) return { rows: [], storeCols: [], layout: 'none', hash: hashRows([]) };

  let layout: ParsedSheet['layout'] = 'header';
  if (!storeCols.length) {
    const cols = assignPositional(grid, pc, wantStores);
    if (cols.length) {
      layout = 'sumcheck';
      storeCols = cols.map((col, i) => ({ store: wantStores[i] ?? 103 + i, col, plus: false }));
    } else {
      layout = 'positional';
      storeCols = pc.storeCols.slice(0, wantStores.length).map((col, i) => ({ store: wantStores[i] ?? 103 + i, col, plus: false }));
    }
  }
  if (!storeCols.length) return { rows: [], storeCols: [], layout: 'none', hash: hashRows([]) };

  // 2) «Min» — колонка сразу лерее первой магазинной, «Сумма» — ещё левее (если числовые)
  const firstStoreCol = Math.min(...storeCols.map((s) => s.col));
  const minCol = firstStoreCol - 1 > pc.unitCol && grid.some((r) => num(r[firstStoreCol - 1]) !== null) ? firstStoreCol - 1 : -1;
  const sumCol = firstStoreCol - 2 > pc.unitCol && grid.some((r) => num(r[firstStoreCol - 2]) !== null) ? firstStoreCol - 2 : -1;

  // 3) карта «колонка -> магазин» только по интересующим нас магазинам
  const byCol = new Map<number, number>();
  for (const s of storeCols) {
    if (!wantStores.includes(s.store)) continue;
    if (!byCol.has(s.col)) byCol.set(s.col, s.store); // «109+» — та же колонка уже занята, не перетираем
  }

  const out: SheetOrderRow[] = [];
  let category = '';
  for (const r of grid) {
    if (r.some((c) => typeof c === 'string' && /общее количество/i.test(c))) break;
    if (headerStores(r).length) continue; // строка-заголовок магазинов
    const name = str(r[pc.nameCol]);
    const unit = str(r[pc.unitCol]).toLowerCase();
    if (!name) continue;
    if (!UNIT_VALUES.has(unit)) {
      if (/[:!]+$/.test(name)) category = name.replace(/[:!]+$/, '').trim().toLowerCase(); // строка раздела
      continue;
    }
    if (/^(наименование|заказ|доставка)/i.test(name)) continue;
    const qty: Record<number, number> = {};
    for (const [col, store] of byCol) {
      const n = num(r[col]);
      if (n === null || n <= 0) continue;
      qty[store] = (qty[store] ?? 0) + n; // плюс-колонка дотачивает тот же магазин
    }
    if (!Object.keys(qty).length) continue;
    out.push({
      category,
      name,
      plu: pc.pluCol >= 0 ? str(r[pc.pluCol]) || (num(r[pc.pluCol]) !== null ? String(num(r[pc.pluCol])) : null) : null,
      unit,
      min: minCol >= 0 ? num(r[minCol]) : null,
      ek: pc.ekCol >= 0 ? num(r[pc.ekCol]) : null,
      vk: pc.vkCol >= 0 ? num(r[pc.vkCol]) : null,
      sum: sumCol >= 0 ? num(r[sumCol]) : null,
      qty,
    });
  }
  return { rows: out, storeCols, layout, hash: hashRows(out) };
}

/**
 * Без подписей магазина: из числовых колонок после юнита (pc.minCol — первая, pc.storeCols — дальше)
 * ищем контрольную сумму: одна колонка («Сумма») равна сумме следующих K колонок (K = wantStores.length),
 * сразу за «Min». Возвращаем индексы K магазинных колонок или [] — тогда позиционный фолбэк.
 */
function assignPositional(grid: CellVal[][], pc: ProductCols, wantStores: number[]): number[] {
  const K = wantStores.length;
  const cand = [pc.minCol, ...pc.storeCols]; // колонки-кандидаты по порядку
  const rowsWithData = grid.filter(
    (r) => pc.storeCols.map((c) => num(r[c])).filter((v) => v !== null && v > 0).length >= 3
  );
  for (const r of rowsWithData.slice(0, 8)) {
    const vals = cand.map((c) => num(r[c]) ?? 0);
    for (let i = 0; i + 2 + K <= vals.length; i++) {
      const s = vals.slice(i + 2, i + 2 + K).reduce((a, b) => a + b, 0);
      if (vals[i] > 0 && Math.abs(vals[i] - s) < 0.01) return cand.slice(i + 2, i + 2 + K);
    }
  }
  return [];
}

function hashRows(rows: SheetOrderRow[]): string {
  return createHash('md5').update(JSON.stringify(rows), 'utf8').digest('hex');
}

/** Имя вкладки -> д/м листа («28.10», «21.2», «17.12  »); null для служебных («Лист4», «17+21»). */
export function tabToDate(name: string): { dd: number; mm: number } | null {
  const m = /^\s*(\d{1,2})[.,](\d{1,2})\s*$/.exec(name);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { dd, mm };
}

/**
 * Годы вкладок: листы идут хронологически, идём с конца; каждая левее идущая дата обязана
 * быть раньше предыдущей, иначе уносим год назад. Крайняя свежая — не позже сегодня+70
 * (листы заводятся на неделю-вперёд).
 * Клармпериод (WINDOW_DAYS) защищает от «каскада»: один перепутанный местами лист
 * (в таблице есть «21.03» между 04.03 и 07.03) иначе сдвинул бы на год все предыдущие.
 */
const WINDOW_DAYS = 420;

export function assignYears(names: string[], today: Date): Map<string, string> {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dated = names
    .map((n) => ({ name: n, dm: tabToDate(n) }))
    .filter((x): x is { name: string; dm: { dd: number; mm: number } } => !!x.dm);
  const res = new Map<string, string>();
  if (!dated.length) return res;

  const { dd, mm } = dated[dated.length - 1].dm;
  let year = today.getFullYear();
  let prev = new Date(year, mm - 1, dd);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 70);
  while (prev > horizon) prev = new Date(--year, mm - 1, dd);
  const windowStart = new Date(prev);
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  res.set(dated[dated.length - 1].name, iso(prev));

  for (let i = dated.length - 2; i >= 0; i--) {
    const { dd: d, mm: m } = dated[i].dm;
    let cand = new Date(prev.getFullYear(), m - 1, d);
    if (cand >= prev) {
      const back = new Date(cand.getFullYear() - 1, m - 1, d);
      // год назад — вне окна истории: значит лист просто стоит не на своём месте,
      // оставляем дату как есть (небольшая нестыковка лучше потери года)
      cand = back < windowStart ? cand : back;
    }
    prev = cand;
    res.set(dated[i].name, iso(cand));
  }
  return res;
}
