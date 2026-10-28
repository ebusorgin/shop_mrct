import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import * as M from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = '/api';

  // ---- meta ----
  units$(): Observable<M.Unit[]> { return this.http.get<M.Unit[]>(`${this.base}/meta/units`); }
  categories$(): Observable<string[]> { return this.http.get<string[]>(`${this.base}/meta/categories`); }

  // ---- products ----
  products$(params?: Record<string, string>): Observable<M.Product[]> {
    let hp = new HttpParams();
    Object.entries(params ?? {}).forEach(([k, v]) => (hp = hp.set(k, v)));
    return this.http.get<M.Product[]>(`${this.base}/products`, { params: hp });
  }
  createProduct(body: unknown): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/products`, body);
  }
  patchProduct(id: number, body: unknown): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/products/${id}`, body);
  }
  deleteProduct(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/products/${id}`);
  }

  // ---- stock ----
  stock$(): Observable<M.StockRow[]> { return this.http.get<M.StockRow[]>(`${this.base}/stock`); }
  movements$(params: Record<string, string>): Observable<M.Movement[]> {
    let hp = new HttpParams();
    Object.entries(params).forEach(([k, v]) => (hp = hp.set(k, v)));
    return this.http.get<M.Movement[]>(`${this.base}/stock/movements`, { params: hp });
  }
  adjust(body: { productId: number; delta: number; comment?: string }): Observable<unknown> {
    return this.http.post(`${this.base}/stock/adjustments`, body);
  }

  // ---- waybills ----
  waybills$(): Observable<M.WaybillShort[]> { return this.http.get<M.WaybillShort[]>(`${this.base}/waybills`); }
  waybill$(id: number): Observable<M.Waybill> { return this.http.get<M.Waybill>(`${this.base}/waybills/${id}`); }
  createWaybill(body: unknown): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/waybills`, body);
  }
  reverseWaybill$(id: number): Observable<{ ok: boolean; productsRecalculated: number }> {
    return this.http.post<{ ok: boolean; productsRecalculated: number }>(`${this.base}/waybills/${id}/reverse`, {});
  }

  // ---- импорт накладных из файлов (GPT) ----
  importParse$(body: {
    fileName?: string;
    mime?: string;
    base64?: string;
    files?: { fileName: string; mime: string; base64: string }[];
    /** true — сервер вернёт ещё и транскрипцию GPT, чтобы сверить разбор с фото */
    debug?: boolean;
  }): Observable<M.ImportParseResult> {
    return this.http.post<M.ImportParseResult>(`${this.base}/import/parse`, body);
  }
  importConfirm$(body: unknown): Observable<M.ImportConfirmResult> {
    return this.http.post<M.ImportConfirmResult>(`${this.base}/import/confirm`, body);
  }

  // ---- semis ----
  semis$(): Observable<M.Semi[]> { return this.http.get<M.Semi[]>(`${this.base}/semis`); }
  createSemi(body: unknown): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${this.base}/semis`, body); }
  patchSemi(id: number, body: unknown): Observable<unknown> { return this.http.patch(`${this.base}/semis/${id}`, body); }
  deleteSemi(id: number): Observable<unknown> { return this.http.delete(`${this.base}/semis/${id}`); }

  // ---- cards ----
  cards$(): Observable<M.TechCard[]> { return this.http.get<M.TechCard[]>(`${this.base}/cards`); }
  createCard(body: unknown): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${this.base}/cards`, body); }
  patchCard(id: number, body: unknown): Observable<unknown> { return this.http.patch(`${this.base}/cards/${id}`, body); }
  deleteCard(id: number): Observable<unknown> { return this.http.delete(`${this.base}/cards/${id}`); }
  cardExpansion$(cardId: number, portions: number): Observable<M.ExpansionRow[]> {
    return this.http.get<M.ExpansionRow[]>(`${this.base}/cards/${cardId}/expansion`, {
      params: new HttpParams().set('portions', String(portions)),
    });
  }

  // ---- batches ----
  batches$(): Observable<M.Batch[]> { return this.http.get<M.Batch[]>(`${this.base}/batches`); }
  batchItems$(id: number): Observable<M.BatchItem[]> {
    return this.http.get<M.BatchItem[]>(`${this.base}/batches/${id}`);
  }
  createBatch(body: unknown): Observable<{ id: number; costTotal: number }> {
    return this.http.post<{ id: number; costTotal: number }>(`${this.base}/batches`, body);
  }
  reverseBatch(id: number): Observable<unknown> {
    return this.http.post(`${this.base}/batches/${id}/reverse`, {});
  }

  // ---- dashboard ----
  dashboard$(): Observable<M.Dashboard> { return this.http.get<M.Dashboard>(`${this.base}/dashboard`); }

  // ---- заказы магазинов (Google Таблица) ----
  orderStores$(): Observable<M.Store[]> { return this.http.get<M.Store[]>(`${this.base}/orders/stores`); }
  orderDates$(store: number): Observable<M.OrderDate[]> {
    return this.http.get<M.OrderDate[]>(`${this.base}/orders/dates`, { params: new HttpParams().set('store', String(store)) });
  }
  orderCategories$(): Observable<string[]> { return this.http.get<string[]>(`${this.base}/orders/categories`); }
  orderCatalog$(): Observable<M.OrderCatalogItem[]> { return this.http.get<M.OrderCatalogItem[]>(`${this.base}/orders/catalog`); }
  orders$(params: Record<string, string>): Observable<M.OrdersResult> {
    let hp = new HttpParams();
    Object.entries(params).forEach(([k, v]) => (hp = hp.set(k, v)));
    return this.http.get<M.OrdersResult>(`${this.base}/orders`, { params: hp });
  }
  placeOrder$(store: number, body: unknown): Observable<M.PlaceOrderResult> {
    return this.http.post<M.PlaceOrderResult>(
      `${this.base}/orders/place`, body, { params: new HttpParams().set('store', String(store)) });
  }
  patchOrder$(id: number, body: unknown): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/orders/${id}`, body);
  }
  orderJournal$(params: Record<string, string> = {}): Observable<M.OrderJournal> {
    let hp = new HttpParams();
    Object.entries(params).forEach(([k, v]) => (hp = hp.set(k, v)));
    return this.http.get<M.OrderJournal>(`${this.base}/orders/journal`, { params: hp });
  }
  orderSync$(): Observable<M.OrderSyncState> { return this.http.get<M.OrderSyncState>(`${this.base}/orders/sync`); }
  runOrderSync$(full: boolean): Observable<{ ok: boolean; started: boolean; full: boolean }> {
    return this.http.post<{ ok: boolean; started: boolean; full: boolean }>(`${this.base}/orders/sync`, {}, {
      params: full ? new HttpParams().set('full', '1') : new HttpParams(),
    });
  }
}
