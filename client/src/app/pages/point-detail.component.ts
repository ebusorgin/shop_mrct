import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiService } from '../core/api.service';
import { PointCard, StoreStats } from '../core/models';
import { fmtMoney, fmtQty, httpErr } from '../core/format';
import { PointFormComponent } from '../shared/point-form.component';

/** Дата «ГГГГ-ММ-ДД» -> «ДД.ММ.ГГГГ». */
function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parts = iso.slice(0, 10).split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : iso;
}

/** Месяц «ГГГГ-ММ» -> «ММ.ГГ». */
function monthLabel(month: string): string {
  const [year, mon] = month.split('-');
  return `${mon}.${year.slice(2)}`;
}

type TrendProduct = StoreStats['productTrends'][number];
type TrendPoint = TrendProduct['points'][number];

const TREND_COLORS = ['#1f91d9', '#e11b22', '#1a8a4a', '#b8860b', '#7c3aed', '#0a3550'];
const TREND_DAY_MS = 86_400_000;
const TREND_COMPOUND_DAILY = Math.pow(1.24, 1 / 365) - 1;
const TREND_FORECAST_DAYS = 30;
const TREND_VELOCITY_DAYS = 28;
const TREND_MAX_SERIES = 6;

function trendDayNo(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) / TREND_DAY_MS;
}

function isoFromTrendDay(day: number): string {
  return new Date(day * TREND_DAY_MS).toISOString().slice(0, 10);
}

interface TrendChartPoint {
  day: number;
  value: number;
}

interface TrendChartSeries {
  name: string;
  color: string;
  actualPath: string;
  forecastPath: string;
  metrics: { lastValue: number; forecastEnd: number; accel: number | null };
}

interface TrendChartModel {
  width: number;
  height: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  plotW: number;
  plotH: number;
  maxActualDay: number;
  horizonDay: number;
  forecastX: number;
  grid: { frac: number; y: number; label: string }[];
  xLabels: { day: number; x: number; label: string }[];
  series: TrendChartSeries[];
}

/**
 * Внутренняя страница точки продаж: профиль, показатели, динамика заказов
 * и действия (изменить, деактивировать, скрыть). Скрытие — мягкое: карточка
 * пропадает из справочника, но заказы и история остаются в БД.
 */
