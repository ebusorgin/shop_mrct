import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslatePipe, TranslateDirective } from '@ngx-translate/core';
import { AuthService } from './core/auth.service';
import { LangService, AppLang } from './core/lang.service';
import { ToastComponent } from './shared/toast.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastComponent, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (auth.user(); as u) {
      <div class="shell">
        <header class="topbar">
          <button type="button" class="burger" aria-label="Меню" (click)="menu.set(true)">☰</button>
          <span class="tb-logo"><span class="wm-mix">mix</span> <span class="wm-markt">markt</span></span>
        </header>
        @if (menu()) { <div class="scrim" (click)="menu.set(false)"></div> }
        <nav class="sidebar" [class.open]="menu()">
          <div class="logo"><span class="wm-mix">mix</span> <span class="wm-markt">markt</span><small>CRM учёта продукции</small></div>
          <button type="button" class="side-close" aria-label="Закрыть меню" (click)="menu.set(false)">✕</button>
          @if (auth.isStoreUser()) {
            <!-- магазинный сотрудник видит только свою точку и заказ продукции -->
            <a href="#" class="nav-link" [class.active]="isActive('store') && !isActive('store/orders') && !isActive('store/history')" (click)="go($event, 'store')">🏪 <span>{{ 'nav.myStore' | translate }}</span></a>
            <a href="#" class="nav-link" [class.active]="isActive('store/orders')" (click)="go($event, 'store/orders')">🧾 <span>{{ 'nav.storeOrders' | translate }}</span></a>
            <a href="#" class="nav-link" [class.active]="isActive('store/history')" (click)="go($event, 'store/history')">📜 <span>{{ 'nav.storeHistory' | translate }}</span></a>
          } @else {
            @for (g of navGroups; track g.titleKey) {
              @if (g.titleKey) { <div class="side-group">{{ g.titleKey | translate }}</div> }
              @for (r of g.items; track r.labelKey) {
                @if (!r.admin || auth.isAdmin()) {
                  <a href="#" class="nav-link" [class.active]="isActive(r.path, r.qp, r.also)"
                     (click)="go($event, r.path, r.qp)">{{ r.icon }} <span>{{ r.labelKey | translate }}</span></a>
                }
              }
            }
          }
          <div class="side-foot">
            <div class="side-user">{{ u.fullName || u.login }}{{ u.storeName ? ' · ' + u.storeName : (u.isAdmin ? ' · админ' : '') }}</div>
            <div class="side-actions">
              <button type="button" class="side-btn" (click)="logout()">{{ 'nav.logout' | translate }}</button>
            </div>
            <!-- Переключатель языка -->
            <div class="lang-switcher">
              @for (lang of langs; track lang) {
                <button type="button" class="lang-btn" [class.active]="langSvc.currentLang() === lang" (click)="langSvc.setLang(lang)">
                  {{ lang.toUpperCase() }}
                </button>
              }
            </div>
          </div>
        </nav>
        <main class="main">
          <router-outlet />
        </main>
      </div>
    } @else {
      <router-outlet />
    }

    <!-- всплывающая плашка уведомления (справа сверху, 2 сек) -->
    <app-toast />
  `,
  styles: [`
    .lang-switcher { display: flex; gap: 4px; padding: 8px 0 0; }
    .lang-btn { padding: 2px 7px; font-size: 11px; border: 1px solid rgba(255,255,255,.3);
      border-radius: 4px; background: transparent; color: inherit; cursor: pointer; opacity: .7; }
    .lang-btn.active { opacity: 1; background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.6); font-weight: 700; }
    .lang-btn:hover:not(.active) { opacity: .9; }
  `],
})
export class AppComponent {
  auth = inject(AuthService);
  langSvc = inject(LangService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  readonly langs: AppLang[] = ['ru', 'en', 'sr'];

  constructor() {
    effect(() => {
      document.documentElement.classList.toggle('menu-lock', this.menu());
    });
    this.router.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        if (e instanceof NavigationEnd) this.currentUrl.set(e.urlAfterRedirects);
      });
  }

  menu = signal(false);
  currentUrl = signal(this.router.url);

  navGroups: { titleKey: string; items: { path: string; qp?: Record<string, string>; icon: string; labelKey: string; admin?: boolean; also?: string[] }[] }[] = [
    { titleKey: '', items: [{ path: '', icon: '📊', labelKey: 'nav.dashboard' }] },
    {
      titleKey: 'nav.groupOperations',
      items: [{ path: 'waybills', icon: '📥', labelKey: 'nav.waybills' }],
    },
    {
      titleKey: 'nav.groupStock',
      items: [
        { path: 'stock', icon: '🏬', labelKey: 'nav.stock' },
        { path: 'semis', icon: '🔪', labelKey: 'nav.semis' },
        { path: 'cards', icon: '📐', labelKey: 'nav.cards' },
        { path: 'constructor', icon: '🍲', labelKey: 'nav.constructor' },
        { path: 'orders', icon: '🧾', labelKey: 'nav.orders' },
      ],
    },
    {
      titleKey: 'nav.groupOther',
      items: [
        { path: 'points', icon: '🏪', labelKey: 'nav.points' },
        { path: 'audit', icon: '📜', labelKey: 'nav.audit' },
        { path: 'users', icon: '👤', labelKey: 'nav.users', admin: true },
        { path: 'settings', icon: '⚙️', labelKey: 'nav.settings', admin: true },
      ],
    },
  ];

  logout(): void {
    this.auth.logout$().subscribe(() => {
      this.menu.set(false);
      void this.router.navigateByUrl('/login');
    });
  }

  isActive(path: string, qp?: Record<string, string>, also?: string[]): boolean {
    const [p] = this.currentUrl().split('?');
    const wants = ['/' + path, ...(also ?? []).map((a) => '/' + a)];
    return wants.some((want) => p === want || p.startsWith(want + '/'));
  }

  go(ev: Event, path: string, qp?: Record<string, string>): void {
    ev.preventDefault();
    this.menu.set(false);
    void this.router.navigate(['/' + path], qp ? { queryParams: qp } : undefined);
  }
}
