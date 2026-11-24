import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import * as M from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = '/api';

  // ---- meta ----
  units$(): Observable<M.Unit[]> { return this.http.get<M.Unit[]>(`${this.base}/meta/units`); }
  categories$(): Observable<{ id: number; name: string }[]> { return this.http.get<{ id: number; name: string }[]>(`${this.base}/meta/categories`); }
  /** Справочник категорий номенклатуры (управляется в настройках): имя + иконка и цвет для выбора. */
  categoriesDictionary$(): Observable<{ id: number; name: string; icon?: string; color?: string }[]> {
    return this.http.get<{ id: number; name: string; icon?: string; color?: string }[]>(`${this.base}/meta/categories-dictionary`);
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
  /** Где используется позиция: полуфабрикаты и техкарты. */
  productUsage$(id: number): Observable<M.ProductUsage> {
    return this.http.get<M.ProductUsage>(`${this.base}/products/${id}/usage`);
  }
  /** Поставщики позиции по накладным. */
  productSuppliers$(id: number): Observable<M.ProductSupplier[]> {
    return this.http.get<M.ProductSupplier[]>(`${this.base}/products/${id}/suppliers`);
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
  /** Разбор накладной агентами ИИ на сервере. */
  importParseCli$(body: {
    fileName?: string;
    mime?: string;
    base64?: string;
    files?: { fileName: string; mime: string; base64: string }[];
    /** true — сервер вернёт транскрипцию агента распознавания, чтобы сверить разбор с фото */
    debug?: boolean;
  }): Observable<M.ImportParseResult> {
    return this.http.post<M.ImportParseResult>(`${this.base}/import/parse-cli`, body);
  }

  productCatalogs$(): Observable<M.ProductCatalog[]> {
    return this.http.get<M.ProductCatalog[]>(`${this.base}/meta/product-catalogs`);
  }
  /** Активные фасовки карты: ручное сопоставление строк Google-таблицы. */
  mapPackagings$(): Observable<{
    id: number; nodeId: number; nodeName: string; title: string | null; name: string;
    qtyBase: number; minOrder: number; available: boolean; price: number;
    unitCode: string; unitId: number; catalogName: string | null;
  }[]> {
    return this.http.get<{
      id: number; nodeId: number; nodeName: string; title: string | null; name: string;
      qtyBase: number; minOrder: number; available: boolean; price: number;
      unitCode: string; unitId: number; catalogName: string | null;
    }[]>(`${this.base}/production-map/packagings`);
  }

  // ---- production map (единый граф производства) ----
  productionMap$(): Observable<M.ProductionMap> {
    return this.http.get<M.ProductionMap>(`${this.base}/production-map`);
  }
  saveProductionMap(body: unknown): Observable<{
    ok: boolean;
    version: number;
    warnings: { opUid: number; opName: string; plan: number; net: number; diff: number }[];
  }> {
    return this.http.put<{
      ok: boolean;
      version: number;
      warnings: { opUid: number; opName: string; plan: number; net: number; diff: number }[];
    }>(`${this.base}/production-map`, body);
  }
  /** ИИ-раскладка: облака сырья по категориям и компактные этапы. */
  aiLayoutMap$(body: unknown, ai = true): Observable<{
    nodes: { uid: number; x: number; y: number }[];
    ops: { uid: number; x: number; y: number }[];
    summary: string;
    ai: boolean;
  }> {
    return this.http.post<{
      nodes: { uid: number; x: number; y: number }[];
      ops: { uid: number; x: number; y: number }[];
      summary: string;
      ai: boolean;
    }>(`${this.base}/production-map/ai-layout`, { ...(body as object), ai });
  }

  /** Выпуск партии по операции: списание сырья по составу с потерями. */
  produceMapBatch$(opId: number, qty?: number): Observable<M.MapProduceResult> {
    return this.http.post<M.MapProduceResult>(`${this.base}/production-map/ops/${opId}/produce`, { qty: qty ?? null });
  }
  /** Отгрузка готового: списание сырья «в обратную сторону». */
  shipMapOutput$(nodeId: number, qty?: number): Observable<M.MapShipResult> {
    return this.http.post<M.MapShipResult>(`${this.base}/production-map/nodes/${nodeId}/ship`, { qty: qty ?? null });
  }
  reverseMapBatch$(batchId: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/production-map/batches/${batchId}/reverse`, {});
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
  pointStats$(id: number): Observable<M.StoreStats> {
    return this.http.get<M.StoreStats>(`${this.base}/points/${id}/stats`);
  }
  createPoint(body: unknown): Observable<{ id: number }> { return this.http.post<{ id: number }>(`${this.base}/points`, body); }
  patchPoint(id: number, body: unknown): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/points/${id}`, body);
  }
  deactivatePoint(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/points/${id}/deactivate`, {});
  }
  activatePoint(id: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/points/${id}/activate`, {});
  }
  deletePoint(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/points/${id}`);
  }

  // ---- поставщики и накладные (только чтение) ----
  suppliers$(): Observable<M.SupplierCard[]> { return this.http.get<M.SupplierCard[]>(`${this.base}/suppliers`); }
  supplierInvoice$(id: number): Observable<M.SupplierInvoiceDetail> {
    return this.http.get<M.SupplierInvoiceDetail>(`${this.base}/suppliers/invoices/${id}`);
  }

  // ---- страница своего магазина (магазинный сотрудник) ----
  myStore$(): Observable<M.MyStore> { return this.http.get<M.MyStore>(`${this.base}/store`); }
  /** Продукция производства для формы заказа магазина (только чтение). */
  storeOrderCatalog$(): Observable<M.OrderCatalogItem[]> {
    return this.http.get<M.OrderCatalogItem[]>(`${this.base}/store/order-catalog`);
  }
  /** Заказ магазина и окно приёма на выбранную дату (без даты — ближайшая открытая). */
  storeCurrentOrder$(date?: string): Observable<M.StoreOrderWindow> {
    return this.http.get<M.StoreOrderWindow>(`${this.base}/store/orders/current`, {
      params: date ? { date } : {},
    });
  }
  /** Сохранить или изменить заказ до срока приёма (только магазин). */
  saveStoreOrder$(body: { deliveryDate: string; comment: string; items: M.StoreOrderItem[] }): Observable<M.StoreOrderWindow> {
    return this.http.put<M.StoreOrderWindow>(`${this.base}/store/orders/current`, body);
  }

  // ---- архив заказов магазинов (офис) ----
  orderArchive$(): Observable<M.OrderArchive> {
    return this.http.get<M.OrderArchive>(`${this.base}/orders/archive`);
  }
  /** Отчёт-отгрузка за дату доставки; storeId не указан — все магазины. priceMode=cost — по себестоимости. */
  orderReport$(
    date: string,
    storeId?: number,
    priceMode: 'sale' | 'cost' = 'sale',
    vatRate = 20
  ): Observable<M.OrderReport> {
    const params: Record<string, string> = { date };
    if (storeId !== undefined) params['storeId'] = String(storeId);
    if (priceMode === 'cost') params['price'] = 'cost';
    if (vatRate !== 20) params['vat'] = String(vatRate);
    return this.http.get<M.OrderReport>(`${this.base}/orders/report`, { params });
  }
  /** Сохранить ручной порядок строк отчёта-отгрузки (офис): id фасовок в новом порядке. */
  reorderReportLines$(orderId: number, packagingIds: number[]): Observable<{ ok: boolean; packagingIds: number[] }> {
    return this.http.put<{ ok: boolean; packagingIds: number[] }>(`${this.base}/orders/report/order`, { orderId, packagingIds });
  }
  /** Документы даты в PDF: один документ — сам PDF, несколько — zip-архив. */
  downloadOrderReportFile$(
    date: string,
    storeId?: number,
    priceMode: 'sale' | 'cost' = 'sale',
    vatRate = 20
  ): Observable<HttpResponse<Blob>> {
    const params: Record<string, string> = { date };
    if (storeId !== undefined) params['storeId'] = String(storeId);
    if (priceMode === 'cost') params['price'] = 'cost';
    if (vatRate !== 20) params['vat'] = String(vatRate);
    return this.http.get(`${this.base}/orders/report/pdf`, { params, responseType: 'blob', observe: 'response' });
  }
  /** Изменить количество упаковок позиции в заказе (офис) — строка заказа перезаписывается. */
  setReportLineQty$(orderId: number, packagingId: number, qty: number): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.base}/orders/report/line`, { orderId, packagingId, qty });
  }
  /** Состояние слепка цен и названий строк заказов на дату доставки. */
  priceSnapshotInfo$(date: string): Observable<{
    date: string; total: number; frozen: number; named: number; frozenAt: string | null; past: boolean;
  }> {
    return this.http.get<{
      date: string; total: number; frozen: number; named: number; frozenAt: string | null; past: boolean;
    }>(`${this.base}/orders/price-snapshot`, { params: { date } });
  }
  /** Переснять слепок прошедшей даты по текущим ценам (офис). */
  refreshPriceSnapshot$(date: string): Observable<{ ok: boolean; rows: number }> {
    return this.http.post<{ ok: boolean; rows: number }>(`${this.base}/orders/price-snapshot/refresh`, { date });
  }

  // ---- ручное списание склада по доставке (офис) ----
  /** Статус списаний на дату доставки. */
  deliveryWriteoffStatus$(date: string): Observable<{ date: string; records: M.DeliveryWriteoffRecord[] }> {
    return this.http.get<{ date: string; records: M.DeliveryWriteoffRecord[] }>(
      `${this.base}/orders/delivery-writeoff/status`,
      { params: { date } }
    );
  }
  /** Предпросмотр: какое сырьё уйдёт со склада по заказам даты (storeId — только один магазин). */
  deliveryWriteoffPreview$(date: string, storeId?: number | null): Observable<M.DeliveryWriteoffPreview> {
    const params: Record<string, string> = { date };
    if (storeId != null) params['storeId'] = String(storeId);
    return this.http.get<M.DeliveryWriteoffPreview>(`${this.base}/orders/delivery-writeoff/preview`, { params });
  }
  /** Провести ручное списание склада по доставке. */
  deliveryWriteoff$(date: string, storeId?: number | null): Observable<M.DeliveryWriteoffResult> {
    return this.http.post<M.DeliveryWriteoffResult>(`${this.base}/orders/delivery-writeoff`, {
      date,
      storeId: storeId ?? null,
    });
  }

  /** История заказов своего магазина (только магазин). */
  myOrderArchive$(): Observable<M.OrderArchive> {
    return this.http.get<M.OrderArchive>(`${this.base}/store/orders/archive`);
  }
  /** Отчёт-отгрузка своего магазина за дату доставки (только магазин). */
  myOrderReport$(date: string): Observable<M.OrderReport> {
    return this.http.get<M.OrderReport>(`${this.base}/store/orders/report`, { params: { date } });
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
  /** Значок валюты нужен всем ролям: суммы есть и в заказе магазина. */
  loadCurrency$(): Observable<M.CurrencySettings> { return this.http.get<M.CurrencySettings>(`${this.base}/currency`); }
  saveCurrency$(symbol: string): Observable<M.CurrencySettings> {
    return this.http.put<M.CurrencySettings>(`${this.base}/settings/currency`, { symbol });
  }
  saveGptSettings$(body: M.GptSettings): Observable<{ ok: boolean; gpt: M.GptSettings }> {
    return this.http.patch<{ ok: boolean; gpt: M.GptSettings }>(`${this.base}/settings/gpt`, body);
  }
  testGpt$(): Observable<M.GptTestResult> { return this.http.post<M.GptTestResult>(`${this.base}/settings/gpt/test`, {}); }

  // ---- чат с Qoder (только админ): свои диалоги у каждого пользователя ----
  qoderDialogs$(): Observable<M.QoderDialog[]> { return this.http.get<M.QoderDialog[]>(`${this.base}/qoder/dialogs`); }
  qoderDialog$(id: number): Observable<M.QoderDialogFull> {
    return this.http.get<M.QoderDialogFull>(`${this.base}/qoder/dialogs/${id}`);
  }
  createQoderDialog$(): Observable<M.QoderDialog> {
    return this.http.post<M.QoderDialog>(`${this.base}/qoder/dialogs`, {});
  }
  deleteQoderDialog$(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/qoder/dialogs/${id}`);
  }
  /** Сообщение в диалог: сервер запускает фоновую задачу агента и сразу возвращает её id. */
  sendQoderMessage$(id: number, text: string): Observable<M.QoderJobStart> {
    return this.http.post<M.QoderJobStart>(`${this.base}/qoder/dialogs/${id}/messages`, { text });
  }
  qoderJob$(jobId: string): Observable<M.QoderJob> {
    return this.http.get<M.QoderJob>(`${this.base}/qoder/jobs/${jobId}`);
  }
  qoderDialogJob$(id: number): Observable<M.QoderDialogJob> {
    return this.http.get<M.QoderDialogJob>(`${this.base}/qoder/dialogs/${id}/job`);
  }
  approveQoder$(jobId: string, approvalId: string, decision: M.QoderApprovalDecision): Observable<M.QoderJob> {
    return this.http.post<M.QoderJob>(`${this.base}/qoder/jobs/${jobId}/approvals/${approvalId}`, { decision });
  }
  cancelQoderJob$(jobId: string): Observable<M.QoderJob> {
    return this.http.post<M.QoderJob>(`${this.base}/qoder/jobs/${jobId}/cancel`, {});
  }

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
  /** Срок приёма заказа магазина: часы до конца дня доставки. */
  deliveryCutoff$(): Observable<M.DeliveryCutoff> {
    return this.http.get<M.DeliveryCutoff>(`${this.base}/settings/delivery-cutoff`);
  }
  saveDeliveryCutoff$(body: M.DeliveryCutoff): Observable<M.DeliveryCutoff> {
    return this.http.put<M.DeliveryCutoff>(`${this.base}/settings/delivery-cutoff`, body);
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
  reorderRawCategories$(ids: number[]): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.base}/settings/raw-categories/order`, { ids });
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
  reorderProductCatalogs$(ids: number[]): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.base}/settings/product-catalogs/order`, { ids });
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
  /** Импорт истории заказов магазинов из сохранённых листов в архив заказов. */
  syncOrderHistory$(): Observable<M.OrderHistoryResult> {
    return this.http.post<M.OrderHistoryResult>(`${this.base}/settings/google-sheet/order-history`, {});
  }
  /** Ручное сопоставление строки листа с фасовкой; packagingId = null — снять. */
  linkGoogleSheetRow$(tab: string, row: number, packagingId: number | null): Observable<{ ok: boolean; link: { id: number; name: string; rowName: string } | null }> {
    return this.http.post<{ ok: boolean; link: { id: number; name: string; rowName: string } | null }>(
      `${this.base}/settings/google-sheet/link`, { tab, row, packagingId });
  }

  labelsManifest$(): Observable<M.LabelManifest> {
    return this.http.get<M.LabelManifest>('/labels/labels.json');
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

  /** Сразу три коэффициента одним запросом (один процесс ИИ вместо трёх). */
  askCoefficients$(body: {
    sourceType?: 'raw' | 'semi';
    refId?: number;
    name?: string;
    unitCode?: string | null;
    context?: string | null;
  }): Observable<{ results: (M.AiCoefficient & { field: 'gPerPcs' | 'mlPerPcs' | 'gPerMl'; unit: string })[] }> {
    return this.http.post<{ results: (M.AiCoefficient & { field: 'gPerPcs' | 'mlPerPcs' | 'gPerMl'; unit: string })[] }>(
      `${this.base}/ai/coefficients`, body);
  }
}
