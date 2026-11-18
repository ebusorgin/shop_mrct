import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { httpErr } from '../core/format';
import { OrderReport, ReportDoc, ReportLine } from '../core/models';
import { DeliveryWriteoffComponent } from './delivery-writeoff.component';

/** Сербское число: точка — тысячи, запятая — дробная часть (45.505,00). */
function grouped(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const head = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}${head}${decimals ? ',' + frac : ''}`;
}

/**
 * Предпросмотр отчёта-отгрузки (Otpremnica) за дату доставки.
 * Без ?storeId — документы по всем магазинам, с ним — по одному.
 * Печатная вёрстка повторяет бумажный образец: шапка, реквизиты сторон, таблица, итоги, подписи.
 */
@Component({
  selector: 'app-order-report',
  standalone: true,
  imports: [RouterLink, FormsModule, DeliveryWriteoffComponent],
  templateUrl: './report.component.html',
  styleUrl: './report.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderReportComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private route = inject(ActivatedRoute);

  /** true — кабинет магазина: отчёт строится только по своей точке (storeId из сессии). */
  readonly storeMode = this.route.snapshot.data['storeMode'] === true;

  readonly date = this.route.snapshot.queryParamMap.get('date') ?? '';
  readonly storeId = (() => {
    if (this.storeMode) return undefined;
    const raw = this.route.snapshot.queryParamMap.get('storeId');
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  })();

  /** Куда вернуться по «←»: в кабинет магазина или в офисный архив. */
  readonly backLink = this.storeMode ? '/store/history' : '/orders';

  report = signal<OrderReport | null>(null);
  loading = signal(false);
  err = signal('');
  /** Офисный отчёт можно построить по себестоимости вместо продажной цены. */
  priceMode = signal<'sale' | 'cost'>('sale');
  /** Ставка PDV для отчёта; по умолчанию 20 %. */
  vatRate = signal(20);
  vatInput: number | null = 20;
  settingsErr = signal('');

  /** Перетаскивание строк: откуда тащим и над какой строкой сейчас курсор. */
  dragFrom = signal<{ orderId: number; index: number } | null>(null);
  dragOver = signal<{ orderId: number; index: number } | null>(null);
  orderSaving = signal(false);
  /** Окно ручного списания склада по доставке (офис). */
  woOpen = signal(false);
  orderNote = signal('');

  documents = computed(() => this.report()?.documents ?? []);

  /** Сводка по всем документам даты: вес, нетто, налог и сумма к оплате. */
  totalWeight = computed(() => {
    const sum = this.documents().reduce((s, d) => s + (d.weightKg ?? 0), 0);
    return Math.round(sum * 1000) / 1000;
  });
  totalNet = computed(() => Math.round(this.documents().reduce((s, d) => s + d.net, 0) * 100) / 100);
  totalVat = computed(() => Math.round(this.documents().reduce((s, d) => s + d.vat, 0) * 100) / 100);
  totalGross = computed(() => Math.round(this.documents().reduce((s, d) => s + d.gross, 0) * 100) / 100);
  /** Ставка, реально применённая сервером (для магазина — 20 %, для офиса — выбранная). */
  docVatRate = computed(() => this.documents()[0]?.vatRate ?? this.vatRate());

  /** Текущий диапазон индексов документов: 843 … 850. */
  firstIndex = computed(() => this.indexFromNumber(this.documents()[0]?.number));
  lastIndex = computed(() => this.indexFromNumber(this.documents()[this.documents().length - 1]?.number));

  /** Позиции без цены — документ неполный, подсказываем заполнить цену фасовки. */
  missingPrices = computed(() =>
    this.documents().reduce((sum, doc) => sum + doc.lines.filter((line) => line.price <= 0).length, 0)
  );

  dateLabel = computed(() => {
    const parts = this.date.split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : this.date;
  });

  scopeLabel = computed(() => {
    if (this.storeMode) return 'Мой магазин';
    return this.storeId === undefined ? 'Все магазины' : 'Один магазин';
  });

  ngOnInit(): void {
    try {
      const raw = localStorage.getItem('report.vatRate');
      const saved = raw == null ? NaN : Number(raw);
      if (Number.isFinite(saved) && saved >= 0 && saved <= 100) {
        this.vatRate.set(saved);
        this.vatInput = saved;
      }
    } catch {
      /* приватный режим — остаётся 20 % */
    }
    this.load();
  }

  load(): void {
    if (!this.date || this.loading()) return;
    this.loading.set(true);
    this.err.set('');
    const request$ = this.storeMode
      ? this.api.myOrderReport$(this.date)
      : this.api.orderReport$(this.date, this.storeId, this.priceMode(), this.vatRate());
    request$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (report) => {
          this.report.set(report);
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  /** Переключение «по себестоимости»: документ строится заново с другим набором цен. */
  setPriceMode(mode: 'sale' | 'cost'): void {
    if (this.priceMode() === mode) return;
    this.priceMode.set(mode);
    this.load();
  }

  print(): void {
    window.print();
  }

  // ── ручной порядок строк ──────────────────────────────────────────────
  /** Тянем строку за ручку ⋮⋮; изображение перетаскивания — вся строка. */
  onLineDragStart(doc: ReportDoc, index: number, ev: DragEvent): void {
    if (this.storeMode) {
      ev.preventDefault();
      return;
    }
    const dt = ev.dataTransfer;
    if (dt) {
      dt.effectAllowed = 'move';
      dt.setData('text/plain', String(index));
      const row = (ev.currentTarget as HTMLElement | null)?.closest('tr');
      // setDragImage требует настоящей drag-сессии; в синтетических событиях молча пропускаем.
      try {
        if (row) dt.setDragImage(row, 24, 24);
      } catch {
        /* без миниатюры строки перетаскивание всё равно работает */
      }
    }
    this.dragFrom.set({ orderId: doc.orderId, index });
    this.dragOver.set(null);
  }

  onLineDragOver(doc: ReportDoc, index: number, ev: DragEvent): void {
    if (this.storeMode) return;
    const from = this.dragFrom();
    if (!from || from.orderId !== doc.orderId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    this.dragOver.set({ orderId: doc.orderId, index });
  }

  onLineDrop(doc: ReportDoc, index: number, ev: DragEvent): void {
    if (this.storeMode) return;
    ev.preventDefault();
    const from = this.dragFrom();
    this.dragFrom.set(null);
    this.dragOver.set(null);
    if (!from || from.orderId !== doc.orderId || from.index === index) return;
    this.moveLine(doc, from.index, index);
  }

  onLineDragEnd(): void {
    this.dragFrom.set(null);
    this.dragOver.set(null);
  }

  /** Переставить строку в локальном документе и сохранить порядок в заказе. */
  private moveLine(doc: ReportDoc, from: number, to: number): void {
    const lines = [...doc.lines];
    if (from < 0 || from >= lines.length || to < 0 || to >= lines.length) return;
    const [moved] = lines.splice(from, 1);
    lines.splice(to, 0, moved);
    this.report.update((r) =>
      r
        ? {
            ...r,
            documents: r.documents.map((d) => (d.orderId === doc.orderId ? { ...d, lines } : d)),
          }
        : r
    );
    this.saveLineOrder(doc.orderId, lines);
  }

  /** Порядок хранится у заказа: обновление одной даты не меняет другие отчёты. */
  private saveLineOrder(orderId: number, lines: ReportLine[]): void {
    this.orderSaving.set(true);
    this.orderNote.set('');
    this.api
      .reorderReportLines$(orderId, lines.map((line) => line.packagingId))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.orderSaving.set(false);
          this.orderNote.set('Порядок сохранён');
        },
        error: (e) => {
          this.orderSaving.set(false);
          this.orderNote.set(`Не удалось сохранить порядок: ${httpErr(e)}`);
          // Серверный порядок — источник истины: возвращаем документ как есть.
          this.load();
        },
      });
  }

  qty(line: ReportLine): string {
    return grouped(line.qty, 3);
  }

  /** Вес документа/сводки для печати. */
  weight(value: number): string {
    return `${grouped(value, 3)} kg`;
  }

  /** Ставка налога без лишних нулей: 20 -> 20, 7.5 -> 7,5. */
  rateLabel(rate: number): string {
    return Number.isInteger(rate) ? String(rate) : String(rate).replace('.', ',');
  }

  get docYear(): string {
    return this.date.slice(0, 4);
  }

  /** Числовая часть номера «2026-843» -> 843. */
  private indexFromNumber(number: string | undefined): number | null {
    const match = String(number ?? '').match(/-(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  /** Применить ставку PDV и пересобрать отчёт. */
  applyVat(value: number | null): void {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      this.settingsErr.set('Ставка налога должна быть числом от 0 до 100 %');
      return;
    }
    this.settingsErr.set('');
    this.vatInput = rate;
    if (this.vatRate() === rate) return;
    this.vatRate.set(rate);
    try {
      localStorage.setItem('report.vatRate', String(rate));
    } catch {
      /* приватный режим — просто не запоминаем */
    }
    this.load();
  }

  /** Единица для узкой колонки JM: «porcija» не помещается — печатаем «porc.». */
  unitLabel(unit: ReportLine['unit']): string {
    return unit === 'porcija' ? 'porc.' : unit;
  }

  money(value: number): string {
    return grouped(value, 2);
  }

  /** Дата в шапке документа — день доставки, без времени. */
  docDate(iso: string): string {
    const parts = iso.split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : iso;
  }

  plural(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }
}
