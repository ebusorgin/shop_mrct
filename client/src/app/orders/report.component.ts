import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { httpErr } from '../core/format';
import { OrderReport, ReportDoc, ReportLine } from '../core/models';
import { DeliveryWriteoffComponent } from './delivery-writeoff.component';
import { RecipesComponent } from '../pages/recipes.component';

/** Сербское число: точка — тысячи, запятая — дробная часть (45.505,00). */
function grouped(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const head = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}${head}${decimals ? ',' + frac : ''}`;
}

/** Сегодняшняя дата в локальной зоне как YYYY-MM-DD. */
function isoToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Предпросмотр отчёта-отгрузки (Otpremnica) за дату доставки.
 * Без ?storeId — документы по всем магазинам, с ним — по одному.
 * Печатная вёрстка повторяет бумажный образец: шапка, реквизиты сторон, таблица, итоги, подписи.
 */
@Component({
  selector: 'app-order-report',
  standalone: true,
  imports: [RouterLink, FormsModule, DeliveryWriteoffComponent, RecipesComponent],
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
  /** Рецептура, открытая в редакторе поверх отчёта (офис). */
  editNodeId = signal<number | null>(null);
  /** Окно правки количества упаковок (офис). */
  qtyEdit = signal<{
    orderId: number;
    packagingId: number;
    name: string;
    unit: ReportLine['unit'];
    /** Сколько единиц документа в одной упаковке — для подсказки и предпросмотра. */
    perPack: number;
    current: number;
    left: number;
    top: number | null;
    bottom: number | null;
  } | null>(null);
  qtyDraft = signal(1);
  qtySaving = signal(false);
  qtyErr = signal('');
  /** Скачивание zip-архива с PDF-документами даты. */
  pdfBusy = signal(false);
  pdfErr = signal('');
  /** Состояние слепка цен и названий на дату доставки (офис). */
  snapshotInfo = signal<{
    date: string; total: number; frozen: number; named: number; frozenAt: string | null; past: boolean;
  } | null>(null);
  snapBusy = signal(false);
  snapErr = signal('');
  /** Прошлая доставка — история: количество в таких заказах не редактируется. */
  readonly qtyLocked = computed(() => !this.date || this.date < isoToday());
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
          this.loadSnapshotInfo();
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

  /** Скачать документы даты: один — PDF, несколько — zip-архив. */
  downloadZip(): void {
    if (!this.date || this.pdfBusy() || !this.documents().length) return;
    this.pdfBusy.set(true);
    this.pdfErr.set('');
    this.api.downloadOrderReportFile$(this.date, this.storeId, this.priceMode(), this.vatRate()).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.pdfBusy.set(false)),
    ).subscribe({
      next: (resp) => {
        const blob = resp.body;
        if (!blob) {
          this.pdfErr.set('Сервер вернул пустой файл');
          return;
        }
        // Имя берём из Content-Disposition: сервер сам решает, PDF это или zip.
        const header = resp.headers.get('Content-Disposition') ?? '';
        const match = header.match(/filename="?([^";]+)"?/);
        const fallback = this.documents().length === 1
          ? `Otpremnica-${this.documents()[0].number}.pdf`
          : `otpremnice-${this.date}.zip`;
        const name = match ? match[1] : fallback;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      },
      error: (e) => {
        const status = (e as { status?: number })?.status;
        this.pdfErr.set(`Не удалось сформировать документы${status ? ` (${status})` : ''}`);
      },
    });
  }

  /** Блок слепка цен: состояние фиксации на дату доставки. */
  private loadSnapshotInfo(): void {
    if (this.storeMode || !this.date) return;
    this.api.priceSnapshotInfo$(this.date).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (info) => this.snapshotInfo.set(info),
      error: () => this.snapshotInfo.set(null),
    });
  }

  /** «12.11.2026 00:05» из ISO-строки момента фиксации. */
  frozenLabel(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Осознанный переснимок слепка прошедшей даты по текущим ценам и названиям. */
  refreshSnapshot(): void {
    if (!this.date || this.snapBusy()) return;
    if (!confirm(`Переснять слепок на ${this.dateLabel()} по текущим ценам и названиям? Прошлые значения будут заменены.`)) return;
    this.snapBusy.set(true);
    this.snapErr.set('');
    this.api.refreshPriceSnapshot$(this.date).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.snapBusy.set(false)),
    ).subscribe({
      next: (r) => {
        this.orderNote.set(`Слепок переснят: ${r.rows} строк`);
        this.load();
      },
      error: (e) => this.snapErr.set(httpErr(e)),
    });
  }

  /** ✎ рядом со строкой: редактор рецептуры поверх отчёта. */
  editRecipe(nodeId: number): void {
    if (!nodeId) return;
    this.editNodeId.set(nodeId);
  }

  /** Редактор закрыт — пересобираем отчёт: цены и названия могли измениться. */
  closeRecipeEditor(): void {
    this.editNodeId.set(null);
    this.load();
  }

  // ── правка количества в заказе ────────────────────────────────────────
  /** Клик по количеству: окошко с числом упаковок и предпросмотром документа. */
  openQtyEditor(ev: MouseEvent, doc: ReportDoc, line: ReportLine): void {
    if (this.storeMode || this.qtyLocked()) return;
    const el = ev.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const width = 250;
    const perPack = line.packQty > 0 ? line.qty / line.packQty : line.qty;
    const openUp = rect.bottom + 230 > window.innerHeight;
    this.qtyErr.set('');
    this.qtyDraft.set(line.packQty);
    this.qtyEdit.set({
      orderId: doc.orderId,
      packagingId: line.packagingId,
      name: line.name,
      unit: line.unit,
      perPack,
      current: line.packQty,
      left: Math.max(8, Math.min(rect.left - 60, window.innerWidth - width - 8)),
      top: openUp ? null : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : null,
    });
  }

  closeQtyEditor(): void {
    this.qtyEdit.set(null);
    this.qtyErr.set('');
  }

  /** Количество в документе для ещё не сохранённого числа упаковок. */
  qtyPreview(packs: number): string {
    const q = this.qtyEdit();
    if (!q || !Number.isFinite(packs)) return '—';
    const decimals = q.unit === 'kg' || q.unit === 'l' ? 3 : 0;
    const value = Math.round(packs * q.perPack * 10 ** decimals) / 10 ** decimals;
    return grouped(value, decimals);
  }

  unitFull(unit: ReportLine['unit']): string {
    if (unit === 'kg') return 'кг';
    if (unit === 'l') return 'л';
    if (unit === 'kom') return 'шт';
    return 'порц.';
  }

  saveQty(): void {
    const q = this.qtyEdit();
    if (!q || this.qtySaving()) return;
    const qty = Number(this.qtyDraft());
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      this.qtyErr.set('Количество упаковок — целое число от 1 до 999');
      return;
    }
    if (qty === q.current) {
      this.closeQtyEditor();
      return;
    }
    this.qtySaving.set(true);
    this.qtyErr.set('');
    this.api.setReportLineQty$(q.orderId, q.packagingId, qty).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.qtySaving.set(false)),
    ).subscribe({
      next: () => {
        this.qtyEdit.set(null);
        this.orderNote.set(`Количество «${q.name}» изменено: ${qty} уп. — заказ перезаписан`);
        this.load();
      },
      error: (e) => this.qtyErr.set(`Не удалось сохранить: ${httpErr(e)}`),
    });
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
