import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { httpErr } from '../core/format';
import { OrderReport, ReportDoc, ReportLine } from '../core/models';

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
  imports: [RouterLink],
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

  /** Перетаскивание строк: откуда тащим и над какой строкой сейчас курсор. */
  dragFrom = signal<{ orderId: number; index: number } | null>(null);
  dragOver = signal<{ orderId: number; index: number } | null>(null);
  orderSaving = signal(false);
  orderNote = signal('');

  documents = computed(() => this.report()?.documents ?? []);

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
    this.load();
  }

  load(): void {
    if (!this.date || this.loading()) return;
    this.loading.set(true);
    this.err.set('');
    const request$ = this.storeMode
      ? this.api.myOrderReport$(this.date)
      : this.api.orderReport$(this.date, this.storeId, this.priceMode());
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
