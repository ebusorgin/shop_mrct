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
  /** Кто сделал движение (логин); null — система/старые записи. */
  userLogin?: string | null;
  /** ФИО автора движения (без ФИО — логин). */
  userName?: string | null;
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
  /** Кто принял накладную на склад и когда. */
  acceptedLogin?: string | null;
  acceptedName?: string | null;
  acceptedAt?: string | null;
  /** Кто отменил приход и когда (только для отменённых). */
  reversedLogin?: string | null;
  reversedName?: string | null;
  reversedAt?: string | null;
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

/**
 * Вход состава заготовки. Ролей больше нет: у каждого входа своё количество
 * НА ПАРТИЮ (в базовых единицах самого входа) и свой необязательный выход после обработки.
 */
export interface SemiInput {
  id?: number;
  sourceType: 'raw' | 'semi';
  refId: number;
  name?: string;
  /** количество входа на партию, в базовых единицах входа */
  qty: number;
  /** выход после обработки этого входа, % (null = без потерь) */
  yieldPct?: number | null;
  unitCode?: string;
  unitId?: number;
}

export interface Semi {
  id: number;
  name: string;
  note: string;
  unitId: number;
  unitCode: string;
  /** размер партии: сколько заготовки (в базовых единицах выхода) даёт состав */
  outQty: number;
  /** Срок годности в днях (null = не задан). */
  shelfLifeDays: number | null;
  /** Парные коэффициенты пересчёта размерностей выхода (null = связь не задана). */
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
  inputs: SemiInput[];
  /** стол конструктора (блоки + связи) этой же заготовки; null — заготовка не собиралась на столе */
  board?: DiagramData | null;
  /** есть ли сохранённый стол (список отдаёт только признак, сам jsonb тяжёлый) */
  hasBoard?: boolean;
}

export interface CardItem {
  id?: number;
  sourceType: 'raw' | 'semi' | 'product';
  refId: number;
  refName?: string;
  refNameEn?: string;
  refNameSr?: string;
  qty: number;
  unitId: number;
  unitCode?: string;
  position?: number;
}

/** Фасовка техкарты — продаваемая позиция (SKU): выход упаковки и минимальный заказ. */
export interface Packaging {
  id: number;
  /** Выход одной упаковки в единице выхода техкарты. */
  qtyBase: number;
  /** Минимальный заказ в упаковках. */
  minOrder: number;
  /** Можно ли уже заказывать эту фасовку магазинам. */
  available: boolean;
  /** Цена за кг / л / шт (RSD); 0 — не задана. */
  price: number;
}

export type PackagingInput = Omit<Packaging, 'id'> & { id?: number };

/** Строка отчёта-отгрузки (Otpremnica): количество уже в кг / л / шт. */
export interface ReportLine {
  name: string;
  unit: 'kg' | 'l' | 'kom';
  qty: number;
  price: number;
  vatRate: number;
  net: number;
  vat: number;
  gross: number;
}

/** Документ отчёта по заказу одного магазина за дату доставки. */
export interface ReportDoc {
  number: string;
  deliveryDate: string;
  savedAt: string;
  supplier: { name: string; address: string; pib: string; mbr: string; account: string };
  buyer: { name: string; address: string; pib: string; mbr: string; account: string };
  lines: ReportLine[];
  net: number;
  vat: number;
  gross: number;
}

export interface OrderReport {
  documents: ReportDoc[];
}

/** Продукция производства в форме заказа магазина: строка = фасовка. */
export interface OrderCatalogItem {
  /** id фасовки. */
  id: number;
  cardId: number;
  name: string;
  /** То же название техкарты на других языках (пусто — показываем name). */
  nameEn?: string;
  nameSr?: string;
  note: string;
  /** Вес/объём одной упаковки. */
  qtyBase: number;
  /** Минимальный заказ в упаковках. */
  minOrder: number;
  unitCode: string;
  catalogId: number | null;
  catalogName: string | null;
  catalogIcon?: string | null;
  catalogColor?: string | null;
}

/** Позиция сохранённого заказа магазина. */
export interface StoreOrderItem {
  packagingId: number;
  qty: number;
}

/** Заказ магазина на конкретную дату доставки. */
export interface StoreOrder {
  id: number;
  deliveryDate: string;
  comment: string;
  updatedAt: string;
  items: StoreOrderItem[];
}

/** Текущий заказ магазина и окно приёма на выбранную доставку. */
export interface StoreOrderWindow {
  today: string;
  cutoffHours: number;
  /** Выбранная доставка; без ?date= — ближайшая с открытым приёмом. */
  deliveryDate: string | null;
  /** Момент закрытия приёма, ISO; null — доставки нет. */
  deadline: string | null;
  order: StoreOrder | null;
}

