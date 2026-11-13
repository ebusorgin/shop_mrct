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
  /** Справочник категорий номенклатуры (управляется в настройках). */
  categoriesDictionary$(): Observable<{ id: number; name: string }[]> {
    return this.http.get<{ id: number; name: string }[]>(`${this.base}/meta/categories-dictionary`);
  }

  // ---- products ----
  products$(params?: Record<string, string>): Observable<M.Product[]> {
    let hp = new HttpParams();
    Object.entries(params ?? {}).forEach(([k, v]) => (hp = hp.set(k, v)));
    return this.http.get<M.Product[]>(`${this.base}/products`, { params: hp });
  }
  createProduct(body: unknown): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/products`, body);
  }
  /** Одна позиция номенклатуры целиком (для модалки редактирования из других страниц). */
  product$(id: number): Observable<M.Product> {
    return this.http.get<M.Product>(`${this.base}/products/${id}`);
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
  /** заготовки каталога — они же «мои схемы» конструктора (список отдаёт only hasBoard) */
  semis$(): Observable<M.Semi[]> { return this.http.get<M.Semi[]>(`${this.base}/semis`); }
  /** одна заготовка со столом конструктора (board) */
  semi$(id: number): Observable<M.Semi> { return this.http.get<M.Semi>(`${this.base}/semis/${id}`); }
  createSemi(body: unknown): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${this.base}/semis`, body); }
  patchSemi(id: number, body: unknown): Observable<unknown> { return this.http.patch(`${this.base}/semis/${id}`, body); }
  deleteSemi(id: number): Observable<unknown> { return this.http.delete(`${this.base}/semis/${id}`); }

  // ---- cards ----
  cards$(): Observable<M.TechCard[]> { return this.http.get<M.TechCard[]>(`${this.base}/cards`); }
  productCatalogs$(): Observable<M.ProductCatalog[]> {
    return this.http.get<M.ProductCatalog[]>(`${this.base}/meta/product-catalogs`);
  }
  createCard(body: unknown): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${this.base}/cards`, body); }
  patchCard(id: number, body: unknown): Observable<unknown> { return this.http.patch(`${this.base}/cards/${id}`, body); }
  deleteCard(id: number): Observable<unknown> { return this.http.delete(`${this.base}/cards/${id}`); }
  cardExpansion$(cardId: number, portions: number): Observable<M.ExpansionRow[]> {
    return this.http.get<M.ExpansionRow[]>(`${this.base}/cards/${cardId}/expansion`, {
      params: new HttpParams().set('portions', String(portions)),
    });
  }

  // ---- dashboard ----
  /** Панель и список сроков годности (expiryLimit — сколько строк nearExpiry вернуть). */
  dashboard$(params: Record<string, string> = {}): Observable<M.Dashboard> {
    let hp = new HttpParams();
    Object.entries(params).forEach(([k, v]) => hp = hp.set(k, v));
    return this.http.get<M.Dashboard>(`${this.base}/dashboard`, { params: hp });
  }

  // ---- точки продаж (справочник магазинов) ----
  points$(): Observable<M.PointCard[]> { return this.http.get<M.PointCard[]>(`${this.base}/points`); }
  point$(id: number): Observable<M.PointCard> { return this.http.get<M.PointCard>(`${this.base}/points/${id}`); }
  createPoint(body: unknown): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${this.base}/points`, body); }
  patchPoint(id: number, body: unknown): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/points/${id}`, body);
  }
  deactivatePoint(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/points/${id}/deactivate`, {});
  }
  deletePoint(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/points/${id}`);
  }

  // ---- страница своего магазина (магазинный сотрудник) ----
  myStore$(): Observable<M.MyStore> { return this.http.get<M.MyStore>(`${this.base}/store`); }
  /** Продукция производства для формы заказа магазина (только чтение). */
  storeOrderCatalog$(): Observable<M.OrderCatalogItem[]> {
    return this.http.get<M.OrderCatalogItem[]>(`${this.base}/store/order-catalog`);
  }

  // ---- журнал действий (кто, что, когда) ----
  audit$(params: Record<string, string> = {}): Observable<M.AuditPage> {
    let hp = new HttpParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) hp = hp.set(k, v);
    });
    return this.http.get<M.AuditPage>(`${this.base}/audit`, { params: hp });
  }

  // ---- настройки CRM (только админ) ----
  settings$(): Observable<M.AppSettings> { return this.http.get<M.AppSettings>(`${this.base}/settings`); }
  saveGptSettings$(body: M.GptSettings): Observable<{ ok: boolean; gpt: M.GptSettings }> {
    return this.http.patch<{ ok: boolean; gpt: M.GptSettings }>(`${this.base}/settings/gpt`, body);
  }
  testGpt$(): Observable<M.GptTestResult> { return this.http.post<M.GptTestResult>(`${this.base}/settings/gpt/test`, {}); }

  deliveryCalendar$(): Observable<M.DeliveryCalendar> {
    return this.http.get<M.DeliveryCalendar>(`${this.base}/settings/delivery-calendar`);
  }
  setDeliveryDate$(date: string, enabled: boolean): Observable<{ date: string; enabled: boolean }> {
    return this.http.put<{ date: string; enabled: boolean }>(`${this.base}/settings/delivery-calendar/${date}`, { enabled });
  }
  /** Правило повторов из справочника периодов: дат в расписании оно не оставляет. */
  deliveryRule$(): Observable<M.DeliveryRule> {
    return this.http.get<M.DeliveryRule>(`${this.base}/settings/delivery-rule`);
  }
  saveDeliveryRule$(body: M.DeliveryRule): Observable<{ ok: boolean; rule: M.DeliveryRule }> {
    return this.http.patch<{ ok: boolean; rule: M.DeliveryRule }>(`${this.base}/settings/delivery-rule`, body);
  }

  // ---- категории сырья (в настройках, только админ) ----
  rawCategories$(): Observable<M.RawCategory[]> { return this.http.get<M.RawCategory[]>(`${this.base}/settings/raw-categories`); }
  createRawCategory$(name: string, icon = '', color = ''): Observable<{ id: number; name: string }> {
    return this.http.post<{ id: number; name: string }>(`${this.base}/settings/raw-categories`, { name, icon, color });
  }
  updateRawCategory$(id: number, patch: { name?: string; icon?: string; color?: string }): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/settings/raw-categories/${id}`, patch);
  }
  deleteRawCategory$(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/settings/raw-categories/${id}`);
  }
  allRawProducts$(): Observable<M.RawProductRef[]> {
    return this.http.get<M.RawProductRef[]>(`${this.base}/settings/raw-products-all`);
  }

  // ---- каталог продукции (в настройках, только админ) ----
  productCatalogList$(): Observable<M.ProductCatalog[]> {
    return this.http.get<M.ProductCatalog[]>(`${this.base}/settings/product-catalogs`);
  }
  createProductCatalog$(name: string, icon = '', color = ''): Observable<M.ProductCatalog> {
    return this.http.post<M.ProductCatalog>(`${this.base}/settings/product-catalogs`, { name, icon, color });
  }
  updateProductCatalog$(id: number, patch: { name?: string; icon?: string; color?: string }): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/settings/product-catalogs/${id}`, patch);
  }
  deleteProductCatalog$(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/settings/product-catalogs/${id}`);
  }

  // ---- синхронизация Excel: сохранённая Google-таблица и её обновление из Google ----
  googleSheet$(): Observable<M.GoogleSheet | null> {
    return this.http.get<M.GoogleSheet | null>(`${this.base}/settings/google-sheet`);
  }
  syncGoogleSheet$(): Observable<M.GoogleSheet> {
    return this.http.post<M.GoogleSheet>(`${this.base}/settings/google-sheet/sync`, {});
  }
  /** Ручное сопоставление строки листа с фасовкой; packagingId = null — снять. */
  linkGoogleSheetRow$(tab: string, row: number, packagingId: number | null): Observable<{ ok: boolean; link: { id: number; name: string; rowName: string } | null }> {
    return this.http.post<{ ok: boolean; link: { id: number; name: string; rowName: string } | null }>(
      `${this.base}/settings/google-sheet/link`, { tab, row, packagingId });
  }

  // ---- подсказки ИИ: спросить значение, подставить в поле (сохраняет человек) ----
  askCoefficient$(body: {
    sourceType?: 'raw' | 'semi';
    /** Сохранённая позиция: сервер сам возьмёт её карточку из базы. */
    refId?: number;
    /** Ещё не сохранённая позиция: описываем её сами. */
    name?: string;
    unitCode?: string | null;
    context?: string | null;
    field: 'gPerPcs' | 'mlPerPcs' | 'gPerMl';
  }): Observable<M.AiCoefficient> {
    return this.http.post<M.AiCoefficient>(`${this.base}/ai/coefficient`, body);
  }
}
