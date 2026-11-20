import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Request } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { readSession, type AuthUser } from './auth';

/**
 * Живой канал «что делает сервер» для офисных страниц.
 *
 * Клиент открывает один WebSocket (/api/ws/log) под своей сессией, а разбор накладной
 * шлёт в него этапы и «размышления» модели с тем же jobId, что и в POST-запросе.
 * Канал только для чтения серверных событий: команды от браузера не принимаются.
 */

export type LogKind = 'stage' | 'thinking' | 'tool' | 'result' | 'error';

interface LogEvent {
  type: 'log';
  jobId: string;
  ts: string;
  kind: LogKind;
  text: string;
}

/** Открытые сокеты по пользователям: чужой разбор в чужое окно не попадёт. */
const rooms = new Map<number, Set<WebSocket>>();
/** Живые сокеты для heartbeat: отвечает на ping — значит соединение держится. */
const alive = new WeakSet<WebSocket>();

/** Слишком длинные куски (размышления модели) режем, чтобы не раздувать канал. */
const MAX_TEXT = 8000;

/** Отправить строку лога во все открытые окна пользователя. */
export function logToUser(userId: number | undefined, jobId: unknown, kind: LogKind, text: string): void {
  if (!userId) return;
  const room = rooms.get(userId);
  if (!room?.size) return;
  const clean = String(text ?? '').trim();
  if (!clean) return;
  const ev: LogEvent = {
    type: 'log',
    jobId: typeof jobId === 'string' ? jobId.slice(0, 100) : '',
    ts: new Date().toISOString(),
    kind,
    text: clean.slice(0, MAX_TEXT),
  };
  const payload = JSON.stringify(ev);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Короткая обёртка для маршрута: log('stage', '...') без повторения userId/jobId. */
export function logSink(
  userId: number | undefined,
  jobId: unknown
): (kind: LogKind, text: string) => void {
  return (kind, text) => logToUser(userId, jobId, kind, text);
}

function register(ws: WebSocket, userId: number): void {
  let room = rooms.get(userId);
  if (!room) {
    room = new Set();
    rooms.set(userId, room);
  }
  room.add(ws);
  alive.add(ws);

  ws.on('pong', () => alive.add(ws));
  ws.on('error', () => undefined);
  ws.on('close', () => {
    room!.delete(ws);
    if (!room!.size) rooms.delete(userId);
  });

  ws.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString() }));
}

/** Подключить WebSocket-канал к HTTP-серверу. Вызывается один раз при старте. */
export function attachLogWs(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    // Чужие пути обрабатывает другой upgrade-обработчик (например, чат Qoder).
    if (pathname !== '/api/ws/log') return;
    // В WebSocket нельзя отдать обычный 401 JSON, поэтому отвечаем строкой HTTP и закрываем.
    const reject = (status: string): void => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    readSession(req as unknown as Request)
      .then((s: { user: AuthUser } | null) => {
        if (!s) {
          reject('401 Unauthorized');
          return;
        }
        // Логи разбора — офисная функция; магазинному сотруднику этот канал не нужен.
        if (s.user.storeId != null) {
          reject('403 Forbidden');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => register(ws, s.user.id));
      })
      .catch(() => socket.destroy());
  });

  // Браузеры за прокси иногда «засыпают» — пингуем и убираем мёртвые соединения.
  const timer = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room) {
        if (!alive.has(ws)) {
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }
  }, 30_000);
  timer.unref();

  wss.on('close', () => clearInterval(timer));
}
