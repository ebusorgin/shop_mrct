import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  signal,
  viewChild,
} from '@angular/core';

/** Первая накладная из папки SHOP: WFC DOO BEOGRAD № 26-3501-046772 от 16.07.2026. */
const FIRST_INVOICE_ISO = '2026-07-16';
/** Ширина дорожки на один день — от неё зависит горизонтальная прокрутка шкалы. */
const TRACK_PX_PER_DAY = 12;
const STACK_STEP = 14;
const STACK_BASE = 34;

interface SupplierGood {
  name: string;
  unit: string;
  min: number;
  max: number;
}

interface Supplier {
  name: string;
  color: string;
  goods: SupplierGood[];
}

/** Реальная накладная WFC DOO BEOGRAD № 26-3501-064886 от 21.09.2026 (фото SHOP/20261027_174343.jpg). */
const INVOICE_COLOR = '#8a5a44';

interface DemoInvoiceData extends ReceiptInvoice {
  dateIso: string;
  supplier: string;
}

export const DEMO_INVOICE: DemoInvoiceData = {
  dateIso: '2026-09-21',
  number: '26-3501-064886',
  supplier: 'WFC DOO Beograd',
  supplierFull: 'WFC DOO BEOGRAD',
  supplierAddress: 'Vinogradska 40, 11271 Surčin',
  customer: 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ',
  net: 27223.3,
  vat: 2739.83,
  gross: 29963.13,
  lines: [
    { ident: 'VIP00098', name: 'CVEKLA KG', qty: 52, unit: 'KG', price: 55, vatRate: 10, net: 2860 },
    { ident: 'OST00039', name: 'JAJA SVEŽA M 180/1', qty: 4, unit: 'KOM', price: 1980, vatRate: 10, net: 7920 },
    { ident: 'VIP00242', name: 'KROMPIR CRVENI KG', qty: 60, unit: 'KG', price: 80, vatRate: 10, net: 4800 },
    { ident: 'VIP00265', name: 'KUPUS BELI KG', qty: 100, unit: 'KG', price: 50, vatRate: 10, net: 5000 },
    { ident: 'VIP00317', name: 'LUK CRNI KG', qty: 39.74, unit: 'KG', price: 45, vatRate: 10, net: 1788.3 },
    { ident: 'VIP00322', name: 'LUK CRNI MLADI VEZA', qty: 10, unit: 'KOM', price: 60, vatRate: 10, net: 600 },
    { ident: 'VIP01569', name: 'MIRODIJA 100G', qty: 1, unit: 'KOM', price: 175, vatRate: 20, net: 175 },
    { ident: 'VIP00629', name: 'ŠARGAREPA KG', qty: 51, unit: 'KG', price: 80, vatRate: 10, net: 4080 },
  ],
};

const INVOICE_SUPPLIER: Supplier = { name: DEMO_INVOICE.supplier, color: INVOICE_COLOR, goods: [] };

/** Поставщики и типовые товары для демонстрационных приходов. */
const SUPPLIERS: Supplier[] = [
  {
    name: 'Milkos',
    color: '#2f6fb0',
    goods: [
      { name: 'Молоко', unit: 'л', min: 20, max: 60 },
      { name: 'Сливки', unit: 'л', min: 10, max: 30 },
      { name: 'Сыр', unit: 'кг', min: 5, max: 20 },
      { name: 'Масло сливочное', unit: 'кг', min: 5, max: 15 },
    ],
  },
  {
    name: 'Imlek',
    color: '#c25b2e',
    goods: [
      { name: 'Йогурт', unit: 'л', min: 10, max: 40 },
      { name: 'Сметана', unit: 'кг', min: 10, max: 25 },
      { name: 'Молоко', unit: 'л', min: 20, max: 50 },
    ],
  },
  {
    name: 'Carnex',
    color: '#b23b5a',
    goods: [
      { name: 'Куриное филе', unit: 'кг', min: 5, max: 20 },
      { name: 'Свинина', unit: 'кг', min: 5, max: 25 },
      { name: 'Фарш', unit: 'кг', min: 5, max: 15 },
    ],
  },
  {
    name: 'Подравка',
    color: '#4a8f57',
    goods: [
      { name: 'Масло подсолнечное', unit: 'л', min: 10, max: 40 },
      { name: 'Уксус', unit: 'л', min: 5, max: 15 },
      { name: 'Соль', unit: 'кг', min: 5, max: 20 },
    ],
  },
  {
    name: 'Атлас',
    color: '#7b61a8',
    goods: [
      { name: 'Мука', unit: 'кг', min: 20, max: 60 },
      { name: 'Сахар', unit: 'кг', min: 20, max: 50 },
      { name: 'Рис', unit: 'кг', min: 10, max: 30 },
      { name: 'Дрожжи', unit: 'кг', min: 5, max: 10 },
    ],
  },
  {
    name: 'Frikom',
    color: '#2c9a9a',
    goods: [
      { name: 'Картофель замороженный', unit: 'кг', min: 10, max: 30 },
      { name: 'Овощная смесь', unit: 'кг', min: 10, max: 25 },
      { name: 'Ягоды', unit: 'кг', min: 5, max: 15 },
    ],
  },
  {
    name: 'Био Спас',
    color: '#b08a2e',
    goods: [
      { name: 'Помидоры', unit: 'кг', min: 10, max: 30 },
      { name: 'Огурцы', unit: 'кг', min: 10, max: 25 },
      { name: 'Лук', unit: 'кг', min: 10, max: 30 },
      { name: 'Морковь', unit: 'кг', min: 10, max: 30 },
    ],
  },
];

