import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { OrdersService } from '../core/orders.service';
import { OrderChange, OrderJournal } from '../core/models';
import { httpErr } from '../core/format';
import { LiveService } from '../core/live.service';
import { OrdersNavComponent } from './orders-nav.component';

/**
 * Страница «Журнал изменений» — вынесена из главной страницы заказов.
 * Кто и что поменял в заказах (создал/изменил количество/удалил/сменил статус),
 * с фильтром по магазину и меткой последнего листа. Обновляется по живому каналу.
 */
@Component({
  selector: 'app-orders-journal',
  standalone: true,
  imports: [CommonModule, FormsModule, OrdersNavComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🧾 Заказы магазинов · Журнал изменений</h1>
    <app-orders-nav></app-orders-nav>

    @if (err()) { <div class="err">{{ err() }}</div> }

    <div class="panel">
      <div class="row" style="align-items:center; flex-wrap:wrap">
        <h3 style="margin:0">Журнал изменений</h3>
        <span class="spacer"></span>
        @if (journal()?.lastTab; as lt) { <span class="badge blue">последний лист: {{ lt.sheetName }} · {{ lt.tabDate }}</span> }
        <label class="f">Магазин
          <select [ngModel]="journalStore()" (ngModelChange)="journalStore.set($event); loadJournal()">
            <option [ngValue]="0">— все —</option>
            @for (s of ordersSvc.stores(); track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }
          </select>
        </label>
        <button class="btn sm" (click)="loadJournal()">⟳ Обновить</button>
      </div>

      <table class="tbl stack">
        <tr class="th-row"><th>Когда</th><th>Кто</th><th>Магазин</th><th>Товар</th><th>Изменение</th><th>Лист</th></tr>
        @for (c of journal()?.changes ?? []; track c.id) {
          <tr>
            <td class="mono" data-l="Когда">{{ when(c.createdAt) }}</td>
            <td data-l="Кто" class="who" [title]="c.userLogin || c.actor || ''">{{ c.userName || c.userLogin || c.actor || '—' }}</td>
            <td data-l="Магазин">{{ c.storeName ?? '—' }}</td>
            <td>{{ c.sourceName }}</td>
            <td data-l="Изменение">
              <span class="badge" [class]="changeCls(c.changeType)">{{ changeLabel(c.changeType) }}</span>
              @if (detail(c); as d) { <span class="muted" style="font-size:12px"> {{ d }}</span> }
            </td>
            <td data-l="Лист" class="muted">{{ c.sheetName ?? '—' }}</td>
          </tr>
        } @empty { <tr class="empty"><td colspan="6">Изменений пока нет</td></tr> }
      </table>
    </div>
  `,
  styles: [` .who { white-space: nowrap; } `],
})
export class OrdersJournalComponent implements OnInit {
  private api = inject(ApiService);
  readonly ordersSvc = inject(OrdersService);
  readonly live = inject(LiveService);

  journal = signal<OrderJournal | null>(null);
  journalStore = signal(0);
  err = signal('');

  constructor() {
    // пришло событие из таблицы — подтягиваем журнал
    effect(() => {
      if (this.live.sheetVersion() > 0) untracked(() => this.loadJournal());
    });
  }

  async ngOnInit(): Promise<void> {
    await this.ordersSvc.ensureStores();
    this.loadJournal();
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
