import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { Dashboard } from '../core/models';
import { fmtCost, fmtMoney, fmtQty, httpErr, trim } from '../core/format';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">Панель производства</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }

    @if (d(); as data) {
      <div class="kpis">
        <div class="kpi"><div class="v">{{ data.stock.productsInStock }}</div><div class="l">позиций на складе</div></div>
        <div class="kpi"><div class="v">{{ fmtMoney(data.stock.stockValue) }}</div><div class="l">стоимость склада (себестоимость)</div></div>
        <div class="kpi"><div class="v">{{ data.today.todayBatches }}</div><div class="l">отгрузок сегодня</div></div>
        <div class="kpi"><div class="v">{{ fmtMoney(data.today.todayCost) }}</div><div class="l">себестоимость отгрузок сегодня</div></div>
        <div class="kpi"><div class="v">{{ data.monthWaybills.cnt }}</div><div class="l">накладных за месяц · {{ fmtMoney(data.monthWaybills.total) }}</div></div>
      </div>

      <div class="grid2">
        <div class="panel">
          <h3>⚠️ Заканчивается на складе</h3>
          @if (data.lowStock.length === 0) { <p class="muted">Все позиции выше минимальных остатков 👍</p> }
          <table class="tbl">
            @for (r of data.lowStock; track r.name) {
              <tr>
                <td>{{ r.name }}</td>
                <td class="num">{{ fmtQty(r.qty, r.unitCode) }}</td>
                <td class="num muted">мин: {{ fmtQty(r.minStock, r.unitCode) }}</td>
                <td><span class="badge red">низкий</span></td>
              </tr>
            }
          </table>
          <a class="btn sm" routerLink="/waybills">+ Новая накладная</a>
        </div>

        <div class="panel">
          <h3>🚚 Последние отгрузки</h3>
          @if (data.recentBatches.length === 0) { <p class="muted">Пока нет отгрузок</p> }
          <table class="tbl">
            @for (b of data.recentBatches; track b.id) {
              <tr>
                <td>{{ b.cardName }} × {{ b.portions }}</td>
                <td class="muted">{{ b.batchDate }}</td>
                <td class="num">{{ fmtMoney(b.costTotal) }}</td>
                <td>
                  @if (b.status === 'posted') { <span class="badge green">проведено</span> }
                  @else { <span class="badge gray">отменена</span> }
                </td>
              </tr>
            }
          </table>
          <a class="btn sm" routerLink="/batches">Оформить расход</a>
        </div>
      </div>

      <div class="panel" style="margin-top:16px">
        <h3>⏳ Скоро истекает срок годности</h3>
        @if (data.nearExpiry.length === 0) { <p class="muted">Нет просроченных или близких к истечению позиций 👍</p> }
        @if (data.nearExpiry.length > 0) {
          <table class="tbl">
            <tr>
              <th>Название</th>
              <th class="num">Кол-во на складе</th>
              <th>Дата прихода</th>
              <th>Истекает</th>
              <th>Статус</th>
            </tr>
            @for (r of data.nearExpiry; track r.name) {
              <tr>
                <td>{{ r.name }}</td>
                <td class="num">{{ fmtQty(r.qty, r.unitCode) }}</td>
                <td class="muted">{{ r.receiptDate }}</td>
                <td>{{ r.expiryDate }}</td>
                <td>
                  @if (r.status === 'expired') { <span class="badge red">Просрочен</span> }
                  @else { <span class="badge amber">Скоро</span> }
                </td>
              </tr>
            }
          </table>
        }
      </div>
    }
  `,
})
export class DashboardComponent implements OnInit {
  private api = inject(ApiService);
  d = signal<Dashboard | null>(null);
  err = signal('');
  fmtMoney = fmtMoney;
  fmtQty = fmtQty;
  trim = trim;
  fmtCost = fmtCost;

  ngOnInit(): void {
    this.api.dashboard$().subscribe({
      next: (v) => this.d.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }
}
