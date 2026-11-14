import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from '../core/api.service';
import { SupplierCard, SupplierInvoiceDetail, SupplierInvoiceShort } from '../core/models';
import { OrderWriteoffComponent } from '../orders/writeoff.component';
import { TabItem, TabStripComponent } from '../shared/tab-strip.component';

@Component({
  selector: 'app-suppliers',
  standalone: true,
  imports: [OrderWriteoffComponent, TabStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">🚚 Поставщики</h1>
    </div>

    <app-tab-strip [tabs]="tabs" [active]="tab()" ariaLabel="Разделы поставщиков" (pick)="setTab($event)" />

    @if (tab() === 'list') {
      @if (opened(); as o) {
        <button type="button" class="back" (click)="closeInvoice()">← Назад к поставщикам</button>

        <section class="panel doc" [attr.aria-label]="'Накладная ' + o.number">
          <header class="doc-head">
            <div>
              <div class="doc-kicker">{{ o.supplier.name }}</div>
              <div class="doc-title-wrap">
                <h2 class="doc-title">Накладная № {{ o.number }}</h2>
                @if (o.sourceFile) {
                  <span class="src-wrap">
                    <button type="button" class="src-btn" (click)="openPhoto()"
                            aria-label="Фото накладной" title="Фото накладной">
                      <span aria-hidden="true">📷</span>
                    </button>
                    <span class="src-pop" role="tooltip">
                      <img [src]="photoUrl(o.sourceFile)" [alt]="'Фото накладной № ' + o.number" loading="lazy" />
                      <span class="src-hint">Нажмите, чтобы открыть целиком</span>
                    </span>
                  </span>
                }
              </div>
              <div class="doc-date">{{ date(o.date) }}</div>
            </div>
            <div class="doc-total">
              <b>{{ money(o.gross) }}</b>
              <small>к оплате</small>
            </div>
          </header>

          <div class="doc-parties">
            <div>
              <span>Поставщик</span>
              <b>{{ o.supplier.legalName || o.supplier.name }}</b>
              <small>{{ o.supplier.address }} · PIB {{ o.supplier.pib }} · MB {{ o.supplier.mb }}</small>
            </div>
            <div>
              <span>Получатель</span>
              <b>MIX MARKT GASTRO DOO</b>
              <small>{{ o.recipient || 'Karađorđeva 5, Smederevo · PIB 114917301 · MB 22090208' }}</small>
              @if (o.buyerCode) { <small>Шифра купца: {{ o.buyerCode }}</small> }
              @if (o.orderRef) { <small>Заказ: {{ o.orderRef }}</small> }
            </div>
          </div>

          @if (o.items.length) {
            <div class="doc-table" role="table" [attr.aria-label]="'Позиции накладной ' + o.number">
              <div class="doc-row tr" role="row">
                <span role="columnheader">Товар</span>
                <span class="num" role="columnheader">Кол-во</span>
                <span class="num" role="columnheader">Сумма, RSD</span>
              </div>
              @for (l of o.items; track l.position) {
                <div class="doc-row" role="row">
                  <span class="doc-name">
                    <b>{{ l.name }}</b>
                    <small>
                      {{ l.ident }} · {{ money(l.price) }} / {{ unitLabel(l.unit) }}
                      @if (l.vatRate !== null) { · PDV {{ l.vatRate }}% }
                      @if (l.discountPct > 0) { · скидка {{ discount(l.discountPct) }} }
                    </small>
                  </span>
                  <span class="num">{{ qty(l.qty) }} {{ unitLabel(l.unit) }}</span>
                  <span class="num">{{ money(l.net) }}</span>
                </div>
              }
            </div>
          } @else {
            <div class="doc-note">Позиции этой накладной ещё не оцифрованы.</div>
          }

          @if (o.note) { <div class="doc-note">{{ o.note }}</div> }

          <div class="doc-totals">
            @if (o.net !== null) { <span>Без PDV <b>{{ money(o.net) }}</b></span> }
            @if (o.vat !== null) { <span>PDV <b>{{ money(o.vat) }}</b></span> }
            <span class="grand">К оплате <b>{{ money(o.gross) }}</b></span>
          </div>
        </section>
      } @else if (loading()) {
        <p class="sub" style="margin:14px 0">Загружаю поставщиков…</p>
      } @else if (error()) {
        <p class="sub" style="margin:14px 0">{{ error() }}</p>
      } @else {
      <div class="list-meta">
        <p class="sub">
          Период {{ period() }} · получатель MIX MARKT GASTRO DOO · PIB 114917301 · MB 22090208
          <span class="demo-chip" title="Накладные оцифрованы с фотографий и хранятся в базе">из базы · оцифровано с фото</span>
        </p>
        <span class="tl-stats">
          <span><b>{{ suppliers().length }}</b> поставщика</span>
          <span><b>{{ invoiceCount() }}</b> накладных</span>
          <span><b>{{ money(total()) }}</b></span>
        </span>
      </div>

      <div class="grid">
        @for (s of suppliers(); track s.id) {
          <article class="card panel">
            <div class="head">
              <div class="ttl">
                <strong>{{ s.name }}</strong>
              </div>
              <div class="sum">
                <b>{{ money(supplierTotal(s)) }}</b>
                <small>{{ s.invoices.length }} {{ s.invoices.length === 1 ? 'накладная' : 'накладных' }}</small>
              </div>
            </div>

            @if (s.legalName) { <div class="legal">{{ s.legalName }}</div> }

          <div class="profile">
            <div class="pf"><span class="k">Адрес</span><span class="v">{{ s.address }}</span></div>
            <div class="pf"><span class="k">PIB</span><span class="v mono">{{ s.pib }}</span></div>
            <div class="pf"><span class="k">MB</span><span class="v mono">{{ s.mb }}</span></div>
            @if (s.phone) { <div class="pf"><span class="k">Телефон</span><span class="v mono">{{ s.phone }}</span></div> }
            @if (s.fax) { <div class="pf"><span class="k">Факс</span><span class="v mono">{{ s.fax }}</span></div> }
            @if (s.email) { <div class="pf"><span class="k">E-mail</span><span class="v mono">{{ s.email }}</span></div> }
            @for (a of s.accounts; track a) {
              <div class="pf"><span class="k">Счёт</span><span class="v mono">{{ a }}</span></div>
            }
            @if (s.gln) { <div class="pf"><span class="k">GLN</span><span class="v mono">{{ s.gln }}</span></div> }
            @if (s.contact) { <div class="pf"><span class="k">Контакт</span><span class="v">{{ s.contact }}</span></div> }
          </div>

          @if (s.note) { <div class="note">{{ s.note }}</div> }

          <div class="inv">
            <div class="inv-head">
              <span>Накладные</span>
              <span class="muted">{{ money(supplierTotal(s)) }}</span>
            </div>
            @for (i of s.invoices; track i.id) {
              <button type="button" class="inv-row" (click)="openInvoice(i)"
                      [attr.aria-label]="'Открыть накладную № ' + i.number + ' от ' + date(i.date)"
                      title="Открыть накладную">
                <span class="inv-date">{{ date(i.date) }}</span>
                <span class="inv-num mono">{{ i.number }}</span>
                <span class="inv-sum">{{ money(i.gross) }}</span>
              </button>
            }
          </div>
        </article>
      }
      </div>
      }
    } @else {
      <div class="supplies-wrap"><app-order-writeoff /></div>
    }

    @if (photoOpen()) {
      @if (opened(); as o) {
        <div class="photo-overlay" (click)="closePhoto()">
          <figure class="photo-card" role="dialog" aria-modal="true" [attr.aria-label]="'Фото накладной ' + o.number">
            <button type="button" class="photo-close" (click)="closePhoto()" aria-label="Закрыть">×</button>
            <img [src]="photoUrl(o.sourceFile)" [alt]="'Фото накладной № ' + o.number" />
            <figcaption>Фото накладной № {{ o.number }} · {{ date(o.date) }}</figcaption>
          </figure>
        </div>
      }
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .list-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; margin: 14px 0; }
    .supplies-wrap { padding-top: 14px; }
    .sub { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
    .sub .demo-chip { margin-left: 6px; }
    .demo-chip {
      padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
      color: #7a5a12; background: var(--amber-soft, #fbf1da); border: 1px solid #ecd9ab; white-space: nowrap;
    }
    .tl-stats { display: flex; align-items: baseline; gap: 14px; color: var(--muted); font-size: 11.5px; white-space: nowrap; flex-wrap: wrap; }
    .tl-stats b { color: var(--text); font-size: 15px; font-variant-numeric: tabular-nums; }

    .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); align-items: start; }
    .card { display: flex; flex-direction: column; gap: 10px; min-width: 0; margin: 0; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .ttl { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
    .ttl strong { font-size: 15px; overflow-wrap: anywhere; }
    .sum { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
    .sum b { font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .sum small { color: var(--muted); font-size: 11px; }
    .legal { color: var(--muted); font-size: 11.5px; line-height: 1.35; }
    .profile { display: flex; flex-direction: column; gap: 4px; }
    .pf { display: flex; gap: 8px; font-size: 12.5px; }
    .pf .k { color: var(--muted); min-width: 64px; flex: 0 0 auto; }
    .pf .v { overflow-wrap: anywhere; }
    .mono { font-variant-numeric: tabular-nums; }
    .note { color: var(--muted); font-size: 11.5px; font-style: italic; }
    .muted { color: var(--muted); }

    .inv { border-top: 1px solid var(--border); padding-top: 8px; display: flex; flex-direction: column; gap: 2px; }
    .inv-head { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); margin-bottom: 2px; }
    .inv-row {
      display: grid; grid-template-columns: 74px minmax(0, 1fr) 96px; gap: 8px; align-items: baseline;
      padding: 4px; margin: 0 -4px; font: inherit; font-size: 12px; color: var(--text); text-align: left;
      background: transparent; border: 0; border-bottom: 1px dashed #e7edf4; border-radius: 6px; cursor: pointer;
    }
    .inv-row:hover { background: var(--bg); }
    .inv-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .inv-row:last-child { border-bottom: none; }
    .inv-date { color: var(--muted); white-space: nowrap; }
    .inv-num { overflow-wrap: anywhere; }
    .inv-sum { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

    @media (max-width: 480px) {
      .inv-row { grid-template-columns: 66px minmax(0, 1fr) 88px; font-size: 11.5px; }
    }

    .back {
      display: inline-flex; align-items: center; gap: 4px; margin: 14px 0 12px; padding: 6px 10px;
      border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--muted);
      font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .back:hover { border-color: var(--accent); color: var(--accent); }
    .back:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .doc { display: flex; flex-direction: column; gap: 14px; padding: 16px; margin-bottom: 14px; }
    .doc-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
    .doc-kicker { color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .doc-title { margin: 2px 0 3px; font-size: 18px; overflow-wrap: anywhere; }
    .doc-title-wrap { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .doc-title-wrap .doc-title { margin: 2px 0 3px; }
    .src-wrap { position: relative; display: inline-flex; }
    .src-btn {
      display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
      padding: 0; font-size: 15px; line-height: 1; cursor: pointer;
      background: #fff; border: 1px solid var(--border); border-radius: 8px;
    }
    .src-btn:hover, .src-btn:focus-visible { border-color: var(--accent); color: var(--accent); }
    .src-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .src-pop {
      position: absolute; top: calc(100% + 6px); left: 50%; z-index: 30;
      width: min(380px, calc(100vw - 24px)); padding: 6px;
      background: #fff; border: 1px solid var(--border); border-radius: 12px;
      box-shadow: 0 12px 30px rgba(15, 35, 60, .18);
      opacity: 0; visibility: hidden; pointer-events: none;
      transition: opacity .12s ease, transform .12s ease;
      transform: translate(-50%, -4px);
    }
    .src-wrap:hover .src-pop, .src-wrap:focus-within .src-pop {
      opacity: 1; visibility: visible; pointer-events: auto; transform: translate(-50%, 0);
    }
    .src-pop img { display: block; width: 100%; height: auto; border-radius: 8px; }
    .src-hint { display: block; padding: 4px 2px 1px; color: var(--muted); font-size: 10.5px; text-align: center; }
    .doc-date { color: var(--muted); font-size: 12.5px; }
    .doc-total { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
    .doc-total b { font-size: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .doc-total small { color: var(--muted); font-size: 11px; }
    .doc-parties {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;
      padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg);
    }
    .doc-parties > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .doc-parties span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
    .doc-parties b { font-size: 12.5px; overflow-wrap: anywhere; }
    .doc-parties small { color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere; }
    .doc-row {
      display: grid; grid-template-columns: minmax(0, 1fr) 92px 104px; gap: 10px; align-items: baseline;
      padding: 7px 0; border-bottom: 1px dashed #e7edf4; font-size: 12.5px;
    }
    .doc-row:last-child { border-bottom: none; }
    .doc-row.tr {
      color: var(--muted); font-size: 10.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .04em; border-bottom: 1px solid var(--border);
    }
    .doc-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .doc-name b { overflow-wrap: anywhere; }
    .doc-name small { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .doc-note {
      padding: 12px; border: 1px dashed var(--border); border-radius: 10px;
      color: var(--muted); font-size: 12px; line-height: 1.45;
    }
    .doc-totals {
      display: flex; flex-wrap: wrap; gap: 8px 18px; justify-content: flex-end; align-items: baseline;
      padding-top: 10px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--muted);
    }
    .doc-totals b { color: var(--text); font-variant-numeric: tabular-nums; }
    .doc-totals .grand { color: var(--text); font-weight: 700; }

    .photo-overlay {
      position: fixed; inset: 0; z-index: 1000; padding: 16px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(12, 22, 36, .72);
    }
    .photo-card { position: relative; margin: 0; max-width: 100%; max-height: 100%; display: flex; flex-direction: column; gap: 6px; }
    .photo-card img {
      display: block; max-width: 100%; max-height: calc(100vh - 80px);
      border-radius: 10px; background: #fff; object-fit: contain;
    }
    .photo-card figcaption { color: #e8eef6; font-size: 12px; text-align: center; }
    .photo-close {
      position: absolute; top: 8px; right: 8px; width: 32px; height: 32px;
      border: 1px solid var(--border); border-radius: 50%; background: rgba(255, 255, 255, .94);
      font: inherit; font-size: 18px; line-height: 1; color: var(--text); cursor: pointer;
    }
    .photo-close:hover { border-color: var(--accent); color: var(--accent); }
    .photo-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 480px) {
      .doc-row { grid-template-columns: minmax(0, 1fr) 72px 88px; font-size: 11.5px; }
      .doc { padding: 12px; }
    }
    `,
  ],
})
export class SuppliersComponent {
  private readonly api = inject(ApiService);

  readonly tabs: TabItem[] = [
    { id: 'list', label: 'Список', icon: '📋' },
    { id: 'supplies', label: 'Поставки', icon: '📦' },
  ];
  readonly tab = signal<'list' | 'supplies'>('list');

  readonly suppliers = signal<SupplierCard[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly opened = signal<SupplierInvoiceDetail | null>(null);
  readonly photoOpen = signal(false);

  readonly invoiceCount = computed(() => this.suppliers().reduce((acc, s) => acc + s.invoices.length, 0));
  readonly total = computed(() => this.suppliers().reduce((acc, s) => acc + this.supplierTotal(s), 0));
  readonly period = computed(() => {
    const dates = this.suppliers().flatMap((s) => s.invoices.map((i) => i.date)).sort();
    if (!dates.length) return '—';
    return `${this.date(dates[0])} – ${this.date(dates[dates.length - 1])}`;
  });

  constructor() {
    this.api.suppliers$().subscribe({
      next: (list) => {
        this.suppliers.set(list);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Не удалось загрузить поставщиков.');
      },
    });
  }

  setTab(id: string): void {
    this.tab.set(id === 'supplies' ? 'supplies' : 'list');
  }

  supplierTotal(s: SupplierCard): number {
    return s.invoices.reduce((acc, i) => acc + (i.gross ?? 0), 0);
  }

  openInvoice(invoice: SupplierInvoiceShort): void {
    this.api.supplierInvoice$(invoice.id).subscribe({
      next: (detail) => {
        this.photoOpen.set(false);
        this.opened.set(detail);
        window.scrollTo(0, 0);
      },
      error: () => this.error.set('Не удалось загрузить накладную.'),
    });
  }

  closeInvoice(): void {
    this.photoOpen.set(false);
    this.opened.set(null);
    window.scrollTo(0, 0);
  }

  openPhoto(): void {
    this.photoOpen.set(true);
  }

  closePhoto(): void {
    this.photoOpen.set(false);
  }

  photoUrl(file: string | null): string {
    return file ? `/invoices/${file}` : '';
  }

  private readonly moneyFmt = new Intl.NumberFormat('sr-RS', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  private readonly qtyFmt = new Intl.NumberFormat('sr-RS', { maximumFractionDigits: 2 });

  money(n: number | null): string {
    return n === null ? '—' : `${this.moneyFmt.format(n)} RSD`;
  }

  date(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  qty(n: number): string {
    return this.qtyFmt.format(n);
  }

  discount(pct: number): string {
    return `−${this.qtyFmt.format(pct)}%`;
  }

  unitLabel(unit: 'KG' | 'KOM'): string {
    return unit === 'KG' ? 'кг' : 'шт';
  }
}
