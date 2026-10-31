import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { OrdersService } from '../core/orders.service';
import { OrdersBoard, OrderDate, OrderItem } from '../core/models';
import { fmtMoney, fmtQty, httpErr } from '../core/format';
import { LiveService } from '../core/live.service';
import { OrdersNavComponent } from './orders-nav.component';

/**
 * Доска производства — главная страница раздела «Заказы магазинов».
 * Показывает ЗАКАЗЫ ТОВАРОВ всех активных магазинов за один лист-дату (по умолчанию —
 * самый свежий лист). Только просмотр: подтверждение/сборка/отмена живут в карточке
 * магазина. Синхронизация и журнал вынесены на отдельные страницы (навигация вверху).
 */
@Component({
  selector: 'app-orders-board',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, OrdersNavComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🧾 Заказы магазинов</h1>
    <app-orders-nav></app-orders-nav>

    @if (err()) { <div class="err">{{ err() }}</div> }

    <!-- переключатель листа-даты + фильтры -->
    <div class="panel">
      <div class="row" style="align-items:flex-end; flex-wrap:wrap">
        <label class="f" style="flex:1; min-width:200px">Лист (дата)
          <select [ngModel]="date()" (ngModelChange)="selectDate($event)">
            @for (d of dates(); track d.date) {
              <option [ngValue]="d.date">{{ pretty(d.date) }} · {{ d.cnt }} поз.{{ d.synced ? '' : ' · ручной' }}</option>
            }
            @if (!dates().length) { <option [ngValue]="null">нет данных</option> }
          </select>
        </label>
        @if (isFresh()) { <span class="badge green">актуальный лист</span> }
        <span class="spacer"></span>
        <button class="btn sm" (click)="goFresh()" title="Перейти на самый свежий лист">⤓ Актуальный</button>
        <button class="btn sm" (click)="load()">⟳ Обновить</button>
      </div>

      <div class="row" style="margin-top:10px; flex-wrap:wrap">
        <label class="f" style="flex:1; min-width:180px">Категория
          <select [ngModel]="category()" (ngModelChange)="category.set($event); load()">
            <option [ngValue]="''">— все —</option>
            @for (c of ordersSvc.categories(); track c) { <option [ngValue]="c">{{ c }}</option> }
          </select>
        </label>
        <label class="f" style="flex:2; min-width:220px">Поиск по названию
          <input [ngModel]="q()" (ngModelChange)="q.set($event); load()" placeholder="напр. оливье" />
        </label>
      </div>
    </div>

    <!-- сводка (только просмотр) -->
    @if (summary(); as s) {
      <div class="kpis">
        <div class="kpi"><div class="v">{{ s.lines }}</div><div class="l">позиций в листе</div></div>
        <div class="kpi"><div class="v">{{ s.stores }}</div><div class="l">магазинов заказали</div></div>
        <div class="kpi"><div class="v">{{ s.totalCost === null ? '—' : fmtMoney(s.totalCost) }}</div><div class="l">стоимость (по VK)</div></div>
        <div class="kpi">
          <div class="v" [class.red]="s.minBadLines > 0">{{ s.minOkLines }} / {{ s.lines }}</div>
          <div class="l">соответствие минимуму @if (s.minBadLines > 0) { · ⚠️ {{ s.minBadLines }} ниже }</div>
        </div>
      </div>
    }

    <!-- таблица заказов всех магазинов за выбранный лист — вид «как в Excel» -->
    <div class="panel">
      @if (loading()) { <p class="muted">Загрузка…</p> }
      @else {
        <div class="xlsx-wrap">
          <table class="tbl xlsx">
            <tr class="th-row">
              <th class="rowno">№</th><th>Магазин</th><th>Товар</th><th>Категория</th><th>Артикул</th>
              <th class="num">Кол-во</th><th class="num">Мин.</th><th>Статус</th>
            </tr>
            @for (it of items(); track it.id; let i = $index) {
              <tr>
                <td class="rowno">{{ i + 1 }}</td>
                <td><a class="store-link" [routerLink]="['/orders', it.storeId]">{{ it.storeName }}</a></td>
                <td>{{ it.name }}</td>
                <td>{{ it.category || '—' }}</td>
                <td>{{ it.plu || '—' }}</td>
                <td class="num">{{ fmtQty(it.qty, unitOf(it)) }}</td>
                <td class="num">
                  @if (it.minQty !== null) {
                    <span [class.red]="belowMin(it)">{{ fmtQty(it.minQty, unitOf(it)) }}</span>
                  } @else { <span class="muted">—</span> }
                </td>
                <td>
                  <span class="badge" [class]="badgeCls(it.status)">{{ statusLabel(it.status) }}</span>
                  @if (it.source === 'g_sheet') { <span class="badge gray" title="из Google Таблицы">G</span> }
                  @if (it.statusByLogin) {
                    <span class="who" [title]="'статус сменил: ' + it.statusByLogin + ' · ' + fmtWhen(it.statusAt)">
                      {{ it.statusByName || it.statusByLogin }} · {{ fmtWhen(it.statusAt) }}
                    </span>
                  }
                </td>
              </tr>
            } @empty {
              <tr class="empty"><td colspan="8">На этот лист заказов нет</td></tr>
            }
          </table>
        </div>
      }
    </div>
  `,
  styles: [`
    .xlsx-wrap { overflow: auto; max-height: 72vh; background: #fff; border: 1px solid #c9c9c9; border-radius: 6px; }
    .tbl.xlsx { border-collapse: collapse; width: 100%; background: #fff; color: #212121; font-family: 'Calibri', 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
    .tbl.xlsx th, .tbl.xlsx td { border: 1px solid #dcdcdc; padding: 5px 10px; text-align: left; vertical-align: middle; white-space: nowrap; }
    /* шапка как в Excel: серая полоса, прилипает сверху (замороженные панели) */
    .tbl.xlsx th { position: sticky; top: 0; z-index: 2; background: #f3f2f1; color: #242424; font-weight: 600; font-size: 12px; letter-spacing: 0; text-transform: none; box-shadow: inset 0 -2px 0 #b7b3af; }
    .tbl.xlsx td.num, .tbl.xlsx th.num { text-align: right; font-variant-numeric: tabular-nums; }
    /* столбец номеров строк — как заголовки строк в Excel, прилипает слева */
    .tbl.xlsx td.rowno, .tbl.xlsx th.rowno { position: sticky; left: 0; z-index: 1; background: #f3f2f1; color: #6a6a6a; text-align: center; font-weight: 600; width: 34px; box-shadow: inset -2px 0 0 #b7b3af; }
    .tbl.xlsx th.rowno { z-index: 3; }
    /* подсветка строки + «активная ячейка» с зелёной рамкой как в Excel */
    .tbl.xlsx tbody tr:hover td:not(.rowno) { background: #f6faf7; }
    .tbl.xlsx td:not(.rowno):hover { box-shadow: inset 0 0 0 2px #107c41; }
    .tbl.xlsx .store-link { font-weight: 600; color: var(--accent); text-decoration: none; }
    .tbl.xlsx .store-link:hover { text-decoration: underline; }
    .tbl.xlsx .empty td { position: static; box-shadow: none; background: #fff; text-align: center; color: var(--muted); padding: 24px; }
    .red { color: var(--red); }
    .who { font-size: 11px; color: var(--muted); }
  `],
})
export class OrdersBoardComponent implements OnInit {
  private api = inject(ApiService);
  readonly ordersSvc = inject(OrdersService);
  readonly live = inject(LiveService);

  dates = signal<OrderDate[]>([]);
  date = signal<string | null>(null);
  items = signal<OrderItem[]>([]);
  summary = signal<OrdersBoard['summary'] | null>(null);
  category = signal('');
  q = signal('');
  loading = signal(false);
  err = signal('');
  /** самый свежий лист, который разрешил сервер (для бейджа «актуальный») */
  private freshDate = signal<string | null>(null);
  /** дату выбрал руками — тогда живые события не переключают на самый свежий лист */
  private pinned = false;

  fmtMoney = fmtMoney;
  fmtQty = fmtQty;

  constructor() {
    // таблица изменилась и сервер перечитал её — обновляем доску
    effect(() => {
      if (this.live.sheetVersion() > 0) {
        untracked(() => {
          if (!this.pinned) this.date.set(null); // офис не выбирал лист — следим за самым свежим
          this.load();
        });
      }
    });
  }

  ngOnInit(): void {
    void this.ordersSvc.ensureCategories();
    this.load();
  }

  load(): void {
    const p: Record<string, string> = {};
    if (this.date()) p['date'] = this.date()!;
    if (this.category()) p['category'] = this.category();
    if (this.q().trim()) p['q'] = this.q().trim();
    this.loading.set(true);
    this.err.set('');
    this.api.ordersBoard$(p).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.dates.set(r.dates);
        this.summary.set(r.summary);
        // офис не выбирал лист руками — сервер вернул самый свежий, запоминаем его как эталон
        if (!this.pinned) {
          this.date.set(r.date);
          this.freshDate.set(r.date);
        }
        this.loading.set(false);
      },
      error: (e) => {
        this.err.set(httpErr(e));
        this.loading.set(false);
      },
    });
  }

  selectDate(d: string | null): void {
    this.pinned = true;
    this.date.set(d);
    this.load();
  }

  goFresh(): void {
    this.pinned = false;
    this.date.set(null);
    this.load();
  }

  /** выбранный лист совпадает с самым свежим, который разрешил сервер? */
  isFresh(): boolean {
    const d = this.date();
    return !!d && d === this.freshDate();
  }

  // ---- отображение ----
  unitOf(it: OrderItem): string {
    return it.cardUnit ?? it.unitCode ?? 'г';
  }
  belowMin(it: OrderItem): boolean {
    return it.minQty !== null && it.qty < it.minQty - 1e-6;
  }
  statusLabel(s: string): string {
    return { synced: 'синхрон.', placed: 'оформлен', confirmed: 'подтверждён', collected: 'собрали', cancelled: 'отменён' }[s] ?? s;
  }
  badgeCls(s: string): string {
    if (s === 'cancelled') return 'gray';
    if (s === 'collected') return 'green';
    if (s === 'confirmed') return 'blue';
    if (s === 'placed') return 'amber';
    return 'gray';
  }
  pretty(d: string | null): string {
    if (!d) return '—';
    const [y, m, day] = d.split('-');
    return `${day}.${m}.${y}`;
  }
  fmtWhen(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}
