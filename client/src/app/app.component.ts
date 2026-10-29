import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { LiveService } from './core/live.service';
import { PasswordFormComponent } from './shared/password-form.component';
import { ToastComponent } from './shared/toast.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, PasswordFormComponent, ToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (auth.user(); as u) {
      <div class="shell">
        <header class="topbar">
          <button type="button" class="burger" aria-label="Меню" (click)="menu.set(true)">☰</button>
          <span class="tb-logo">🥗 MIX markt</span>
        </header>
        @if (menu()) { <div class="scrim" (click)="menu.set(false)"></div> }
        <nav class="sidebar" [class.open]="menu()">
          <div class="logo">🥗 MIX markt<small>CRM учёта продукции</small></div>
          <button type="button" class="side-close" aria-label="Закрыть меню" (click)="menu.set(false)">✕</button>
          @if (auth.isStoreUser()) {
            <!-- магазинный сотрудник видит только свою точку -->
            <a routerLink="/store" routerLinkActive="active" (click)="menu.set(false)">🏪 <span>Мой магазин</span></a>
          } @else {
            @for (r of nav; track r.path) {
              @if (!r.admin || auth.isAdmin()) {
                <a [routerLink]="r.path" routerLinkActive="active" (click)="menu.set(false)">{{ r.icon }} <span>{{ r.label }}</span></a>
              }
            }
          }
          <div class="side-foot">
            <div class="side-user">{{ u.fullName || u.login }}{{ u.storeName ? ' · ' + u.storeName : (u.isAdmin ? ' · админ' : '') }}</div>
            <div class="side-actions">
              <button type="button" class="side-btn" (click)="pwdOpen.set(true)">Пароль</button>
              <button type="button" class="side-btn" (click)="logout()">Выйти</button>
            </div>
          </div>
        </nav>
        <main class="main">
          <router-outlet />
        </main>
      </div>

      @if (pwdOpen()) {
        <app-password-form (closed)="pwdOpen.set(false)" />
      }
    } @else {
      <router-outlet />
    }

    <!-- плашка «в таблице изменения» (справа сверху, 2 сек) -->
    <app-toast />
  `,
})
export class AppComponent {
  auth = inject(AuthService);
  private router = inject(Router);
  private live = inject(LiveService);

  constructor() {
    // живой канал (SSE) нужен только с активной сессией: на /login он бесполезен
    effect(() => {
      if (this.auth.user()) this.live.connect();
      else this.live.disconnect();
    });
  }

  menu = signal(false);
  pwdOpen = signal(false);
  nav = [
    { path: '', icon: '📊', label: 'Панель', admin: false },
    { path: 'waybills', icon: '📥', label: 'Накладные (входящие)', admin: false },
    { path: 'stock', icon: '🏬', label: 'Склад', admin: false },
    { path: 'semis', icon: '🔪', label: 'Полуфабрикаты', admin: false },
    { path: 'cards', icon: '📐', label: 'Техкарты', admin: false },
    { path: 'batches', icon: '🚚', label: 'Расход продукции', admin: false },
    { path: 'points', icon: '🏪', label: 'Точки продаж', admin: false },
    { path: 'orders', icon: '🧾', label: 'Заказы магазинов', admin: false },
    { path: 'users', icon: '👤', label: 'Пользователи', admin: true },
    { path: 'audit', icon: '📜', label: 'Журнал действий', admin: false },
  ];

  logout(): void {
    this.auth.logout$().subscribe(() => {
      this.menu.set(false);
      void this.router.navigateByUrl('/login');
    });
  }
}