interface ReceiptGood {
  name: string;
  qty: number;
  unit: string;
}

export interface InvoiceLine {
  ident: string;
  name: string;
  qty: number;
  unit: 'KG' | 'KOM';
  price: number;
  vatRate: number;
  net: number;
}

interface ReceiptInvoice {
  number: string;
  supplierFull: string;
  supplierAddress: string;
  customer: string;
  net: number;
  vat: number;
  gross: number;
  lines: InvoiceLine[];
}

interface Receipt {
  id: string;
  dayIndex: number;
  dateLabel: string;
  leftPct: number;
  bottomPx: number;
  supplier: string;
  color: string;
  goods: ReceiptGood[];
  invoice?: ReceiptInvoice;
}

interface MonthMark {
  key: string;
  label: string;
  leftPct: number;
}

interface ScaleMark {
  key: string;
  leftPct: number;
  label?: string;
  first?: boolean;
}

interface DemoScale {
  startLabel: string;
  todayLabel: string;
  trackWidth: number;
  receipts: Receipt[];
  months: MonthMark[];
  weeks: ScaleMark[];
  ticks: ScaleMark[];
}

/** Детерминированный ГПСЧ: демо-приходы не «прыгают» при каждом открытии страницы. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function pickGoods(goods: SupplierGood[], count: number, rnd: () => number): ReceiptGood[] {
  const pool = [...goods];
  const picked: ReceiptGood[] = [];
  while (picked.length < count && pool.length) {
    const index = Math.floor(rnd() * pool.length);
    const good = pool.splice(index, 1)[0];
    const qty = Math.max(5, Math.round((good.min + rnd() * (good.max - good.min)) / 5) * 5);
    picked.push({ name: good.name, qty, unit: good.unit });
  }
  return picked;
}

function buildDemoScale(): DemoScale {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const first = new Date(`${FIRST_INVOICE_ISO}T12:00:00`);
  const dayCount = Math.max(2, Math.round((today.getTime() - first.getTime()) / 86400000) + 1);
  const days = Array.from({ length: dayCount }, (_, i) => addDays(first, i));

  const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const tickFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });
  const monthFmt = new Intl.DateTimeFormat('ru-RU', { month: 'short' });

  const months: MonthMark[] = [];
  for (let i = 0; i < dayCount; ) {
    const key = `${days[i].getFullYear()}-${days[i].getMonth()}`;
    let end = i;
    while (end + 1 < dayCount && `${days[end + 1].getFullYear()}-${days[end + 1].getMonth()}` === key) end++;
    months.push({
      key,
      label: monthFmt.format(days[i]).replace('.', ''),
      leftPct: ((i + end) / 2 / (dayCount - 1)) * 100,
    });
    i = end + 1;
  }

  const weeks: ScaleMark[] = [];
  for (let i = 0; i < dayCount; i += 7) {
    weeks.push({ key: `w${i}`, leftPct: (i / (dayCount - 1)) * 100 });
  }

  const ticks: ScaleMark[] = [];
  for (let i = 0; i < dayCount; i += 14) {
    if (dayCount - 1 - i < 10) break;
    ticks.push({
      key: `t${i}`,
      leftPct: (i / (dayCount - 1)) * 100,
      label: tickFmt.format(days[i]),
      first: i === 0,
    });
  }

  const rnd = mulberry32(0x5eed2026);
  const receipts: Receipt[] = [];
  for (let week = 0; week * 7 < dayCount; week++) {
    const start = week * 7;
    const length = Math.min(7, dayCount - start);
    const count = 5 + Math.floor(rnd() * 4);
    for (let n = 0; n < count; n++) {
      const dayIndex = start + Math.floor(rnd() * length);
      const supplier = SUPPLIERS[Math.floor(rnd() * SUPPLIERS.length)];
      const goods = pickGoods(supplier.goods, 2 + Math.floor(rnd() * 3), rnd);
      receipts.push({
        id: `${dayIndex}-${n}-${supplier.name}`,
        dayIndex,
        dateLabel: dateFmt.format(days[dayIndex]),
        leftPct: (dayIndex / (dayCount - 1)) * 100,
        bottomPx: STACK_BASE,
        supplier: supplier.name,
        color: supplier.color,
        goods,
      });
    }
  }

  receipts.sort((a, b) => a.dayIndex - b.dayIndex || a.supplier.localeCompare(b.supplier));
  const stacks = new Map<number, number>();
  for (const receipt of receipts) {
    const stack = stacks.get(receipt.dayIndex) ?? 0;
    receipt.bottomPx = STACK_BASE + (stack % 4) * STACK_STEP;
    stacks.set(receipt.dayIndex, stack + 1);
  }

  const invoiceDay = days.findIndex((d) => {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return key === DEMO_INVOICE.dateIso;
  });
  if (invoiceDay >= 0) {
    const receipt: Receipt = {
      id: `invoice-${DEMO_INVOICE.number}`,
      dayIndex: invoiceDay,
      dateLabel: dateFmt.format(days[invoiceDay]),
      leftPct: (invoiceDay / (dayCount - 1)) * 100,
      bottomPx: STACK_BASE,
      supplier: DEMO_INVOICE.supplier,
      color: INVOICE_COLOR,
      goods: DEMO_INVOICE.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit.toLowerCase() })),
      invoice: {
        number: DEMO_INVOICE.number,
        supplierFull: DEMO_INVOICE.supplierFull,
        supplierAddress: DEMO_INVOICE.supplierAddress,
        customer: DEMO_INVOICE.customer,
        net: DEMO_INVOICE.net,
        vat: DEMO_INVOICE.vat,
        gross: DEMO_INVOICE.gross,
        lines: DEMO_INVOICE.lines,
      },
    };
    receipts.push(receipt);
    const stack = stacks.get(invoiceDay) ?? 0;
    receipt.bottomPx = STACK_BASE + (stack % 4) * STACK_STEP;
    stacks.set(invoiceDay, stack + 1);
  }

  return {
    startLabel: dateFmt.format(first),
    todayLabel: dateFmt.format(today),
    trackWidth: dayCount * TRACK_PX_PER_DAY,
    receipts,
    months,
    weeks,
    ticks,
  };
}

/**
 * Порядок списания со склада по доставке выбранной даты.
 * На шкале от первой накладной до сегодня пока демонстрационные приходы товара.
 */
