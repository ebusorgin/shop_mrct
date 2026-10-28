export interface Unit {
  id: number;
  code: string;
  name: string;
  dimension: 'mass' | 'volume' | 'count';
  baseFactor: number;
}

export interface Product {
  id: number;
  name: string;
  category: string;
  unitId: number;
  unitCode: string;
  dimension: string;
  baseFactor: number;
  minStock: number;
  active: boolean;
  /** Срок годности в днях (null = не задан). */
  shelfLifeDays: number | null;
  /** Парные коэффициенты пересчёта между размерностями (null = связь не задана). */
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
  stockQty: number;
  avgCost: number;
}

export interface StockRow {
  productId: number;
  name: string;
  category: string;
  unitCode: string;
  qty: number;
  avgCost: number;
  minStock: number;
  low: boolean;
}

export interface Movement {
  id: number;
  productId: number;
  productName: string;
  unitCode: string;
  type: 'receipt' | 'writeoff' | 'adjustment';
  qty: number;
  unitCost: number;
  docType: string | null;
  docId: number | null;
  comment: string | null;
  created_at: string;
}

export interface WaybillShort {
  id: number;
  number: string;
  supplier: string;
  docDate: string;
  itemsCount: number;
  total: number;
  hasFile?: boolean;
  /** Число дополнительных листов фото. */
  extraCount?: number;
  status?: 'posted' | 'reversed';
}

/** Результат GPT-разбора файла накладной (одна строка документа). */
export interface ImportItem {
  rawName: string;
  /** количество уже в базовых единицах (г/мл/шт) */
  qty: number | null;
  unitId: number | null;
  /** как напечатано в документе («kg», 50) — для сверки с базовыми цифрами */
  docUnitPrinted?: string | null;
  docQtyPrinted?: number | null;
  /** печатная цена за напечатанную единицу документа (195,00 за «kom») — редактируется из накладной */
  docPricePrinted?: number | null;
  /** qty/единица пересчитаны по решению GPT «в чём класть» (упаковки -> г/мл), а не как напечатано */
  qtyForecast?: boolean;
  /** сомнение GPT по строке — карточка подсвечивается, чтобы человек посмотрел фото */
  doubt?: string | null;
  /** цена за базовую единицу — производная от денег строки (сумма ÷ количество), не вводится вручную */
  price: number | null;
  /** Ставка PDV, % (5/10/20) или null. */
  vatRate: number | null;
  /** Ставка PDV прочитана неуверенно — проверить по фото. */
  vatSuspect?: boolean;
  /** Ставку не напечатали в документе — вывели по итогам/товару, проверить. */
  vatInferred?: boolean;
  /** Деньги строки — якорь: цена за базовую единицу считается из них, а не вводится. */
  lineSum: number | null;
  /** Сумма напечатана в документе; если false — это Кол × Цена, и подпись в карточке другая. */
  lineSumPrinted?: boolean;
  match: { productId: number; name: string; unitCode: string; via: 'name' | 'alias' | 'llm' } | null;
  candidates: { productId: number; name: string; sim: number }[];
  newHint: { name: string; category: string } | null;
}

export interface ImportParseResult {
  storedFile: string;
  fileName: string;
  /** Дополнительные листы/дубли фото пакета (store-имена и исходные названия). */
  extraFiles?: { stored: string; name: string }[];
  model: string;
  doc: {
    number: string | null;
    supplier: string | null;
    date: string | null;
    supplierPib: string | null;
    currency: string | null;
    /** Сумма без PDV («Вредност»). */
    totalSum: number | null;
    /** Сумма НДС («ПДВ»). */
    totalVat: number | null;
    /** К оплате с НДС («Наплата»). */
    totalGross: number | null;
  };
  items: ImportItem[];
  /** Что проверить: спорные строки и расхождения контрольных сумм. */
  warnings: string[];
  /** Что разбор уточнил сам — справка, а не требование действовать. */
  corrections: string[];
  /** Сырая транскрипция GPT — приходит только при debug-разборе, для сверки с фото. */
  transcript?: string;
  /** Скидки и служебные начисления, посчитанные отдельно от товаров (на склад не приходовываются). */
  serviceLines?: ServiceLine[];
  /** Отдельный блок скидок из разбора GPT: подтверждённая сумма + роспись по скидкам. */
  discounts?: DiscountBlock;
}

