import { Injectable, inject, signal } from '@angular/core';
import { ToastService } from './toast.service';

interface SheetChanged {
  source: string;
  tab: string | null;
  changeType: string | null;
  actor: string | null;
  at: string;
}

interface SheetSynced {
  tab: string | null;
  created?: number;
  changed?: number;
  removed?: number;
  failed?: number;
  error?: string;
  at: string;
}

/**
 * Живой канал с сервером (SSE, GET /api/events).
 *
 * Сервер присылает два события:
 *  - `sheet-changed` — в Google Таблице что-то поменяли (вебхук Apps Script или вотчер);
 *  - `sheet-synced`  — внеплановый прогон завершён, в payload итог (+создано ~изменено −удалено).
 *
 * На первое сразу показываем плашку (2 секунды), на второе — плашку с итогом.
 * `sheetVersion` растёт на каждом событии: страницы по нему сами перечитывают данные.
 *
 * EventSource не умеет заголовки, но cookie уходит автоматически (withCredentials),
 * а переподключение при обрыве браузер делает сам — поэтому WebSocket тут не нужен.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private toast = inject(ToastService);

  private es: EventSource | null = null;
  private attempts = 0;

  /** Счётчик событий «таблица изменилась» — триггер для перечитывания данных на страницах. */
  readonly sheetVersion = signal(0);
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
    es.addEventListener('sheet-changed', (e) => this.onChanged(e as MessageEvent));
    es.addEventListener('sheet-synced', (e) => this.onSynced(e as MessageEvent));

    this.es = es;
  }

  disconnect(): void {
    this.es?.close();
    this.es = null;
    this.connected.set(false);
  }

  private onChanged(e: MessageEvent): void {
    const d = this.parse<SheetChanged>(e);
    if (!d) return;
    // плашку показываем сразу, не дожидаясь синхронизации
    this.toast.show(`В Google Таблице изменения${d.tab ? ' · лист ' + d.tab : ''} — обновляем…`, 'info');
  }

  private onSynced(e: MessageEvent): void {
    const d = this.parse<SheetSynced>(e);
    if (!d) return;
    this.sheetVersion.update((v) => v + 1);
    if (d.error) {
      this.toast.show('Синхронизация таблицы не удалась', 'err');
      return;
    }
    const sum = (d.created ?? 0) + (d.changed ?? 0) + (d.removed ?? 0);
    const text = sum
      ? `Таблица синхронизирована: +${d.created ?? 0} ~${d.changed ?? 0} −${d.removed ?? 0}`
      : 'Таблица синхронизирована: без изменений';
    this.toast.show(text, sum ? 'ok' : 'info');
  }

  private parse<T>(e: MessageEvent): T | null {
    try {
      return JSON.parse(String(e.data)) as T;
    } catch {
      return null;
    }
  }
}
