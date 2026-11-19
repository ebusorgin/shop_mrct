import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { fmtDateTime, fmtMoney, fmtQty, fmtReportQty, httpErr } from '../core/format';
import { ArchiveOrder, ArchiveOrderItem, DeliveryWriteoffRecord, OrderArchive, UpcomingDelivery } from '../core/models';
import { DeliveryWriteoffComponent } from './delivery-writeoff.component';
import { packagingLabel } from '../core/packaging-label';
import { LangService } from '../core/lang.service';

/** Одна дата доставки и её заказы. */
interface DateGroup {
  date: string;
  orders: ArchiveOrder[];
  packages: number;
  positions: number;
  weightG: number;
}

/** День календаря доставок; null — пустая клетка до/после месяца. */
interface CalendarDay {
  date: string;
  day: number;
  hasDelivery: boolean;
  /** Будущая дата из расписания, заказа на неё ещё нет. */
  isUpcoming: boolean;
  isSelected: boolean;
  isToday: boolean;
}

/** Позиции заказа одного каталога — лёгкая визуальная группировка в карточке. */
interface ItemGroup {
  key: string;
  name: string;
  icon: string;
  color: string;
  items: ArchiveOrderItem[];
}

/**
 * Архив заказов: заказы сгруппированы по дате доставки, свежие даты первыми.
 * В офисе — заказы всех магазинов, в аккаунте магазина — только свои (route data storeMode).
 * Состав и комментарий заказа только для чтения.
 */
