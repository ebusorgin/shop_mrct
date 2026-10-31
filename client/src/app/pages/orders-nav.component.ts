import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';

/**
 * Общая панель перехода по разделу «Заказы и продажи».
 * Ставится в шапку каждой страницы раздела (доска, синхронизация,
 * магазины-точки, журнал), чтобы из любой точки можно было перепрыгнуть между ними.
 * Активный раздел подсвечивается (для доски — точное совпадение пути, иначе он
 * «активен» везде). Витрины-магазины живут в одном месте — на «Магазинах и точках»
 * (бывш. «Точки продаж»), отдельная страница «Магазины» упразднена как дубль.
 */
@Component({
  selector: 'app-orders-nav',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="ontabs">
      <a class="ontab" routerLink="/orders" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }">📋 Доска</a>
      <a class="ontab" routerLink="/orders/sync" routerLinkActive="on">🔄 Синхронизация</a>
      <a class="ontab" routerLink="/points" routerLinkActive="on">🏬 Магазины и точки</a>
      <a class="ontab" routerLink="/orders/journal" routerLinkActive="on">📜 Журнал</a>
    </nav>
  `,
  styles: [`
    .ontabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 0 0 16px; padding: 4px;
      background: #fff; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
      width: fit-content; max-width: 100%; }
    .ontab { display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px; border-radius: 9px;
      font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; white-space: nowrap;
      transition: background .12s, color .12s; }
    .ontab:hover { background: #f2f5fa; color: var(--text); }
    .ontab.on { background: var(--accent); color: #fff; }
    @media (max-width: 640px) {
      .ontabs { width: 100%; }
      .ontab { flex: 1 1 auto; justify-content: center; }
    }
  `],
})
export class OrdersNavComponent {}
