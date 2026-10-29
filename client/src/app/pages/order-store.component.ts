import { ChangeDetectionStrategy, Component, Input, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { OrdersService } from '../core/orders.service';
import { OrderCatalogItem, OrderDate, OrderItem, OrderViolation, OrdersSummary } from '../core/models';
import { fmtDateTime, fmtMoney, fmtQty, httpErr, today, trim } from '../core/format';
import { LiveService } from '../core/live.service';

interface CartLine {
  cardId: number;
  name: string;
  baseUnit: string; // единица хранения техкарты (г/мл/шт)
  unit: string; // в чём вводит магазин
  qty: number;
}

@Component({
  selector: 'app-order-store',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row" style="align-items:center; margin-bottom:6px">
      @if (!storeView) { <a class="btn sm" routerLink="/orders">← Заказы</a> }
      <h1 class="page-title" style="margin:0">🛒 {{ title() }}</h1>
    </div>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <!-- ===== переключатель дат: сегодня + история ===== -->
    <div class="panel">
      <div class="row" style="align-items:flex-end">
        <label class="f" style="flex:1">Дата заказа
          <select [ngModel]="date()" (ngModelChange)="selectDate($event)">
            @for (d of dates(); track d.date) {
              <option [ngValue]="d.date">{{ pretty(d.date) }} · {{ d.cnt }} поз.</option>
            }
            @if (!dates().length) { <option [ngValue]="null">нет данных</option> }
          </select>
        </label>
        <button class="btn sm" (click)="goToday()">Сегодня</button>
        <button class="btn sm" (click)="reload()">⟳ Обновить</button>
      </div>
    </div>

    <!-- ===== сводка ===== -->
    @if (summary(); as s) {
      <div class="kpis">
        <div class="kpi"><div class="v">{{ s.lines }}</div><div class="l">позиций в заказе</div></div>
        <div class="kpi"><div class="v">{{ qtySummary(s) }}</div><div class="l">всего количества</div></div>
        <div class="kpi"><div class="v">{{ s.totalCost === null ? '—' : fmtMoney(s.totalCost) }}</div><div class="l">стоимость (по VK)@if (s.totalCost !== null && s.costLines < s.lines) { · часть } </div></div>
        <div class="kpi">
          <div class="v" [class.red]="s.minBadLines > 0">{{ s.minOkLines }} / {{ s.lines }}</div>
          <div class="l">соответствие минимуму @if (s.minBadLines > 0) { · ⚠️ {{ s.minBadLines }} ниже }</div>
        </div>
      </div>
    }

    <!-- ===== фильтр по категории и поиск ===== -->
    <div class="panel">
      <div class="row">
        <label class="f" style="flex:1">Категория
          <select [ngModel]="category()" (ngModelChange)="category.set($event); loadOrders()">
            <option [ngValue]="''">— все —</option>
            @for (c of ordersSvc.categories(); track c) { <option [ngValue]="c">{{ c }}</option> }
          </select>
        </label>
        <label class="f" style="flex:2">Поиск по названию
          <input [ngModel]="q()" (ngModelChange)="q.set($event); loadOrders()" placeholder="напр. оливье" />
        </label>
      </div>

      @if (loading()) { <p class="muted">Загрузка…</p> }
      @else {
        <table class="tbl stack">
          <tr class="th-row"><th>Товар</th><th class="num">Кол-во</th><th class="num">Мин.</th><th>Статус</th><th></th></tr>
          @for (it of items(); track it.id) {
            <tr>
              <td>
                <b>{{ it.name }}</b>
                @if (it.category) { <div class="muted" style="font-size:11px">{{ it.category }}@if (it.plu) { · {{ it.plu }} }</div> }
              </td>
              <td class="num" data-l="Кол-во">{{ fmtQty(it.qty, unitOf(it)) }}</td>
              <td class="num" data-l="Мин.">
                @if (it.minQty !== null) {
                  <span [class.red]="belowMin(it)">{{ fmtQty(it.minQty, unitOf(it)) }}</span>
                } @else { <span class="muted">—</span> }
              </td>
              <td data-l="Статус">
                <span class="badge" [class]="badgeCls(it.status)">{{ statusLabel(it.status) }}</span>
                @if (it.source === 'g_sheet') { <span class="badge gray" title="из Google Таблицы">G</span> }
                @if (it.statusByLogin) {
                  <div class="who" [title]="'статус сменил: ' + it.statusByLogin + ' · ' + fmtWhen(it.statusAt)">
                    {{ it.statusByName || it.statusByLogin }} · {{ fmtWhen(it.statusAt) }}
                  </div>
                }
              </td>
              <td style="white-space:nowrap">
                @if (!storeView) {
                  @if (it.status !== 'confirmed' && it.status !== 'collected' && it.status !== 'cancelled') {
                    <button class="btn sm" (click)="setStatus(it, 'confirmed')">✓</button>
                  }
                  @if (it.status === 'confirmed') {
                    <button class="btn sm" (click)="setStatus(it, 'collected')">📦 собрали</button>
                  }
                }
                @if (it.status !== 'cancelled' && it.status !== 'collected') {
                  <button class="btn sm danger" (click)="setStatus(it, 'cancelled')">✕</button>
                }
              </td>
            </tr>
          } @empty {
            <tr class="empty"><td colspan="5">На эту дату заказов нет</td></tr>
          }
        </table>
      }
    </div>

    <!-- ===== оформление нового заказа ===== -->
    @if (!storeView || isToday()) {
    <div class="panel">
      <h3>➕ Оформить заказ (дата {{ pretty(date()) }})</h3>
      <label class="f" style="margin-bottom:10px">Добавить из каталога
        <input [ngModel]="picker()" (ngModelChange)="picker.set($event)" placeholder="поиск товара…" />
      </label>
      <div class="list-pick" style="max-height:260px">
        @for (c of pickedCatalog(); track c.id) {
          <button type="button" [class.on]="inCart(c.id)" (click)="toggleCart(c)">
            {{ c.name }} <span class="muted" style="font-size:11px">({{ c.unitCode }}{{ c.plu ? ' · ' + c.plu : '' }})</span>
            @if (inCart(c.id)) { <b>✓</b> }
          </button>
        }
        @if (pickedCatalog().length === 0) { <p class="muted">Ничего не найдено</p> }
      </div>

      @if (cart().length) {
        <hr class="hr" />
        <table class="tbl stack">
          <tr class="th-row"><th>Позиция</th><th class="num">Кол-во</th><th>Ед.</th><th></th></tr>
          @for (l of cart(); track l.cardId) {
            <tr>
              <td>{{ l.name }}</td>
              <td class="num" data-l="Кол-во">
                <input type="number" min="0" step="0.01" style="width:96px;text-align:right"
                       [ngModel]="l.qty" (ngModelChange)="setQty(l.cardId, $event)" />
              </td>
              <td data-l="Ед.">
                <select [ngModel]="l.unit" (ngModelChange)="setUnit(l.cardId, $event)">
                  @for (u of unitsFor(l.baseUnit); track u) { <option [ngValue]="u">{{ u }}</option> }
                </select>
              </td>
              <td><button class="btn sm danger" (click)="removeCart(l.cardId)">убрать</button></td>
            </tr>
          }
        </table>
        <div class="row" style="margin-top:10px">
          <button class="btn primary" [disabled]="placing()" (click)="submit(false)">
            {{ placing() ? 'Отправка…' : '➤ Оформить заказ' }}
          </button>
          @if (lastViolations().length) {
            <button class="btn danger" [disabled]="placing()" (click)="submit(true)">Всё равно разместить (ниже мин.)</button>
          }
          <span class="spacer"></span>
          <button class="btn sm" (click)="clearCart()">Очистить</button>
        </div>
        @if (lastViolations().length) {
          <p class="err" style="margin-top:10px">
            Ниже минимума: @for (v of lastViolations(); track v.name) { <span>{{ v.name }} ({{ fmtBase(v.qty, v.unit) }} &lt; {{ fmtBase(v.minQty, v.unit) }}) </span> }
          </p>
        }
      }
    </div>
    }
  `,
  styles: [`.red { color: var(--red); } .who { font-size: 11px; color: var(--muted); white-space: nowrap; }`],
})
export class OrderStoreComponent implements OnInit {
  private api = inject(ApiService);
  readonly ordersSvc = inject(OrdersService);
  private route = inject(ActivatedRoute);
  private live = inject(LiveService);

  /** Точка зафиксирована (страница своего магазина): выбор магазина не нужен. */
  @Input() fixedStoreId: number | null = null;
  /** Режим магазина: без подтверждения/сборки, без ссылки «Заказы», заказ — только на сегодня. */
  @Input() storeView = false;

  storeId = 0;
  dates = signal<OrderDate[]>([]);
  date = signal<string | null>(null);
  items = signal<OrderItem[]>([]);
  summary = signal<OrdersSummary | null>(null);
  category = signal('');
  q = signal('');
  loading = signal(false);
  err = signal('');
  msg = signal('');

  // корзина оформления
  picker = signal('');
  cart = signal<CartLine[]>([]);
  placing = signal(false);
  lastViolations = signal<OrderViolation[]>([]);

  fmtQty = fmtQty;
  fmtMoney = fmtMoney;
  trim = trim;
  fmtWhen = fmtDateTime;

  title(): string {
    return this.storeView ? 'Заказы магазина' : `Магазин ${this.storeId}`;
  }

  /** Сегодняшний лист — единственный, на который магазин может оформить заказ. */
  isToday(): boolean {
    return this.date() === today();
  }

  constructor() {
    // в таблице что-то поменяли и сервер уже перечитал её — обновляем список заказов
    effect(() => {
      if (this.live.sheetVersion() > 0 && this.storeId) {
        untracked(() => {
          this.loadDates();
          this.ordersSvc.ensureCategories(true);
        });
      }
    });
  }

  pickedCatalog = computed(() => {
    const kw = this.picker().trim().toLowerCase();
    const all = this.ordersSvc.catalog();
    if (!kw) return all.slice(0, 40);
    return all.filter((c) => c.name.toLowerCase().includes(kw)).slice(0, 40);
  });

  async ngOnInit(): Promise<void> {
    // страница магазина: своя точка известна заранее, список точек офиса не запрашиваем
    if (this.fixedStoreId) {
      this.storeId = this.fixedStoreId;
      await Promise.all([this.ordersSvc.ensureCatalog(), this.ordersSvc.ensureCategories()]);
      await this.loadDates();
      return;
    }
    this.route.paramMap.subscribe(async (pm) => {
      this.storeId = Number(pm.get('storeId')) || 0;
      await this.ordersSvc.ensureStores();
      await Promise.all([this.ordersSvc.ensureCatalog(), this.ordersSvc.ensureCategories()]);
      await this.loadDates();
    });
  }

  loadDates(): void {
    this.api.orderDates$(this.storeId).subscribe({
      next: (v) => {
        this.dates.set(v);
        const t = today();
        const has = v.find((d) => d.date === t);
        this.date.set(has ? t : v[0]?.date ?? null);
        this.loadOrders();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  selectDate(d: string | null): void {
    this.date.set(d);
    this.loadOrders();
  }

  goToday(): void {
    this.date.set(today());
    this.loadOrders();
  }

  reload(): void {
    this.loadDates();
  }

  loadOrders(): void {
    const p: Record<string, string> = { store: String(this.storeId) };
    if (this.date()) p['date'] = this.date()!;
    if (this.category()) p['category'] = this.category();
    if (this.q().trim()) p['q'] = this.q().trim();
    this.loading.set(true);
    this.err.set('');
    this.api.orders$(p).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.summary.set(r.summary);
        this.loading.set(false);
      },
      error: (e) => {
        this.err.set(httpErr(e));
        this.loading.set(false);
      },
    });
  }

  // ---- отображение ----
  qtySummary(s: OrdersSummary): string {
    const parts = Object.entries(s.qtyByUnit ?? {}).map(([base, n]) => fmtQty(n, base));
    return parts.length ? parts.join(' · ') : '—';
  }
  /** qty в базовой единице карточки; fmtQty сама сворачивает г→кг, мл→л. */
  fmtBase(qty: number, base: string): string {
    return fmtQty(qty, base);
  }
  unitOf(it: OrderItem): string {
    return it.cardUnit ?? it.unitCode ?? 'г';
  }
  belowMin(it: OrderItem): boolean {
    return it.minQty !== null && it.qty < it.minQty - 1e-6;
  }
  statusLabel(s: string): string {
    return { synced: 'синхрон.', placed: 'оформлен', confirmed: 'подтверждён', collected: 'собрали', cancelled: 'отменён' }[s] ?? s;
  }
  badgeCls(s: string): string {
    if (s === 'cancelled') return 'gray';
    if (s === 'collected') return 'green';
    if (s === 'confirmed') return 'blue';
    if (s === 'placed') return 'amber';
    return 'gray';
  }
  pretty(d: string | null): string {
    if (!d) return '—';
    const [y, m, day] = d.split('-');
    return `${day}.${m}.${y}`;
  }

  // ---- статус строки ----
  setStatus(it: OrderItem, status: string): void {
    this.api.patchOrder$(it.id, { status }).subscribe({
      next: () => {
        this.msg.set(`Статус «${this.statusLabel(status)}» сохранён ✓`);
        this.loadOrders();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  // ---- корзина ----
  private unitsForCache: Record<string, string[]> = {};
  unitsFor(baseUnit: string): string[] {
    if (this.unitsForCache[baseUnit]) return this.unitsForCache[baseUnit];
    const list = baseUnit === 'г' ? ['г', 'кг'] : baseUnit === 'мл' ? ['мл', 'л'] : [baseUnit];
    return (this.unitsForCache[baseUnit] = list);
  }
  friendly(baseUnit: string): string {
    return baseUnit === 'г' ? 'кг' : baseUnit === 'мл' ? 'л' : baseUnit;
  }
  inCart(cardId: number): boolean {
    return this.cart().some((l) => l.cardId === cardId);
  }
  toggleCart(c: OrderCatalogItem): void {
    if (this.inCart(c.id)) {
      this.removeCart(c.id);
      return;
    }
    const base = c.unitCode;
    this.cart.update((list) => [
      ...list,
      { cardId: c.id, name: c.name, baseUnit: base, unit: this.friendly(base), qty: base === 'г' || base === 'мл' ? 0.5 : 1 },
    ]);
  }
  setQty(cardId: number, qty: number): void {
    this.cart.update((list) => list.map((l) => (l.cardId === cardId ? { ...l, qty: Number(qty) || 0 } : l)));
  }
  setUnit(cardId: number, unit: string): void {
    this.cart.update((list) => list.map((l) => (l.cardId === cardId ? { ...l, unit } : l)));
  }
  removeCart(cardId: number): void {
    this.cart.update((list) => list.filter((l) => l.cardId !== cardId));
  }
  clearCart(): void {
    this.cart.set([]);
    this.lastViolations.set([]);
  }

  submit(force: boolean): void {
    const lines = this.cart().filter((l) => l.qty > 0);
    if (!lines.length) {
      this.err.set('Добавьте хотя бы одну позицию с количеством больше нуля');
      return;
    }
    this.placing.set(true);
    this.err.set('');
    this.msg.set('');
    const body = {
      date: this.date() ?? undefined,
      force,
      items: lines.map((l) => ({ cardId: l.cardId, qty: l.qty, unit: l.unit })),
    };
    this.api.placeOrder$(this.storeId, body).subscribe({
      next: (r) => {
        this.placing.set(false);
        // позиции, сохранённые сервером, убираем из корзины — иначе «Всё равно разместить» задвоит их
        const placed = new Set((r.created ?? []).map((c) => c.name));
        this.cart.update((list) => list.filter((l) => !placed.has(l.name)));
        this.lastViolations.set(r.violations ?? []);
        this.msg.set(r.message);
        this.date.set(this.date() ?? today());
        this.loadDates();
        this.ordersSvc.ensureCategories(true);
      },
      error: (e) => {
        this.placing.set(false);
        const det = (e as { error?: { details?: { violations?: OrderViolation[] } } })?.error?.details?.violations;
        if (det?.length) {
          this.lastViolations.set(det);
          this.err.set('Есть позиции ниже минимального количества — можно разместить принудительно.');
        } else {
          this.err.set(httpErr(e));
        }
      },
    });
  }
}