@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [FormsModule, RouterLink, DeliveryWriteoffComponent],
  templateUrl: './orders.component.html',
  styleUrl: './orders.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrdersComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private route = inject(ActivatedRoute);
  private lang = inject(LangService);

  /** true — история своего магазина, false — офисный архив всех магазинов. */
  readonly storeMode = this.route.snapshot.data['storeMode'] === true;

  /** Дата из ссылки ?date=YYYY-MM-DD: архив открывается на ней, если она есть в доставках. */
  private readonly linkedDate = (() => {
    const raw = this.route.snapshot.queryParamMap.get('date') ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  })();
  private linkedDateApplied = false;

  archive = signal<OrderArchive | null>(null);
  loading = signal(false);
  err = signal('');
  query = signal('');
  /** Выбранная дата доставки; null — берём самую свежую. */
  selectedDate = signal<string | null>(null);
  /** Месяц календаря (YYYY-MM); доставка в день одна, поэтому вместо списка дат — календарь. */
  viewMonth = signal<string | null>(null);

  readonly weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  fmtQty = fmtQty;
  fmtReportQty = fmtReportQty;
  fmtDateTime = fmtDateTime;
  fmtMoney = fmtMoney;

  groups = computed<DateGroup[]>(() => {
    const byDate = new Map<string, DateGroup>();
    for (const order of this.archive()?.orders ?? []) {
      let group = byDate.get(order.deliveryDate);
      if (!group) {
        group = { date: order.deliveryDate, orders: [], packages: 0, positions: 0, weightG: 0 };
        byDate.set(order.deliveryDate, group);
      }
      group.orders.push(order);
      group.packages += order.packages;
      group.positions += order.positions;
      group.weightG += order.weightG;
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  });

  group = computed<DateGroup | null>(() => {
    const date = this.selectedDate();
    return this.groups().find((g) => g.date === date) ?? null;
  });

  /** Будущие даты из расписания доставки: дата -> можно ли ещё оформить заказ. */
  upcoming = computed(() => new Map<string, UpcomingDelivery>(
    (this.archive()?.upcoming ?? []).map((item) => [item.date, item])
  ));

  /** Дни с заказами — отдельно от будущих дат расписания. */
  orderDates = computed(() => new Set(this.groups().map((g) => g.date)));

  /** Все отмеченные дни календаря: прошедшие с заказами и будущие доставки. */
  deliveryDates = computed(() => new Set([...this.orderDates(), ...this.upcoming().keys()]));

  /** Месяцы с доставками по возрастанию — стрелки календаря ходят только по ним. */
  monthKeys = computed(() => [...new Set([...this.deliveryDates()].map((date) => date.slice(0, 7)))].sort());

  viewMonthLabel = computed(() => {
    const key = this.viewMonth();
    return key ? this.monthLabel(key) : '';
  });

  canOlderMonth = computed(() => this.monthKeys().indexOf(this.viewMonth() ?? '') > 0);

  canNewerMonth = computed(() => {
    const keys = this.monthKeys();
    const index = keys.indexOf(this.viewMonth() ?? '');
    return index >= 0 && index < keys.length - 1;
  });

  /** Клетки календаря: дни месяца с отметкой доставки, понедельник — первый столбец. */
  calendarDays = computed<(CalendarDay | null)[]>(() => {
    const key = this.viewMonth();
    if (!key) return [];
    const [year, month] = key.split('-').map(Number);
    const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month, 0).getDate();
    const deliveries = this.deliveryDates();
    const ordered = this.orderDates();
    const selected = this.selectedDate();
    const today = this.todayIso();
    const cells: (CalendarDay | null)[] = Array.from({ length: offset }, () => null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${key}-${String(day).padStart(2, '0')}`;
      cells.push({
        date,
        day,
        hasDelivery: deliveries.has(date),
        isUpcoming: deliveries.has(date) && !ordered.has(date),
        isSelected: date === selected,
        isToday: date === today,
      });
    }
    while (cells.length % 7) cells.push(null);
    return cells;
  });

  /** Расписание выбранной даты: open — приём заказа ещё идёт. */
  selectedWindow = computed<UpcomingDelivery | null>(() => {
    const date = this.selectedDate();
    return date ? this.upcoming().get(date) ?? null : null;
  });

  /** Магазин может оформить заказ на выбранную дату, пока приём не закрыт. */
  canOrderSelected = computed(() => this.storeMode && !!this.selectedWindow()?.open);

  /** Отчёт-отгрузку можно выгрузить, когда приём заказов на дату уже закрыт. */
  canDownloadReport = computed(() => {
    // Отчёт доступен для любой даты с заказами — и для ещё открытого окна приёма,
    // чтобы офис мог проверить документ до закрытия заказа.
    const group = this.group();
    return !!this.selectedDate() && !!group && group.orders.length > 0;
  });

  todayIso = computed(() => this.archive()?.today ?? '');

  totalOrders = computed(() => this.archive()?.orders.length ?? 0);
  totalPackages = computed(() => this.groups().reduce((sum, g) => sum + g.packages, 0));

  private normalizedQuery = computed(() => this.query().trim().toLocaleLowerCase('ru'));

  visibleOrders = computed(() => {
    const orders = this.group()?.orders ?? [];
    const q = this.normalizedQuery();
    if (!q) return orders;
    return orders.filter((o) =>
      `${o.storeName} ${o.storeCode} ${o.storeId} ${o.items
        .flatMap((item) => [item.cardName, item.cardNameEn ?? '', item.cardNameSr ?? ''])
        .join(' ')}`
        .toLocaleLowerCase('ru')
        .includes(q)
    );
  });

  private readonly fullDateFormat = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  private readonly monthFormat = new Intl.DateTimeFormat('ru-RU', {
    month: 'long', year: 'numeric',
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    if (this.loading()) return;
    this.loading.set(true);
    this.err.set('');
    const request$ = this.storeMode ? this.api.myOrderArchive$() : this.api.orderArchive$();
    request$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (archive) => {
          this.archive.set(archive);
          this.loading.set(false);
          const current = this.selectedDate();
          if (!this.linkedDateApplied && this.linkedDate && this.deliveryDates().has(this.linkedDate)) {
            this.linkedDateApplied = true;
            this.selectedDate.set(this.linkedDate);
          } else if (!current || !this.deliveryDates().has(current)) {
            const nextOpen = archive.upcoming.find((item) => item.open) ?? archive.upcoming[0];
            this.selectedDate.set(archive.orders[0]?.deliveryDate ?? nextOpen?.date ?? null);
          }
          this.linkedDateApplied = true;
          const selected = this.selectedDate();
          if (selected) this.viewMonth.set(selected.slice(0, 7));
          this.loadWriteoffStatus(selected);
        },
        error: (e) => {
          this.loading.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  selectDate(date: string): void {
    this.selectedDate.set(date);
    this.viewMonth.set(date.slice(0, 7));
    this.loadWriteoffStatus(date);
  }

  // ---------- ручное списание склада по доставке ----------
  woOpen = signal(false);
  woRecords = signal<DeliveryWriteoffRecord[]>([]);

  /** Статус списаний даты — бейдж в шапке даты (только офис). */
  loadWriteoffStatus(date: string | null): void {
    if (this.storeMode || !date) {
      this.woRecords.set([]);
      return;
    }
    this.api.deliveryWriteoffStatus$(date).subscribe({
      next: (r) => this.woRecords.set(r.records ?? []),
      error: () => this.woRecords.set([]),
    });
  }

  onWriteoffWritten(): void {
    this.loadWriteoffStatus(this.selectedDate());
  }

  /** Короткая подпись бейджа: когда и кем списано. */
  woWhen(): string {
    const r = this.woRecords()[0];
    if (!r) return '';
    const d = new Date(r.at);
    const when = Number.isNaN(d.getTime())
      ? r.at
      : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return r.storeId == null ? `все магазины, ${when}` : `${r.storeName ?? 'магазин'}, ${when}`;
  }

  woTitle(): string {
    return this.woRecords()
      .map((r) => `${r.storeName || 'все магазины'} · ${r.login ?? ''} · ${r.positions} поз.`)
      .join('\n');
  }

  /** Стрелки календаря: только месяцы, в которых были доставки. */
  shiftMonth(delta: number): void {
    const keys = this.monthKeys();
    const next = keys[keys.indexOf(this.viewMonth() ?? '') + delta];
    if (next) this.viewMonth.set(next);
  }

  resetFilters(): void {
    this.query.set('');
  }

  /** «Ноябрь 2026» — заголовок месяца в календаре. */
  private monthLabel(key: string): string {
    const label = this.monthFormat.format(this.toDate(`${key}-01`)).replace(' г.', '');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  fullDateLabel(date: string): string {
    const label = this.fullDateFormat.format(this.toDate(date));
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  /** «Сегодня» / «Предстоит» / «Прошла» — статус даты доставки. */
  dateState(date: string): string {
    const today = this.todayIso();
    if (date === today) return 'Сегодня';
    return date > today ? 'Предстоит' : 'Прошла';
  }

  itemLabel(item: ArchiveOrderItem): string {
    const lang = this.lang.currentLang();
    const cardName =
      (lang === 'en' && item.cardNameEn) || (lang === 'sr' && item.cardNameSr) || item.cardName;
    return packagingLabel(cardName, item.packagingName || fmtQty(item.qtyBase, item.unitCode));
  }

  /**
   * Вторая строка количества — там, где основная строка уже показывает число:
   * для порций это вес партии, для кг/л и штук — число упаковок в заказе.
   */
  itemSub(item: ArchiveOrderItem): string {
    if (item.reportUnit === 'porcija') {
      return fmtQty(item.qty * item.qtyBase, item.unitCode);
    }
    return `${item.qty} уп.`;
  }

  /** Позиции заказа по каталогам: заголовок группы рисуем тонко, без рамок и плашек. */
  itemGroups(o: ArchiveOrder): ItemGroup[] {
    const groups = new Map<string, ItemGroup>();
    for (const item of o.items) {
      const key = item.catalogId == null ? 'none' : String(item.catalogId);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          name: item.catalogName || 'прочее',
          icon: item.catalogIcon || '📦',
          color: item.catalogColor || '#d9d3c7',
          items: [],
        };
        groups.set(key, g);
      }
      g.items.push(item);
    }
    return [...groups.values()];
  }

  plural(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  private toDate(date: string): Date {
    return new Date(`${date}T00:00:00`);
  }
}
