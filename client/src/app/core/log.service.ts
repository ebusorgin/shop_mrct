import { Injectable, signal } from '@angular/core';

/** Виды строк живого лога, которые присылает сервер. */
export type LogKind = 'stage' | 'thinking' | 'tool' | 'result' | 'error';

export interface ServerLogLine {
  time: string;
  kind: LogKind;
  text: string;
}

/**
 * Живой лог сервера по WebSocket (/api/ws/log).
 *
 * Одна вкладка CRM держит одно соединение; строки фильтруются по jobId текущего
 * разбора, чтобы поздние события другого запроса не подмешивались в открытую форму.
 * Соединение переподключается само: после перезапуска API или обрыва сети.
 */
@Injectable({ providedIn: 'root' })
export class LogService {
  readonly lines = signal<ServerLogLine[]>([]);
  readonly connected = signal(false);

  private readonly jobId = signal('');
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;

  /** Подключиться заранее (страница открыта) — к моменту разбора канал уже готов. */
  connect(): void {
    this.open();
  }

  /** Новый разбор: чистим окно и слушаем только события этого jobId. */
  watch(jobId: string): void {
    this.jobId.set(jobId);
    this.lines.set([]);
    this.open();
  }

  clear(): void {
    this.lines.set([]);
  }

  private open(): void {
    if (typeof window === 'undefined') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/ws/log`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected.set(true);
      this.attempts = 0;
    };
    ws.onclose = () => {
      this.connected.set(false);
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || !this.jobId()) return;
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(this.attempts++, 4));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg['type'] === 'hello') {
      this.connected.set(true);
      return;
    }
    if (msg['type'] !== 'log') return;
    const job = typeof msg['jobId'] === 'string' ? msg['jobId'] : '';
    if (!job || job !== this.jobId()) return;

    const kindRaw = String(msg['kind'] ?? 'stage');
    const kind: LogKind = ['stage', 'thinking', 'tool', 'result', 'error'].includes(kindRaw)
      ? (kindRaw as LogKind)
      : 'stage';
    const text = String(msg['text'] ?? '').trim();
    if (!text) return;

    const ts = new Date(String(msg['ts'] ?? ''));
    const time = Number.isNaN(ts.getTime())
      ? ''
      : ts.toLocaleTimeString('ru-RU', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.lines.update((arr) => {
      const next = arr.length >= 400 ? arr.slice(-399) : arr.slice();
      next.push({ time, kind, text });
      return next;
    });
  }
}
