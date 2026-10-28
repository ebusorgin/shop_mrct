import { ChangeDetectionStrategy, Component, EventEmitter, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../core/auth.service';
import { httpErr } from '../core/format';
import { ModalComponent } from './modal.component';

/** Смена собственного пароля. После смены сервер гасит остальные сессии этого пользователя. */
@Component({
  selector: 'app-password-form',
  standalone: true,
  imports: [FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal title="Смена пароля" (closed)="closed.emit()">
      @if (err()) { <div class="err">{{ err() }}</div> }
      <div class="col">
        <label class="f">
          Текущий пароль
          <input type="password" autocomplete="current-password" [(ngModel)]="current" [disabled]="busy()" />
        </label>
        <label class="f">
          Новый пароль
          <input type="password" autocomplete="new-password" [(ngModel)]="next" [disabled]="busy()" />
        </label>
        <label class="f">
          Повторите новый пароль
          <input type="password" autocomplete="new-password" [(ngModel)]="again" [disabled]="busy()" />
        </label>
        <div class="muted small">Не короче 6 символов. Остальные устройства, где вы вошли, выйдут из системы.</div>
      </div>
      <div modalFooter>
        <button type="button" class="btn" (click)="closed.emit()" [disabled]="busy()">Отмена</button>
        <button type="button" class="btn primary" (click)="save()" [disabled]="busy()">
          {{ busy() ? 'Сохраняем…' : 'Сменить пароль' }}
        </button>
      </div>
    </app-modal>
  `,
  styles: [
    `
    .col { display: flex; flex-direction: column; gap: 10px; }
    .small { font-size: 12px; }
    `,
  ],
})
export class PasswordFormComponent {
  private auth = inject(AuthService);

  @Output() closed = new EventEmitter<void>();

  current = '';
  next = '';
  again = '';
  busy = signal(false);
  err = signal('');

  save(): void {
    if (this.busy()) return;
    if (!this.current) {
      this.err.set('Введите текущий пароль');
      return;
    }
    if (this.next.length < 6) {
      this.err.set('Новый пароль должен быть не короче 6 символов');
      return;
    }
    if (this.next !== this.again) {
      this.err.set('Пароли не совпадают');
      return;
    }
    this.busy.set(true);
    this.err.set('');
    this.auth.changePassword$(this.current, this.next).subscribe({
      next: () => {
        this.busy.set(false);
        this.closed.emit();
      },
      error: (e) => {
        this.busy.set(false);
        this.err.set(httpErr(e));
      },
    });
  }
}
