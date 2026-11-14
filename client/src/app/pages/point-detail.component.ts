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

        <div class="grid2">
          <div class="panel">
            <h3>Топ продукции</h3>
            @if (s.topProducts.length) {
              <table class="tbl">
                <thead><tr><th>Продукция</th><th class="num">упак.</th><th class="num">сумма</th></tr></thead>
                <tbody>
                  @for (row of s.topProducts; track row.name) {
                    <tr>
                      <td>
                        {{ row.name }}
                        @if (row.nameSr) { <div class="muted small">{{ row.nameSr }}</div> }
                      </td>
                      <td class="num">{{ row.packages }}</td>
                      <td class="num">{{ fmtMoney(row.net) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
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
