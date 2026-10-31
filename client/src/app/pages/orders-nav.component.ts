import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';

/**
 * Общая панель перехода по разделам «Заказов магазинов».
 * Ставится в шапку каждой страницы раздела, чтобы из любой точки можно было
 * перепрыгнуть в доску, магазины, синхронизацию или журнал. Активный раздел
 * подсвечивается (для доски — точное совпадение пути, иначе он «активен» везде).
 */
@Component({
  selector: 'app-orders-nav',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="row onav">
      <a class="btn sm" routerLink="/orders" routerLinkActive="primary" [routerLinkActiveOptions]="{ exact: true }">
        📋 Доска заказов
      </a>
      <a class="btn sm" routerLink="/orders/stores" routerLinkActive="primary">🏪 Магазины</a>
      <a class="btn sm" routerLink="/orders/sync" routerLinkActive="primary">🔄 Синхронизация</a>
      <a class="btn sm" routerLink="/orders/journal" routerLinkActive="primary">📜 Журнал изменений</a>
    </nav>
  `,
  styles: [`.onav { gap: 8px; flex-wrap: wrap; margin: 4px 0 14px; }`],
})
export class OrdersNavComponent {}