/** Позиция заказа в архиве офиса. */
export interface ArchiveOrderItem {
  packagingId: number;
  qty: number;
  cardName: string;
  cardNameEn?: string;
  cardNameSr?: string;
  packagingName: string;
  qtyBase: number;
  unitCode: string;
}

/** Сохранённый заказ в архиве: магазин, состав и итоги. */
export interface ArchiveOrder {
  id: number;
  deliveryDate: string;
  storeId: number;
  storeCode: string;
  storeName: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
  packages: number;
  positions: number;
  /** Вес заказа в граммах (только позиции с единицей «г»). */
  weightG: number;
  items: ArchiveOrderItem[];
}

/** Будущая дата доставки: open — приём заказа ещё не закрыт. */
export interface UpcomingDelivery {
  date: string;
  open: boolean;
}

export interface OrderArchive {
  today: string;
  orders: ArchiveOrder[];
  /** Даты доставки впереди, в том числе без сохранённых заказов. */
  upcoming: UpcomingDelivery[];
}

/** Срок приёма заказа в настройках доставок. */
export interface DeliveryCutoff {
  cutoffHours: number;
}

export interface TechCard {
  id: number;
  name: string;
  /** Название на английском; пусто — показываем основное. */
  nameEn: string;
  /** Название на сербском; пусто — показываем основное. */
  nameSr: string;
  note: string;
  portionQty: number;
  portionUnitId: number;
  portionUnitCode: string;
  items: CardItem[];
  /** Продаваемые фасовки: хотя бы одна. */
  packagings: Packaging[];
  /** Каталог готовой продукции (product_catalogs); null — без каталога. */
  catalogId?: number | null;
  catalogName?: string | null;
}

export interface ExpansionRow {
  productId: number;
  qty: number;
  name: string;
  unitCode: string;
  stockQty: number;
  deficit?: boolean;
}

// ================= СТОЛ КОНСТРУКТОРА (он же «блок-схема» заготовки) =================
// Отдельной сущности больше нет: сохранённая схема — это и есть полуфабрикат,
// расположение блоков живёт в semi_products.board.

/** Один блок на столе (снимок для хранения) — совпадает с PlateItem компонента. */
export interface DiagramBlock {
  uid: number;
  /** ingredient — сброшен с левого меню; note — свободный блок (сборка) */
  kind: 'ingredient' | 'note';
  sourceType: 'raw' | 'semi';
  refId: number;
  name: string;
  title: string;
  x: number;
  y: number;
  qty: string;
  unitCode: string;
}

/** Связь между блоками: from → to, yieldPct — «выход после обработки» (текст поля). */
export interface DiagramLink {
  id: number;
  from: number;
  to: number;
  yieldPct: string;
}

export interface DiagramData {
  blocks: DiagramBlock[];
  links: DiagramLink[];
}

/** Партия (приход) с истекающим сроком: остаток раскладывается по приходам FIFO. */
export interface NearExpiryRow {
  productId: number;
  name: string;
  unitCode: string;
  /** остаток именно этой партии на складе (в базовой единице) */
  qty: number;
  receiptDate: string;
  expiryDate: string;
  /** дней до истечения: отрицательное — уже просрочено */
  expiryDays: number;
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

// ================= ТОЧКИ ПРОДАЖ =================

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
  pib?: string;
  mbr?: string;
  accountNo?: string;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Кто завёл точку и кто последним её правил (логин). */
  createdByLogin?: string | null;
  createdByName?: string | null;
  updatedByLogin?: string | null;
  updatedByName?: string | null;
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
}

/** Вошедший пользователь CRM. */
export interface AuthUser {
  id: number;
  login: string;
  /** ФИО для подписи; без ФИО совпадает с логином. */
  fullName: string;
  isAdmin: boolean;
  /** Магазинный пользователь: точка, к которой привязан; null — офис. */
  storeId: number | null;
  storeName: string | null;
}

