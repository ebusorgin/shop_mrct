import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { OrderCatalogItem, Store } from './models';

/**
 * Состояние и кеш данных заказов. Магазины/каталог/категории грузятся один раз
 * (кеш), повторные ensureX возвращают готовый сигнал без похода в API — это и есть
 * клиентский кеш, сокращающий обращения (в т.ч. косвенно — к Google Таблице на бэке).
 */
@Injectable({ providedIn: 'root' })
export class OrdersService {
  private api = inject(ApiService);

  readonly stores = signal<Store[]>([]);
  readonly catalog = signal<OrderCatalogItem[]>([]);
  readonly categories = signal<string[]>([]);

  private storesReq: Promise<void> | null = null;
  private catalogReq: Promise<void> | null = null;
  private categoriesReq: Promise<void> | null = null;

  /** Витрины 103..110 (один запрос на сессию). */
  ensureStores(): Promise<Store[]> {
    if (this.stores().length) return Promise.resolve(this.stores());
    if (!this.storesReq) {
      this.storesReq = new Promise<void>((resolve) => {
        this.api.orderStores$().subscribe({
          next: (v) => { this.stores.set(v); this.storesReq = null; resolve(); },
          error: () => { this.storesReq = null; resolve(); },
        });
      });
    }
    return this.storesReq.then(() => this.stores());
  }

  /** Каталог техкарт для оформления (один запрос на сессию). */
  ensureCatalog(): Promise<OrderCatalogItem[]> {
    if (this.catalog().length) return Promise.resolve(this.catalog());
    if (!this.catalogReq) {
      this.catalogReq = new Promise<void>((resolve) => {
        this.api.orderCatalog$().subscribe({
          next: (v) => { this.catalog.set(v); this.catalogReq = null; resolve(); },
          error: () => { this.catalogReq = null; resolve(); },
        });
      });
    }
    return this.catalogReq.then(() => this.catalog());
  }

  /** Категории строк для фильтра (сбрасывается после оформления, чтобы подхватить новые). */
  ensureCategories(force = false): Promise<string[]> {
    if (this.categories().length && !force) return Promise.resolve(this.categories());
    if (!this.categoriesReq) {
      this.categoriesReq = new Promise<void>((resolve) => {
        this.api.orderCategories$().subscribe({
          next: (v) => { this.categories.set(v); this.categoriesReq = null; resolve(); },
          error: () => { this.categoriesReq = null; resolve(); },
        });
      });
    }
    return this.categoriesReq.then(() => this.categories());
  }

  storeName(id: number): string {
    return this.stores().find((s) => s.id === id)?.name ?? `Магазин ${id}`;
  }
}
