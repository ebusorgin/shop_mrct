import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ApiService } from '../core/api.service';
import { MyStore } from '../core/models';
import { httpErr } from '../core/format';
import { ModalComponent } from '../shared/modal.component';

/**
 * Страница магазинного сотрудника: карточка своей точки (сотрудники) и
 * справочная карточка «Данные магазина». Данные точки заполняет офис,
 * поэтому сотруднику они показываются только для просмотра.
 *
 * Доступна только пользователю с привязкой к точке (storeGuard), и все
 * запросы на сервере всё равно сужены до его store_id.
 */
@Component({
  selector: 'app-store-home',
  standalone: true,
  imports: [CommonModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">🏪 {{ store()?.name ?? 'Мой магазин' }}</h1>
      @if (store()?.code) { <span class="badge gray">{{ store()!.code }}</span> }
      @if (store() && !store()!.active) { <span class="badge red">точка закрыта</span> }
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()">⟳</button>
      <button class="btn sm primary" (click)="goOrder()" [disabled]="!store()">＋ Новый заказ товаров с производства</button>
      <button class="btn sm" (click)="infoOpen.set(true)" [disabled]="!store()">✎ Данные магазина</button>
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }

    @if (!store() && !err()) {
      <p class="muted">Загрузка…</p>
    }

    @if (infoOpen()) {
      <app-modal title="Данные магазина" (closed)="infoOpen.set(false)">
        @if (store(); as s) {
          <div class="info">
            <div><span class="k">Номер точки</span><span class="v">{{ s.id }}</span></div>
            <div><span class="k">Код</span><span class="v">{{ s.code || '—' }}</span></div>
            <div><span class="k">Название</span><span class="v">{{ s.name }}</span></div>
            <div><span class="k">Адрес</span><span class="v">{{ s.address || '—' }}</span></div>
            <div><span class="k">Телефон</span><span class="v">{{ s.phone || '—' }}</span></div>
            <div><span class="k">E-mail</span><span class="v">{{ s.email || '—' }}</span></div>
            <div><span class="k">Контактное лицо</span><span class="v">{{ s.contactPerson || '—' }}</span></div>
            <div><span class="k">Часы работы</span><span class="v">{{ s.openingHours || '—' }}</span></div>
            <div><span class="k">PIB</span><span class="v">{{ s.pib || '—' }}</span></div>
            <div><span class="k">MBR</span><span class="v">{{ s.mbr || '—' }}</span></div>
            <div><span class="k">Tekući račun</span><span class="v">{{ s.accountNo || '—' }}</span></div>
            <div><span class="k">Порядок</span><span class="v">{{ s.position }}</span></div>
            <div><span class="k">Активна</span><span class="v">{{ s.active ? 'да' : 'нет' }}</span></div>
            <div class="wide"><span class="k">Примечание</span><span class="v">{{ s.note || '—' }}</span></div>
          </div>
          <div class="muted small" style="margin-top:12px">
            Данные магазина заполняет офис — здесь только просмотр.
          </div>
        } @else {
          <p class="muted">Загрузка…</p>
        }
        <div modalFooter>
          <button type="button" class="btn" (click)="infoOpen.set(false)">Закрыть</button>
        </div>
      </app-modal>
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .spacer { flex: 1 1 auto; }
    .small { font-size: 12px; }

    .info { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
    .info > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .info > .wide { grid-column: 1 / -1; }
    .info .k { font-size: 11px; text-transform: uppercase; letter-spacing: .02em; color: var(--muted); }
    .info .v { font-size: 14px; overflow-wrap: anywhere; }
    .red { color: var(--red); }
    `,
  ],
})
export class StoreHomeComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);

  store = signal<MyStore | null>(null);
  err = signal('');
  infoOpen = signal(false);

  ngOnInit(): void {
    this.load();
  }

  /** Заказ оформляется на отдельной странице аккаунта магазина. */
  goOrder(): void {
    this.router.navigate(['/store/orders']);
  }

  load(): void {
    this.err.set('');
    this.api.myStore$().subscribe({
      next: (v) => this.store.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }
}
