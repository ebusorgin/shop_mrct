import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { OrdersService } from '../core/orders.service';
import { OrderChange, OrderSyncState, Store } from '../core/models';
import { httpErr } from '../core/format';

@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🧾 Заказы магазинов</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }

    <!-- витрины 103..110 -->
    <div class="panel">
      <h3>Витрины</h3>
      <div class="row">
        @for (s of stores(); track s.id) {
          <a class="btn" [routerLink]="['/orders', s.id]">🏪 {{ s.name }}<small class="muted" style="margin-left:6px">{{ s.code }}</small></a>
        }
      </div>
    </div>

    <!-- синхронизация -->
    <div class="panel">
      <div class="row" style="align-items:center">
        <h3 style="margin:0">Синхронизация с Google Таблицей</h3>
        <span class="spacer"></span>
        <button class="btn sm" (click)="refreshSync()">⟳</button>
        <button class="btn sm" [disabled]="busy()" (click)="runSync(false)">Обновить свежие</button>
        <button class="btn sm primary" [disabled]="busy()" (click)="runSync(true)">Полный прогон</button>
      </div>
      @if (sync(); as st) {
        <div class="kpis" style="margin-top:12px">
          <div class="kpi"><div class="v">{{ st.state?.status ?? '—' }}</div><div class="l">статус прогона</div></div>
          <div class="kpi"><div class="v">{{ st.state?.tabs_synced ?? 0 }}</div><div class="l">листов синхронизировано</div></div>
          <div class="kpi"><div class="v">{{ st.state?.tabs_failed ?? 0 }}</div><div class="l">листов с ошибкой</div></div>
          <div class="kpi"><div class="v">{{ when(st.state?.finished_at) }}</div><div class="l">завершён</div></div>
        </div>
        @if (st.summary) {
          <p class="muted" style="font-size:12px">
            Последний прогон: увидено {{ st.summary.tabsSeen }}, разобрано {{ st.summary.tabsParsed }},
            без изменений {{ st.summary.unchanged }}, +{{ st.summary.ordersCreated }} · ~{{ st.summary.ordersChanged }} · −{{ st.summary.ordersRemoved }}
            @if (st.summary.full) { · (полный) }
          </p>
        }
        @if (st.state?.last_error) { <div class="err" style="margin-top:8px">{{ st.state?.last_error }}</div> }

        <table class="tbl stack">
          <tr class="th-row"><th>Лист</th><th>Дата</th><th class="num">Строк</th><th>Синхронизирован</th><th>Ошибка</th></tr>
          @for (t of st.tabs; track t.sheetName) {
            <tr>
              <td>{{ t.sheetName }}</td>
              <td data-l="Дата">{{ t.date ?? '—' }}</td>
              <td class="num" data-l="Строк">{{ t.rowCount ?? 0 }}</td>
              <td data-l="Синхр.">{{ when(t.lastSyncAt) }}</td>
              <td data-l="Ошибка" class="wide">
                @if (t.lastError) { <span class="badge red">{{ t.lastError }}</span> } @else { <span class="muted">ok</span> }
              </td>
            </tr>
          } @empty { <tr class="empty"><td colspan="5">Листов пока нет — запустите прогон</td></tr> }
        </table>
      }
    </div>

    <!-- журнал изменений -->
    <div class="panel">
      <div class="row" style="align-items:center">
        <h3 style="margin:0">Журнал изменений</h3>
        <span class="spacer"></span>
        @if (journal()?.lastTab; as lt) { <span class="badge blue">последний лист: {{ lt.sheetName }} · {{ lt.tabDate }}</span> }
        <label class="f">Магазин
          <select [ngModel]="journalStore()" (ngModelChange)="journalStore.set($event); loadJournal()">
            <option [ngValue]="0">— все —</option>
            @for (s of stores(); track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }
          </select>
        </label>
      </div>
      <table class="tbl stack">
        <tr class="th-row"><th>Когда</th><th>Магазин</th><th>Товар</th><th>Изменение</th><th>Лист</th></tr>
        @for (c of journal()?.changes ?? []; track c.id) {
          <tr>
            <td class="mono" data-l="Когда">{{ when(c.createdAt) }}</td>
            <td data-l="Магазин">{{ c.storeName ?? '—' }}</td>
            <td>{{ c.sourceName }}</td>
            <td data-l="Изменение">
              <span class="badge" [class]="changeCls(c.changeType)">{{ changeLabel(c.changeType) }}</span>
              @if (detail(c); as d) { <span class="muted" style="font-size:12px"> {{ d }}</span> }
            </td>
            <td data-l="Лист" class="muted">{{ c.sheetName ?? '—' }}</td>
          </tr>
        } @empty { <tr class="empty"><td colspan="5">Изменений пока нет</td></tr> }
      </table>
    </div>
  `,
})
export class OrdersComponent implements OnInit {
  private api = inject(ApiService);
  readonly ordersSvc = inject(OrdersService);

  stores = signal<Store[]>([]);
  sync = signal<OrderSyncState | null>(null);
  journal = signal<{ lastTab: { sheetName: string; tabDate: string } | null; changes: OrderChange[] } | null>(null);
  journalStore = signal(0);
  err = signal('');
  busy = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    this.stores.set(await this.ordersSvc.ensureStores());
    this.refreshSync();
    this.loadJournal();
    // автообновление статуса, пока идёт прогон
    this.timer = setInterval(() => {
      if (this.sync()?.state?.status === 'running') this.refreshSync();
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  refreshSync(): void {
    this.api.orderSync$().subscribe({
      next: (v) => this.sync.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  runSync(full: boolean): void {
    this.busy.set(true);
    this.err.set('');
    this.api.runOrderSync$(full).subscribe({
      next: () => {
        this.busy.set(false);
        this.refreshSync();
      },
      error: (e) => {
        this.busy.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  loadJournal(): void {
    const p: Record<string, string> = {};
    if (this.journalStore()) p['store'] = String(this.journalStore());
    this.api.orderJournal$(p).subscribe({
      next: (v) => this.journal.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  changeLabel(t: string): string {
    return { created: 'создан', qty_changed: 'кол-во', removed: 'удалён', status_changed: 'статус', updated: 'изменён' }[t] ?? t;
  }
  changeCls(t: string): string {
    if (t === 'created') return 'green';
    if (t === 'removed') return 'red';
    if (t === 'qty_changed') return 'amber';
    return 'blue';
  }
  detail(c: OrderChange): string {
    const d = c.details;
    if (!d) return '';
    const from = d['from'];
    const to = d['to'];
    if (from !== undefined || to !== undefined) return `${trimv(from)} → ${trimv(to)}`;
    if (d['name']) return String(d['name']);
    return '';
  }

  when(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

function trimv(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : String(v);
}
