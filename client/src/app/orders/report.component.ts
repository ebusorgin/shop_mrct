import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { httpErr } from '../core/format';
import { OrderReport, PointCard, ReportDoc, ReportLine } from '../core/models';
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

/** Ключ сортировки строк документа (как по столбцам Excel). */
type SortKey = 'name' | 'unit' | 'qty' | 'price' | 'rate' | 'vat' | 'gross';

/** Сектор 3D-пирога: значение и цвета торца/стенки. */
interface PiePart {
  key: string;
  label: string;
  value: number;
  fill: string;
  side: string;
}

/** Сектор с посчитанной геометрией SVG. */
interface PieSlice extends PiePart {
  pct: number;
  mid: number;
  top: string;
  wall: string;
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
  /** undefined — все магазины; число — один магазин. */
  readonly storeId = signal<number | undefined>((() => {
    if (this.storeMode) return undefined;
    const raw = this.route.snapshot.queryParamMap.get('storeId');
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  })());
  /** Точки для выбора магазина в шапке отчёта. */
  readonly stores = signal<PointCard[]>([]);

  /** Куда вернуться по «←»: в кабинет магазина или в офисный архив. */
  readonly backLink = this.storeMode ? '/store/history' : '/orders';

  report = signal<OrderReport | null>(null);
  loading = signal(false);
  err = signal('');
  /** Офисный отчёт можно построить по себестоимости вместо продажной цены. */
  priceMode = signal<'sale' | 'cost'>('sale');
  /** Ставка PDV для отчёта; по умолчанию 20 %. */
  vatRate = signal(20);
  /** Язык названий позиций в документе: сербский по умолчанию. */
  lang = signal<'ru' | 'en' | 'sr'>('sr');
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
  /** Прошлая доставка — история: количество в таких заказах не редактируется. */
  readonly qtyLocked = computed(() => !this.date || this.date < isoToday());
  orderNote = signal('');

  /** Документы отчёта: загружаются все, селект в шапке фильтрует их на клиенте.
   *  Показываем только активные магазины (в кабинете магазина фильтр не применяется). */
  documents = computed<ReportDoc[]>(() => {
    const all = this.report()?.documents ?? [];
    if (this.storeMode) return all;
    const known = this.stores();
    const active = known.length ? new Set(known.filter((s) => s.active).map((s) => s.id)) : null;
    const visible = active ? all.filter((d) => active.has(d.storeId)) : all;
    const id = this.storeId();
    return id == null ? visible : visible.filter((d) => d.storeId === id);
  });

  /** Пункты селекта: активные магазины, у которых есть заказ/документ на эту дату. */
  readonly storeOptions = computed<PointCard[]>(() => {
    const docs = this.report()?.documents ?? [];
    const ids = new Set(docs.map((d) => d.storeId));
    return this.stores()
      .filter((s) => s.active && ids.has(s.id))
      .sort((a, b) => a.code.localeCompare(b.code, 'ru'));
  });

