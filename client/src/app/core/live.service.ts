import { Injectable, signal } from '@angular/core';

/**
 * Живой канал с сервером (SSE, GET /api/events).
 *
 * Сервер присылает `orders-changed` — заказ оформлен, изменён или отменён в CRM.
 * `ordersVersion` растёт на каждом событии: страницы по нему сами перечитывают данные.
 *
 * EventSource не умеет заголовки, но cookie уходит автоматически (withCredentials),
 * а переподключение при обрыве браузер делает сам — поэтому WebSocket тут не нужен.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private es: EventSource | null = null;
  private attempts = 0;

  /** Счётчик событий «заказ изменён в CRM» — триггер для перечитывания данных на страницах. */
  readonly ordersVersion = signal(0);
  readonly connected = signal(false);

  connect(): void {
    if (this.es || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events', { withCredentials: true });

    es.addEventListener('open', () => {
      this.attempts = 0;
      this.connected.set(true);
    });
    es.addEventListener('error', () => {
      this.connected.set(false);
      // EventSource переподключается сам; если сессия истекла или сервер лежит —
      // после нескольких попыток закрываем, чтобы не долбить сервер 401-ми
      this.attempts += 1;
      if (this.attempts > 5) this.disconnect();
    });
    es.addEventListener('orders-changed', () => this.ordersVersion.update((v) => v + 1));

    this.es = es;
  }

  disconnect(): void {
    this.es?.close();
    this.es = null;
    this.connected.set(false);
  }
}
