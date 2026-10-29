import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { MyStore } from '../core/models';
import { httpErr } from '../core/format';
import { ModalComponent } from '../shared/modal.component';
import { OrderStoreComponent } from './order-store.component';

/**
 * Страница магазинного сотрудника: только своя точка.
 *
 *   • карточка магазина (адрес, телефоны, контакты, часы работы, примечание) + правка;
 *   • заказы с производства: оформление на сегодня и архив по датам
 *     (порядок заказов живёт в app-order-store, но без выбора магазина
 *      и без подтверждений — это делает производство).
 *
 * Доступна только пользователю с привязкой к точке (storeGuard), и все
 * запросы на сервере всё равно сужены до его store_id.
 */
@Component({
  selector: 'app-store-home',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalComponent, OrderStoreComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">🏪 {{ store()?.name ?? 'Мой магазин' }}</h1>
      @if (store()?.code) { <span class="badge gray">{{ store()!.code }}</span> }
      @if (store() && !store()!.active) { <span class="badge red">точка закрыта</span> }
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()">⟳</button>
      <button class="btn sm primary" (click)="openEdit()" [disabled]="!store()">✎ Данные магазина</button>
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    @if (store(); as s) {
      <div class="kpis">
        <div class="kpi"><div class="v">{{ s.todayLines }}</div><div class="l">позиций в заказе сегодня</div></div>
        <div class="kpi"><div class="v" [class.red]="s.openLines > 0">{{ s.openLines }}</div><div class="l">в работе (ждёт производства)</div></div>
        <div class="kpi"><div class="v">{{ s.orderDays }}</div><div class="l">дней с заказами в архиве</div></div>
        <div class="kpi"><div class="v">{{ s.employees }}</div><div class="l">сотрудников точки</div></div>
      </div>

      <div class="panel">
        <div class="row" style="align-items:center">
          <h3 style="margin:0">Информация о магазине</h3>
          <span class="spacer"></span>
          <span class="muted small">
            последний заказ: {{ s.lastOrderDate ? fmtDate(s.lastOrderDate) : '—' }} ·
            позиций в листе: {{ s.lastDateLines }}
          </span>
        </div>
        <div class="info">
          <div><span class="k">Адрес</span><span class="v">{{ s.address || '—' }}</span></div>
          <div><span class="k">Телефон</span><span class="v">{{ s.phone || '—' }}</span></div>
          <div><span class="k">E-mail</span><span class="v">{{ s.email || '—' }}</span></div>
          <div><span class="k">Контактное лицо</span><span class="v">{{ s.contactPerson || '—' }}</span></div>
          <div><span class="k">Часы работы</span><span class="v">{{ s.openingHours || '—' }}</span></div>
          <div><span class="k">Примечание</span><span class="v">{{ s.note || '—' }}</span></div>
        </div>
        <div class="muted small" style="margin-top:8px">
          Номер, код точки и её активность меняет офис. Заказы и их статусы — в разделе ниже.
        </div>
      </div>

      <app-order-store [fixedStoreId]="s.id" [storeView]="true" />
    } @else if (!err()) {
      <p class="muted">Загрузка…</p>
    }

    @if (editOpen()) {
      <app-modal title="Данные магазина" (closed)="editOpen.set(false)">
        @if (err()) { <div class="err">{{ err() }}</div> }
        <div class="col">
          <label class="f">
            Название
            <input [(ngModel)]="fName" maxlength="120" [disabled]="busy()" />
          </label>
          <label class="f">
            Адрес
            <input [(ngModel)]="fAddress" maxlength="200" [disabled]="busy()" placeholder="ул. …, дом" />
          </label>
          <div class="grid2">
            <label class="f">
              Телефон
              <input [(ngModel)]="fPhone" maxlength="60" [disabled]="busy()" placeholder="+38…" />
            </label>
            <label class="f">
              E-mail
              <input [(ngModel)]="fEmail" maxlength="120" [disabled]="busy()" placeholder="shop@…" />
            </label>
            <label class="f">
              Контактное лицо
              <input [(ngModel)]="fContact" maxlength="120" [disabled]="busy()" placeholder="Иванов Иван" />
            </label>
            <label class="f">
              Часы работы
              <input [(ngModel)]="fHours" maxlength="120" [disabled]="busy()" placeholder="08:00–22:00" />
            </label>
          </div>
          <label class="f">
            Примечание
            <input [(ngModel)]="fNote" maxlength="500" [disabled]="busy()" placeholder="напр. вход со двора" />
          </label>
          <div class="muted small">Изменения сохраняются в журнале действий с вашим ФИО.</div>
        </div>
        <div modalFooter>
          <button type="button" class="btn" (click)="editOpen.set(false)" [disabled]="busy()">Отмена</button>
          <button type="button" class="btn primary" (click)="save()" [disabled]="busy()">
            {{ busy() ? 'Сохраняем…' : 'Сохранить' }}
          </button>
        </div>
      </app-modal>
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .spacer { flex: 1 1 auto; }
    .small { font-size: 12px; }
    .col { display: flex; flex-direction: column; gap: 10px; }
    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .info { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; margin-top: 10px; }
    .info > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .info .k { font-size: 11px; text-transform: uppercase; letter-spacing: .02em; color: var(--muted); }
    .info .v { font-size: 14px; overflow-wrap: anywhere; }
    .red { color: var(--red); }
    `,
  ],
})
export class StoreHomeComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);

  store = signal<MyStore | null>(null);
  err = signal('');
  msg = signal('');
  busy = signal(false);
  editOpen = signal(false);

  // поля формы
  fName = '';
  fAddress = '';
  fPhone = '';
  fEmail = '';
  fContact = '';
  fHours = '';
  fNote = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.err.set('');
    this.api.myStore$().subscribe({
      next: (v) => this.store.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  openEdit(): void {
    const s = this.store();
    if (!s) return;
    this.fName = s.name;
    this.fAddress = s.address ?? '';
    this.fPhone = s.phone ?? '';
    this.fEmail = s.email ?? '';
    this.fContact = s.contactPerson ?? '';
    this.fHours = s.openingHours ?? '';
    this.fNote = s.note ?? '';
    this.err.set('');
    this.editOpen.set(true);
  }

  save(): void {
    if (this.busy()) return;
    const name = this.fName.trim().replace(/\s+/g, ' ');
    if (!name) {
      this.err.set('Название магазина не может быть пустым');
      return;
    }
    this.busy.set(true);
    this.err.set('');
    this.api
      .patchMyStore$({
        name,
        address: this.fAddress,
        phone: this.fPhone,
        email: this.fEmail,
        contactPerson: this.fContact,
        openingHours: this.fHours,
        note: this.fNote,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.editOpen.set(false);
          this.flash('Данные магазина сохранены');
          this.load();
        },
        error: (e) => {
          this.busy.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  /** YYYY-MM-DD -> ДД.ММ.ГГГГ (для даты последнего заказа). */
  fmtDate(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return d && m && y ? `${d}.${m}.${y}` : iso;
  }

  private flash(text: string): void {
    this.msg.set(text);
    setTimeout(() => this.msg.set(''), 4000);
  }
}
