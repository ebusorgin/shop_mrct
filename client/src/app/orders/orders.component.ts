import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ApiService } from '../core/api.service';
import { fmtQty, httpErr } from '../core/format';
import { ProductCatalog, TechCard } from '../core/models';

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

  products = signal<TechCard[]>([]);
  catalogs = signal<ProductCatalog[]>([]);
  loading = signal(false);
  err = signal('');
  query = signal('');
  catalogFilter = signal('');
  fmtQty = fmtQty;

  catalogsById = computed(() => new Map(this.catalogs().map((c) => [c.id, c])));
  hasFilters = computed(() => !!this.query().trim() || !!this.catalogFilter());
  filtered = computed(() => {
    const query = this.query().trim().toLocaleLowerCase('ru');
    const catalog = this.catalogFilter();
    return this.products().filter((p) => {
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
    forkJoin({ products: this.api.cards$(), catalogs: this.api.productCatalogs$() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ products, catalogs }) => {
          this.products.set(products);
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
