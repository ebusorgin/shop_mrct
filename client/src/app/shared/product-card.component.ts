import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../core/api.service';
import { ProductSupplier, ProductUsage } from '../core/models';
import { fmtCost, fmtMoney, fmtQty, httpErr } from '../core/format';
import { ModalComponent } from './modal.component';
import { TabStripComponent, TabItem } from './tab-strip.component';
import { ProductFormComponent } from './product-form.component';

export type ProductCardTab = 'usage' | 'suppliers' | 'edit';

/** Минимум полей позиции, который нужен карточке (строка списка Склада подходит целиком). */
export interface ProductCardItem {
  id: number;
  name: string;
  unitCode?: string;
  qty: number;
  avgCost: number;
  minStock?: number;
}

/**
 * Карточка складской позиции: всплывает по клику на строку списка.
 * Вкладки: где используется (полуфабрикаты и техкарты), поставщики по накладным, редактирование.
 */
@Component({
  selector: 'app-product-card',
  standalone: true,
  imports: [CommonModule, ModalComponent, TabStripComponent, ProductFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .card-sum { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .sum-item { display: flex; flex-direction: column; gap: 1px; padding: 6px 10px; border-radius: 8px;
      background: var(--panel); border: 1px solid var(--border); min-width: 110px; }
    .sum-l { font-size: 10.5px; text-transform: uppercase; letter-spacing: .3px; color: var(--muted); }
    .sum-item b { font-size: 13px; font-variant-numeric: tabular-nums; }
    .group-t { margin: 10px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
    .group-t:first-child { margin-top: 0; }
    .mini th { font-size: 11px; }
    .mini td { padding-top: 6px; padding-bottom: 6px; }
    .empty { text-align: center; color: var(--muted); padding: 18px 10px; font-size: 13px; }
    .hint { font-size: 12px; color: var(--muted); }
    .money { font-variant-numeric: tabular-nums; }
  `],
  template: `
    <app-modal [title]="product().name" [tabs]="true" (closed)="closed.emit()">
      <div modalTabs>
        <div class="card-sum">
          <span class="sum-item"><span class="sum-l">Остаток</span><b>{{ fmtQty(product().qty, product().unitCode || '') }}</b></span>
          <span class="sum-item"><span class="sum-l">Себестоимость</span><b>{{ fmtCost(product().avgCost, product().unitCode || '') }}</b></span>
          <span class="sum-item"><span class="sum-l">Сумма остатка</span><b>{{ fmtMoney(product().qty * product().avgCost) }}</b></span>
          <span class="sum-item"><span class="sum-l">Мин. остаток</span><b>{{ minLabel() }}</b></span>
        </div>

        <app-tab-strip [tabs]="tabs" [active]="tab()" ariaLabel="Карточка позиции" (pick)="pick($event)" />
      </div>

      @switch (tab()) {
          @case ('usage') {
            @if (usageErr()) {
              <div class="err">{{ usageErr() }}</div>
            } @else if (!usage()) {
              <p class="hint">Загружаем состав…</p>
            } @else if (!usage()!.semis.length && !usage()!.cards.length) {
              <div class="empty">Позиция пока нигде не используется — нет ни в полуфабрикатах, ни в техкартах.</div>
            } @else {
              @if (usage()!.semis.length) {
                <div class="group-t">Полуфабрикаты · {{ usage()!.semis.length }}</div>
                <table class="tbl mini">
                  <tr><th>Название</th><th class="num">На партию</th><th class="num">Выход партии</th></tr>
                  @for (u of usage()!.semis; track u.id) {
                    <tr>
                      <td><b>{{ u.name }}</b>
                        @if (u.yieldPct && u.yieldPct < 100) { <span class="hint"> · выход после обработки {{ u.yieldPct }}%</span> }
                      </td>
                      <td class="num">{{ fmtQty(u.qty, u.unitCode) }}</td>
                      <td class="num muted">{{ fmtQty(u.outQty, u.outUnitCode) }}</td>
                    </tr>
                  }
                </table>
              }
              @if (usage()!.cards.length) {
                <div class="group-t">Техкарты · {{ usage()!.cards.length }}</div>
                <table class="tbl mini">
                  <tr><th>Название</th><th class="num">На порцию</th><th class="num">Порция</th></tr>
                  @for (u of usage()!.cards; track u.id) {
                    <tr>
                      <td><b>{{ u.name }}</b></td>
                      <td class="num">{{ fmtQty(u.qty, u.unitCode) }}</td>
                      <td class="num muted">{{ fmtQty(u.portionQty, u.portionUnitCode) }}</td>
                    </tr>
                  }
                </table>
              }
            }
          }
          @case ('suppliers') {
            @if (supErr()) {
              <div class="err">{{ supErr() }}</div>
            } @else if (!suppliers()) {
              <p class="hint">Загружаем поставщиков…</p>
            } @else if (!suppliers()!.length) {
              <div class="empty">По этой позиции ещё не было приходов — поставщики появятся после первой накладной.</div>
            } @else {
              <table class="tbl mini">
                <tr><th>Поставщик</th><th class="num">Поставок</th><th class="num">Последняя</th><th class="num">Цена</th></tr>
                @for (s of suppliers()!; track s.supplier) {
                  <tr>
                    <td><b>{{ s.supplier }}</b></td>
                    <td class="num muted">{{ s.deliveries }}</td>
                    <td class="num muted">{{ fmtDay(s.lastDate) }}</td>
                    <td class="num money">{{ fmtCost(s.lastPrice, s.unitCode) }}</td>
                  </tr>
                }
              </table>
              <p class="hint" style="margin:8px 0 0">Цена — из последней действующей накладной, без PDV.</p>
            }
          }
          @case ('edit') {
            <app-product-form [productId]="product().id" (saved)="saved.emit()" (closed)="closed.emit()" />
          }
        }
    </app-modal>
  `,
})
export class ProductCardComponent implements OnInit {
  private api = inject(ApiService);

  product = input.required<ProductCardItem>();
  initialTab = input<ProductCardTab>('usage');

  saved = output<void>();
  closed = output<void>();

  tabs: TabItem[] = [
    { id: 'usage', label: 'Используется', icon: '🔗' },
    { id: 'suppliers', label: 'Поставщики', icon: '🚚' },
    { id: 'edit', label: 'Редактирование', icon: '✎' },
  ];

  tab = signal<ProductCardTab>('usage');
  usage = signal<ProductUsage | null>(null);
  suppliers = signal<ProductSupplier[] | null>(null);
  usageErr = signal('');
  supErr = signal('');

  fmtQty = fmtQty;
  fmtCost = fmtCost;
  fmtMoney = fmtMoney;

  minLabel = computed(() => {
    const m = this.product().minStock ?? 0;
    return m > 0 ? fmtQty(m, this.product().unitCode || '') : '—';
  });

  ngOnInit(): void {
    this.tab.set(this.initialTab());
    const id = this.product().id;
    this.api.productUsage$(id).subscribe({
      next: (u) => this.usage.set(u),
      error: (e) => this.usageErr.set(httpErr(e)),
    });
    this.api.productSuppliers$(id).subscribe({
      next: (s) => this.suppliers.set(s),
      error: (e) => this.supErr.set(httpErr(e)),
    });
  }

  pick(id: string): void {
    this.tab.set(id as ProductCardTab);
  }

  fmtDay(iso: string): string {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
}
