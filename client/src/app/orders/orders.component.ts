import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ApiService } from '../core/api.service';
import { fmtQty, httpErr } from '../core/format';
import { ProductCatalog, TechCard } from '../core/models';
import { packagingLabel } from '../core/packaging-label';

/** Строка списка — продаваемая фасовка техкарты. */
interface SaleRow {
  id: number;
  cardId: number;
  name: string;
  catalogId: number | null;
  catalogName: string | null;
  qtyBase: number;
  unitCode: string;
  minOrder: number;
}

@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './orders.component.html',
  styleUrl: './orders.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrdersComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  cards = signal<TechCard[]>([]);
  catalogs = signal<ProductCatalog[]>([]);
  loading = signal(false);
  err = signal('');
  query = signal('');
  catalogFilter = signal('');
  fmtQty = fmtQty;

  /** Плоский список: каждая доступная к заказу фасовка — отдельная позиция. */
  rows = computed<SaleRow[]>(() =>
    this.cards().flatMap((card) =>
      (card.packagings ?? []).filter((pk) => pk.available).map((pk) => ({
        id: pk.id,
        cardId: card.id,
        name: packagingLabel(card.name, fmtQty(pk.qtyBase, card.portionUnitCode)),
        catalogId: card.catalogId ?? null,
        catalogName: card.catalogName ?? null,
        qtyBase: pk.qtyBase,
        unitCode: card.portionUnitCode,
        minOrder: pk.minOrder,
      }))
    )
  );

  catalogsById = computed(() => new Map(this.catalogs().map((c) => [c.id, c])));
  hasFilters = computed(() => !!this.query().trim() || !!this.catalogFilter());
  filtered = computed(() => {
    const query = this.query().trim().toLocaleLowerCase('ru');
    const catalog = this.catalogFilter();
    return this.rows().filter((p) => {
      if (catalog && (catalog === 'none' ? p.catalogId != null : p.catalogId !== Number(catalog))) return false;
      return !query || `${p.name} ${p.catalogName ?? ''}`.toLocaleLowerCase('ru').includes(query);
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.err.set('');
    forkJoin({ cards: this.api.cards$(), catalogs: this.api.productCatalogs$() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ cards, catalogs }) => {
          this.cards.set(cards);
          this.catalogs.set(catalogs);
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  resetFilters(): void {
    this.query.set('');
    this.catalogFilter.set('');
  }
}