  /** Сортировка строк как в Excel: по клику на заголовок, только в просмотре и печати. */
  sort = signal<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  readonly viewDocuments = computed<ReportDoc[]>(() => {
    const s = this.sort();
    const docs = this.documents();
    if (!s) return docs;
    const sign = s.dir === 'asc' ? 1 : -1;
    const value = (line: ReportLine): string | number => {
      switch (s.key) {
        case 'name':
          return line.name;
        case 'unit':
          return this.unitLabel(line.unit);
        case 'qty':
          return line.qty;
        case 'price':
          return line.price;
        case 'rate':
          return line.vatRate;
        case 'vat':
          return line.vat;
        case 'gross':
          return line.gross;
      }
    };
    return docs.map((doc) => ({
      ...doc,
      lines: [...doc.lines].sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
        return String(va).localeCompare(String(vb), 'ru', { sensitivity: 'base' }) * sign;
      }),
    }));
  });

  sortBy(key: SortKey): void {
    const cur = this.sort();
    this.sort.set(cur?.key === key
      ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  }

  sortMark(key: SortKey): string {
    const s = this.sort();
    return s?.key === key ? (s.dir === 'asc' ? '▲' : '▼') : '';
  }

  /** Сводка по всем документам даты: вес, нетто, налог и сумма к оплате. */
  totalWeight = computed(() => {
    const sum = this.documents().reduce((s, d) => s + (d.weightKg ?? 0), 0);
    return Math.round(sum * 1000) / 1000;
  });
  totalNet = computed(() => Math.round(this.documents().reduce((s, d) => s + d.net, 0) * 100) / 100);
  totalVat = computed(() => Math.round(this.documents().reduce((s, d) => s + d.vat, 0) * 100) / 100);
  totalGross = computed(() => Math.round(this.documents().reduce((s, d) => s + d.gross, 0) * 100) / 100);

  /** Себестоимость строк отчёта (только офисный отчёт) — основа маржи. */
  totalCost = computed(() =>
    Math.round(this.documents().reduce((s, d) => s + d.lines.reduce((x, l) => x + (l.costTotal ?? 0), 0), 0) * 100) / 100
  );

  /** Вкладка блока экономики: 'total' — весь отчёт, иначе ключ категории (c<id>). */
  finTab = signal<string>('total');

  /** Категории, реально присутствующие в отчёте: вкладки идут в порядке каталогов рецептур. */
  categoryStats = computed(() => {
    const groups = new Map<
      string,
      { key: string; label: string; position: number; net: number; cost: number; vat: number }
    >();
    for (const doc of this.documents()) {
      for (const line of doc.lines) {
        const key = line.categoryId != null ? `c${line.categoryId}` : 'none';
        let g = groups.get(key);
        if (!g) {
          g = {
            key,
            label: line.categoryName || 'Без категории',
            position: line.categoryPosition ?? 9999,
            net: 0,
            cost: 0,
            vat: 0,
          };
          groups.set(key, g);
        }
        g.net += line.net;
        g.cost += line.costTotal ?? 0;
        g.vat += line.vat;
      }
    }
    return [...groups.values()].sort((a, b) => a.position - b.position || b.net - a.net);
  });

  /** Если выбранная категория исчезла (сменились дата/магазин) — показываем «Общую». */
  activeTabKey = computed(() => {
    const tab = this.finTab();
    return tab === 'total' || this.categoryStats().some((c) => c.key === tab) ? tab : 'total';
  });

  private activeCategory = computed(() => this.categoryStats().find((c) => c.key === this.activeTabKey()) ?? null);

  /** Суммы активной вкладки: весь отчёт или одна категория. */
  private activeSum = computed(() => {
    const c = this.activeCategory();
    return {
      net: c ? c.net : this.totalNet(),
      cost: c ? c.cost : this.totalCost(),
      vat: c ? c.vat : this.totalVat(),
    };
  });

  /**
   * 3D-пирог «куда уходит сумма к оплате»: себестоимость + маржа + PDV.
   * Геометрия считается здесь, SVG — только отрисовка (без сторонних библиотек).
   */
  activeSlices = computed(() => {
    const s = this.activeSum();
    return this.buildPie([
      { key: 'cost', label: 'Себестоимость', value: s.cost, fill: '#7d8aa0', side: '#5f6b80' },
      { key: 'margin', label: 'Маржа производства', value: Math.max(s.net - s.cost, 0), fill: '#2e9e5b', side: '#1f7a44' },
      { key: 'vat', label: 'PDV к уплате', value: s.vat, fill: '#e0a32e', side: '#b57c15' },
    ]);
  });

  activeDraw = computed(() => [...this.activeSlices()].sort((s1, s2) => Math.sin(s1.mid) - Math.sin(s2.mid)));
  activeTotal = computed(() => {
    const s = this.activeSum();
    return Math.round((s.cost + Math.max(s.net - s.cost, 0) + s.vat) * 100) / 100;
  });
  activeTotalLabel = computed(() => `К оплате · PDV ${this.rateLabel(this.docVatRate())} %`);
  activeMarginPctLabel = computed(() => {
    const s = this.activeSum();
    if (!(s.net > 0)) return '';
    return `${(((s.net - s.cost) / s.net) * 100).toFixed(1).replace('.', ',')} % от нетто`;
  });

  /**
   * Геометрия 3D-пирога: плоский эллипс сверху + боковые стенки, выдавленные вниз.
   * Порядок в массиве — порядок секторов по кругу; порядок отрисовки задаёт activeDraw.
   */
  private buildPie(parts: PiePart[]): PieSlice[] {
    const items = parts.filter((p) => p.value > 0);
    const total = items.reduce((s, p) => s + p.value, 0);
    if (!(total > 0)) return [];
    const cx = 100;
    const cy = 72;
    const rx = 94;
    const ry = 48;
    const depth = 16;
    const n = (v: number) => v.toFixed(2);
    const pt = (a: number, dy = 0): [number, number] => [cx + rx * Math.cos(a), cy + ry * Math.sin(a) + dy];
    let a = -Math.PI / 2;
    return items.map((p) => {
      const a0 = a;
      const span = (p.value / total) * Math.PI * 2;
      a = a0 + span;
      const [x0, y0] = pt(a0);
      const [x1, y1] = pt(a);
      const [bx0, by0] = pt(a0, depth);
      const [bx1, by1] = pt(a, depth);
      const large = span > Math.PI ? 1 : 0;
      const full = span >= Math.PI * 2 - 0.001;
      const top = full
        ? `M ${n(cx - rx)} ${n(cy)} A ${rx} ${ry} 0 1 1 ${n(cx + rx)} ${n(cy)} A ${rx} ${ry} 0 1 0 ${n(cx - rx)} ${n(cy)} Z`
        : `M ${n(cx)} ${n(cy)} L ${n(x0)} ${n(y0)} A ${rx} ${ry} 0 ${large} 1 ${n(x1)} ${n(y1)} Z`;
      const wall = full
        ? `M ${n(cx - rx)} ${n(cy + depth)} A ${rx} ${ry} 0 1 1 ${n(cx + rx)} ${n(cy + depth)} ` +
          `L ${n(cx + rx)} ${n(cy)} A ${rx} ${ry} 0 1 1 ${n(cx - rx)} ${n(cy)} Z`
        : `M ${n(x0)} ${n(y0)} A ${rx} ${ry} 0 ${large} 1 ${n(x1)} ${n(y1)} ` +
          `L ${n(bx1)} ${n(by1)} A ${rx} ${ry} 0 ${large} 0 ${n(bx0)} ${n(by0)} Z`;
      return { ...p, pct: (p.value / total) * 100, mid: a0 + span / 2, top, wall };
    });
  }

  pctLabel(pct: number): string {
    return `${pct.toFixed(1).replace('.', ',')} %`;
  }
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
    return this.storeId() === undefined ? 'Все магазины' : 'Один магазин';
  });

  ngOnInit(): void {
    try {
      const raw = localStorage.getItem('report.vatRate');
      const saved = raw == null ? NaN : Number(raw);
      if (Number.isFinite(saved) && saved >= 0 && saved <= 100) {
        this.vatRate.set(saved);
        this.vatInput = saved;
      }
      const savedLang = localStorage.getItem('report.lang');
      if (savedLang === 'ru' || savedLang === 'en' || savedLang === 'sr') this.lang.set(savedLang);
    } catch {
      /* приватный режим — остаётся 20 % и сербский */
    }
    if (!this.storeMode) {
      this.api.points$().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (rows) => {
          this.stores.set(rows);
          if (this.storeId() != null && !this.storeOptions().some((s) => s.id === this.storeId())) {
            this.storeId.set(undefined);
          }
        },
        error: () => undefined,
      });
    }
    this.load();
  }

  /** Подпись точки в селекте: код, а имя — только если отличается. */
  storeLabel(s: PointCard): string {
    return s.name && s.name !== s.code ? `${s.code} — ${s.name}` : s.code;
  }

  /** Выбор магазина в шапке — только фильтр по уже загруженным документам, без перехода. */
  setStore(value: string | number): void {
    const id = value === '' || value == null ? undefined : Number(value);
    this.storeId.set(Number.isInteger(id) && (id as number) > 0 ? (id as number) : undefined);
  }

  load(): void {
    if (!this.date || this.loading()) return;
    this.loading.set(true);
    this.err.set('');
    const request$ = this.storeMode
      ? this.api.myOrderReport$(this.date)
      : this.api.orderReport$(this.date, undefined, this.priceMode(), this.vatRate(), this.lang());
    request$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (report) => {
          this.report.set(report);
          // Ссылка могла вести на закрытый магазин или магазин без заказа этой даты.
          if (this.stores().length && this.storeId() != null &&
              !this.storeOptions().some((s) => s.id === this.storeId())) {
            this.storeId.set(undefined);
          }
          this.loading.set(false);
        },
        error: (e) => {
          this.loading.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  /** Язык названий позиций: RU / EN / SR. Бланк Otpremnica остаётся на сербском. */
  setLang(lang: 'ru' | 'en' | 'sr'): void {
    if (this.lang() === lang) return;
    this.lang.set(lang);
    try {
      localStorage.setItem('report.lang', lang);
    } catch {
      /* приватный режим */
    }
    this.load();
  }

  /** Переключение «по себестоимости»: документ строится заново с другим набором цен. */
  setPriceMode(mode: 'sale' | 'cost'): void {    if (this.priceMode() === mode) return;
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
    this.api.downloadOrderReportFile$(this.date, this.storeId(), this.priceMode(), this.vatRate(), this.lang(), this.sort()).pipe(
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

  /** Блок слепка цен удалён вместе с механизмом фиксации цен. */

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

  /** Единица для узкой колонки JM: «porcija» печатаем как сербское «kom» (komad). */
  unitLabel(unit: ReportLine['unit']): string {
    return unit === 'porcija' ? 'kom' : unit;
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