@Component({
  selector: 'app-order-writeoff',
  standalone: true,
  templateUrl: './writeoff.component.html',
  styleUrl: './writeoff.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderWriteoffComponent implements AfterViewInit {
  private scrollRef = viewChild<ElementRef<HTMLDivElement>>('tlScroll');

  private readonly demo = buildDemoScale();
  readonly suppliers = [...SUPPLIERS, INVOICE_SUPPLIER];
  readonly receipts = this.demo.receipts;
  readonly months = this.demo.months;
  readonly weeks = this.demo.weeks;
  readonly ticks = this.demo.ticks;
  readonly startLabel = this.demo.startLabel;
  readonly todayLabel = this.demo.todayLabel;
  readonly trackWidth = this.demo.trackWidth;
  readonly supplierCount = new Set(this.receipts.map((r) => r.supplier)).size;

  readonly picked = signal<Receipt | null>(null);

  private readonly moneyFmt = new Intl.NumberFormat('sr-RS', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  private readonly qtyFmt = new Intl.NumberFormat('sr-RS', { maximumFractionDigits: 2 });

  ngAfterViewInit(): void {
    const el = this.scrollRef()?.nativeElement;
    if (el) el.scrollLeft = el.scrollWidth;
  }

  pick(receipt: Receipt): void {
    this.picked.set(receipt);
  }

  money(value: number): string {
    return this.moneyFmt.format(value);
  }

  qty(value: number): string {
    return this.qtyFmt.format(value);
  }

  receiptLabel(receipt: Receipt): string {
    const goods = receipt.goods.map((g) => `${g.name} ${g.qty} ${g.unit}`).join(', ');
    const prefix = receipt.invoice ? `Накладная № ${receipt.invoice.number}. ` : '';
    return `${prefix}${receipt.dateLabel}, ${receipt.supplier}: ${goods}`;
  }
}