/** Строка списка пользователей (раздел «Пользователи»). */
export interface AuthUserRow extends AuthUser {
  /** ФИО как сохранено (null — не задано, в списке показывается логин). */
  fullNameRaw: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Своя точка магазинного сотрудника (страница «Мой магазин»). */
export interface MyStore {
  id: number;
  code: string;
  name: string;
  active: boolean;
  position: number;
  address: string | null;
  phone: string | null;
  email: string | null;
  contactPerson: string | null;
  openingHours: string | null;
  pib: string | null;
  mbr: string | null;
  accountNo: string | null;
  note: string | null;
}

// ================= ЖУРНАЛ ДЕЙСТВИЙ =================

/** Вид действия в журнале (фильтр «что сделал»). */
export type AuditAction =
  | 'create' | 'update' | 'delete' | 'post' | 'reverse' | 'adjust' | 'approve'
  | 'login' | 'logout' | 'password' | 'role' | 'sync';

/** Раздел системы, к которому относится запись. */
export type AuditEntity =
  | 'product' | 'waybill' | 'semi' | 'tech_card' | 'batch'
  | 'store' | 'user' | 'stock' | 'setting';

/** Одна запись журнала: кто, что, когда и с какими деталями. */
export interface AuditEntry {
  id: number;
  userId: number | null;
  userLogin: string;
  /** ФИО автора записи (снимок на момент действия). */
  userName?: string | null;
  action: AuditAction | string;
  entity: AuditEntity | string;
  entityId: string | null;
  title: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/** Страница журнала + сводка для фильтров. */
export interface AuditPage {
  total: number;
  limit: number;
  offset: number;
  entries: AuditEntry[];
  summary: {
    people: { userLogin: string; userName?: string | null; cnt: number }[];
    entities: { entity: string; cnt: number }[];
    actions: { action: string; cnt: number }[];
  };
}

// ================= НАСТРОЙКИ (админ) =================

/** Транспорт запросов к OpenAI: напрямую или через SOCKS/HTTP-прокси (Tor). */
export interface GptSettings {
  viaProxy: boolean;
  proxyUrl: string;
}

/** Всё, что показывает страница «Настройки». */
export interface AppSettings {
  gpt: GptSettings;
  defaults: GptSettings;
  openai: { keyConfigured: boolean; model: string };
  proxy: { scheme: string; host: string; port: number; reachable: boolean };
}

/** Результат кнопки «Проверить связь»: настоящий запрос к модели текущим транспортом. */
export interface GptTestResult {
  ok: boolean;
  ms: number;
  transport: string;
  reply?: string;
  error?: string;
}

/** Все ручные даты расписания и сегодняшняя дата сервера. Дни правила клиент считает сам — их в расписании нет. */
export interface DeliveryCalendar {
  today: string;
  dates: string[];
}

/** Повторяющиеся доставки: дни недели по ISO (1=пн) ИЛИ числа месяца (1..31). */
export interface DeliveryRule {
  weekdays: number[];
  monthDays: number[];
}

/** Лист Google-таблицы: строки как в документе, значения отформатированы Google. */
export interface GoogleSheetTab {
  name: string;
  rows: string[][];
  /** Ширина листа — по ней рисуются колонки, даже если строки нет. */
  width: number;
  /** Локальный id продукции для каждой строки; null — позиция не найдена. */
  links: (number | null)[];
  /** Название продукции из БД для каждой строки; null — позиция не найдена. */
  names: (string | null)[];
  /** Индексы строк-позиций, которым не нашлось продукции. */
  misses: number[];
}

/** Таблица «Микс Маркт Гастро», скачанная сервисным аккаунтом. */
export interface GoogleSheet {
  title: string;
  spreadsheetId: string;
  url: string;
  loadedAt: string;
  tabs: GoogleSheetTab[];
  /** Позиции, которых нет в «Продукции». */
  unmatched: string[];
}

/** Итог импорта истории заказов из сохранённых листов Google-таблицы. */
export interface OrderHistoryResult {
  from: string | null;
  to: string | null;
  dates: number;
  orders: number;
  positions: number;
  rounded: number;
  skipped: string[];
}

/** Категория сырья (product_categories) для управления в Настройках. */
export interface RawCategory {
  id: number;
  name: string;
  /** Иконка категории (эмодзи); '' — без иконки. */
  icon?: string;
  /** Фоновый цвет #rrggbb; '' — без цвета. */
  color?: string;
  productCount: number;
}

/** Каталог готовой продукции (product_catalogs). */
export interface ProductCatalog {
  id: number;
  name: string;
  /** Иконка каталога (эмодзи); '' — без иконки. */
  icon?: string;
  /** Фоновый цвет #rrggbb; '' — без цвета. */
  color?: string;
  /** Сколько продуктов привязано (только в списке настроек). */
  cardCount?: number;
}

/** Ссылка на позицию номенклатуры (products) для привязки к категории сырья. */
export interface RawProductRef {
  id: number;
  name: string;
  categoryId?: number | null;
  /** Единица хранения (базовая): г / мл / шт. */
  unitCode?: string;
  /** Минимальный остаток в базовой единице. */
  minStock?: number;
  /** Срок годности, дней (null — не задан). */
  shelfLifeDays?: number | null;
}

/**
 * Результат кнопки «Спросить у ИИ»: число для поля-коэффициента и объяснение.
 * Ничего не сохраняет — значение подставляется в поле, сохраняет человек.
 */
export interface AiCoefficient {
  field: 'gPerPcs' | 'mlPerPcs' | 'gPerMl';
  /** В чём модель ответила (г/мл, г/шт, мл/шт) — сверяемся с ней перед подстановкой. */
  unit: string;
  /** Число для поля; null — вразумительного ответа нет (или он физически невозможен). */
  value: number | null;
  /** high | medium | low — как сама модель оценила ответ. */
  confidence: string;
  reason: string;
  model: string;
}
