import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { OrdersService } from '../core/orders.service';
import { OrdersNavComponent } from './orders-nav.component';

/**
 * Страница «Магазины» — сетка витрин. Точка входа в карточку конкретного магазина
 * (/orders/:storeId), где производство подтверждает/собирает/отменяет позиции и
 * магазин оформляет заказ. Нужна как отдельная, т.к. главная доска теперь только
 * просмотр и объединяет все магазины в одну таблицу.
 */
@Component({
  selector: 'app-orders-stores',
  standalone: true,
  imports: [CommonModule, RouterLink, OrdersNavComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🧾 Заказы магазинов · Магазины</h1>
    <app-orders-nav></app-orders-nav>

    <div class="panel">
      <h3>Витрины</h3>
      <p class="muted" style="font-size:12px; margin-top:-6px">
        Откройте магазин, чтобы подтвердить, собрать или отменить позиции, а также оформить заказ.
      </p>
      <div class="row" style="flex-wrap:wrap">
        @for (s of ordersSvc.stores(); track s.id) {
          <a class="btn" [routerLink]="['/orders', s.id]">
            🏪 {{ s.name }}<small class="muted" style="margin-left:6px">{{ s.code }}</small>
          </a>
        }
        @if (!ordersSvc.stores().length) { <span class="muted">Нет активных витрин</span> }
      </div>
    </div>
  `,
})
export class OrdersStoresComponent implements OnInit {
  readonly ordersSvc = inject(OrdersService);

  ngOnInit(): void {
    void this.ordersSvc.ensureStores();
  }
}
