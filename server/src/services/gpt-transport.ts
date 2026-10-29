/**
 * Транспорт запросов к OpenAI.
 *
 * Из ряда стран api.openai.com отвечает 403 unsupported_country_region_territory,
 * поэтому в настройках есть галочка «через Tor»: тогда все запросы к GPT идут через
 * SOCKS5-прокси (по умолчанию 127.0.0.1:9050) или обычный HTTP-прокси.
 *
 * OpenAI SDK v6 ходит глобальным undici-fetch, которому нельзя передать node-агент,
 * поэтому в режиме прокси подменяем fetch целиком: свой http(s).request через
 * socks-proxy-agent. Тела запросов и ответов буферизуем — стриминга (stream: true)
 * в CRM нет, а vision-запросы и так уходят одним JSON-пакетом.
 */
import * as http from 'http';
import * as https from 'https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import OpenAI from 'openai';
import { config } from '../config';
import { ApiError } from '../http';
import { gptSettings } from './settings';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** socks5h://… — socks-proxy-agent, http(s)://… — https-proxy-agent (CONNECT-туннель). */
function makeAgent(proxyUrl: string): http.Agent {
  return /^socks/i.test(proxyUrl) ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

function bodyToBuffer(body: RequestInit['body']): Buffer | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  return null;
}

function headersToObject(h: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Ошибки прокси объясняем по-человечески: чаще всего просто не запущен Tor. */
function friendly(err: Error, label: string): string {
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (code === 'ECONNREFUSED') return `${label}: подключение отклонено — прокси (Tor) не запущен?`;
  if (code === 'ETIMEDOUT') return `${label}: таймаут — прокси не отвечает`;
  return `${label}: ${err.message}`;
}

/**
 * fetch-совместимая функция, которая ходит через прокси.
 * Поддерживает только то, что нужно OpenAI SDK: JSON-тело, заголовки, AbortSignal, редиректы.
 */
export function proxiedFetch(proxyUrl: string): typeof fetch {
  const agent = makeAgent(proxyUrl);
  const label = `прокси ${proxyUrl}`;

  const once = (url: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const request = (target.protocol === 'https:' ? https.request : http.request) as typeof https.request;
      const body = bodyToBuffer(init.body);
      const headers = headersToObject(init.headers);
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
        headers['content-length'] = String(body.length);
      }

      const req = request(
        target,
        {
          method: init.method ?? 'GET',
          headers,
          agent: agent as http.Agent,
          signal: init.signal ?? undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            const outHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) v.forEach((one) => outHeaders.append(k, one));
              else if (v !== undefined) outHeaders.set(k, String(v));
            }
            resolve(
              new Response(new Uint8Array(Buffer.concat(chunks)), {
                status: res.statusCode ?? 502,
                statusText: res.statusMessage ?? '',
                headers: outHeaders,
              })
            );
          });
          res.on('error', (e) => reject(new ApiError(502, friendly(e, label))));
        }
      );
      req.on('error', (e) => reject(new ApiError(502, friendly(e, label))));
      req.end(body ?? undefined);
    });

  return (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}): Promise<Response> => {
    const first = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let url = first;
    for (let hop = 0; hop < 4; hop++) {
      const res = await once(url, init);
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || !location) return res;
      url = new URL(location, url).toString();
    }
    throw new ApiError(502, `${label}: слишком много перенаправлений`);
  }) as typeof fetch;
}

/** Клиент OpenAI с учётом галочки «через Tor» из настроек. */
export async function createGptClient(): Promise<OpenAI> {
  if (!config.openaiKey) {
    throw new ApiError(501, 'OPENAI_API_KEY не задан в server/.env — импорт из файлов недоступен');
  }
  const s = await gptSettings();
  if (!s.viaProxy) return new OpenAI({ apiKey: config.openaiKey });
  // через Tor ответ может идти минутами — не обрываем запрос раньше 5 минут
  return new OpenAI({ apiKey: config.openaiKey, timeout: 300000, fetch: proxiedFetch(s.proxyUrl) });
}