/** Одна скидка/акция из блока discounts (не товарная строка). */
export interface ImportDiscount {
  name: string;
  /** Товар, к которому относится скидка, если связь однозначна. */
  productName: string | null;
  discountKind: 'line' | 'percent' | 'promotion' | 'unknown';
  /** Сумма скидки положительным числом; null — не напечатана/не вычислилась. */
  amount: number | null;
  percent: number | null;
  vatRate: number | null;
  /** true — уже учтена в суммах товарных строк (повторно не вычитаем); null — не определить. */
  includedInLineSum: boolean | null;
  doubt: string | null;
}

export interface DiscountBlock {
  /** Общая сумма скидок, подтверждённая документом; null — документ её не даёт. */
  total: number | null;
  items: ImportDiscount[];
  doubt: string | null;
}

/** Не-товарная строка документа: скидка (discount) или служба/доставка/плата (service). */
export interface ServiceLine {
  kind: 'discount' | 'service';
  name: string;
  amount: number | null;
}

export interface ImportConfirmResult {
  waybillId: number;
  created: { id: number; name: string }[];
  aliasesSaved: number;
}

export interface WaybillItem {
  id?: number;
  productId: number;
  productName?: string;
  qty: number;
  unitId: number;
  unitCode?: string;
  price: number;
  vatRate?: number | null;
  vatAmount?: number;
}

export interface Waybill extends WaybillShort {
  fileName?: string | null;
  /** Доп. листы фото (без байтов): [{stored, name, mime}]. */
  extraFiles?: { stored: string; name: string; mime: string }[] | null;
  currency?: string;
  supplierPib?: string | null;
  totalNet?: number | null;
  totalVat?: number | null;
  totalGross?: number | null;
  docTotalNet?: number | null;
  docTotalVat?: number | null;
  docTotalGross?: number | null;
  items?: WaybillItem[];
}

export interface SemiInput {
  id?: number;
  sourceType: 'raw' | 'semi';
  refId: number;
  name?: string;
  role: 'base' | 'additive';
  yieldPct?: number | null;
  qtyPerOutput?: number | null;
  unitCode?: string;
  unitId?: number;
}

export interface Semi {
  id: number;
  name: string;
  note: string;
  unitId: number;
  unitCode: string;
  /** Срок годности в днях (null = не задан). */
  shelfLifeDays: number | null;
  /** Парные коэффициенты пересчёта размерностей выхода (null = связь не задана). */
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
  inputs: SemiInput[];
}

export interface CardItem {
  id?: number;
  sourceType: 'raw' | 'semi';
  refId: number;
  refName?: string;
  qty: number;
  unitId: number;
  unitCode?: string;
  position?: number;
}

export interface TechCard {
  id: number;
  name: string;
  note: string;
  portionQty: number;
  portionUnitId: number;
  portionUnitCode: string;
  items: CardItem[];
}

export interface ExpansionRow {
  productId: number;
  qty: number;
  name: string;
  unitCode: string;
  stockQty: number;
  deficit?: boolean;
}

export interface Batch {
  id: number;
  cardId: number;
  cardName: string;
  portions: number;
  batchDate: string;
  costTotal: number;
  status: 'posted' | 'reversed';
  note: string;
  portionQty: number;
  portionUnitCode: string;
}

export interface BatchItem {
  productId: number;
  name: string;
  unitCode: string;
  qty: number;
  unitCost: number;
  cost: number;
}

export interface NearExpiryRow {
  name: string;
  unitCode: string;
  qty: number;
  receiptDate: string;
  expiryDate: string;
  status: 'expired' | 'soon';
}

export interface Dashboard {
  stock: { productsInStock: number; stockValue: number };
  today: { todayCost: number; todayBatches: number };
  lowStock: { name: string; unitCode: string; qty: number; minStock: number }[];
  recentBatches: { id: number; cardName: string; portions: number; batchDate: string; status: string; costTotal: number }[];
  monthWaybills: { cnt: number; total: number };
  nearExpiry: NearExpiryRow[];
}

// ================= ЗАКАЗЫ МАГАЗИНОВ (Google Таблица) =================

