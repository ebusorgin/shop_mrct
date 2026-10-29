import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { Dashboard, Movement, NearExpiryRow } from '../core/models';
import { fmtCost, fmtDateTime, fmtMoney, fmtQty, httpErr, trim } from '../core/format';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">Панель производства</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }

    @if (!d() && !err()) { <p class="muted">Загрузка показателей…</p> }

    @if (d(); as data) {
      <!-- ============ БЛОК A. Основные показатели ============ -->
      <div class="kpis">
        <div class="kpi"><div class="v">{{ data.stock.productsInStock }}</div><div class="l">позиций на складе</div></div>
        <div class="kpi"><div class="v">{{ fmtMoney(data.stock.stockValue) }}</div><div class="l">стоимость склада (себестоимость)</div></div>
        <div class="kpi"><div class="v">{{ data.today.todayBatches }}</div><div class="l">отгрузок сегодня</div></div>
        <div class="kpi"><div class="v">{{ fmtMoney(data.today.todayCost) }}</div><div class="l">себестоимость отгрузок сегодня</div></div>
        <div class="kpi"><div class="v">{{ data.monthWaybills.cnt }}</div><div class="l">накладных за месяц · {{ fmtMoney(data.monthWaybills.total) }}</div></div>
      </div>

      <!-- ============ БЛОК B. Быстрые действия ============ -->
      <div class="panel">
        <div class="quick">
          <a class="quick-btn primary" routerLink="/waybills" [queryParams]="{ panel: 'new' }">
            <span class="qi">📥</span><span class="qt">Принять товар<small>входящая накладная</small></span>
          </a>
          <a class="quick-btn" routerLink="/batches">
            <span class="qi">🍲</span><span class="qt">Начать производство<small>отгрузка с техники</small></span>
          </a>
          <a class="quick-btn" routerLink="/stock" [queryParams]="{ tab: 'journal', type: 'writeoff' }">
            <span class="qi">📉</span><span class="qt">Списать продукты<small>расход и корректировки</small></span>
          </a>
          <a class="quick-btn" [class.hot]="pendingTotal() > 0" routerLink="/orders">
            <span class="qi">🧾</span><span class="qt">Обработать заказы<small>ждут производства</small></span>
            @if (pendingTotal() > 0) { <span class="pill amber">{{ pendingTotal() }}</span> }
          </a>
          <a class="quick-btn" routerLink="/waybills" [queryParams]="{ panel: 'smart' }">
            <span class="qi">🤖</span><span class="qt">Умный приход<small>фото или PDF накладной</small></span>
          </a>
        </div>
      </div>

      <!-- ============ БЛОК C. Требует внимания ============ -->
      <div class="panel">
        <h3>Требует внимания</h3>
        @if (calm()) {
          <div class="calm">✓ Всё в порядке, срочных задач нет</div>
        } @else {
          <div class="tiles">
            <a class="tile" [class.critical]="data.lowStock.length" routerLink="/stock" [queryParams]="{ tab: 'balances', low: '1' }">
              <div class="t-head"><span class="t-count">{{ data.lowStock.length }}</span><span class="t-title">низкие остатки</span></div>
              <div class="t-sub">ниже минимального запаса · открыть список</div>
            </a>
            <a class="tile" [class.critical]="expiredCount() > 0" routerLink="/stock" [queryParams]="{ tab: 'shelf' }">
              <div class="t-head"><span class="t-count">{{ soonRows().length }}</span><span class="t-title">истекают партии</span></div>
              <div class="t-sub">@if (expiredCount() > 0) { ⚠ просрочено: {{ expiredCount() }} партий · } ближайшие {{ soonRows().length }} — открыть список</div>
            </a>
            <a class="tile" routerLink="/orders">
              <div class="t-head"><span class="t-count">{{ pendingTotal() }}</span><span class="t-title">ожидают обработки</span></div>
              <div class="t-sub">позиции ближайших листов магазинов · к сборке</div>
            </a>
          </div>
        }

        @if (data.lowStock.length || data.nearExpiry.length || data.pendingOrders.length) {
          <div class="grid2" style="margin-top:14px">
            <div>
              <h3>📉 Заканчивается на складе</h3>
              <table class="tbl stack">
                <tr class="th-row"><th>Позиция</th><th class="num">Остаток</th><th class="num">Минимум</th><th></th></tr>
                @for (r of data.lowStock; track r.name) {
                  <tr>
                    <td>{{ r.name }}</td>
                    <td class="num" data-l="остаток">{{ fmtQty(r.qty, r.unitCode) }}</td>
                    <td class="num muted" data-l="минимум">{{ fmtQty(r.minStock, r.unitCode) }}</td>
                    <td class="no-l"><a class="btn sm" routerLink="/waybills" [queryParams]="{ panel: 'new' }">приход</a></td>
                  </tr>
                } @empty { <tr class="empty"><td colspan="4">Все позиции выше минимальных остатков 👍</td></tr> }
              </table>
              @if (data.lowStock.length > 4) {
                <a class="muted more" routerLink="/stock" [queryParams]="{ tab: 'balances', low: '1' }">
                  ещё {{ data.lowStock.length - 4 }} →
                </a>
              }
            </div>

            <div>
              <h3>⏳ Истекает срок годности (по партиям)</h3>
              <table class="tbl stack">
                <tr class="th-row"><th>Партия</th><th class="num">Остаток</th><th>Приход</th><th>Истекает</th></tr>
                @for (r of soonRows(); track r.productId + r.receiptDate) {
                  <tr>
                    <td>
                      {{ r.name }}
                      @if (r.receiptDate === firstReceipt(r)) { <span class="badge gray">1-я партия</span> }
                    </td>
                    <td class="num" data-l="остаток">{{ fmtQty(r.qty, r.unitCode) }}</td>
                    <td class="nw muted" data-l="приход">{{ r.receiptDate }}</td>
                    <td data-l="истекает" class="nw">
                      {{ r.expiryDate }}
                      <span class="badge amber">{{ r.expiryDays }} дн.</span>
                    </td>
                  </tr>
                } @empty { <tr class="empty"><td colspan="4">Партий, истекающих в ближайшие дни, нет 👍</td></tr> }
              </table>
              @if (soonRows().length > 4) {
                <a class="muted more" routerLink="/stock" [queryParams]="{ tab: 'shelf' }">
                  ещё {{ soonRows().length - 4 }} партий →
                </a>
              }
            </div>
          </div>
        }
      </div>

      <!-- ============ БЛОК D. Последние операции ============ -->
      <div class="grid2">
        <div class="panel">
          <div class="row" style="align-items:center">
            <h3 style="margin:0">🚚 Последние отгрузки</h3>
            <span class="spacer"></span>
            <a class="btn sm" routerLink="/batches">Все отгрузки</a>
          </div>
          <table class="tbl stack">
            <tr class="th-row"><th>Продукция</th><th>Дата</th><th class="num">Себест.</th><th>Статус</th></tr>
            @for (b of data.recentBatches; track b.id) {
              <tr>
                <td>{{ b.cardName }} × {{ b.portions }}</td>
                <td class="nw muted" data-l="дата">{{ b.batchDate }}</td>
                <td class="num" data-l="себест.">{{ fmtMoney(b.costTotal) }}</td>
                <td data-l="статус">
                  @if (b.status === 'posted') { <span class="badge green">проведено</span> }
                  @else { <span class="badge gray">отменена</span> }
                </td>
              </tr>
            } @empty { <tr class="empty"><td colspan="4">Отгрузок пока не было</td></tr> }
          </table>
        </div>

        <div class="panel">
          <div class="row" style="align-items:center">
            <h3 style="margin:0">📦 Движения склада</h3>
            <span class="spacer"></span>
            <a class="btn sm" routerLink="/stock" [queryParams]="{ tab: 'journal' }">Журнал движений</a>
          </div>
          <table class="tbl stack">
            <tr class="th-row"><th>Дата</th><th>Продукт</th><th class="num">Δ</th><th>Тип</th></tr>
            @for (m of movements(); track m.id) {
              <tr>
                <td class="nw mono" data-l="дата">{{ fmtWhen(m.created_at) }}</td>
                <td>{{ m.productName }}</td>
                <td class="num" data-l="изменение">{{ m.qty > 0 ? '+' : '' }}{{ fmtQty(m.qty, m.unitCode) }}</td>
                <td data-l="тип">
                  @if (m.type === 'receipt') { <span class="badge green">приход</span> }
                  @if (m.type === 'writeoff') { <span class="badge red">расход</span> }
                  @if (m.type === 'adjustment') { <span class="badge amber">корректировка</span> }
                </td>
              </tr>
            } @empty { <tr class="empty"><td colspan="4">Движений пока нет</td></tr> }
          </table>
        </div>
      </div>
    }
  `,
  styles: [`
    .more { display: inline-block; margin-top: 6px; font-size: 12px; text-decoration: underline; }
    .calm { background: var(--green-soft); color: var(--green); border-radius: 8px; padding: 10px 12px; font-weight: 600; }
  `],
})
export class DashboardComponent implements OnInit {
  private api = inject(ApiService);
  d = signal<Dashboard | null>(null);
  movements = signal<Movement[]>([]);
  err = signal('');
  fmtMoney = fmtMoney;
  fmtQty = fmtQty;
  fmtCost = fmtCost;
  trim = trim;
  fmtWhen = fmtDateTime;

  /** сколько позиций заказа ждут производства (сумма по магазинам ближайших листов) */
  pendingTotal = computed(() => (this.d()?.pendingOrders ?? []).reduce((s, r) => s + r.cnt, 0));
  expiredCount = computed(() => (this.d()?.nearExpiry ?? []).filter((r) => r.status === 'expired').length);
  /**
   * На панели показываем только то, что ещё можно успеть продать/использовать:
   * просроченные партии — отдельным счётчиком, их разбор ведётся на странице «Сроки годности».
   */
  soonRows = computed(() => (this.d()?.nearExpiry ?? []).filter((r) => r.status === 'soon').slice(0, 6));
  /** «всё спокойно» считается по всем трём группам предупреждений */
  calm = computed(() => this.lowCount() === 0 && this.expiryCount() === 0 && this.pendingTotal() === 0);
  lowCount = computed(() => (this.d()?.lowStock ?? []).length);
  expiryCount = computed(() => (this.d()?.nearExpiry ?? []).length);

  /** самая ранняя партия позиции: у неё же и самый короткий остаток срока — помечаем в списке */
  firstReceipt(r: NearExpiryRow): string {
    const rows = (this.d()?.nearExpiry ?? []).filter((x) => x.productId === r.productId);
    return rows.length ? rows.reduce((a, b) => (a.receiptDate <= b.receiptDate ? a : b)).receiptDate : '';
  }

  ngOnInit(): void {
    this.api.dashboard$().subscribe({
      next: (v) => this.d.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
    // последние операции берём из существующего журнала движений (ровно столько, сколько показываем)
    this.api.movements$({ limit: '6' }).subscribe({
      next: (v) => this.movements.set(v),
      error: () => this.movements.set([]),
    });
  }
}
