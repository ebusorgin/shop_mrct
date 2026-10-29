/**
 * Живой канал «сервер -> браузер» на Server-Sent Events.
 *
 * Браузер держит GET /api/events (EventSource переподключается сам), сервер пишет
 * в поток строки `event: <имя>\ndata: <json>`. Клиентов мало (рабочие станции CRM),
 * поэтому простого Set достаточно; раз в 25 с шлём комментарий-сердцебиение, чтобы
 * прокси и браузер не закрыли «молчащее» соединение.
 *
 * Почему SSE, а не WebSocket: WebSocket в браузере не умеет отправлять cookie, а весь
 * вход в CRM построен на httpOnly-cookie. SSE идёт обычным HTTP — авторизация работает
 * без переделки, и новых npm-зависимостей не нужно.
 */
import { Request, Response } from 'express';

interface SseClient {
  id: number;
  res: Response;
}

const clients = new Set<SseClient>();
let seq = 0;
const HEARTBEAT_MS = 25_000;

/** Подписать ответ на поток событий. Обработчик не завершает ответ — он живёт до закрытия. */
export function addSseClient(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx не должен копить поток в буфере
  res.flushHeaders();

  // долгие соединения: снимаем таймаут сокета и отключаем алгоритм Нейгла для мелких пакетов
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  res.write(': connected\n\n');

  const client: SseClient = { id: ++seq, res };
  clients.add(client);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
      clients.delete(client);
    }
  }, HEARTBEAT_MS);

  const drop = (): void => {
    clearInterval(ping);
    clients.delete(client);
  };
  req.on('close', drop);
  res.on('close', drop);
}

/** Разослать событие всем подключённым браузерам. Ошибка записи = клиент ушёл, убираем его. */
export function broadcast(event: string, data: unknown): void {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

/** Сколько браузеров сейчас слушают события (для диагностики в /api/orders/sync). */
export function sseClients(): number {
  return clients.size;
}
