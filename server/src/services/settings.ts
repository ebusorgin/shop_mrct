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

// ============ РАСПИСАНИЕ ДОСТАВОК И ЗАКРЫТИЯ ЗАКАЗОВ ============

export const DELIVERY_KEY = 'delivery_schedule';

export interface DeliverySettings {
  /** Включено ли автоматическое закрытие заказов и списание со склада. */
  enabled: boolean;
  /** Список дат доставок в формате YYYY-MM-DD. */
  dates: string[];
  /** Время закрытия и списания на дату доставки, например '18:00' (устанавливается 1 раз). */
  time: string;
  /** IANA-таймзона; по умолчанию Европа/Москва. */
  tz: string;
}

export const DELIVERY_DEFAULTS: DeliverySettings = {
  enabled: false,
  dates: [],
  time: '18:00',
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
  const s = String(raw ?? '').trim() || DELIVERY_DEFAULTS.tz;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: s });
  } catch {
    throw new ApiError(400, `Неизвестный часовой пояс «${s}»`);
  }
  return s;
}

/** Уникальные отсортированные валидные даты YYYY-MM-DD. */
function normalizeDates(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [
        ...new Set(
          raw.filter((d): d is string => {
            if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
            const dt = new Date(d);
            return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
          })
        ),
      ].sort()
    : [];
}

/** Чистит и валидирует расписание доставок и закрытия (кривая таймзона — ApiError(400)). */
export function normalizeDeliverySchedule(raw: Partial<DeliverySettings> | null | undefined): DeliverySettings {
  const src = raw ?? {};
  let timeStr = src.time;
  if (!timeStr && Array.isArray((src as any).times) && (src as any).times.length) {
    timeStr = (src as any).times[0];
  }
  const time = timeStr !== undefined ? normalizeTime(timeStr) : DELIVERY_DEFAULTS.time;
  return {
    enabled: src.enabled === true || (src.enabled as unknown) === 'true',
    dates: normalizeDates(src.dates),
    time,
    tz: normalizeTz(src.tz),
  };
}

let deliveryCache: { value: DeliverySettings; at: number } | null = null;

export async function deliverySettings(): Promise<DeliverySettings> {
  if (deliveryCache && Date.now() - deliveryCache.at < CACHE_MS) return deliveryCache.value;
  const { rows } = await pool.query('select value from app_settings where key = $1', [DELIVERY_KEY]);
  const raw = (rows[0]?.value ?? {}) as Partial<DeliverySettings> & { times?: string[] };
  let timeStr = raw.time;
  if (!timeStr && Array.isArray(raw.times) && raw.times.length) {
    timeStr = raw.times[0];
  }
  const value: DeliverySettings = {
    enabled: Boolean(raw.enabled),
    dates: normalizeDates(raw.dates),
    time: typeof timeStr === 'string' && TIME_RE.test(timeStr) ? timeStr : (timeStr ? normalizeTime(timeStr) : DELIVERY_DEFAULTS.time),
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

// Алиасы для обратной совместимости
export const WRITEOFF_KEY = DELIVERY_KEY;
export type WriteoffSettings = DeliverySettings;
export const WRITEOFF_DEFAULTS = DELIVERY_DEFAULTS;
export const normalizeWriteoffSchedule = normalizeDeliverySchedule;
export const writeoffSettings = deliverySettings;
export const saveWriteoffSettings = saveDeliverySettings;

// ============ РЕКВИЗИТЫ ПРОИЗВОДСТВА (ДОБАВЛЯЧ) ============

export const PRODUCTION_KEY = 'production_details';

export interface ProductionDetails {
  name: string;
  address: string;
  pib: string;
  mbr: string;
  accountNo: string;
}

export const PRODUCTION_DEFAULTS: ProductionDetails = {
  name: 'MIX Markt Production DOO',
  address: 'Industrijska bb, Beograd',
  pib: '109876543',
  mbr: '21543210',
  accountNo: '160-0000000000000-00',
};

let productionCache: { value: ProductionDetails; at: number } | null = null;

export async function productionSettings(): Promise<ProductionDetails> {
  if (productionCache && Date.now() - productionCache.at < CACHE_MS) return productionCache.value;
  const { rows } = await pool.query('select value from app_settings where key = $1', [PRODUCTION_KEY]);
  const raw = (rows[0]?.value ?? {}) as Partial<ProductionDetails>;
  const value: ProductionDetails = {
    name: String(raw.name || PRODUCTION_DEFAULTS.name).trim(),
    address: String(raw.address || PRODUCTION_DEFAULTS.address).trim(),
    pib: String(raw.pib || PRODUCTION_DEFAULTS.pib).trim(),
    mbr: String(raw.mbr || PRODUCTION_DEFAULTS.mbr).trim(),
    accountNo: String(raw.accountNo || PRODUCTION_DEFAULTS.accountNo).trim(),
  };
  productionCache = { value, at: Date.now() };
  return value;
}

export async function saveProductionSettings(next: ProductionDetails, actor: Actor): Promise<ProductionDetails> {
  const cleaned: ProductionDetails = {
    name: String(next.name || PRODUCTION_DEFAULTS.name).trim(),
    address: String(next.address || PRODUCTION_DEFAULTS.address).trim(),
    pib: String(next.pib || PRODUCTION_DEFAULTS.pib).trim(),
    mbr: String(next.mbr || PRODUCTION_DEFAULTS.mbr).trim(),
    accountNo: String(next.accountNo || PRODUCTION_DEFAULTS.accountNo).trim(),
  };
  await pool.query(
    `insert into app_settings (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key) do update
        set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [PRODUCTION_KEY, JSON.stringify(cleaned), actor?.login ?? 'system']
  );
  productionCache = { value: cleaned, at: Date.now() };
  return cleaned;
}
