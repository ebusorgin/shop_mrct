import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'ok' | 'warn' | 'err';

export interface ToastMsg {
  id: number;
  text: string;
  kind: ToastKind;
}

/**
 * Одна плашка-уведомление в правом верхнем углу. Живёт 2 секунды и убирается сама;
 * новое сообщение заменяет предыдущее (очередь не копим — это сигнал, а не журнал).
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly message = signal<ToastMsg | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  show(text: string, kind: ToastKind = 'info', ms = 2000): void {
    if (this.timer) clearTimeout(this.timer);
    const id = ++this.seq;
    this.message.set({ id, text, kind });
    this.timer = setTimeout(() => {
      if (this.message()?.id === id) this.message.set(null);
      this.timer = null;
    }, ms);
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.message.set(null);
  }
}
