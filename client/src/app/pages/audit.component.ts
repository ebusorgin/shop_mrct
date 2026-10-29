import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { AuditEntry, AuditPage } from '../core/models';
import { httpErr, fmtDateTime } from '../core/format';

/**
 * Раздел «Журнал действий»: кто, что и когда сделал.
 *
 * Читает audit_log (GET /api/audit). Здесь же видно, кто принял накладную на склад,
 * кто подтвердил/собрал заказ, кто правил товар, точку или пользователя.
 * Фильтры: человек, раздел, вид действия, период и поиск по названию.
 */
@Component({
  selector: 'app-audit',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">📜 Журнал действий</h1>
      <span class="spacer"></span>
      <span class="muted small">записей: {{ total() }}</span>
      <button class="btn sm" (click)="apply()" [disabled]="loading()">⟳</button>
    </div>

    <div class="panel filters">
      <label class="f">
        Кто
        <select [(ngModel)]="fUser" (change)="apply()">
          <option value="">все</option>
          @for (p of people(); track p.userLogin) {
            <option [value]="p.userLogin">{{ p.userName || p.userLogin }} ({{ p.cnt }})</option>
          }
        </select>
      </label>
      <label class="f">
        Раздел
        <select [(ngModel)]="fEntity" (change)="apply()">
          <option value="">все</option>
          @for (e of entities(); track e.entity) {
            <option [value]="e.entity">{{ entityLabel(e.entity) }} ({{ e.cnt }})</option>
          }
        </select>
      </label>
      <label class="f">
        Действие
        <select [(ngModel)]="fAction" (change)="apply()">
          <option value="">все</option>
          @for (a of actions(); track a.action) {
            <option [value]="a.action">{{ actionLabel(a.action) }} ({{ a.cnt }})</option>
          }
        </select>
      </label>
      <label class="f">
        С даты
        <input type="date" [(ngModel)]="fFrom" (change)="apply()" />
      </label>
      <label class="f">
        По дату
        <input type="date" [(ngModel)]="fTo" (change)="apply()" />
      </label>
      <label class="f grow">
        Поиск
        <input
          [(ngModel)]="fQ"
          (keyup.enter)="apply()"
          placeholder="номер накладной, товар, точка, комментарий…"
        />
      </label>
      <button class="btn sm primary" (click)="apply()" [disabled]="loading()">Найти</button>
      <button class="btn sm" (click)="reset()" [disabled]="loading()">Сброс</button>
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }

    <div class="panel">
      <table class="tbl stack">
        <thead>
          <tr>
            <th class="nw">Когда</th>
            <th>Кто</th>
            <th>Что сделал</th>
            <th>Объект</th>
            <th>Детали</th>
          </tr>
        </thead>
        <tbody>
          @for (e of entries(); track e.id) {
            <tr>
              <td data-l="Когда" class="nw">{{ fmtWhen(e.createdAt) }}</td>
              <td data-l="Кто">
                <span class="who" [class.sys]="isSystem(e.userLogin)" [title]="e.userLogin">{{ e.userName || e.userLogin }}</span>
              </td>
              <td data-l="Что сделал">
                <span [class]="'badge ' + toneOf(e.action)">{{ actionLabel(e.action) }}</span>
              </td>
              <td data-l="Объект">
                <span class="muted small">{{ entityLabel(e.entity) }}</span>
                @if (e.title) {
                  <div class="title">{{ e.title }}</div>
                }
              </td>
              <td data-l="Детали">
                @if (detailChips(e).length) {
                  <div class="chips">
                    @for (c of detailChips(e); track c) {
                      <span class="chip">{{ c }}</span>
                    }
                  </div>
                } @else {
                  <span class="muted">—</span>
                }
              </td>
            </tr>
          } @empty {
            <tr class="empty">
              <td colspan="5">{{ loading() ? 'Загружаем…' : 'Записей нет' }}</td>
            </tr>
          }
        </tbody>
      </table>

      @if (hasMore()) {
        <div class="more">
          <button class="btn sm" (click)="more()" [disabled]="loading()">
            {{ loading() ? 'Загружаем…' : 'Показать ещё' }}
          </button>
          <span class="muted small">показано {{ entries().length }} из {{ total() }}</span>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      .spacer { flex: 1 1 auto; }
      .small { font-size: 12px; }
      .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 14px; }
      .filters .f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
      .filters .f.grow { flex: 1 1 220px; min-width: 180px; }
      .filters input, .filters select { min-width: 120px; }
      .who { font-weight: 600; }
      .who.sys { color: var(--muted); font-weight: 400; font-style: italic; }
      .title { font-size: 13px; margin-top: 2px; }
      .chips { display: flex; gap: 6px; flex-wrap: wrap; }
      .chip {
        background: #f2f5fa;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 11px;
        color: var(--muted);
        white-space: nowrap;
      }
      .more { display: flex; align-items: center; gap: 10px; padding: 12px 2px 2px; }
    `,
  ],
})
export class AuditComponent implements OnInit {
  private api = inject(ApiService);

  entries = signal<AuditEntry[]>([]);
  total = signal(0);
  people = signal<AuditPage['summary']['people']>([]);
  entities = signal<AuditPage['summary']['entities']>([]);
  actions = signal<AuditPage['summary']['actions']>([]);
  loading = signal(false);
  err = signal('');

  fUser = '';
  fEntity = '';
  fAction = '';
  fFrom = '';
  fTo = '';
  fQ = '';

  private offset = 0;
  private readonly limit = 100;

  hasMore = computed(() => this.entries().length < this.total());

  ngOnInit(): void {
    this.apply();
  }

  apply(): void {
    this.offset = 0;
    this.entries.set([]);
    this.load();
  }

  more(): void {
    if (this.loading() || !this.hasMore()) return;
    this.offset += this.limit;
    this.load();
  }

  reset(): void {
    this.fUser = '';
    this.fEntity = '';
    this.fAction = '';
    this.fFrom = '';
    this.fTo = '';
    this.fQ = '';
    this.apply();
  }

  private load(): void {
    this.loading.set(true);
    this.err.set('');
    this.api
      .audit$({
        limit: String(this.limit),
        offset: String(this.offset),
        user: this.fUser,
        entity: this.fEntity,
        action: this.fAction,
        from: this.fFrom,
        to: this.fTo,
        q: this.fQ.trim(),
      })
      .subscribe({
        next: (page) => {
          this.loading.set(false);
          this.total.set(page.total);
          this.entries.update((cur) => (this.offset === 0 ? page.entries : [...cur, ...page.entries]));
          this.people.set(page.summary.people);
          this.entities.set(page.summary.entities);
          this.actions.set(page.summary.actions);
        },
        error: (e) => {
          this.loading.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  // ---------- подписи ----------

  private readonly ACTIONS: Record<string, string> = {
    create: 'создал',
    update: 'изменил',
    delete: 'удалил',
    post: 'провёл',
    reverse: 'отменил',
    adjust: 'корректировка',
    approve: 'статус заказа',
    login: 'вход',
    logout: 'выход',
    password: 'пароль',
    role: 'права',
    sync: 'синхронизация',
  };

  private readonly ENTITIES: Record<string, string> = {
    product: 'Товар',
    waybill: 'Накладная',
    semi: 'Полуфабрикат',
    tech_card: 'Техкарта',
    batch: 'Партия',
    order: 'Заказ',
    store: 'Точка',
    user: 'Пользователь',
    stock: 'Склад',
    sheet: 'Google Таблица',
  };

  private readonly KEYS: Record<string, string> = {
    mode: 'способ',
    items: 'позиций',
    supplier: 'поставщик',
    docDate: 'дата документа',
    createdProducts: 'создано товаров',
    aliasesSaved: 'новых синонимов',
    delta: 'изменение',
    comment: 'комментарий',
    reason: 'причина',
    stockQty: 'остаток',
    cleaned: 'очищено',
    unitId: 'единица',
    note: 'заметка',
    shelfLifeDays: 'срок годности, дн',
    inputs: 'состав',
    portionQty: 'выход порции',
    portionUnitId: 'единица порции',
    cardId: 'техкарта',
    portions: 'порций',
    batchDate: 'дата партии',
    costTotal: 'себестоимость',
    lines: 'позиций',
    merged: 'дополнено',
    violations: 'ниже минимума',
    date: 'дата',
    status: 'статус',
    statusRu: 'статус',
    from: 'было',
    to: 'стало',
    ip: 'адрес',
    userAgent: 'устройство',
    isAdmin: 'админ',
    active: 'вход',
    passwordReset: 'пароль сброшен',
    full: 'все листы',
    code: 'код',
    // снимки «до/после» в продуктах и полуфабрикатах идут колонками БД — подписываем и их
    name: 'название',
    category: 'категория',
    unit_id: 'единица',
    min_stock: 'минимум',
    shelf_life_days: 'срок годности, дн',
    g_per_pcs: 'грамм в 1 шт',
    ml_per_pcs: 'мл в 1 шт',
    g_per_ml: 'грамм в 1 мл (плотность)',
    ai_model: 'значение подсказал ИИ',
  };

  actionLabel(a: string): string {
    return this.ACTIONS[a] ?? a;
  }

  entityLabel(e: string): string {
    return this.ENTITIES[e] ?? e;
  }

  toneOf(a: string): string {
    if (a === 'post' || a === 'create') return 'green';
    if (a === 'delete' || a === 'reverse') return 'red';
    if (a === 'update' || a === 'adjust' || a === 'approve') return 'amber';
    if (a === 'login' || a === 'logout') return 'gray';
    return 'blue';
  }

  isSystem(login: string): boolean {
    return !login || login === 'system';
  }

  /** Детали — короткими плашками: «статус: подтверждён», «было 5 → стало 7». */
  detailChips(e: AuditEntry): string[] {
    const d = e.details ?? {};
    const out: string[] = [];
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined || v === '') continue;
      const key = this.KEYS[k] ?? k;
      if (typeof v === 'object' && !Array.isArray(v)) {
        const pair = v as { from?: unknown; to?: unknown };
        if ('from' in pair || 'to' in pair) {
          out.push(`${key}: ${this.short(pair.from)} → ${this.short(pair.to)}`);
          continue;
        }
        out.push(`${key}: ${this.short(JSON.stringify(v))}`);
        continue;
      }
      out.push(`${key}: ${this.short(v)}`);
    }
    return out.slice(0, 6);
  }

  private short(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'да' : 'нет';
    const s = String(v);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }

  /** Дата-время для шаблона (общий помощник из format.ts). */
  readonly fmtWhen = fmtDateTime;
}
