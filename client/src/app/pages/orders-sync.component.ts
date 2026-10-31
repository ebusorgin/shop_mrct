import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../core/api.service';
import { OrderSyncState } from '../core/models';
import { httpErr } from '../core/format';
import { LiveService } from '../core/live.service';
import { OrdersNavComponent } from './orders-nav.component';

/**
 * Страница «Синхронизация с Google Таблицей» — вынесена из главной страницы заказов.
 * Показывает состояние прогона, ссылку на документ-источник, из которого идёт
 * парсинг, живой канал (SSE/вотчер) и таблицу листов; умеет запускать обновление
 * свежих и полный прогон. Пока идёт прогон — сами опрашиваем статус.
 */
@Component({
  selector: 'app-orders-sync',
  standalone: true,
  imports: [CommonModule, OrdersNavComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🔄 Синхронизация</h1>
    <app-orders-nav></app-orders-nav>

    @if (err()) { <div class="err">{{ err() }}</div> }

    <div class="panel">
      <div class="row" style="align-items:center; flex-wrap:wrap">
        <h3 style="margin:0">Синхронизация с Google Таблицей</h3>
        <span class="spacer"></span>
        <button class="btn sm" (click)="refreshSync()" title="Обновить статус">⟳</button>
        <button class="btn sm" [disabled]="busy()" (click)="runSync(false)">Обновить свежие</button>
        <button class="btn sm primary" [disabled]="busy()" (click)="runSync(true)">▶ Полный прогон</button>
      </div>

      @if (sync(); as st) {
        @if (st.sheetUrl) {
          <div class="sheet-src">
            <label class="f grow minw0">Источник заказов — Google Таблица, из которой идёт парсинг
              <input #url readonly [value]="st.sheetUrl" (click)="selectInput(url)" />
            </label>
            <a class="btn sm" [href]="st.sheetUrl" target="_blank" rel="noopener">👁 Открыть</a>
            <button class="btn sm" (click)="copySheetUrl(st.sheetUrl)">📋 Копировать</button>
          </div>
          @if (copied()) { <div class="ok-msg" style="margin-top:8px">Ссылка скопирована в буфер обмена</div> }
          @if (st.copyConfigured) {
            <div class="row copy-row">
              <button class="btn sm primary" [disabled]="copying() || busy()" (click)="copyToTest()">
                {{ copying() ? '⏳ Копирую…' : '⬇️ Скопировать прод → тест' }}
              </button>
              <span class="muted hint">прод-таблица не меняется; тестовая перезапишется листами прод, затем начнётся синхронизация</span>
              @if (copyMsg()) { <span class="ok-msg" style="margin:0">{{ copyMsg() }}</span> }
            </div>
          }
        }
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
        @if (st.watch; as w) {
          <p class="muted" style="font-size:12px">
            Живой канал: {{ live.connected() ? 'подключён' : 'нет' }} · открытых вкладок {{ w.clients }}
            @if (w.intervalSec > 0) { · вотчер проверяет лист каждые {{ w.intervalSec }} с (последняя проверка {{ when(w.lastCheckAt) }}) }
            @else { · вотчер выключен, работает только вебхук }
          </p>
        }

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
  `,
  styles: [`
    .sheet-src { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .sheet-src label.f { flex: 1 1 280px; min-width: 0; }
    .sheet-src input { font-size: 12.5px; width: 100%; min-width: 0; }
    .copy-row { margin-top: 10px; align-items: center; }
    .copy-row .hint { font-size: 12px; }
  `],
})
export class OrdersSyncComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  readonly live = inject(LiveService);

  sync = signal<OrderSyncState | null>(null);
  err = signal('');
  busy = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // пришло событие из таблицы — сразу подтягиваем состояние прогона
    effect(() => {
      if (this.live.sheetVersion() > 0) untracked(() => this.refreshSync());
    });
  }

  ngOnInit(): void {
    this.refreshSync();
    // автообновление статуса, пока идёт прогон
    this.timer = setInterval(() => {
      if (this.sync()?.state?.status === 'running') this.refreshSync();
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }

  refreshSync(): void {
    this.api.orderSync$().subscribe({
      next: (v) => this.sync.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  /** выделить ссылку кликом по read-only полю — удобно копировать вручную */
  selectInput(el: HTMLInputElement): void {
    el.select();
  }

  copied = signal(false);
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  async copySheetUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copied.set(false), 2500);
    } catch {
      this.err.set('Не удалось скопировать — выделите ссылку кликом и скопируйте вручную (Ctrl+C)');
    }
  }

  copying = signal(false);
  copyMsg = signal('');

  /** прод → тест: сервер зовёт Apps Script на прод-таблице; копирование всех листов долгое */
  copyToTest(): void {
    this.copying.set(true);
    this.copyMsg.set('');
    this.err.set('');
    this.api.copySheetToTest$().subscribe({
      next: (v) => {
        this.copying.set(false);
        this.copyMsg.set(`Скопировано листов: ${v.tabsCopied} (+${v.tabsCreated}, −${v.tabsRemoved}) — синхронизация запущена`);
        this.refreshSync();
      },
      error: (e) => {
        this.copying.set(false);
        this.err.set(httpErr(e));
      },
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

  when(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}
