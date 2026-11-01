import { ChangeDetectionStrategy, Component, Input, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
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
      .board-toolbar { padding: 12px 14px; }
      .bt-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .tb-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .tb-group.right { margin-left: auto; }
      .tb-group .grow { flex: 1; min-width: 180px; max-width: 300px; }
      .fresh-btn { white-space: nowrap; }
      .fresh-btn.on { background: var(--accent); color: #fff; border-color: var(--accent); }
      .nav-arrow { min-width: 30px; text-align: center; padding: 4px 6px; }

      /* сетка «как в Excel»: скролл-контейнер + залипающая шапка и колонка товара */
      .xlsx-wrap { overflow-x: auto; background: #fff; border: 1px solid #c9c9c9; border-radius: 6px; }
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
      /* id товара из БД рядом с наименованием */
      .tbl.xlsx .pid { font-weight: 400; color: #8a8a8a; font-size: 11px; margin-left: 6px;
        font-variant-numeric: tabular-nums; }
      /* «активная ячейка» при наведении (не трогаем закрепления и итог) */
      .tbl.xlsx tr:not(.th-row):not(.tfoot):hover td:not(.cname) { background: #f6faf7; }
      .tbl.xlsx tr:not(.tfoot) td:not(.cname):hover { box-shadow: inset 0 0 0 2px #107c41; }
      /* строка-заголовок категории: зелёная полоса на всю ширину */
      .tbl.xlsx tr.cat-row td { background: #e5efe6; color: #1d5c2e; font-weight: 700;
        text-transform: capitalize; letter-spacing: .2px; padding: 6px 10px; }
      .tbl.xlsx tr.cat-row td.cname { box-shadow: inset -2px 0 0 #b7b3af; }
      .tbl.xlsx tr.cat-row .cnt { font-weight: 400; color: #5c7a63; font-size: 11px; margin-left: 6px; }
      /* итоговая строка — прижата снизу */
      .tbl.xlsx tr.tfoot td { position: sticky; bottom: 0; z-index: 2; background: #eef2ee; font-weight: 700; }
      .tbl.xlsx tr.tfoot td.cname { z-index: 4; background: #e7ece7; }
      .tbl.xlsx .empty td { position: static; box-shadow: none; background: #fff; text-align: center; color: var(--muted); padding: 24px; }
      /* степ-редактор количества прямо на доске (аккаунт магазина): ▼ [число] ед ▲ */
      .qty-step { display: inline-flex; align-items: center; gap: 4px; }
      .qty-step input { width: 76px; text-align: right; font-size: 14px; padding: 3px 6px;
        border: 1px solid #c9c9c9; border-radius: 5px; font-variant-numeric: tabular-nums; }
      .qty-step input:focus { outline: 2px solid #107c41; outline-offset: -1px; border-color: #107c41; }
      /* убираем нативные стрелки-спиннер внутри поля (у нас свои ▼/▲) */
      .qty-step input::-webkit-outer-spin-button,
      .qty-step input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .qty-step input[type=number] { -moz-appearance: textfield; appearance: textfield; }
      .qty-step .step { min-width: 26px; padding: 3px 6px; font-size: 11px; line-height: 1;
        border: 1px solid #c9c9c9; border-radius: 5px; background: #f3f2f1; cursor: pointer; color: #242424; }
      .qty-step .step:hover:not(:disabled) { background: #e5efe6; border-color: #107c41; color: #1d5c2e; }
      .qty-step .step:disabled { opacity: .5; cursor: default; }
      .qty-step.saving { opacity: .6; }
      /* фоновая перезагрузка доски: не прячем таблицу (иначе скачет скролл) — лишь слегка гасим */
      .xlsx-wrap.refreshing { opacity: .72; transition: opacity .15s ease; }
    `,
  ],
  template: `
    @if (!embedded) {
      <h1 class="page-title">📋 Доска производства</h1>
      <app-orders-nav />
    }

    <div class="panel board-toolbar">
      <div class="bt-row">
        <div class="tb-group">
          <button class="btn sm nav-arrow" [disabled]="!canOlder()" (click)="stepDate(-1)" title="Старше">&#9664;</button>
          <select class="board-select" [ngModel]="date()" (ngModelChange)="selectDate($event)">
            @if (!date()) { <option [ngValue]="null">Лист не выбран</option> }
            @for (d of dates(); track d.date) {
              <option [ngValue]="d.date">{{ pretty(d.date) }} · {{ d.cnt }} поз.</option>
            }
          </select>
          <button class="btn sm nav-arrow" [disabled]="!canNewer()" (click)="stepDate(1)" title="Новее">&#9654;</button>
          @if (!isFresh() && date()) {
            <button class="btn sm fresh-btn" (click)="goFresh()">К свежему</button>
          }
        </div>
        <div class="tb-group right">
          <select class="minw0" [ngModel]="category()" (ngModelChange)="category.set($event)">
            <option [ngValue]="null">Все категории</option>
            @for (c of ordersSvc.categories(); track c) {
              <option [ngValue]="c">{{ c }}</option>
            }
          </select>
          <input type="search" class="grow" placeholder="🔍 Поиск по товару" [ngModel]="q()" (ngModelChange)="q.set($event)" />
        </div>
      </div>
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }

    <div class="panel">
      @if (loading() && !rows().length) {
        <p class="muted">Загрузка…</p>
      } @else {
        <div class="xlsx-wrap" [class.refreshing]="loading()">
          <table class="tbl xlsx">
            <tr class="th-row">
              <th class="cname">Наименование товара</th>
              <th class="num">Кол-во</th>
              <th class="num" title="Минимальный заказ — кратность изменения по кнопкам ▼/▲">Мин. заказ</th>
              <th class="num">Цена порции</th>
              <th class="num">Полная цена</th>
              @for (s of storeCols(); track s.id) {
                <th class="c" [title]="s.name">{{ s.code }}</th>
              }
            </tr>

            @for (g of groups(); track g.key) {
              <tr class="cat-row">
                <td class="cname" [attr.colspan]="colspan()">
                  {{ g.category ?? 'Без категории' }}<span class="cnt">· {{ g.rows.length }} поз.</span>
                </td>
              </tr>
              @for (r of g.rows; track r.key) {
                <tr>
                  <td class="cname">
                    {{ r.name }}
                    @if (r.productId != null) { <span class="pid">#{{ r.productId }}</span> }
                    @if (r.plu) { <div class="sub">{{ r.plu }}</div> }
                  </td>
                  <td class="num">
                    @if (canEdit(r)) {
                      <div class="qty-step" [class.saving]="savingKey() === r.key">
                        <button type="button" class="step dn" [disabled]="savingKey() === r.key || qtyOf(r) <= 0"
                                (click)="bump(r, -1)" title="меньше">▼</button>
                        <input type="number" min="0" [step]="stepSize(r)"
                               [ngModel]="qtyOf(r)" (ngModelChange)="onQty(r, $event)"
                               (blur)="commit(r)" (keyup.enter)="commit(r)" />
                        <span class="sub">{{ r.unit }}</span>
                        <button type="button" class="step up" [disabled]="savingKey() === r.key"
                                (click)="bump(r, 1)" title="больше">▲</button>
                      </div>
                    } @else {
                      {{ trim(r.totalQty) }} <span class="sub">{{ r.unit }}</span>
                    }
                  </td>
                  <td class="num">
                    @if (r.minOrder && r.minOrder > 0) {
                      {{ trim(r.minOrder) }} <span class="sub">{{ r.unit }}</span>
                    } @else { <span class="sub">—</span> }
                  </td>
                  <td class="num">{{ r.pricePer === null ? '—' : fmtMoney(r.pricePer) }}</td>
                  <td class="num">{{ fmtMoney(r.fullPrice) }}</td>
                  @for (s of storeCols(); track s.id) {
                    <td class="num c">{{ cell(r.byStore[s.id]) }}</td>
                  }
                </tr>
              }
            } @empty {
              <tr class="empty"><td [attr.colspan]="colspan()">На этот лист заказов нет</td></tr>
            }

            @if (rows().length) {
              <tr class="tfoot">
                <td class="cname">Итого · {{ rows().length }} поз.</td>
                <td class="num"></td>
                <td class="num"></td>
                <td class="num"></td>
                <td class="num">{{ fmtMoney(totals()?.full ?? 0) }}</td>
                @for (s of storeCols(); track s.id) {
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
  /** Встроено в чужую страницу (аккаунт магазина): без офисной шапки и навигации. */
  @Input() embedded = false;

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

  /** Черновик печатного количества по ключу строки — правка на доске до подтверждения. */
  protected draft = signal<Record<string, number>>({});
  /** ключ строки, которая сейчас сохраняется (блокирует стрелки/повторный запрос). */
  protected savingKey = signal<string | null>(null);

  /**
   * Колонки-точки справа от «Полной цены». В аккаунте магазина точка одна, и её количество
   * совпадает с «Кол-во» — колонку дублировать не нужно, скрываем её (embedded).
   */
  protected storeCols(): { id: number; code: string; name: string }[] {
    return this.embedded ? [] : this.stores();
  }
  /** Ширина сквозных ячеек (категория/пусто): 5 фикс. колонок + видимые колонки точек. */
  protected colspan(): number {
    return 5 + this.storeCols().length;
  }

  fmtMoney = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format;

  /** Строки пивота, сгруппированные по категории: секции идут по алфавиту, «без категории» — в конце. */
  protected groups = computed(() => {
    const map = new Map<string | null, BoardRow[]>();
    for (const r of this.rows()) {
      const arr = map.get(r.category);
      if (arr) arr.push(r);
      else map.set(r.category, [r]);
    }
    const out = [...map.entries()].map(([category, rows]) => ({
      key: category ?? '__none__',
      category,
      rows: rows.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    }));
    out.sort((a, b) => {
      if (a.category === null) return b.category === null ? 0 : 1;
      if (b.category === null) return -1;
      return a.category.localeCompare(b.category, 'ru');
    });
    return out;
  });

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

  /** Перейти на delta позиций: +1 = новее, -1 = старше. */
  protected stepDate(delta: 1 | -1): void {
    const arr = this.dates();
    const cur = arr.findIndex((x) => x.date === this.date());
    if (cur < 0) return;
    // dates[] отсортированы DESC: [0]=самая свежая. delta=+1 → индекс--, delta=-1 → индекс++
    const next = cur - delta;
    if (next >= 0 && next < arr.length) this.selectDate(arr[next].date);
  }

  protected canNewer(): boolean {
    return this.dates().findIndex((x) => x.date === this.date()) > 0;
  }

  protected canOlder(): boolean {
    const i = this.dates().findIndex((x) => x.date === this.date());
    return i >= 0 && i < this.dates().length - 1;
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

  /** Число печатной единицы: пусто при отсутствии, иначе с разделителями (до 3 знаков); 0 показываем как «0». */
  protected cell(v: number | undefined | null): string {
    if (v === undefined || v === null) return '';
    return this.trim(v);
  }

  protected trim(n: number): string {
    if (!Number.isFinite(n)) return '';
    return (Math.round(n * 1000) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  }

  // ---- редактирование количества прямо на доске (аккаунт магазина) ----
  /** Правка доступна встроенной доске магазина: существующая линия или позиция каталога (0) для добавления. */
  protected canEdit(r: BoardRow): boolean {
    return this.embedded && !!r.editable;
  }
  /** id точки для создания заказа (встроенная доска — своя единственная колонка). */
  private storeId(): number | null {
    return this.stores()[0]?.id ?? null;
  }
  /** Текущее печатное количество строки: черновик (если правим) или значение доски. */
  protected qtyOf(r: BoardRow): number {
    const d = this.draft()[r.key];
    return d === undefined ? r.totalQty : d;
  }
  /** Шаг стрелок по единице: порции/шт — 1, кг/л — 0,5, г/мл — 100. */
  protected stepFor(unit: string): number {
    if (['порц', 'порция', 'порции', 'шт', 'des'].includes(unit)) return 1;
    if (unit === 'кг' || unit === 'л') return 0.5;
    if (unit === 'г' || unit === 'мл') return 100;
    return 1;
  }
  /** Шаг ▼/▲ = минимальный заказ (кратность) строки; если не задан — типовой шаг по единице. */
  protected stepSize(r: BoardRow): number {
    const m = r.minOrder;
    return m && m > 0 ? m : this.stepFor(r.unit);
  }
  private setDraft(key: string, v: number): void {
    this.draft.update((m) => ({ ...m, [key]: v }));
  }
  private clearDraft(key: string): void {
    this.draft.update((m) => { const n = { ...m }; delete n[key]; return n; });
  }
  protected onQty(r: BoardRow, v: number): void {
    this.setDraft(r.key, Number(v) || 0);
  }
  /** Стрелка ▼/▲: сдвиг на шаг и немедленное сохранение. */
  protected bump(r: BoardRow, delta: 1 | -1): void {
    if (this.savingKey() === r.key) return;
    const step = this.stepSize(r);
    const next = Math.max(0, Math.round((this.qtyOf(r) + delta * step) * 1000) / 1000);
    this.setDraft(r.key, next);
    this.save(r, next);
  }
  /** Потеря фокуса/Enter: сохранить, если значение изменилось; иначе сбросить черновик. */
  protected commit(r: BoardRow): void {
    const v = this.draft()[r.key];
    if (v === undefined) return;
    if (Math.abs(v - r.totalQty) < 1e-9) { this.clearDraft(r.key); return; }
    this.save(r, v);
  }
  /**
   * Сохранение строки доски: существующая линия — PATCH по orderId; позиция каталога без линии —
   * POST /place (создание строки заказа на выбранную дату, force — чтобы не блокировать минимумом).
   * После успеха — перезагрузка доски (созданная строка станет редактируемой линией).
   */
  private save(r: BoardRow, qty: number): void {
    if (this.savingKey() === r.key) return;
    if (!(qty > 0)) {
      // 0 = «убрать позицию»: существующую линию отменяем (в таблице ячейка очистится),
      // синтетическую строку каталога (и так 0) нечего удалять — просто сбрасываем черновик.
      if (r.orderId != null) {
        this.savingKey.set(r.key);
        this.err.set('');
        const reload = (): void => { this.savingKey.set(null); this.clearDraft(r.key); this.load(); };
        this.api
          .patchOrder$(r.orderId, { status: 'cancelled' })
          .subscribe({
            next: reload,
            error: (e: { error?: { message?: string } }) => {
              this.savingKey.set(null);
              this.clearDraft(r.key);
              this.err.set(e?.error?.message ?? 'Не удалось отменить позицию');
            },
          });
      } else {
        this.clearDraft(r.key);
      }
      return;
    }
    if (r.orderId == null && r.cardId == null) {
      this.err.set('Эту позицию нельзя изменить с доски.');
      this.clearDraft(r.key);
      return;
    }
    this.savingKey.set(r.key);
    this.err.set('');
    const done = (): void => { this.savingKey.set(null); this.clearDraft(r.key); this.load(); };
    const fail = (e: { error?: { message?: string } }): void => {
      this.savingKey.set(null);
      this.clearDraft(r.key);
      this.err.set(e?.error?.message ?? 'Не удалось сохранить количество');
    };
    if (r.orderId != null) {
      this.api.patchOrder$(r.orderId, { qty, unit: r.unit }).subscribe({ next: done, error: fail });
    } else {
      const store = this.storeId();
      const date = this.date();
      if (store == null || !date) { fail({ error: { message: 'Не удалось определить точку и дату для добавления' } }); return; }
      this.api.placeOrder$(store, { date, force: true, items: [{ cardId: r.cardId, qty, unit: r.unit }] })
        .subscribe({ next: done, error: fail });
    }
  }

  protected pretty(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  }
}
