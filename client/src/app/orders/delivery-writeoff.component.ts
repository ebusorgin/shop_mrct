import { ChangeDetectionStrategy, Component, HostListener, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../core/api.service';
import { DeliveryWriteoffPreview, DeliveryWriteoffResult } from '../core/models';
import { fmtQty, httpErr } from '../core/format';

/** Деньги в отчётах и на складе — RSD, как в Otpremnica. */
function rsd(value: number): string {
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + ' RSD';
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Окно ручного списания склада по доставке.
 * Считает сырьё по техкартам заказов, показывает остатки и среднюю себестоимость,
 * проводит движения writeoff только после подтверждения.
 * Один магазин (storeId) или все магазины даты (storeId = null).
 */
@Component({
  selector: 'app-delivery-writeoff',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wo-back" (click)="close()">
      <div class="wo-card" role="dialog" aria-modal="true" aria-label="Списание склада по доставке" (click)="$event.stopPropagation()">
        <header class="wo-head">
          <div>
            <h3>Списание склада</h3>
            <p>{{ dateLabel() }} · {{ scopeLabel() || (storeId() == null ? 'все магазины' : 'один магазин') }}</p>
          </div>
          <button type="button" class="wo-x" (click)="close()" aria-label="Закрыть">✕</button>
        </header>

        @if (loading()) {
          <p class="wo-state" role="status">Считаю сырьё по техкартам…</p>
        } @else if (err()) {
          <div class="wo-err" role="alert">{{ err() }}</div>
          <footer class="wo-foot">
            <button type="button" class="btn" (click)="load()">Повторить</button>
            <button type="button" class="btn" (click)="close()">Закрыть</button>
          </footer>
        } @else {
          @if (result(); as r) {
          <div class="wo-ok" role="status">
            <b>Списано со склада ✓</b>
            <p>{{ r.positions }} {{ r.positions === 1 ? 'позиция' : 'позиций' }} сырья · {{ rsd(r.totalCost) }} · {{ r.orders }} {{ r.orders === 1 ? 'заказ' : 'заказов' }}</p>
          </div>
          <footer class="wo-foot">
            <button type="button" class="btn primary" (click)="close()">Готово</button>
          </footer>
          } @else {
            @if (preview(); as p) {
          @if (p.records.length) {
            <div class="wo-records">
              <b>Уже списано на эту дату:</b>
              @for (rec of p.records; track rec.id) {
                <span>{{ rec.storeName || 'все магазины' }} · {{ when(rec.at) }} · {{ rsd(rec.costTotal) }}{{ rec.login ? ' · ' + rec.login : '' }}</span>
              }
            </div>
          }

          @if (p.blocked) {
            <p class="wo-note bad">Повторно списать на эту дату{{ p.storeId == null ? '' : ' / магазин' }} нельзя — запись уже есть.</p>
            <footer class="wo-foot">
              <button type="button" class="btn primary" (click)="close()">Понятно</button>
            </footer>
          } @else {
            <div class="wo-scope">
              <span>{{ p.orders.length }} {{ p.orders.length === 1 ? 'заказ' : 'заказов' }}</span>
              @if (p.orders.length <= 8) {
                <span class="wo-stores">{{ storeNames() }}</span>
              }
            </div>

            <div class="wo-grid">
              <div class="wo-grid-head">
                <span>Сырьё</span><span>Нужно</span><span>На складе</span><span class="r">Сумма</span>
              </div>
              @for (l of p.lines; track l.productId) {
                <div class="wo-row" [class.short]="!l.enough">
                  <span class="wo-name">{{ l.name }}</span>
                  <span>{{ fmtQty(l.qty, l.unitCode) }}</span>
                  <span>{{ fmtQty(l.stockQty, l.unitCode) }}</span>
                  <span class="r">{{ rsd(l.cost) }}</span>
                </div>
              }
            </div>

            <div class="wo-total">
              <span>Позиций: {{ p.lines.length }}</span>
              <span>Оценка по средней: <b>{{ rsd(p.totalCost) }}</b></span>
            </div>

            @if (p.shortages) {
              <p class="wo-note bad" role="alert">
                Не хватает остатка по {{ p.shortages }} {{ p.shortages === 1 ? 'позиции' : 'позициям' }} — списание недоступно.
                Сначала оформите приход на склад, затем повторите.
              </p>
            } @else {
              <p class="wo-note">
                Будут созданы движения «расход» по средней себестоимости. Это ручная операция: автоматически ничего не списывается.
              </p>
            }
            @if (err()) { <div class="wo-err" role="alert" style="margin-top:10px">{{ err() }}</div> }

            <footer class="wo-foot">
              <button type="button" class="btn" [disabled]="posting()" (click)="close()">Отмена</button>
              <button type="button" class="btn danger" [disabled]="!p.canPost || posting()" (click)="post()">
                {{ posting() ? 'Списываю…' : 'Списать со склада' }}
              </button>
            </footer>
          }
            }
          }
        }
      </div>
    </div>
  `,
  styles: [
    `
      .wo-back{position:fixed;inset:0;z-index:120;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px}
      .wo-card{width:min(760px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);padding:16px 18px}
      .wo-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
      .wo-head h3{margin:0;font-size:18px}
      .wo-head p{margin:3px 0 0;font-size:12px;color:var(--muted)}
      .wo-x{border:0;background:#f1f5f9;border-radius:8px;width:32px;height:32px;font-size:14px;cursor:pointer}
      .wo-state{padding:16px 0;color:var(--muted)}
      .wo-err{background:#fdecec;color:#8a1f1f;border-radius:8px;padding:10px 12px;font-size:13px}
      .wo-ok{background:#e9f8ef;color:#146c43;border-radius:10px;padding:14px 16px;font-size:14px}
      .wo-ok b{display:block;margin-bottom:4px}
      .wo-ok p{margin:0}
      .wo-records{background:#f1f5f9;border-radius:8px;padding:8px 10px;font-size:12px;display:grid;gap:2px;margin-bottom:10px}
      .wo-scope{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;font-size:13px;margin-bottom:8px}
      .wo-stores{color:var(--muted);font-size:12px}
      .wo-grid{border:1px solid var(--border);border-radius:10px;overflow:hidden}
      .wo-grid-head,.wo-row{display:grid;grid-template-columns:minmax(0,1fr) 130px 130px 110px;gap:8px;padding:7px 12px;font-size:13px}
      .wo-grid-head{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
      .wo-row{border-top:1px solid var(--border)}
      .wo-row.short{background:#fff7e2}
      .wo-row .r,.wo-grid-head .r{text-align:right}
      .wo-total{display:flex;justify-content:space-between;gap:12px;padding:8px 2px 0;font-size:13px}
      .wo-note{font-size:12.5px;color:var(--muted);margin:10px 0 0;line-height:1.45}
      .wo-note.bad{color:#8a5a00;background:#fff7e2;border:1px solid #f0d9a6;border-radius:8px;padding:8px 10px}
      .wo-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      @media (max-width:640px){
        .wo-grid-head{display:none}
        .wo-row{grid-template-columns:1fr auto;grid-template-areas:"name sum" "need stock";gap:2px 10px;padding:9px 12px}
        .wo-row .wo-name{grid-area:name;font-weight:600}
        .wo-row span:nth-child(2){grid-area:need;color:var(--muted);font-size:12px}
        .wo-row span:nth-child(3){grid-area:stock;color:var(--muted);font-size:12px;text-align:right}
        .wo-row .r{grid-area:sum;font-weight:600}
        .wo-foot{position:sticky;bottom:0;background:#fff;padding-top:8px}
      }
    `,
  ],
})
export class DeliveryWriteoffComponent implements OnInit {
  private api = inject(ApiService);

  readonly date = input.required<string>();
  readonly storeId = input<number | null>(null);
  readonly scopeLabel = input<string>('');
  readonly closed = output<void>();
  readonly written = output<void>();

  loading = signal(true);
  posting = signal(false);
  err = signal('');
  preview = signal<DeliveryWriteoffPreview | null>(null);
  result = signal<DeliveryWriteoffResult | null>(null);

  readonly rsd = rsd;
  readonly when = when;
  readonly fmtQty = fmtQty;

  dateLabel = computed(() => {
    const parts = this.date().split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : this.date();
  });

  storeNames = computed(() => {
    const p = this.preview();
    if (!p) return '';
    return [...new Set(p.orders.map((o) => o.storeName))].join(' · ');
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.err.set('');
    this.api
      .deliveryWriteoffPreview$(this.date(), this.storeId())
      .subscribe({
        next: (p) => {
          this.preview.set(p);
          this.loading.set(false);
        },
        error: (e) => {
          this.err.set(httpErr(e));
          this.loading.set(false);
        },
      });
  }

  post(): void {
    const p = this.preview();
    if (!p || !p.canPost || this.posting()) return;
    this.posting.set(true);
    this.err.set('');
    this.api.deliveryWriteoff$(this.date(), this.storeId()).subscribe({
      next: (r) => {
        this.posting.set(false);
        this.result.set(r);
        this.written.emit();
      },
      error: (e) => {
        this.posting.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  close(): void {
    if (this.posting()) return;
    this.closed.emit();
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    this.close();
  }
}
