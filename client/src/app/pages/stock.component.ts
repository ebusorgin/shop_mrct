import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../core/api.service';
import { Movement, NearExpiryRow } from '../core/models';
import { fmtDateTime, fmtQty, httpErr } from '../core/format';
import { StockItemsComponent } from '../shared/stock-items.component';

type Tab = 'items' | 'journal' | 'shelf';

@Component({
  selector: 'app-stock',
  standalone: true,
  imports: [CommonModule, FormsModule, StockItemsComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`.red { color: var(--red); }`],
  template: `
    <h1 class="page-title">🏬 Склад</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="tabs">
      <button [class.on]="tab() === 'items'" (click)="go('items')">Остатки и номенклатура</button>
      <button [class.on]="tab() === 'shelf'" (click)="go('shelf')">Сроки годности</button>
      <button [class.on]="tab() === 'journal'" (click)="go('journal')">Журнал движений</button>
    </div>

    <!-- ================= ОСТАТКИ И НОМЕНКЛАТУРА ================= -->
    @if (tab() === 'items') {
      <app-stock-items />
    }

    <!-- ================= СРОКИ ГОДНОСТИ (по партиям прихода) ================= -->
    @if (tab() === 'shelf') {
      <div class="panel">
        <div class="row" style="align-items:center">
          <div class="muted" style="flex:1;font-size:12px">
            Остаток раскладывается по партиям FIFO: расход сначала «съедает» самую старую партию,
            поэтому новая партия не продлевает срок старой. Считаем по приходам из проведённых накладных.
          </div>
          <button class="btn sm" [disabled]="shelfBusy()" (click)="loadShelf()">⟳ Обновить</button>
          <a class="btn sm primary" [routerLink]="wbLink" [queryParams]="wbQp">+ Принять товар</a>
        </div>
        @if (shelfBusy()) { <p class="muted">Считаем партии…</p> }
        <hr class="hr" />
        <table class="tbl">
          <tr><th>Продукт</th><th class="num">Остаток партии</th><th>Дата прихода</th><th>Истекает</th><th class="num">Дней</th><th>Статус</th><th></th></tr>
          @for (r of shelf(); track r.productId + r.receiptDate) {
            <tr>
              <td><b>{{ r.name }}</b></td>
              <td class="num">{{ fmtQty(r.qty, r.unitCode) }}</td>
              <td class="nw muted">{{ r.receiptDate }}</td>
              <td class="nw">{{ r.expiryDate }}</td>
              <td class="num" [class.red]="r.expiryDays < 0">{{ r.expiryDays }}</td>
              <td>
                @if (r.status === 'expired') { <span class="badge red">просрочен</span> }
                @else { <span class="badge amber">скоро · {{ r.expiryDays }} дн.</span> }
              </td>
              <td style="white-space:nowrap">
                <button class="btn sm" (click)="showMovements(r.name)">движения партии</button>
                <a class="btn sm" [routerLink]="wbLink" [queryParams]="wbQp">приход</a>
              </td>
            </tr>
          } @empty {
            @if (!shelfBusy()) {
              <tr class="empty"><td colspan="7">Просроченных и близких к истечению партий нет 👍</td></tr>
            }
          }
        </table>
      </div>
    }

    <!-- ================= ЖУРНАЛ ================= -->
    @if (tab() === 'journal') {
      <div class="panel">
        <div class="row">
          <label class="f">Дата с<input type="date" [(ngModel)]="jFrom" (ngModelChange)="loadJournal()" /></label>
          <label class="f">Дата по<input type="date" [(ngModel)]="jTo" (ngModelChange)="loadJournal()" /></label>
          <label class="f">Тип
            <select [(ngModel)]="jType" (ngModelChange)="loadJournal()">
              <option value="">все</option>
              <option value="receipt">приход</option>
              <option value="writeoff">расход</option>
              <option value="adjustment">корректировка</option>
            </select>
          </label>
        </div>
        @if (jProduct) {
          <div class="row" style="align-items:center;margin-top:8px">
            <span class="badge blue">позиция: {{ jProduct }}</span>
            <button class="btn sm" (click)="clearProductFilter()">сбросить фильтр</button>
          </div>
        }
        <hr class="hr" />
        <table class="tbl">
          <tr><th>Дата</th><th>Продукт</th><th>Кто</th><th>Тип</th><th class="num">Δ</th><th>Документ</th><th>Комментарий</th></tr>
          @for (m of journal(); track m.id) {
            <tr>
              <td class="mono nw">{{ fmtWhen(m.created_at) }}</td>
              <td><b>{{ m.productName }}</b></td>
              <td class="muted" [title]="m.userLogin ?? ''">{{ m.userName || m.userLogin || '—' }}</td>
              <td>
                @if (m.type === 'receipt') { <span class="badge green">приход</span> }
                @if (m.type === 'writeoff') { <span class="badge red">расход</span> }
                @if (m.type === 'adjustment') { <span class="badge amber">корр.</span> }
              </td>
              <td class="num">{{ m.qty > 0 ? '+' : '' }}{{ fmtQty(m.qty, m.unitCode) }}</td>
              <td class="muted">{{ m.docType ?? '—' }} @if (m.docId) { #{{ m.docId }}}</td>
              <td class="muted">{{ m.comment }}</td>
            </tr>
          } @empty { <tr class="empty"><td colspan="7">нет движений</td></tr> }
        </table>
      </div>
    }
  `,
})
export class StockComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  tab = signal<Tab>('items');
  err = signal('');
  msg = signal('');

  journal = signal<Movement[]>([]);
  /** партии с истекающим сроком (тот же /dashboard с большим лимитом — без нового эндпоинта) */
  shelf = signal<NearExpiryRow[]>([]);
  shelfBusy = signal(false);

  jFrom = '';
  jTo = '';
  jType = '';
  /** фильтр журнала по позиции: приходит из «истории» остатков и из предупреждений панели */
  jProduct = '';

  fmtQty = fmtQty;
  fmtWhen = fmtDateTime;

  ngOnInit(): void {
    // переходы с панели и из меню приходят как query-параметры: вкладка, тип/позиция журнала
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const t = String(p['tab'] ?? '');
      // старые ссылки на «Остатки»/«Номенклатуру» ведут на объединённую вкладку
      if (t === 'items' || t === 'balances' || t === 'catalog') {
        this.tab.set('items');
        this.err.set('');
        this.msg.set('');
      } else if (t === 'journal' || t === 'shelf') {
        this.tab.set(t);
        this.err.set('');
        this.msg.set('');
      }
      if (typeof p['type'] === 'string') this.jType = p['type'];
      this.jProduct = typeof p['product'] === 'string' ? p['product'] : '';
      if (this.tab() === 'journal') this.loadJournal();
      if (this.tab() === 'shelf' && !this.shelf().length) this.loadShelf();
    });
  }

  go(t: Tab): void {
    this.tab.set(t);
    this.msg.set('');
    this.err.set('');
    if (t === 'journal' && this.journal().length === 0) this.loadJournal();
    if (t === 'shelf' && this.shelf().length === 0) this.loadShelf();
  }

  /** ссылка на приход с уже открытой формой накладной (используется в шаблоне многократно) */
  wbLink = ['/waybills'];
  wbQp = { panel: 'new' };

  /** Строки партий с истекающим сроком — из показателей панели (expiryLimit больше). */
  loadShelf(): void {
    this.shelfBusy.set(true);
    this.api.dashboard$({ expiryLimit: '200' }).subscribe({
      next: (v) => { this.shelfBusy.set(false); this.shelf.set(v.nearExpiry); },
      error: (e) => { this.shelfBusy.set(false); this.err.set(httpErr(e)); },
    });
  }

  /** История движений конкретной позиции (из остатков или из предупреждения). */
  showMovements(name: string): void {
    void this.router.navigate(['/stock'], { queryParams: { tab: 'journal', product: name } });
  }

  clearProductFilter(): void {
    void this.router.navigate(['/stock'], { queryParams: { tab: 'journal' } });
  }

  // -------- журнал --------
  loadJournal(): void {
    const params: Record<string, string> = {};
    if (this.jFrom) params['from'] = this.jFrom;
    if (this.jTo) params['to'] = this.jTo;
    if (this.jType) params['type'] = this.jType;
    if (this.jProduct) params['q'] = this.jProduct;
    this.api.movements$(params).subscribe({
      next: (v) => this.journal.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }
}
