/**
 * Настройки, которые админ меняет прямо в CRM, а не правкой server/.env.
 *
 * Сейчас это транспорт запросов к OpenAI: из ряда стран api.openai.com отвечает
 * 403 unsupported_country_region_territory, поэтому запросы можно завернуть
 * в SOCKS5-прокси (Tor на 127.0.0.1:9050) или в обычный HTTP-прокси.
 *
 * Значения лежат в app_settings (key -> jsonb) и кешируются в памяти на несколько
 * секунд: переключатель в интерфейсе действует сразу, без перезапуска сервиса.
 */
import * as net from 'net';
import { pool } from '../db';
import { ApiError } from '../http';
import type { Actor } from './audit';

export const GPT_KEY = 'gpt';

export interface GptSettings {
  /** Все запросы к OpenAI идут через прокси (по умолчанию — Tor). */
  viaProxy: boolean;
  /** socks5h://127.0.0.1:9050 — Tor; http://host:port — обычный прокси. */
  proxyUrl: string;
}

export const GPT_DEFAULTS: GptSettings = {
  viaProxy: false,
  proxyUrl: 'socks5h://127.0.0.1:9050',
};

/** Схемы, которые понимают socks-proxy-agent / https-proxy-agent. */
const PROXY_SCHEMES = ['socks5h:', 'socks5:', 'socks4a:', 'socks4:', 'http:', 'https:'];

/** Приводит адрес прокси к виду scheme://host:port; «127.0.0.1:9050» считаем SOCKS5. */
export function normalizeProxyUrl(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return GPT_DEFAULTS.proxyUrl;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `socks5h://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new ApiError(400, `Не разобрал адрес прокси «${s}». Пример: socks5h://127.0.0.1:9050`);
  }
  if (!PROXY_SCHEMES.includes(u.protocol)) {
    throw new ApiError(400, `Поддерживаются socks5h://, socks5://, socks4://, http:// и https://, а не «${u.protocol}//»`);
  }
  if (!u.hostname) throw new ApiError(400, 'В адресе прокси нет хоста');
  const port = u.port || (/^https?:$/.test(u.protocol) ? '8080' : '9050');
  return `${u.protocol}//${u.hostname}:${port}`;
}

/** Хост и порт прокси — для индикатора доступности на странице настроек. */
export function proxyTarget(proxyUrl: string): { scheme: string; host: string; port: number } {
  const u = new URL(proxyUrl);
  return {
    scheme: u.protocol.replace(':', ''),
    host: u.hostname,
    port: Number(u.port || (/^https?:$/.test(u.protocol) ? 8080 : 9050)),
  };
}

/** Проверка «порт прокси вообще слушается» — быстрая, для статуса в интерфейсе. */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Настройки читаются на каждый запрос к GPT, поэтому держим их в памяти
// недолго: правка в интерфейсе подхватывается сразу, а чужие изменения — за 5 с.
let cache: { value: GptSettings; at: number } | null = null;
const CACHE_MS = 5000;

export async function gptSettings(): Promise<GptSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const { rows } = await pool.query('select value from app_settings where key = $1', [GPT_KEY]);
  const raw = (rows[0]?.value ?? {}) as Partial<GptSettings>;
  const value: GptSettings = {
    viaProxy: Boolean(raw.viaProxy),
    proxyUrl: typeof raw.proxyUrl === 'string' && raw.proxyUrl ? raw.proxyUrl : GPT_DEFAULTS.proxyUrl,
  };
  cache = { value, at: Date.now() };
  return value;
}

