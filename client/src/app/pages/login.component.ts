import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { httpErr } from '../core/format';

/** Страница входа: логин + пароль, сессия остаётся в httpOnly-cookie на 7 дней. */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <form class="card" (ngSubmit)="submit()">
        <div class="brand">🥗 MIX markt<small>CRM учёта продукции</small></div>
        <h1>Вход</h1>

        @if (err()) { <div class="err">{{ err() }}</div> }

        <label class="f">
          Логин
          <input name="login" autocomplete="username" [(ngModel)]="login" [disabled]="busy()" autofocus />
        </label>
        <label class="f">
          Пароль
          <input name="password" type="password" autocomplete="current-password" [(ngModel)]="password" [disabled]="busy()" />
        </label>

        <button type="submit" class="btn primary submit" [disabled]="busy()">
          {{ busy() ? 'Проверяем…' : 'Войти' }}
        </button>
        <div class="hint muted">Логин и пароль выдаёт администратор CRM</div>
      </form>
    </div>
  `,
  styles: [
    `
    :host { display: block; min-height: 100vh; background: #10233f; }
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card {
      width: min(380px, 100%); display: flex; flex-direction: column; gap: 12px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
      box-shadow: 0 18px 44px rgba(6, 14, 28, 0.45); padding: 26px 24px;
    }
    .brand { color: var(--muted); font-size: 13px; }
    .brand small { display: block; font-size: 11px; color: var(--muted); opacity: .8; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    .submit { justify-content: center; padding: 10px 14px; margin-top: 4px; }
    .hint { font-size: 12px; text-align: center; }
    @media (max-width: 420px) { .card { padding: 20px 16px; } }
    `,
  ],
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  login = '';
  password = '';
  busy = signal(false);
  err = signal('');

  submit(): void {
    if (this.busy()) return;
    const login = this.login.trim();
    if (!login || !this.password) {
      this.err.set('Введите логин и пароль');
      return;
    }
    this.busy.set(true);
    this.err.set('');
    this.auth.login$(login, this.password).subscribe({
      next: () => {
        this.busy.set(false);
        void this.router.navigateByUrl(this.nextUrl());
      },
      error: (e) => {
        this.busy.set(false);
        this.password = '';
        this.err.set(httpErr(e));
      },
    });
  }

  /** Куда вернуться после входа: только внутренний путь из параметра next. */
  private nextUrl(): string {
    const n = this.route.snapshot.queryParamMap.get('next') ?? '';
    return n.startsWith('/') && !n.startsWith('//') ? n : '/';
  }
}
