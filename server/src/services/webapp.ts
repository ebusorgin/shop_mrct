/**
 * Единый вызов Apps Script Web App (привязан к прод-таблице).
 *
 * Веб-приложение Google отвечает 302 на script.googleusercontent.com/macros/echo, где
 * doPost УЖЕ выполнен на первом POST (тело/токен обработаны), а по location лежит
 * за кэшированный ответ. Поэтому второй шаг — обычный GET без тела: повторный POST
 * на googleusercontent Google отсекает страницей защиты от ботов (HTML вместо JSON).
 */
export async function postToWebApp(url: string, payload: unknown, timeoutMs = 300_000): Promise<Response> {
  const opts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  };
  let r = await fetch(url, opts);
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc) {
    // doPost уже отработал на первом POST — читаем закешированный ответ через GET
    r = await fetch(loc, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  }
  return r;
}

/** Прочитать JSON-ответ веб-приложения; если тело не JSON — положить его в error. */
export async function readWebAppJson<T = Record<string, unknown>>(r: Response): Promise<T> {
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { ok: false, error: text.slice(0, 300) || `HTTP ${r.status}` } as unknown as T;
  }
}
