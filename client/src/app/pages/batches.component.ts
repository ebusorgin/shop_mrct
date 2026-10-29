import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Batch, BatchItem, ExpansionRow, TechCard } from '../core/models';
import { fmtDateTime, fmtMoney, fmtQty, httpErr, today, trim } from '../core/format';

@Component({
  selector: 'app-batches',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🚚 Расход продукции (отгрузки с производства)</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <!-- ===== оформление расхода ===== -->
    <div class="panel">
      <h3>Оформить отгрузку</h3>
      <div class="row">
        <label class="f" style="flex:2">Готовая продукция (техкарта)
          <select [(ngModel)]="cardId" (ngModelChange)="loadPreview()">
            <option [ngValue]="null">— выбрать —</option>
            @for (c of cards(); track c.id) {
              <option [ngValue]="c.id">{{ c.name }} · порция {{ trim(c.portionQty) }} {{ c.portionUnitCode }}</option>
            }
          </select>
        </label>
        <label class="f">Порций<input type="number" [(ngModel)]="portions" (ngModelChange)="loadPreview()" min="1" /></label>
        <label class="f">Дата<input type="date" [(ngModel)]="batchDate" /></label>
        <label class="f" style="flex:1">Комментарий<input [(ngModel)]="note" placeholder="напр. 20 порций борща в столовую №3" /></label>
        <button class="btn primary" [disabled]="!cardId || !portions || posting()" (click)="post()">
          {{ posting() ? 'Списание…' : '➤ Списать с склада' }}
        </button>
      </div>

      @if (preview().length) {
        <hr class="hr" />
        <b class="muted" style="font-size:12px">Будет списано сырьё (после раскрытия полуфабрикатов и выхода после обработки):</b>
        <table class="tbl">
          <tr><th>Сырьё</th><th class="num">Расход</th><th class="num">Остаток сейчас</th><th>Достаточность</th></tr>
          @for (r of preview(); track r.productId) {
            <tr>
              <td>{{ r.name }}</td>
              <td class="num">{{ fmtQty(r.qty, r.unitCode) }}</td>
              <td class="num">{{ fmtQty(r.stockQty, r.unitCode) }}</td>
              <td>
                @if (r.qty > r.stockQty) { <span class="badge red">не хватает {{ fmtQty(r.qty - r.stockQty, r.unitCode) }}</span> }
                @else { <span class="badge green">хватит</span> }
              </td>
            </tr>
          }
        </table>
      }
    </div>

    <!-- ===== журнал ===== -->
    <div class="panel">
      <h3>Журнал отгрузок</h3>
      <table class="tbl">
        <tr><th>Дата</th><th>Продукция</th><th class="num">Порций</th><th class="num">Себестоимость</th><th>Кто отгрузил</th><th>Комментарий</th><th>Статус</th><th></th></tr>
        @for (b of batches(); track b.id) {
          <tr>
            <td class="mono">{{ b.batchDate }}</td>
            <td><b>{{ b.cardName }}</b> ({{ trim(b.portionQty) }} {{ b.portionUnitCode }})</td>
            <td class="num">{{ b.portions }}</td>
            <td class="num">{{ fmtMoney(b.costTotal) }}</td>
            <td class="muted">
              @if (b.createdLogin) {
                <b style="color:inherit" [title]="b.createdLogin">{{ b.createdName || b.createdLogin }}</b>
                <div style="font-size:11px">{{ fmtWhen(b.createdAt) }}</div>
              } @else { — }
            </td>
            <td class="muted">{{ b.note }}</td>
            <td>
              @if (b.status === 'posted') { <span class="badge green">проведено</span> }
              @else { <span class="badge gray">отменена</span> }
            </td>
            <td style="white-space:nowrap">
              <button class="btn sm" (click)="toggleDetails(b.id)">
                @if (openId() === b.id) { ▲ свернуть } @else { ▼ состав }
              </button>
              @if (b.status === 'posted') {
                <button class="btn sm danger" (click)="reverse(b)">отменить</button>
              }
            </td>
          </tr>
          @if (openId() === b.id) {
            <tr>
              <td colspan="8" style="background:#f8fafd">
                <table class="tbl">
                  <tr><th>Списанное сырьё</th><th class="num">Кол-во</th><th class="num">Себест./ед.</th><th class="num">Сумма</th></tr>
                  @for (i of details()[b.id] ?? []; track i.productId) {
                    <tr>
                      <td>{{ i.name }}</td>
                      <td class="num">{{ fmtQty(i.qty, i.unitCode) }}</td>
                      <td class="num muted">{{ trim(i.unitCost) }} ₽</td>
                      <td class="num">{{ fmtMoney(i.cost) }}</td>
                    </tr>
                  }
                </table>
              </td>
            </tr>
          }
        } @empty { <tr class="empty"><td colspan="8">Отгрузок пока не было</td></tr> }
      </table>
    </div>
  `,
})
export class BatchesComponent implements OnInit {
  private api = inject(ApiService);

  cards = signal<TechCard[]>([]);
  batches = signal<Batch[]>([]);
  preview = signal<ExpansionRow[]>([]);
  details = signal<Record<number, BatchItem[]>>({});
  openId = signal<number | null>(null);
  err = signal('');
  msg = signal('');
  posting = signal(false);

  cardId: number | null = null;
  portions = 20;
  batchDate = today();
  note = '';

  fmtQty = fmtQty;
  fmtMoney = fmtMoney;
  trim = trim;
  fmtWhen = fmtDateTime;

  ngOnInit(): void {
    this.api.cards$().subscribe((c) => this.cards.set(c));
    this.reload();
  }

  reload(): void {
    this.api.batches$().subscribe({
      next: (v) => this.batches.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  loadPreview(): void {
    this.preview.set([]);
    if (!this.cardId || !this.portions) return;
    this.api.cardExpansion$(this.cardId, this.portions).subscribe({
      next: (v) => this.preview.set(v),
      error: () => this.preview.set([]),
    });
  }

  post(): void {
    if (!this.cardId) return;
    this.err.set('');
    this.msg.set('');
    this.posting.set(true);
    this.api
      .createBatch({ cardId: this.cardId, portions: this.portions, batchDate: this.batchDate, note: this.note })
      .subscribe({
        next: (r) => {
          this.posting.set(false);
          const card = this.cards().find((c) => c.id === this.cardId);
          this.msg.set(
            `Отгружено: ${card?.name ?? ''} × ${this.portions} порц. — сырьё списано со склада, ` +
              `себестоимость ${fmtMoney(r.costTotal)} ✓`
          );
          this.preview.set([]);
          this.note = '';
          this.reload();
        },
        error: (e) => {
          this.posting.set(false);
          this.err.set(httpErr(e));
        },
      });
  }

  toggleDetails(id: number): void {
    if (this.openId() === id) {
      this.openId.set(null);
      return;
    }
    this.openId.set(id);
    if (!this.details()[id]) {
      this.api.batchItems$(id).subscribe((v) => this.details.set({ ...this.details(), [id]: v }));
    }
  }

  reverse(b: Batch): void {
    if (!confirm(`Отменить партию №${b.id} (${b.cardName} × ${b.portions})? Сырьё вернётся на склад.`)) return;
    this.api.reverseBatch(b.id).subscribe({
      next: () => {
        this.msg.set(`Партия №${b.id} отменена, сырьё возвращено на склад ✓`);
        this.details.set({ ...this.details(), [b.id]: [] });
        this.reload();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }
}