export async function saveGptSettings(next: GptSettings, actor: Actor): Promise<GptSettings> {
  await pool.query(
    `insert into app_settings (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key) do update
        set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [GPT_KEY, JSON.stringify(next), actor?.login ?? 'system']
  );
  cache = { value: next, at: Date.now() };
  return next;
}

// ============ РАСПИСАНИЕ АВТОСПИСАНИЯ ЗАКАЗОВ ============

export const WRITEOFF_KEY = 'writeoff_schedule';

export interface WriteoffSettings {
  /** Включён ли автоматический прогон списания по расписанию. */
  enabled: boolean;
  /** Дни недели по конвенции JS getDay: 0=Вс … 6=Сб. */
  weekdays: number[];
  /** Слоты времени в формате 'HH:MM' (по часовому поясу tz). */
  times: string[];
  /** IANA-таймзона; по умолчанию Европа/Москва. */
  tz: string;
}

export const WRITEOFF_DEFAULTS: WriteoffSettings = {
  enabled: false,
  weekdays: [],
  times: [],
  tz: 'Europe/Moscow',
};

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Приводит 'H:MM'/'HH:MM' к канону 'HH:MM'; невалидное — ApiError(400). */
function normalizeTime(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const m = TIME_RE.exec(s);
  if (!m) throw new ApiError(400, `Время «${s}» не разобрано — нужно HH:MM (например 09:30)`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Валидная IANA-таймзона либо дефолт (Intl бросает RangeError на мусор). */
function normalizeTz(raw: unknown): string {
  const s = String(raw ?? '').trim() || WRITEOFF_DEFAULTS.tz;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: s });
  } catch {
    throw new ApiError(400, `Неизвестный часовой пояс «${s}»`);
  }
  return s;
}

/**
 * Чистит и валидирует присланное расписание: enabled→bool, weekdays→уникальные 0..6,
 * times→каноничные 'HH:MM' без дублей по сортировке, tz→IANA. Возвращает полный объект
 * (добивает дефолтами отсутствующие поля), готовый к сохранению и сравнению в журнале.
 */
export function normalizeWriteoffSchedule(raw: Partial<WriteoffSettings> | null | undefined): WriteoffSettings {
  const src = raw ?? {};
  const weekdays = Array.isArray(src.weekdays)
    ? [...new Set(src.weekdays.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
    : [];
  const times = Array.isArray(src.times)
    ? [...new Set(src.times.map(normalizeTime))].sort()
    : [];
  return {
    enabled: src.enabled === true || (src.enabled as unknown) === 'true',
    weekdays,
    times,
    tz: normalizeTz(src.tz),
  };
}

// Как и настройки GPT: читаем недолго из кеша, чтобы переключатель в интерфейсе
// действовал сразу, а чужие изменения подхватывались за несколько секунд.
let woffCache: { value: WriteoffSettings; at: number } | null = null;

export async function writeoffSettings(): Promise<WriteoffSettings> {
  if (woffCache && Date.now() - woffCache.at < CACHE_MS) return woffCache.value;
  const { rows } = await pool.query('select value from app_settings where key = $1', [WRITEOFF_KEY]);
  const raw = (rows[0]?.value ?? {}) as Partial<WriteoffSettings>;
  const value: WriteoffSettings = {
    enabled: Boolean(raw.enabled),
    weekdays: Array.isArray(raw.weekdays)
      ? [...new Set(raw.weekdays.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
      : [],
    times: Array.isArray(raw.times)
      ? [...new Set(raw.times.map((t) => String(t)).filter((t) => TIME_RE.test(String(t))))].sort()
      : [],
    tz: typeof raw.tz === 'string' && raw.tz ? raw.tz : WRITEOFF_DEFAULTS.tz,
  };
  woffCache = { value, at: Date.now() };
  return value;
}

export async function saveWriteoffSettings(next: WriteoffSettings, actor: Actor): Promise<WriteoffSettings> {
  await pool.query(
    `insert into app_settings (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key) do update
        set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [WRITEOFF_KEY, JSON.stringify(next), actor?.login ?? 'system']
  );
  woffCache = { value: next, at: Date.now() };
  return next;
}

// ============ РАСПИСАНИЕ ДОСТАВОК (какие дни недели — даты доставки) ============

export const DELIVERY_KEY = 'delivery_schedule';

export interface DeliverySettings {
  /** Дни недели-доставки по конвенции JS getDay: 0=Вс … 6=Сб. */
  weekdays: number[];
  /** IANA-таймзона; по умолчанию Европа/Москва. */
  tz: string;
}

export const DELIVERY_DEFAULTS: DeliverySettings = {
  weekdays: [],
  tz: 'Europe/Moscow',
};

/** Уникальные целые дни недели 0..6 по порядку. */
function normalizeWeekdays(raw: unknown): number[] {
  return Array.isArray(raw)
    ? [...new Set(raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
    : [];
}

/** Чистит и валидирует расписание доставок (кривая таймзона — ApiError(400)). */
export function normalizeDeliverySchedule(raw: Partial<DeliverySettings> | null | undefined): DeliverySettings {
  const src = raw ?? {};
  return { weekdays: normalizeWeekdays(src.weekdays), tz: normalizeTz(src.tz) };
}

let deliveryCache: { value: DeliverySettings; at: number } | null = null;

export async function deliverySettings(): Promise<DeliverySettings> {
  if (deliveryCache && Date.now() - deliveryCache.at < CACHE_MS) return deliveryCache.value;
  const { rows } = await pool.query('select value from app_settings where key = $1', [DELIVERY_KEY]);
  const raw = (rows[0]?.value ?? {}) as Partial<DeliverySettings>;
  const value: DeliverySettings = {
    weekdays: normalizeWeekdays(raw.weekdays),
    tz: typeof raw.tz === 'string' && raw.tz ? raw.tz : DELIVERY_DEFAULTS.tz,
  };
  deliveryCache = { value, at: Date.now() };
  return value;
}

export async function saveDeliverySettings(next: DeliverySettings, actor: Actor): Promise<DeliverySettings> {
  await pool.query(
    `insert into app_settings (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key) do update
        set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [DELIVERY_KEY, JSON.stringify(next), actor?.login ?? 'system']
  );
  deliveryCache = { value: next, at: Date.now() };
  return next;
}
