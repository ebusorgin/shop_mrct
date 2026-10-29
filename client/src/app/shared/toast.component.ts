import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../core/toast.service';

/**
 * Всплывающая плашка справа сверху (например «в Google Таблице изменения»).
 * Показом и скрытием управляет ToastService: компонент только рисует текущее сообщение.
 */
@Component({
  selector: 'app-toast',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (toast.message(); as m) {
      <div class="toast" [class]="m.kind" role="status" aria-live="polite">{{ m.text }}</div>
    }
  `,
  styles: [
    `
    :host {
      position: fixed; top: 14px; right: 14px; z-index: 200;
      pointer-events: none; display: block;
    }
    .toast {
      max-width: min(420px, calc(100vw - 28px));
      padding: 10px 14px; border-radius: 10px;
      background: #10233f; color: #fff; font-size: 13px; line-height: 1.35;
      box-shadow: 0 10px 28px rgba(10, 18, 32, 0.28);
      animation: toast-in 0.16s ease-out;
    }
    .toast.ok { background: #12683a; }
    .toast.warn { background: #8a5a09; }
    .toast.err { background: #8c1d24; }
    @keyframes toast-in {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 640px) {
      :host { top: 8px; right: 8px; left: 8px; }
      .toast { max-width: none; }
    }
    `,
  ],
})
export class ToastComponent {
  toast = inject(ToastService);
}
