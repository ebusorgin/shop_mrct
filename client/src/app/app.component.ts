import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <header class="topbar">
        <button type="button" class="burger" aria-label="Меню" (click)="menu.set(true)">☰</button>
        <span class="tb-logo">🥗 MIX markt</span>
      </header>
      @if (menu()) { <div class="scrim" (click)="menu.set(false)"></div> }
      <nav class="sidebar" [class.open]="menu()">
        <div class="logo">🥗 MIX markt<small>CRM учёта продукции</small></div>
        <button type="button" class="side-close" aria-label="Закрыть меню" (click)="menu.set(false)">✕</button>
        @for (r of nav; track r.path) {
          <a [routerLink]="r.path" routerLinkActive="active" (click)="menu.set(false)">{{ r.icon }} <span>{{ r.label }}</span></a>
        }
      </nav>
      <main class="main">
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppComponent {
  menu = signal(false);
  nav = [
    { path: '', icon: '📊', label: 'Панель' },
    { path: 'waybills', icon: '📥', label: 'Накладные (входящие)' },
    { path: 'stock', icon: '🏬', label: 'Склад' },
    { path: 'semis', icon: '🔪', label: 'Полуфабрикаты' },
    { path: 'cards', icon: '📐', label: 'Техкарты' },
    { path: 'batches', icon: '🚚', label: 'Расход продукции' },
    { path: 'orders', icon: '🧾', label: 'Заказы магазинов' },
  ];
}
