import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { MyStore, OrderCatalogItem } from '../core/models';
import { fmtQty, httpErr } from '../core/format';
import { ModalComponent } from '../shared/modal.component';

/**
 * Страница магазинного сотрудника: карточка своей точки (сотрудники) и
 * справочная карточка «Данные магазина». Данные точки заполняет офис,
 * поэтому сотруднику они показываются только для просмотра.
 *
 * Доступна только пользователю с привязкой к точке (storeGuard), и все
 * запросы на сервере всё равно сужены до его store_id.
 */
@Component({
  selector: 'app-store-home',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">🏪 {{ store()?.name ?? 'Мой магазин' }}</h1>
      @if (store()?.code) { <span class="badge gray">{{ store()!.code }}</span> }
      @if (store() && !store()!.active) { <span class="badge red">точка закрыта</span> }
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()">⟳</button>
      <button class="btn sm primary" (click)="openOrder()" [disabled]="!store()">＋ Новый заказ товаров с производства</button>
      <button class="btn sm" (click)="infoOpen.set(true)" [disabled]="!store()">✎ Данные магазина</button>
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    @if (!store() && !err()) {
      <p class="muted">Загрузка…</p>
    }

    @if (orderOpen()) {
      <app-modal title="Новый заказ товаров с производства" (closed)="orderOpen.set(false)">
        <div class="ord-tools">
          <input type="search" placeholder="🔍 поиск продукции…" [ngModel]="orderQuery()" (ngModelChange)="orderQuery.set($event)" />
          <span class="muted ord-cnt">В заказе: <b>{{ selectedCount() }}</b> из {{ orderCatalog().length }}</span>
        </div>

        @if (orderErr()) { <div class="err">{{ orderErr() }}</div> }
        @if (orderLoading()) {
          <p class="muted">Загружаем продукцию…</p>
        } @else {
          <div class="ord-list">
            @for (g of orderGroups(); track g.key) {
              <div class="ord-grp">
                <div class="ord-grp-t">
                  <span class="cat-chip" [style.background]="g.color || '#eef2f7'">{{ g.icon ? g.icon + ' ' : '' }}{{ g.name }}</span>
                  <span class="muted">{{ g.items.length }}</span>
                </div>
                @for (p of g.items; track p.id) {
                  <div class="ord-row" [class.on]="qtyOf(p.id) > 0" [title]="p.note || ''">
                    <span class="ord-nm">
                      <b>{{ p.name }}</b>
                      <span class="muted">выход {{ fmtQty(p.portionQty, p.portionUnitCode) }}</span>
                    </span>
                    <span class="ord-qty">
                      <input type="number" min="0" step="1" [value]="qtyOf(p.id)"
                             (input)="setQty(p.id, $any($event.target).value)" aria-label="Количество" />
                    </span>
                  </div>
                }
              </div>
            } @empty {
              <p class="muted" style="text-align:center;padding:18px 0">
                {{ orderQuery().trim() ? 'По запросу ничего не найдено' : 'Продукция производства пока не заведена' }}
              </p>
            }
          </div>
          @if (selectedCount()) {
            <div class="ord-sum">Итого: <b>{{ selectedCount() }}</b> поз. · <b>{{ totalUnits() }}</b> порц.</div>
          }
        }

        <div modalFooter>
          <button type="button" class="btn" (click)="orderOpen.set(false)">Отмена</button>
          <button type="button" class="btn primary" [disabled]="!selectedCount()" (click)="submitOrder()">Оформить заказ ({{ selectedCount() }})</button>
        </div>
      </app-modal>
    }

    @if (infoOpen()) {
      <app-modal title="Данные магазина" (closed)="infoOpen.set(false)">
        @if (store(); as s) {
          <div class="info">
            <div><span class="k">Номер точки</span><span class="v">{{ s.id }}</span></div>
            <div><span class="k">Код</span><span class="v">{{ s.code || '—' }}</span></div>
            <div><span class="k">Название</span><span class="v">{{ s.name }}</span></div>
            <div><span class="k">Адрес</span><span class="v">{{ s.address || '—' }}</span></div>
            <div><span class="k">Телефон</span><span class="v">{{ s.phone || '—' }}</span></div>
            <div><span class="k">E-mail</span><span class="v">{{ s.email || '—' }}</span></div>
            <div><span class="k">Контактное лицо</span><span class="v">{{ s.contactPerson || '—' }}</span></div>
            <div><span class="k">Часы работы</span><span class="v">{{ s.openingHours || '—' }}</span></div>
            <div><span class="k">PIB</span><span class="v">{{ s.pib || '—' }}</span></div>
            <div><span class="k">MBR</span><span class="v">{{ s.mbr || '—' }}</span></div>
            <div><span class="k">Tekući račun</span><span class="v">{{ s.accountNo || '—' }}</span></div>
            <div><span class="k">Порядок</span><span class="v">{{ s.position }}</span></div>
            <div><span class="k">Активна</span><span class="v">{{ s.active ? 'да' : 'нет' }}</span></div>
            <div class="wide"><span class="k">Примечание</span><span class="v">{{ s.note || '—' }}</span></div>
          </div>
          <div class="muted small" style="margin-top:12px">
            Данные магазина заполняет офис — здесь только просмотр.
          </div>
        } @else {
          <p class="muted">Загрузка…</p>
        }
        <div modalFooter>
          <button type="button" class="btn" (click)="infoOpen.set(false)">Закрыть</button>
        </div>
      </app-modal>
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .spacer { flex: 1 1 auto; }
    .small { font-size: 12px; }

    /* форма заказа: поиск, группы каталогов, строки продукции */
    .ord-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .ord-tools input[type=search] { flex: 1 1 220px; max-width: 340px; }
    .ord-cnt { font-size: 12px; white-space: nowrap; }
    .ord-list { display: flex; flex-direction: column; gap: 10px; }
    .ord-grp { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .ord-grp-t { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: #f7f9fc; border-bottom: 1px solid var(--border); font-size: 12px; }
    .cat-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; line-height: 16px; color: #26303f; }
    .ord-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-bottom: 1px solid #f0f3f8; }
    .ord-row:last-child { border-bottom: 0; }
    .ord-row:hover { background: #f8fafd; }
    .ord-row.on { background: var(--accent-soft); }
    .ord-nm { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .ord-nm b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ord-nm .muted { font-size: 11.5px; }
    .ord-qty { flex: none; display: flex; align-items: center; gap: 5px; }
    .ord-qty input { width: 70px; }
    .ord-sum { margin-top: 10px; font-size: 12.5px; color: var(--muted); text-align: right; }
    .info { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
    .info > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .info > .wide { grid-column: 1 / -1; }
    .info .k { font-size: 11px; text-transform: uppercase; letter-spacing: .02em; color: var(--muted); }
    .info .v { font-size: 14px; overflow-wrap: anywhere; }
    .red { color: var(--red); }
    `,
  ],
})
export class StoreHomeComponent implements OnInit {
  private api = inject(ApiService);

  store = signal<MyStore | null>(null);
  err = signal('');
  msg = signal('');
  infoOpen = signal(false);
  orderOpen = signal(false);

  // ---------- заказ с производства (пока только интерфейс) ----------
  orderCatalog = signal<OrderCatalogItem[]>([]);
  orderLoaded = signal(false);
  orderLoading = signal(false);
  orderErr = signal('');
  orderQuery = signal('');
  /** id продукции -> количество порций в заказе; отсутствие ключа = 0 (не заказываем). */
  orderQty = signal<Record<number, number>>({});

  fmtQty = fmtQty;

  orderFiltered = computed(() => {
    const q = this.orderQuery().trim().toLowerCase();
    if (!q) return this.orderCatalog();
    return this.orderCatalog().filter((p) => `${p.name} ${p.note ?? ''}`.toLowerCase().includes(q));
  });

  /** Группы по каталогу производства — порядок задаёт сервер (position каталога). */
  orderGroups = computed(() => {
    const groups: { key: string; name: string; icon: string; color: string; items: OrderCatalogItem[] }[] = [];
    const byKey = new Map<string, (typeof groups)[number]>();
    for (const p of this.orderFiltered()) {
      const key = p.catalogId != null ? `c${p.catalogId}` : 'none';
      let g = byKey.get(key);
      if (!g) {
        g = {
          key,
          name: p.catalogName || 'Без каталога',
          icon: p.catalogIcon || '',
          color: p.catalogColor || '',
          items: [],
        };
        byKey.set(key, g);
        groups.push(g);
      }
      g.items.push(p);
    }
    return groups;
  });

  selectedCount = computed(() => Object.values(this.orderQty()).filter((q) => q > 0).length);
  totalUnits = computed(() => Object.values(this.orderQty()).reduce((s, q) => s + Math.max(0, q), 0));

  ngOnInit(): void {
    this.load();
  }

  openOrder(): void {
    this.orderOpen.set(true);
    this.orderQuery.set('');
    this.orderErr.set('');
    if (!this.orderLoaded()) this.loadOrderCatalog();
  }

  private loadOrderCatalog(): void {
    this.orderLoading.set(true);
    this.api.storeOrderCatalog$().subscribe({
      next: (v) => {
        this.orderLoading.set(false);
        this.orderLoaded.set(true);
        this.orderCatalog.set(v);
      },
      error: (e) => {
        this.orderLoading.set(false);
        this.orderErr.set(httpErr(e));
      },
    });
  }

  qtyOf(id: number): number {
    return this.orderQty()[id] ?? 0;
  }

  setQty(id: number, value: string): void {
    const q = Math.max(0, Math.floor(Number(value) || 0));
    this.orderQty.update((m) => {
      const n = { ...m };
      if (q > 0) n[id] = q;
      else delete n[id];
      return n;
    });
  }

  submitOrder(): void {
    const n = this.selectedCount();
    if (!n) return;
    this.msg.set(`Черновик заказа: ${n} поз. · ${this.totalUnits()} порц. — отправка на производство появится позже`);
    this.orderQty.set({});
    this.orderOpen.set(false);
  }

  load(): void {
    this.err.set('');
    this.api.myStore$().subscribe({
      next: (v) => this.store.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }
}
