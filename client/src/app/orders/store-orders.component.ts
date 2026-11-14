import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { fmtQty, httpErr } from '../core/format';
import { OrderCatalogItem, StoreOrder, StoreOrderWindow } from '../core/models';
import { LangService } from '../core/lang.service';
import { localizedName } from '../core/localized-name';

/**
 * Заказ продукции производства из аккаунта магазина.
 *
 * Доступен только магазинному пользователю (storeGuard) и грузит продукцию
 * через /api/store/order-catalog — офисный /api/cards магазину недоступен.
 * Раскладка «каталог + чек»: слева каталоги, в центре фасовки с минимальным
 * заказом, справа заказ. Сохранённый заказ можно менять до срока приёма.
 */
interface CatalogMeta {
  key: string;
  id: number | null;
  name: string;
  icon: string;
  tone: number;
}

interface CatalogGroup extends CatalogMeta {
  items: OrderCatalogItem[];
}

@Component({
  selector: 'app-store-orders',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './store-orders.component.html',
  styleUrl: './store-orders.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StoreOrdersComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private route = inject(ActivatedRoute);
  private lang = inject(LangService);
  auth = inject(AuthService);

  items = signal<OrderCatalogItem[]>([]);
  loading = signal(false);
  err = signal('');
  msg = signal('');
  query = signal('');
  /** null — все каталоги, 'none' — продукция без каталога. */
  catalogFilter = signal<number | 'none' | null>(null);
  /** id фасовки -> количество упаковок; отсутствие ключа = 0. */
  qty = signal<Record<number, number>>({});
  /** Комментарий к заказу. */
  comment = signal('');

  /** Окно приёма и сохранённый заказ на ближайшую доставку. */
  orderInfo = signal<StoreOrderWindow | null>(null);
  savedOrder = signal<StoreOrder | null>(null);
  saving = signal(false);
  saveErr = signal('');
  /** Тикающие «сейчас» — для живого таймера; минута точности достаточно. */
  now = signal(Date.now());

  fmtQty = fmtQty;
  readonly today = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

  /** Каталоги и их порядок берём из ответа сервера (position каталога, затем название). */
  catalogs = computed<CatalogMeta[]>(() => {
    const out: CatalogMeta[] = [];
    const seen = new Set<number>();
    for (const p of this.items()) {
      if (p.catalogId == null || seen.has(p.catalogId)) continue;
      seen.add(p.catalogId);
      out.push({
        key: `c${p.catalogId}`,
        id: p.catalogId,
        name: p.catalogName || 'Без каталога',
        icon: p.catalogIcon || '',
        tone: (out.length % 5) + 1,
      });
    }
    return out;
  });

  /** Стабильная цветовая пара каталога по его порядку. */
  toneById = computed(() => new Map(this.catalogs().map((c) => [c.id as number, c.tone])));

  private normalizedQuery = computed(() => this.query().trim().toLocaleLowerCase('ru'));

  /** Сколько позиций каталога подходит под поиск (фильтр каталога не учитываем). */
  queryCounts = computed(() => {
    const q = this.normalizedQuery();
    const counts = new Map<number | null, number>();
    for (const p of this.items()) {
      if (q && !this.matches(p, q)) continue;
      const key = p.catalogId ?? null;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });

  queryTotal = computed(() => {
    const q = this.normalizedQuery();
    return q ? this.items().filter((p) => this.matches(p, q)).length : this.items().length;
  });

  groups = computed<CatalogGroup[]>(() => {
    const q = this.normalizedQuery();
    const only = this.catalogFilter();
    const visible = this.items().filter((p) => {
      if (only !== null && (p.catalogId ?? 'none') !== only) return false;
      return !q || this.matches(p, q);
    });

    const byCat = new Map<number | null, OrderCatalogItem[]>();
    for (const p of visible) {
      const key = p.catalogId ?? null;
      const list = byCat.get(key);
      if (list) list.push(p);
      else byCat.set(key, [p]);
    }

    const out: CatalogGroup[] = [];
    for (const c of this.catalogs()) {
      const items = byCat.get(c.id) ?? [];
      if (!items.length) continue;
      out.push({ ...c, items });
    }
    const orphans = byCat.get(null) ?? [];
    if (orphans.length) out.push({ key: 'none', id: null, name: 'Без каталога', icon: '', tone: 0, items: orphans });
    return out;
  });

  visibleCount = computed(() => this.groups().reduce((sum, g) => sum + g.items.length, 0));

  /** Позиции в порядке сервера: каталог, затем название продукта. */
  selected = computed(() => {
    const qty = this.qty();
    return this.items().filter((p) => (qty[p.id] ?? 0) > 0);
  });

  selectedCount = computed(() => this.selected().length);
  totalPackages = computed(() => this.selected().reduce((sum, p) => sum + (this.qty()[p.id] ?? 0), 0));

  /** Общий вес заказа в граммах: сумма веса упаковок (объём и штучный товар в вес не входят). */
  totalWeight = computed(() => {
    const qty = this.qty();
    return this.selected().reduce(
      (sum, p) => (p.unitCode === 'г' ? sum + (qty[p.id] ?? 0) * p.qtyBase : sum),
      0
    );
  });

  private readonly deliveryFormat = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long',
  });
  private readonly deadlineFormat = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  private readonly savedFormat = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  /** Ближайшая доставка с открытым приёмом и момент его закрытия (с сервера). */
  orderDeadline = computed<{ date: string; deadline: Date } | null>(() => {
    const info = this.orderInfo();
    if (!info?.deliveryDate || !info.deadline) return null;
    const deadline = new Date(info.deadline);
    return Number.isNaN(deadline.getTime()) ? null : { date: info.deliveryDate, deadline };
  });

  /** Приём ещё открыт: до срока заказ можно менять и сохранять. */
  windowOpen = computed(() => {
    const info = this.orderDeadline();
    return !!info && info.deadline.getTime() > this.now();
  });

  /** Состав или комментарий отличаются от сохранённого заказа. */
  orderDirty = computed(() => {
    const saved = this.savedOrder();
    const qty = this.qty();
    const savedQty = new Map((saved?.items ?? []).map((item) => [item.packagingId, item.qty]));
    const ids = new Set([...Object.keys(qty).map(Number), ...savedQty.keys()]);
    for (const id of ids) if ((qty[id] ?? 0) !== (savedQty.get(id) ?? 0)) return true;
    return this.comment().trim() !== (saved?.comment ?? '').trim();
  });

  savedLabel = computed(() => {
    const order = this.savedOrder();
    return order ? this.savedFormat.format(new Date(order.updatedAt)) : '';
  });

  deliveryLabel = computed(() => {
    const info = this.orderDeadline();
    return info ? this.deliveryFormat.format(new Date(`${info.date}T00:00:00`)) : '';
  });

  deadlineLabel = computed(() => {
    const info = this.orderDeadline();
    return info ? this.deadlineFormat.format(info.deadline) : '';
  });

  deadlineCountdown = computed(() => {
    const info = this.orderDeadline();
    if (!info) return '';
    const totalMinutes = Math.max(0, Math.ceil((info.deadline.getTime() - this.now()) / 60_000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];
    if (days) parts.push(`${days} д`);
    if (hours) parts.push(`${hours} ч`);
    if (minutes || !parts.length) parts.push(`${minutes} мин`);
    return parts.join(' ');
  });

  deadlineSoon = computed(() => {
    const info = this.orderDeadline();
    return !!info && info.deadline.getTime() - this.now() < 6 * 3_600_000;
  });

  /** Дата доставки из календаря истории (?date=); без неё — ближайшая открытая. */
  private readonly requestedDate = this.route.snapshot.queryParamMap.get('date') || undefined;

  ngOnInit(): void {
    this.load();
    const timer = setInterval(() => this.now.set(Date.now()), 15_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.err.set('');
    this.saveErr.set('');
    forkJoin({ catalog: this.api.storeOrderCatalog$(), window: this.api.storeCurrentOrder$(this.requestedDate) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ catalog, window }) => {
          this.items.set(catalog);
          this.orderInfo.set(window);
          this.savedOrder.set(window.order);
          const qty: Record<number, number> = {};
          for (const item of window.order?.items ?? []) qty[item.packagingId] = item.qty;
          this.qty.set(qty);
          this.comment.set(window.order?.comment ?? '');
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  /** Название позиции на текущем языке интерфейса; пустой перевод — основное. */
  displayName(p: OrderCatalogItem): string {
    return localizedName(p, this.lang.currentLang());
  }

  private matches(p: OrderCatalogItem, q: string): boolean {
    return `${p.name} ${p.nameEn ?? ''} ${p.nameSr ?? ''} ${p.note || ''} ${p.catalogName || ''}`
      .toLocaleLowerCase('ru')
      .includes(q);
  }

  qtyOf(id: number): number {
    return this.qty()[id] ?? 0;
  }

  /** Вес позиции заказа в базовых единицах фасовки (г/мл/шт). */
  weightOf(p: OrderCatalogItem): number {
    return this.qtyOf(p.id) * p.qtyBase;
  }

  /** Первый шаг из нуля — сразу минимальный заказ. */
  inc(p: OrderCatalogItem): void {
    const current = this.qtyOf(p.id);
    this.setQty(p.id, current === 0 ? p.minOrder : current + 1);
  }

  dec(p: OrderCatalogItem): void {
    const current = this.qtyOf(p.id);
    if (!current) return;
    const next = current - 1;
    this.setQty(p.id, next < p.minOrder ? 0 : next);
  }

  private setQty(id: number, value: number): void {
    if (!this.windowOpen()) return;
    const n = Math.max(0, Math.min(999, Math.floor(value) || 0));
    this.qty.update((m) => {
      const next = { ...m };
      if (n > 0) next[id] = n;
      else delete next[id];
      return next;
    });
    this.msg.set('');
  }

  selectCatalog(id: number | 'none' | null): void {
    this.catalogFilter.set(id);
  }

  resetFilters(): void {
    this.query.set('');
    this.catalogFilter.set(null);
  }

  clearOrder(): void {
    if (!this.windowOpen()) return;
    this.qty.set({});
    this.comment.set('');
    this.msg.set('Черновик очищен — сохранённый заказ не изменился.');
  }

  /** Сохранить заказ на ближайшую доставку; до срока приёма можно сохранять многократно. */
  saveOrder(): void {
    const deadline = this.orderDeadline();
    if (!deadline || !this.windowOpen() || !this.selectedCount() || this.saving()) return;
    const wasSaved = !!this.savedOrder();
    this.saving.set(true);
    this.saveErr.set('');
    this.msg.set('');
    const items = this.selected().map((p) => ({ packagingId: p.id, qty: this.qtyOf(p.id) }));
    this.api
      .saveStoreOrder$({ deliveryDate: deadline.date, comment: this.comment().trim(), items })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => {
          this.saving.set(false);
          this.orderInfo.set(info);
          this.savedOrder.set(info.order);
          this.msg.set(
            wasSaved
              ? `Изменения сохранены · доставка ${this.deliveryLabel()}`
              : `Заказ оформлен на доставку ${this.deliveryLabel()}`
          );
        },
        error: (e) => {
          this.saving.set(false);
          this.saveErr.set(`Не удалось сохранить заказ: ${httpErr(e)}`);
        },
      });
  }

  plural(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  /** Иллюстрация строки: тип блюда для маленькой SVG-картинки. */
  kindOf(p: OrderCatalogItem): 'soup' | 'frozen' | 'hot' | 'jar' {
    const cat = (p.catalogName ?? '').toLocaleLowerCase('ru');
    const name = p.name.toLocaleLowerCase('ru');
    if (cat.includes('суп') || /суп|борщ|солянк|харчо/.test(name)) return 'soup';
    if (cat.includes('замороз')) return 'frozen';
    if (cat.includes('горяч')) return 'hot';
    if (p.unitCode === 'шт') return 'frozen';
    return 'jar';
  }

  toneOf(catalogId: number | null | undefined): number {
    return catalogId == null ? 0 : this.toneById().get(catalogId) ?? 1;
  }
}