@Component({
  selector: 'app-point-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, PointFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (err() && !point()) {
      <div class="err">{{ err() }}</div>
      <a class="btn sm" routerLink="/points">← К списку магазинов</a>
    }

    @if (point(); as p) {
      <div class="bar">
        <a class="back" routerLink="/points" title="Все магазины">←</a>
        <h1 class="page-title" style="margin:0">{{ p.name }}</h1>
        <span class="pill blue">{{ p.code }}</span>
        <span class="pill" [class.green]="p.active" [class.gray]="!p.active">{{ p.active ? 'Активен' : 'Не активен' }}</span>
        <span class="spacer"></span>
        <button class="btn sm" (click)="editing.set(true)">✏️ Изменить</button>
        @if (p.active) {
          <button class="btn sm" (click)="deactivate(p)">⏸ Деактивировать</button>
        } @else {
          <button class="btn sm" (click)="activate(p)">▶ Активировать</button>
        }
        <button class="btn sm danger" (click)="remove(p)">🗑 Удалить</button>
      </div>

      @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }
      @if (err()) { <div class="err">{{ err() }}</div> }

      @if (stats(); as s) {
        <div class="kpis">
          <div class="kpi">
            <div class="v">{{ s.orders.total }}</div>
            <div class="l">заказов всего</div>
            <div class="k-sub">за 30 дней: {{ s.orders.last30 }} · за 90: {{ s.orders.last90 }}</div>
          </div>
          <div class="kpi">
            <div class="v">{{ fmtMoney(s.revenue.gross) }}</div>
            <div class="l">сумма заказов с PDV</div>
            <div class="k-sub">без PDV: {{ fmtMoney(s.revenue.net) }} · PDV: {{ fmtMoney(s.revenue.vat) }}</div>
          </div>
          <div class="kpi">
            <div class="v">{{ fmtMoney(s.revenue.avgNet) }}</div>
            <div class="l">средний заказ без PDV</div>
            <div class="k-sub">за 30 дней: {{ fmtMoney(s.revenue.last30Net) }}</div>
          </div>
          <div class="kpi">
            <div class="v">{{ day(s.orders.lastDate) }}</div>
            <div class="l">последняя доставка</div>
            <div class="k-sub">первая: {{ day(s.orders.firstDate) }}</div>
          </div>
          <div class="kpi">
            <div class="v">{{ day(s.nextDelivery?.date) }}</div>
            <div class="l">ближайшая доставка</div>
            <div class="k-sub">
              @if (s.nextDelivery) {
                {{ s.nextDelivery.open ? 'приём открыт' : 'приём закрыт' }} ·
                {{ s.nextDelivery.hasOrder ? 'заказ сохранён' : 'заказа нет' }}
              } @else {
                дат доставки нет
              }
            </div>
          </div>
        </div>

        <div class="grid2">
          <div class="panel">
            <h3>Профиль магазина</h3>
            <div class="profile">
              <div class="pf"><span class="k">Адрес</span><span class="v">{{ p.address || '—' }}</span></div>
              <div class="pf"><span class="k">Телефон</span><span class="v">{{ p.phone || '—' }}</span></div>
              <div class="pf"><span class="k">Email</span><span class="v">{{ p.email || '—' }}</span></div>
              <div class="pf"><span class="k">Контакт</span><span class="v">{{ p.contactPerson || '—' }}</span></div>
              <div class="pf"><span class="k">Режим</span><span class="v">{{ p.openingHours || '—' }}</span></div>
              <div class="pf"><span class="k">PIB</span><span class="v">{{ p.pib || '—' }}</span></div>
              <div class="pf"><span class="k">MBR</span><span class="v">{{ p.mbr || '—' }}</span></div>
              <div class="pf"><span class="k">Tekući račun</span><span class="v">{{ p.accountNo || '—' }}</span></div>
              @if (p.note) { <div class="pf"><span class="k">Заметка</span><span class="v">{{ p.note }}</span></div> }
            </div>
            <div class="muted small foot">
              @if (p.createdByLogin) { завёл {{ p.createdByName || p.createdByLogin }} · {{ day(p.createdAt) }} }
              @if (p.updatedByLogin) { · правил {{ p.updatedByName || p.updatedByLogin }} · {{ day(p.updatedAt) }} }
            </div>
          </div>

          <div class="panel">
            <h3>Сумма заказов по месяцам <small class="muted">· без PDV, 12 месяцев</small></h3>
            @if (hasMonthly()) {
              <div class="chart">
                @for (m of s.monthly; track m.month) {
                  <div class="col" [title]="month(m.month) + ': заказов ' + m.orders + ', ' + fmtMoney(m.net)">
                    <div class="bar-area">
                      <div class="bar" [class.zero]="!m.net" [style.height.%]="barHeight(m.net)"></div>
                    </div>
                    <div class="mon">{{ month(m.month) }}</div>
                  </div>
                }
              </div>
            } @else {
              <div class="muted small">Заказов пока нет.</div>
            }
          </div>
        </div>

        <div class="panel">
          <h3>Топ продукции <small class="muted">· индекс: экономика 40 % + сложный рост 30 % + частота 20 % + свежесть 10 %, 12 месяцев</small></h3>
          @if (s.topProducts.length) {
            <table class="tbl stack">
              <thead>
                <tr>
                  <th>#</th><th>Продукция</th><th>ABC</th><th>Индекс</th>
                  <th class="num">доля</th><th class="num">выручка</th><th class="num">заказы</th><th class="num">рост/мес</th>
                </tr>
              </thead>
              <tbody>
                @for (row of s.topProducts; track row.name; let rank = $index) {
                  <tr [title]="topHint(row)">
                    <td class="nw">{{ rank + 1 }}</td>
                    <td>
                      <b>{{ row.name }}</b>
                      @if (row.nameSr) { <div class="muted small">{{ row.nameSr }}</div> }
                    </td>
                    <td data-l="ABC">
                      <span class="badge" [class.green]="row.abc === 'A'" [class.blue]="row.abc === 'B'" [class.gray]="row.abc === 'C'">{{ row.abc }}</span>
                    </td>
                    <td data-l="Индекс" class="nw">
                      <div class="score">
                        <span class="score-bar"><i [style.width.%]="row.score"></i></span>
                        <b>{{ row.score }}</b>
                      </div>
                    </td>
                    <td data-l="Доля" class="num">{{ row.sharePct.toFixed(1) }}%</td>
                    <td data-l="Выручка 12 мес" class="num">{{ fmtMoney(row.net) }}</td>
                    <td data-l="Заказы" class="num">{{ row.orders }}</td>
                    <td data-l="Рост/мес" class="num">
                      <span class="badge" [class.green]="row.cagrPct > 0" [class.red]="row.cagrPct < 0" [class.gray]="!row.cagrPct">{{ signedPct(row.cagrPct) }}</span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            <div class="muted small top-note">
              ABC — вклад в выручку; рост/мес — сложный процент (CAGR); наведите на строку — RFM и импульс 90/90.
            </div>
          } @else {
            <div class="muted small">Продаж за последние 12 месяцев нет.</div>
          }
        </div>

        <div class="panel">
          <h3>Динамика по позициям <small class="muted">· выбор до 6, наложение, ускорение, прогноз 30 дн.</small></h3>
          @if (s.productTrends.length) {
            <div class="trend-controls">
              <input class="trend-search" [value]="trendSearch()" (input)="onTrendSearch($event)" placeholder="Поиск товара…">
              <span class="muted small">выбрано {{ selectedTrends().length }}/{{ maxTrends }}</span>
            </div>

            <div class="trend-selected">
              @for (name of selectedTrends(); track name) {
                <button type="button" class="trend-chip" (click)="toggleTrend(name)">
                  <span class="dot" [style.background]="trendColor(trendIndex(name))"></span>{{ name }} ×
                </button>
              } @empty {
                <span class="muted small">Выберите товары ниже — графики наложатся на одну шкалу.</span>
              }
            </div>

            <div class="trend-picker">
              @for (p of trendFiltered(); track p.name) {
                <label class="trend-pick" [class.on]="isTrendSelected(p.name)">
                  <input type="checkbox" [checked]="isTrendSelected(p.name)" (change)="toggleTrend(p.name)" [disabled]="!isTrendSelected(p.name) && selectedTrends().length >= maxTrends">
                  <span>{{ p.name }}</span>
                </label>
              }
            </div>

            @if (trendModel(); as tm) {
              <svg class="trend-chart" viewBox="0 0 640 260" role="img" aria-label="Динамика по позициям">
                @for (g of tm.grid; track g.frac) {
                  <line [attr.x1]="tm.padL" [attr.x2]="tm.plotW + tm.padL" [attr.y1]="g.y" [attr.y2]="g.y" stroke="#e3ecf5" stroke-width="1" />
                  <text [attr.x]="tm.padL - 6" [attr.y]="g.y + 3" text-anchor="end" class="axis">{{ g.label }}</text>
                }
                <line [attr.x1]="tm.forecastX" [attr.x2]="tm.forecastX" [attr.y1]="tm.padT" [attr.y2]="tm.plotH + tm.padT" stroke="#9fb3c8" stroke-width="1" stroke-dasharray="4 4" />
                <text [attr.x]="tm.forecastX" [attr.y]="tm.padT - 4" text-anchor="middle" class="axis">прогноз</text>
                @for (s of tm.series; track s.name) {
                  <path [attr.d]="s.actualPath" fill="none" [attr.stroke]="s.color" stroke-width="2" vector-effect="non-scaling-stroke" />
                  <path [attr.d]="s.forecastPath" fill="none" [attr.stroke]="s.color" stroke-width="2" stroke-dasharray="6 4" opacity="0.8" vector-effect="non-scaling-stroke" />
                }
                @for (xl of tm.xLabels; track xl.day) {
                  <text [attr.x]="xl.x" [attr.y]="tm.height - tm.padB + 18" text-anchor="middle" class="axis">{{ xl.label }}</text>
                }
              </svg>

              <div class="trend-legend">
                @for (s of tm.series; track s.name) {
                  <div class="trend-chip static">
                    <span class="dot" [style.background]="s.color"></span>
                    <span class="trend-chip-name" [title]="s.name">{{ s.name }}</span>
                    <span class="muted small">{{ fmtMoney(s.metrics.lastValue) }}</span>
                    <span class="pill" [class.green]="s.metrics.accel !== null && s.metrics.accel > 0" [class.red]="s.metrics.accel !== null && s.metrics.accel < 0" [class.gray]="s.metrics.accel === null">
                      {{ accelText(s.metrics.accel) }}
                    </span>
                    <span class="muted small">→ {{ fmtMoney(s.metrics.forecastEnd) }}</span>
                  </div>
                }
              </div>
            } @else {
              <div class="muted small">Выберите хотя бы один товар.</div>
            }
          } @else {
            <div class="muted small">Нет данных по заказам.</div>
          }
        </div>

        <div class="panel">
          <h3>Последние доставки</h3>
          @if (s.recentOrders.length) {
            <table class="tbl">
              <thead><tr><th>Доставка</th><th class="num">поз.</th><th class="num">упак.</th><th class="num">вес</th><th class="num">сумма</th></tr></thead>
              <tbody>
                @for (row of s.recentOrders; track row.id) {
                  <tr>
                    <td class="nw">{{ day(row.deliveryDate) }}</td>
                    <td class="num">{{ row.positions }}</td>
                    <td class="num">{{ row.packages }}</td>
                    <td class="num nw">{{ row.weightG ? fmtQty(row.weightG, 'г') : '—' }}</td>
                    <td class="num">{{ fmtMoney(row.net) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="muted small">Заказов ещё не было.</div>
          }
        </div>

        @if (s.users.length) {
          <div class="panel">
            <h3>Сотрудники магазина</h3>
            <table class="tbl">
              <thead><tr><th>Логин</th><th>Имя</th><th>Последний вход</th><th>Статус</th></tr></thead>
              <tbody>
                @for (u of s.users; track u.login) {
                  <tr>
                    <td>{{ u.login }}</td>
                    <td>{{ u.name }}</td>
                    <td class="nw">{{ u.lastLogin || '—' }}</td>
                    <td><span class="pill" [class.green]="u.active" [class.gray]="!u.active">{{ u.active ? 'активен' : 'выключен' }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      } @else if (!err()) {
        <p class="muted">Загрузка показателей…</p>
      }

      @if (editing()) {
        <app-point-form [point]="p" (saved)="onSaved()" (closed)="editing.set(false)" />
      }
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    .back {
      display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px;
      border-radius: 8px; border: 1px solid var(--border); background: #fff; color: var(--text);
      text-decoration: none; font-size: 16px; flex: 0 0 auto;
    }
    .back:hover { background: #f2f5fa; border-color: #c3d5e6; }
    .kpis { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
    .kpi .k-sub { color: var(--muted); font-size: 11.5px; margin-top: 4px; }
    .profile { display: flex; flex-direction: column; gap: 6px; }
    .pf { display: flex; gap: 10px; font-size: 13px; }
    .pf .k { color: var(--muted); min-width: 110px; flex: 0 0 auto; }
    .pf .v { overflow-wrap: anywhere; }
    .foot { margin-top: 10px; }
    .small { font-size: 12px; }
    .chart { display: flex; align-items: stretch; gap: 6px; height: 170px; padding-top: 6px; }
    .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .bar-area { flex: 1; display: flex; align-items: flex-end; }
    .bar {
      width: 100%; min-height: 2px; border-radius: 4px 4px 0 0;
      background: linear-gradient(180deg, var(--brand-blue) 0%, var(--brand-blue-dark) 100%);
    }
    .bar.zero { background: #dfe7f0; }
    .col:hover .bar { filter: brightness(1.08); }
    .mon { text-align: center; font-size: 10.5px; color: var(--muted); white-space: nowrap; }
    .tbl td .small { margin-top: 2px; }
    .score { display: flex; align-items: center; gap: 8px; }
    .score-bar { display: inline-block; width: 64px; height: 6px; border-radius: 999px; background: #e3ecf5; overflow: hidden; }
    .score-bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--brand-blue), var(--brand-blue-dark)); }
    .score b { font-variant-numeric: tabular-nums; }
    .top-note { margin-top: 8px; }
    .trend-controls { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
    .trend-search { min-width: 220px; max-width: 320px; }
    .trend-selected { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    .trend-chip {
      display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border);
      background: #fff; border-radius: 999px; padding: 4px 10px; font-size: 12px; cursor: pointer;
    }
    .trend-chip.static { cursor: default; }
    .trend-chip .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
    .trend-chip-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .trend-picker {
      display: flex; flex-wrap: wrap; gap: 6px; max-height: 120px; overflow: auto;
      padding: 8px; border: 1px solid var(--border); border-radius: 10px; background: #fbfdff; margin-bottom: 12px;
    }
    .trend-pick {
      display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border);
      border-radius: 999px; padding: 4px 9px; font-size: 12px; background: #fff; cursor: pointer;
    }
    .trend-pick.on { border-color: var(--brand-blue); background: var(--accent-soft); }
    .trend-pick input { margin: 0; }
    .trend-chart { width: 100%; height: auto; display: block; background: #fbfdff; border: 1px solid var(--border); border-radius: 10px; }
    .axis { font-size: 10px; fill: var(--muted); }
    .trend-legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    @media (max-width: 720px) {
      .grid2 { grid-template-columns: 1fr; }
      .pf .k { min-width: 88px; }
    }
    `,
  ],
})
export class PointDetailComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly id = Number(this.route.snapshot.paramMap.get('id'));

  point = signal<PointCard | null>(null);
  stats = signal<StoreStats | null>(null);
  editing = signal(false);
  err = signal('');
  msg = signal('');

  readonly fmtMoney = fmtMoney;
  readonly fmtQty = fmtQty;
  readonly day = dateLabel;
  readonly month = monthLabel;

  readonly hasMonthly = computed(() => (this.stats()?.monthly ?? []).some((m) => m.net > 0 || m.orders > 0));
  private readonly maxNet = computed(() =>
    (this.stats()?.monthly ?? []).reduce((max, m) => Math.max(max, m.net), 0)
  );

  readonly maxTrends = TREND_MAX_SERIES;
  trendSearch = signal('');
  selectedTrends = signal<string[]>([]);
  private trendsSeeded = false;

  readonly trendProducts = computed(() => this.stats()?.productTrends ?? []);
  readonly trendFiltered = computed(() => {
    const q = this.trendSearch().trim().toLowerCase();
    const list = this.trendProducts();
    if (!q) return list;
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.nameSr ?? '').toLowerCase().includes(q)
    );
  });
  readonly selectedTrendProducts = computed(() => {
    const byName = new Map(this.trendProducts().map((p) => [p.name, p]));
    return this.selectedTrends()
      .map((name) => byName.get(name))
      .filter((p): p is TrendProduct => Boolean(p));
  });
  readonly trendModel = computed(() => this.buildTrendModel());

  onTrendSearch(event: Event): void {
    this.trendSearch.set((event.target as HTMLInputElement).value);
  }

  isTrendSelected(name: string): boolean {
    return this.selectedTrends().includes(name);
  }

  trendIndex(name: string): number {
    return this.selectedTrends().indexOf(name);
  }

  trendColor(index: number): string {
    return TREND_COLORS[((index % TREND_COLORS.length) + TREND_COLORS.length) % TREND_COLORS.length];
  }

  toggleTrend(name: string): void {
    const sel = [...this.selectedTrends()];
    const idx = sel.indexOf(name);
    if (idx >= 0) {
      sel.splice(idx, 1);
      this.selectedTrends.set(sel);
      return;
    }
    if (sel.length >= this.maxTrends) {
      this.message(`Можно накладывать не больше ${this.maxTrends} графиков`);
      return;
    }
    sel.push(name);
    this.selectedTrends.set(sel);
  }

  accelText(value: number | null): string {
    if (value === null) return '—';
    const pct = Math.round(value * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
  }

  /** Знаковый процент «+12.4%». */
  signedPct(value: number | null): string {
    if (value === null) return '—';
    const rounded = Math.round(value * 10) / 10;
    return `${rounded > 0 ? '+' : ''}${rounded}%`;
  }

  /** Подсказка строки топа: RFM, объём и импульс последних 90 дней. */
  topHint(row: StoreStats['topProducts'][number]): string {
    const parts = [
      `RFM R${row.rfm.r}·F${row.rfm.f}·M${row.rfm.m}`,
      `заказов: ${row.orders}`,
      `упаковок: ${row.packages}`,
    ];
    if (row.momentumPct !== null) parts.push(`импульс 90/90: ${this.signedPct(row.momentumPct)}`);
    if (row.lastDate) parts.push(`последняя доставка: ${dateLabel(row.lastDate)}`);
    return parts.join(' · ');
  }

  private ensureTrendSelection(stats: StoreStats): void {
    if (this.trendsSeeded) return;
    this.trendsSeeded = true;
    this.selectedTrends.set(stats.productTrends.slice(0, 3).map((p) => p.name));
  }

  private buildTrendModel(): TrendChartModel | null {
    const products = this.selectedTrendProducts();
    if (!products.length) return null;

    const width = 640;
    const height = 260;
    const padL = 58;
    const padR = 14;
    const padT = 18;
    const padB = 34;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const prepared = products.map((product, index) => {
      const pts = product.points
        .map((pt: TrendPoint) => ({ day: trendDayNo(pt.date), value: pt.value, net: pt.net }))
        .sort((a, b) => a.day - b.day);
      const firstDay = pts[0]?.day ?? 0;
      const lastDay = pts[pts.length - 1]?.day ?? 0;
      const lastValue = pts[pts.length - 1]?.value ?? product.lastValue;
      const recentNet = pts
        .filter((pt) => pt.day >= lastDay - TREND_VELOCITY_DAYS + 1)
        .reduce((sum, pt) => sum + pt.net, 0);
      const prevNet = pts
        .filter((pt) => pt.day >= lastDay - TREND_VELOCITY_DAYS * 2 + 1 && pt.day < lastDay - TREND_VELOCITY_DAYS + 1)
        .reduce((sum, pt) => sum + pt.net, 0);
      const recentAvg = recentNet / TREND_VELOCITY_DAYS;
      const prevAvg = prevNet / TREND_VELOCITY_DAYS;
      const spanDays = Math.max(1, lastDay - firstDay);
      const velocity = recentAvg > 0 ? recentAvg : product.totalNet / spanDays;
      const accel = prevAvg > 0 ? (recentAvg - prevAvg) / prevAvg : recentAvg > 0 ? 1 : null;

      return {
        product,
        color: this.trendColor(index),
        pts,
        firstDay,
        lastDay,
        lastValue,
        velocity,
        accel,
        forecastPts: [] as TrendChartPoint[],
        forecastEnd: 0,
      };
    });

    const maxActualDay = Math.max(...prepared.map((p) => p.lastDay));
    const horizonDay = maxActualDay + TREND_FORECAST_DAYS;
    const minDay = Math.min(...prepared.map((p) => p.firstDay));
    const maxDay = horizonDay;

    for (const p of prepared) {
      const forecastPts: TrendChartPoint[] = [{ day: p.lastDay, value: p.lastValue }];
      let value = p.lastValue;
      for (let day = p.lastDay + 1; day <= horizonDay; day++) {
        value *= 1 + TREND_COMPOUND_DAILY;
        if (day > maxActualDay) value += p.velocity;
        forecastPts.push({ day, value });
      }
      p.forecastPts = forecastPts;
      p.forecastEnd = forecastPts[forecastPts.length - 1]?.value ?? p.lastValue;
    }

    const maxValue = Math.max(
      1,
      ...prepared.flatMap((p) => [
        ...p.pts.map((pt) => pt.value),
        ...p.forecastPts.map((pt) => pt.value),
      ])
    );
    const x = (day: number): number =>
      padL + (maxDay > minDay ? ((day - minDay) / (maxDay - minDay)) * plotW : plotW / 2);
    const y = (value: number): number => padT + plotH - (value / maxValue) * plotH;
    const pathFrom = (pts: { day: number; value: number }[]): string =>
      pts.length
        ? `M${pts.map((pt) => `${x(pt.day).toFixed(1)},${y(pt.value).toFixed(1)}`).join(' L')}`
        : '';

    const grid = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
      frac,
      y: padT + plotH - frac * plotH,
      label: this.fmtMoney(maxValue * frac),
    }));
    const labelDays = [...new Set([minDay, Math.round((minDay + maxActualDay) / 2), maxActualDay, horizonDay])].sort(
      (a, b) => a - b
    );
    const xLabels = labelDays.map((day) => ({
      day,
      x: x(day),
      label: dateLabel(isoFromTrendDay(day)),
    }));

    return {
      width,
      height,
      padL,
      padR,
      padT,
      padB,
      plotW,
      plotH,
      maxActualDay,
      horizonDay,
      forecastX: x(maxActualDay),
      grid,
      xLabels,
      series: prepared.map((p) => ({
        name: p.product.name,
        color: p.color,
        actualPath: pathFrom(p.pts),
        forecastPath: pathFrom(p.forecastPts),
        metrics: { lastValue: p.lastValue, forecastEnd: p.forecastEnd, accel: p.accel },
      })),
    };
  }

  ngOnInit(): void {
    this.load();
  }

  barHeight(net: number): number {
    const max = this.maxNet();
    return max > 0 ? Math.max((net / max) * 100, net > 0 ? 4 : 0) : 0;
  }

  load(): void {
    this.err.set('');
    forkJoin({ point: this.api.point$(this.id), stats: this.api.pointStats$(this.id) }).subscribe({
      next: ({ point, stats }) => {
        this.point.set(point);
        this.stats.set(stats);
        this.ensureTrendSelection(stats);
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  onSaved(): void {
    this.message('Сохранено');
    this.load();
  }

  deactivate(p: PointCard): void {
    if (!confirm(`Деактивировать магазин «${p.name}»? Он останется в справочнике, но будет помечен как неактивный.`)) return;
    this.api.deactivatePoint(p.id).subscribe({
      next: () => {
        this.message('Магазин деактивирован');
        this.load();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  activate(p: PointCard): void {
    this.api.activatePoint(p.id).subscribe({
      next: () => {
        this.message('Магазин снова активен');
        this.load();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  remove(p: PointCard): void {
    if (!confirm(`Скрыть магазин «${p.name}»? Он исчезнет из справочника, но все заказы и история останутся в БД.`)) return;
    this.api.deletePoint(p.id).subscribe({
      next: () => this.router.navigate(['/points']),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  private message(text: string): void {
    this.msg.set(text);
    setTimeout(() => this.msg.set(''), 3000);
  }
}
