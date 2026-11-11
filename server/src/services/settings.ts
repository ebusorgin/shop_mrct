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
