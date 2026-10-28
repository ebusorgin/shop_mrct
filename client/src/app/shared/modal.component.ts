import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * Простое модальное окно поверх затемняющего фона (scrim). Контент — по умолчанию,
 * кнопки подвала — в элемент с атрибутом [modalFooter]. Родитель показывает окно
 * через @if, поэтому компонент существует в DOM только когда он открыт.
 * Закрытие: клик по затемнению, крестик, Escape, либо closed.emit() из footer-кнопки.
 */
@Component({
  selector: 'app-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-scrim" (click)="closed.emit()"></div>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1" (keydown.escape)="closed.emit()">
      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button type="button" class="modal-x" (click)="closed.emit()" aria-label="Закрыть">✕</button>
      </div>
      <div class="modal-body"><ng-content></ng-content></div>
      <div class="modal-foot"><ng-content select="[modalFooter]"></ng-content></div>
    </div>
  `,
  styles: [
    `
    :host { position: fixed; inset: 0; z-index: 80; }
    .modal-scrim { position: fixed; inset: 0; background: rgba(10, 18, 32, 0.5); z-index: 80; }
    .modal {
      position: fixed; z-index: 81; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 48px);
      display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: 0 12px 40px rgba(10, 18, 32, 0.28); outline: none;
    }
    .modal-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px; border-bottom: 1px solid var(--border);
    }
    .modal-head h3 { margin: 0; font-size: 16px; }
    .modal-x {
      border: 0; background: transparent; font-size: 18px; line-height: 1; cursor: pointer;
      color: var(--muted); padding: 4px 8px; border-radius: 6px;
    }
    .modal-x:hover { background: #f2f5fa; color: var(--text); }
    .modal-body { padding: 16px; overflow: auto; }
    .modal-foot {
      display: flex; gap: 10px; justify-content: flex-end;
      padding: 12px 16px; border-top: 1px solid var(--border);
    }
    @media (max-width: 640px) {
      .modal-foot .btn { flex: 1 1 auto; justify-content: center; }
    }
    `,
  ],
})
export class ModalComponent {
  @Input() title = '';
  @Output() closed = new EventEmitter<void>();
}
