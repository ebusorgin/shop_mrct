import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { OrdersService } from '../core/orders.service';
import { LiveService } from '../core/live.service';
import type { BoardRow, OrderDate } from '../core/models';
import { OrdersNavComponent } from './orders-nav.component';

/**
 * Доска производства («как в Excel»): строки = позиции-товары, колонки = магазины 103..110
 * с печатным количеством (порции/шт/кг), плюс Кол-во / Цена порции / Полная цена и итоговая
 * строка по магазинам. Только просмотр — действия в карточке магазина.
 * По умолчанию — самый свежий лист; переключатель дат сверху. Живой канал (SSE) перезагружает
 * доску на изменения листа, если пользователь не выбрал дату вручную.
 */
@Component({
  selector: 'app-orders-board',
  standalone: true,
  imports: [CommonModule, FormsModule, OrdersNavComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .board-select { min-width: 170px; }
      .fresh-btn { white-space: nowrap; }
      .fresh-btn.on { background: var(--accent); color: #fff; border-color: var(--accent); }

      /* сетка «как в Excel»: скролл-контейнер + залипающая шапка и колонка товара */
      .xlsx-wrap { overflow: auto; max-height: 72vh; background: #fff; border: 1px solid #c9c9c9; border-radius: 6px; }
      .tbl.xlsx { border-collapse: collapse; width: 100%; background: #fff; color: #212121;
        font-family: 'Calibri','Segoe UI',system-ui,sans-serif; font-size: 14px; }
      .tbl.xlsx th, .tbl.xlsx td { border: 1px solid #dcdcdc; padding: 5px 10px;
        text-align: left; vertical-align: middle; white-space: nowrap; }
      .tbl.xlsx th { position: sticky; top: 0; z-index: 2; background: #f3f2f1; color: #242424;
        font-weight: 600; font-size: 12px; letter-spacing: 0; text-transform: none;
        box-shadow: inset 0 -2px 0 #b7b3af; }
      .tbl.xlsx td.num, .tbl.xlsx th.num { text-align: right; font-variant-numeric: tabular-nums; }
      .tbl.xlsx td.c, .tbl.xlsx th.c { text-align: center; }
      /* залипающая левая колонка наименований (вместо нумерации строк) */
      .tbl.xlsx th.cname, .tbl.xlsx td.cname {
        position: sticky; left: 0; z-index: 1; background: #f3f2f1;
        min-width: 220px; max-width: 360px; white-space: normal;
        box-shadow: inset -2px 0 0 #b7b3af;
      }
      .tbl.xlsx td.cname { background: #fff; font-weight: 600; color: #202124; }
      .tbl.xlsx th.cname { z-index: 3; }
      .tbl.xlsx .sub { font-weight: 400; color: var(--muted); font-size: 11px; }
      /* «активная ячейка» при наведении (не трогаем закрепления и итог) */
      .tbl.xlsx tr:not(.th-row):not(.tfoot):hover td:not(.cname) { background: #f6faf7; }
      .tbl.xlsx tr:not(.tfoot) td:not(.cname):hover { box-shadow: inset 0 0 0 2px #107c41; }
      /* итоговая строка — прижата снизу */
      .tbl.xlsx tr.tfoot td { position: sticky; bottom: 0; z-index: 2; background: #eef2ee; font-weight: 700; }
      .tbl.xlsx tr.tfoot td.cname { z-index: 4; background: #e7ece7; }
      .tbl.xlsx .empty td { position: static; box-shadow: none; background: #fff; text-align: center; color: var(--muted); padding: 24px; }
    `,
  ],
  template: `
    <app-orders-nav />

    <div class="row spread board-top">
      <h2>Доска производства</h2>
      <div class="row">
        @if (!isFresh() && date()) {
          <button class="btn sm fresh-btn" (click)="goFresh()">К свежему листу</button>
        }
        <select class="board-select" [ngModel]="date()" (ngModelChange)="selectDate($event)">
          @if (!date()) { <option [ngValue]="null">Лист не выбран</option> }
          @for (d of dates(); track d.date) {
            <option [ngValue]="d.date">{{ pretty(d.date) }} · {{ d.cnt }} поз.</option>
          }
        </select>
      </div>
    </div>

    <div class="row wrap filters">
      <select class="minw0" [ngModel]="category()" (ngModelChange)="category.set($event)">
        <option [ngValue]="null">Все категории</option>
        @for (c of ordersSvc.categories(); track c) {
          <option [ngValue]="c">{{ c }}</option>
        }
      </select>
      <input type="search" class="grow" placeholder="Поиск по товару" [ngModel]="q()" (ngModelChange)="q.set($event)" />
    </div>

    <div class="grid kpi">
      <div class="panel kpi">
        <div class="k-label">Позиций (товаров)</div>
        <div class="k-val">{{ totals()?.positions ?? '—' }}</div>
      </div>
      <div class="panel kpi">
        <div class="k-label">Магазинов в листе</div>
        <div class="k-val">{{ totals()?.stores ?? '—' }}</div>
      </div>
      <div class="panel kpi">
        <div class="k-label">Полная цена (VK)</div>
        <div class="k-val">{{ totals() ? fmtMoney(totals()!.full) : '—' }}</div>
      </div>
    </div>

    @if (err()) { <div class="error banner">{{ err() }}</div> }

    <div class="panel">
      @if (loading()) {
        <p class="muted">Загрузка…</p>
      } @else {
        <div class="xlsx-wrap">
          <table class="tbl xlsx">
            <tr class="th-row">
              <th class="cname">Наименование товара</th>
              <th class="num">Кол-во</th>
              <th class="num">Цена порции</th>
              <th class="num">Полная цена</th>
              @for (s of stores(); track s.id) {
                <th class="c" [title]="s.name">{{ s.code }}</th>
              }
            </tr>

            @for (r of rows(); track r.key) {
              <tr>
                <td class="cname">
                  {{ r.name }}
                  @if (r.plu) { <div class="sub">{{ r.category ? r.category + ' · ' : '' }}{{ r.plu }}</div> }
                  @else if (r.category) { <div class="sub">{{ r.category }}</div> }
                </td>
                <td class="num">{{ trim(r.totalQty) }} <span class="sub">{{ r.unit }}</span></td>
                <td class="num">{{ r.pricePer === null ? '—' : fmtMoney(r.pricePer) }}</td>
                <td class="num">{{ fmtMoney(r.fullPrice) }}</td>
                @for (s of stores(); track s.id) {
                  <td class="num c">{{ cell(r.byStore[s.id]) }}</td>
                }
              </tr>
            } @empty {
              <tr class="empty"><td [attr.colspan]="4 + stores().length">На этот лист заказов нет</td></tr>
            }

            @if (rows().length) {
              <tr class="tfoot">
                <td class="cname">Итого · {{ rows().length }} поз.</td>
                <td class="num"></td>
                <td class="num"></td>
                <td class="num">{{ fmtMoney(totals()?.full ?? 0) }}</td>
                @for (s of stores(); track s.id) {
                  <td class="num c">{{ cell(totals()?.byStore?.[s.id]) }}</td>
                }
              </tr>
            }
          </table>
        </div>

        @if (dates().length > 1) {
          <button class="btn sm block mt" (click)="loadMore()">Показать больше дат</button>
        }
      }
    </div>
  `,
})
export class OrdersBoardComponent implements OnInit {
  private api = inject(ApiService);
  protected ordersSvc = inject(OrdersService);
  private live = inject(LiveService);

  protected dates = signal<OrderDate[]>([]);
  protected date = signal<string | null>(null);
  protected stores = signal<{ id: number; code: string; name: string }[]>([]);
  protected rows = signal<BoardRow[]>([]);
  protected totals = signal<{ positions: number; full: number; stores: number; byStore: Record<number, number> } | null>(null);
  protected category = signal<string | null>(null);
  protected q = signal('');
  protected loading = signal(true);
  protected err = signal('');

  /** Самый свежий лист (как его видит сервер по умолчанию) — для подсветки кнопки «К свежему». */
  private freshDate = signal<string | null>(null);
  /** Пользователь выбрал дату вручную — не переключать на свежий при live-событиях. */
  private pinned = false;

  fmtMoney = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format;

  constructor() {
    // живой канал: изменения листа перезагружают доску (если дата не закреплена вручную)
    effect(() => {
      this.live.sheetVersion();
      if (!this.pinned) this.date.set(untracked(() => this.freshDate()));
      this.load();
    });
  }

  ngOnInit(): void {
    this.ordersSvc.ensureCategories();
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    const params: Record<string, string> = {};
    if (this.date()) params['date'] = this.date()!;
    if (this.category()) params['category'] = this.category()!;
    if (this.q().trim()) params['q'] = this.q().trim();
    this.api.ordersBoard$(params).subscribe({
      next: (r) => {
        this.dates.set(r.dates);
        this.stores.set(r.stores);
        this.rows.set(r.rows);
        this.totals.set(r.totals);
        if (!this.date()) this.date.set(r.date);
        if (!this.pinned) {
          this.date.set(r.date);
          this.freshDate.set(r.date);
        }
        this.loading.set(false);
      },
      error: (e) => {
        this.err.set(e?.error?.message ?? 'Не удалось загрузить доску заказов');
        this.loading.set(false);
      },
    });
  }

  protected selectDate(d: string): void {
    this.pinned = true;
    this.date.set(d);
    this.load();
  }

  /** Вернуться на самый свежий лист и снова следить за live-обновлениями. */
  protected goFresh(): void {
    this.pinned = false;
    this.date.set(null);
    this.load();
  }

  /** Сейчас открыт самый свежий лист? */
  protected isFresh(): boolean {
    const d = this.date();
    return !!d && d === this.freshDate();
  }

  protected loadMore(): void {
    this.dates.set(this.dates().slice(0, this.dates().length + 30));
  }

  /** Число печатной единицы: пусто при 0/отсутствии, иначе с разделителями (до 3 знаков). */
  protected cell(v: number | undefined | null): string {
    if (v === undefined || v === null || Math.abs(v) < 1e-9) return '';
    return this.trim(v);
  }

  protected trim(n: number): string {
    if (!Number.isFinite(n)) return '';
    return (Math.round(n * 1000) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  }

  protected pretty(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  }
}
