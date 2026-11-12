import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { fmtQty, httpErr } from '../core/format';
import { OrderCatalogItem } from '../core/models';

/**
 * Заказ продукции производства из аккаунта магазина.
 *
 * Доступен только магазинному пользователю (storeGuard) и грузит продукцию
 * через /api/store/order-catalog — офисный /api/cards магазину недоступен.
 * Раскладка «каталог + чек»: слева каталоги, в центре продукция с шагом
 * порций, справа черновик заказа. Отправки на сервер пока нет.
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
  auth = inject(AuthService);

  items = signal<OrderCatalogItem[]>([]);
  loading = signal(false);
  err = signal('');
  msg = signal('');
  query = signal('');
  /** null — все каталоги, 'none' — продукция без каталога. */
  catalogFilter = signal<number | 'none' | null>(null);
  /** id продукции -> количество порций; отсутствие ключа = 0. */
  qty = signal<Record<number, number>>({});

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
  totalPortions = computed(() => this.selected().reduce((sum, p) => sum + (this.qty()[p.id] ?? 0), 0));

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.err.set('');
    this.api.storeOrderCatalog$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (items) => {
          this.items.set(items);
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  private matches(p: OrderCatalogItem, q: string): boolean {
    return `${p.name} ${p.note || ''} ${p.catalogName || ''}`.toLocaleLowerCase('ru').includes(q);
  }

  qtyOf(id: number): number {
    return this.qty()[id] ?? 0;
  }

  inc(id: number): void {
    this.setQty(id, this.qtyOf(id) + 1);
  }

  dec(id: number): void {
    this.setQty(id, this.qtyOf(id) - 1);
  }

  private setQty(id: number, value: number): void {
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
    this.qty.set({});
    this.msg.set('Черновик заказа очищен.');
  }

  submitOrder(): void {
    const n = this.selectedCount();
    if (!n) return;
    this.msg.set(
      `Черновик заказа: ${n} ${this.plural(n, 'позиция', 'позиции', 'позиций')} · ` +
        `${this.totalPortions()} ${this.plural(this.totalPortions(), 'порция', 'порции', 'порций')} — ` +
        'отправка на производство появится позже'
    );
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
    if (p.portionUnitCode === 'шт') return 'frozen';
    return 'jar';
  }

  toneOf(catalogId: number | null | undefined): number {
    return catalogId == null ? 0 : this.toneById().get(catalogId) ?? 1;
  }
}
