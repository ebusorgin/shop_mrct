import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from './core/auth.service';
import { LiveService } from './core/live.service';
import { PasswordFormComponent } from './shared/password-form.component';
import { ToastComponent } from './shared/toast.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, PasswordFormComponent, ToastComponent],
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
            <a href="#" class="nav-link" [class.active]="isActive('/store', undefined)" (click)="go($event, '/store')">🏪 <span>Мой магазин</span></a>
          } @else {
            @for (g of navGroups; track g.title) {
              @if (g.title) { <div class="side-group">{{ g.title }}</div> }
              @for (r of g.items; track r.label) {
                @if (!r.admin || auth.isAdmin()) {
                  <a href="#" class="nav-link" [class.active]="isActive(r.path, r.qp)"
                     (click)="go($event, r.path, r.qp)">{{ r.icon }} <span>{{ r.label }}</span></a>
                }
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
  private destroyRef = inject(DestroyRef);

  constructor() {
    // живой канал (SSE) нужен только с активной сессией: на /login он бесполезен
    effect(() => {
      if (this.auth.user()) this.live.connect();
      else this.live.disconnect();
    });
    // подсветка пункта меню: у «Остатков» и «сроков годности» один путь, различаются ?tab=,
    // поэтому активный пункт считаем сами из текущего URL
    this.router.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        if (e instanceof NavigationEnd) this.currentUrl.set(e.urlAfterRedirects);
      });
  }

  menu = signal(false);
  pwdOpen = signal(false);
  /** текущий адрес для подсветки меню (fields-инициализаторы отработают до constructor) */
  currentUrl = signal(this.router.url);

  /**
   * Меню сгруппировано по частоте работы: ежедневные операции, склад-справочники,
   * заказы и точки, редкое — вниз. Ссылки с queryParams открывают нужную вкладку страницы.
   */
  navGroups: { title: string; items: { path: string; qp?: Record<string, string>; icon: string; label: string; admin?: boolean }[] }[] = [
    { title: '', items: [{ path: '', icon: '📊', label: 'Панель' }] },
    {
      title: 'Операции',
      items: [
        { path: 'waybills', icon: '📥', label: 'Приход товара' },
        { path: 'batches', icon: '🚚', label: 'Производство и отгрузки' },
      ],
    },
    {
      title: 'Склад',
      items: [
        { path: 'stock', icon: '🏬', label: 'Остатки' },
        { path: 'stock', qp: { tab: 'catalog' }, icon: '🏷️', label: 'Номенклатура' },
        { path: 'semis', icon: '🔪', label: 'Полуфабрикаты' },
        { path: 'cards', icon: '📐', label: 'Техкарты' },
        { path: 'stock', qp: { tab: 'shelf' }, icon: '⏳', label: 'Сроки годности' },
      ],
    },
    {
      title: 'Заказы и продажи',
      items: [
        { path: 'orders', icon: '🧾', label: 'Заказы магазинов' },
        { path: 'points', icon: '🏪', label: 'Точки продаж' },
      ],
    },
    {
      title: 'Ещё',
      items: [
        { path: 'audit', icon: '📜', label: 'Журнал действий' },
        { path: 'users', icon: '👤', label: 'Пользователи', admin: true },
        { path: 'settings', icon: '⚙️', label: 'Настройки', admin: true },
      ],
    },
  ];

  logout(): void {
    this.auth.logout$().subscribe(() => {
      this.menu.set(false);
      void this.router.navigateByUrl('/login');
    });
  }

  /** Пункт активен, если совпадают путь и ?tab= (у нескольких пунктов он общий). */
  isActive(path: string, qp?: Record<string, string>): boolean {
    const url = this.currentUrl();
    const [p, qs] = url.split('?');
    const want = '/' + path;
    if (p !== want) return false;
    const tab = qp?.['tab'];
    if (!tab) return !qs || !qs.includes('tab=');
    return new URLSearchParams(qs ?? '').get('tab') === tab;
  }

  go(ev: Event, path: string, qp?: Record<string, string>): void {
    ev.preventDefault();
    this.menu.set(false);
    // queryParams — вторым аргументом (NavigationExtras), иначе Angular завернёт объект
    // в матричный параметр сегмента: /stock;queryParams=[object Object]
    void this.router.navigate(['/' + path], qp ? { queryParams: qp } : undefined);
  }
}
