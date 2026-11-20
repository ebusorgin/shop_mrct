import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Request } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { readSession, type AuthUser } from './auth';
import { qoderAgent, type QoderJobSnapshot } from './qoder-agent';

/**
 * Живой канал чата с Qoder (/api/ws/qoder, только администратор).
 *
 * Клиент подписывается на jobId и дальше получает снимки задачи при каждом изменении:
 * мысли, текст, инструменты, подтверждения и финальный ответ. После обрыва браузер
 * переподключается и повторяет subscribe — снимок сразу возвращает всё пропущенное,
 * поэтому опрос по HTTP больше не нужен. Сама задача живёт на сервере независимо
 * от соединения: закрытый сокет не останавливает работу CLI.
 */

interface ClientMessage {
  type?: unknown;
  jobId?: unknown;
}

/** Ограничение очереди: если браузер не успевает читать, кадр пропускаем — следующий догонит состояние. */
const MAX_BUFFERED = 2_000_000;

const alive = new WeakSet<WebSocket>();

export function attachQoderWs(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    // Чужие пути обрабатывает другой upgrade-обработчик — здесь не трогаем.
    if (pathname !== '/api/ws/qoder') return;

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
        if (!s.user.isAdmin) {
          reject('403 Forbidden');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => register(ws, s.user.id));
      })
      .catch(() => socket.destroy());
  });

  function register(ws: WebSocket, userId: number): void {
    let unsubscribe: (() => void) | null = null;
    alive.add(ws);

    const send = (payload: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        /* сокет закрылся во время отправки */
      }
    };

    const drop = (): void => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    };

    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => undefined);
    ws.on('close', drop);
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send({ type: 'error', message: 'Некорректный JSON' });
        return;
      }
      if (msg.type === 'unsubscribe') {
        drop();
        send({ type: 'unsubscribed' });
        return;
      }
      if (msg.type !== 'subscribe') {
        send({ type: 'error', message: 'Ожидается subscribe с jobId' });
        return;
      }
      const jobId = typeof msg.jobId === 'string' ? msg.jobId : '';
      if (!jobId) {
        send({ type: 'error', message: 'Пустой jobId' });
        return;
      }
      drop();
      unsubscribe = qoderAgent.subscribe(jobId, userId, (snapshot: QoderJobSnapshot) =>
        send({ type: 'job', job: snapshot })
      );
      // Задача уже истекла (или чужая) — клиент обновит историю диалога по REST.
      if (!unsubscribe) send({ type: 'gone', jobId });
    });

    send({ type: 'hello', ts: new Date().toISOString() });
  }

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
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
  }, 30_000);
  timer.unref();

  wss.on('close', () => clearInterval(timer));
}