/** Точка продаж (витрина-магазин). id = номер точки (103..110 и далее). */
export interface Store {
  id: number;
  code: string;
  name: string;
  active?: boolean;
  position?: number;
  address?: string;
  phone?: string;
  email?: string;
  contactPerson?: string;
  openingHours?: string;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Разрез тренда: один лист-дата доставки с итогом по точке. */
export interface PointTrendPoint {
  tabDate: string;
  positions: number;
  totalCost: number | null;
}

/** Одна позиция заказа за день-лист (для подсказки на графике). */
export interface PointDayLine {
  /** техкарта (товар); для строк без карточки — отрицательный номер строки заказа */
  id: number;
  name: string;
  category: string | null;
  /** печатное количество (в единице unit) */
  qty: number;
  unit: string;
  sum: number | null;
}

/** Заказ точки за конкретную дату-лист. */
export interface PointDayOrder {
  date: string;
  positions: number;
  lines: PointDayLine[];
  totalCost: number | null;
}

/** «Здоровье» точки — read-only агрегаты по зеркалу заказов. */
export interface PointHealth {
  lastOrderDate: string | null;
  daysSince: number | null;
  lastSyncAt: string | null;
  onLatestTab: number;
  latestTab: string | null;
  badge: 'inactive' | 'none' | 'missed' | 'stale' | 'ok';
}

/** Карточка точки продаж для раздела «Точки продаж». */
export interface PointCard extends Store {
  active: boolean;
  position: number;
  address: string;
  phone: string;
  email: string;
  contactPerson: string;
  openingHours: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  health: PointHealth;
  trend: PointTrendPoint[];
}

/** Одна строка заказа (позиция товара в листе магазина). */
export interface OrderItem {
  id: number;
  storeId: number;
  storeName: string;
  cardId: number | null;
  name: string;
  sourceName: string;
  plu: string | null;
  category: string | null;
  /** минимальное количество заказа в базовой единице */
  minQty: number | null;
  /** количество в базовой единице (г/мл/шт) */
  qty: number;
  unitCode: string | null;
  /** базовая единица техкарты (г/мл/шт) */
  cardUnit: string | null;
  ek: number | null;
  vk: number | null;
  dateTab: string;
  status: string;
  source: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrdersSummary {
  lines: number;
  totalQty: number;
  qtyByUnit: Record<string, number>;
  baseUnit: string;
  totalCost: number | null;
  costLines: number;
  minOkLines: number;
  minBadLines: number;
}

export interface OrdersResult {
  items: OrderItem[];
  summary: OrdersSummary;
}

/** Дата-лист, за который у магазина есть заказы. */
export interface OrderDate {
  date: string;
  cnt: number;
  tabId: number;
  synced: boolean;
  manual: boolean;
}

/** Каталог техкарт для оформления заказа. */
export interface OrderCatalogItem {
  id: number;
  name: string;
  plu: string | null;
  unitCode: string;
  portionQty: number;
}

/** Оформленная позиция (ответ /place). qty — в базовой единице карточки. */
export interface OrderCreatedLine {
  id: number;
  name: string;
  qty: number;
  unit: string;
}

/** Позиция ниже минимального количества (ответ /place). */
export interface OrderViolation {
  name: string;
  qty: number;
  minQty: number;
  unit: string;
}

export interface PlaceOrderResult {
  ok: boolean;
  created: OrderCreatedLine[];
  merged: number[];
  violations: OrderViolation[];
  message: string;
}

/** Одна запись журнала изменений заказа. */
export interface OrderChange {
  id: number;
  changeType: string;
  sourceName: string;
  storeId: number | null;
  storeName: string | null;
  sheetName: string | null;
  tabDate: string | null;
  details: Record<string, unknown> | null;
  actor: string;
  createdAt: string;
}

export interface OrderJournal {
  lastTab: { sheetName: string; tabDate: string } | null;
  changes: OrderChange[];
}

export interface OrderSyncTab {
  sheetName: string;
  date: string | null;
  rowCount: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface OrderSyncState {
  state: {
    status: string;
    last_run_at: string | null;
    finished_at: string | null;
    tabs_synced: number | null;
    tabs_failed: number | null;
    last_error: string | null;
    next_run_at: string | null;
  } | null;
  summary: {
    tabsSeen: number; tabsParsed: number; tabsFailed: number; unchanged: number;
    ordersCreated: number; ordersChanged: number; ordersRemoved: number; full: boolean;
  } | null;
  tabs: OrderSyncTab[];
}

/** Вошедший пользователь CRM. */
export interface AuthUser {
  id: number;
  login: string;
  isAdmin: boolean;
}

/** Строка списка пользователей (раздел «Пользователи»). */
export interface AuthUserRow extends AuthUser {
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}
