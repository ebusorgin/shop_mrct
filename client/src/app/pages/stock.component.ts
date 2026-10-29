import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Movement, Product, StockRow, Unit } from '../core/models';
import { fmtCost, fmtDateTime, fmtMoney, fmtQty, httpErr, trim } from '../core/format';
import { ModalComponent } from '../shared/modal.component';

type Tab = 'balances' | 'catalog' | 'journal';

@Component({
  selector: 'app-stock',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🏬 Склад</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="tabs">
      <button [class.on]="tab() === 'balances'" (click)="go('balances')">Остатки</button>
      <button [class.on]="tab() === 'catalog'" (click)="go('catalog')">Номенклатура</button>
      <button [class.on]="tab() === 'journal'" (click)="go('journal')">Журнал движений</button>
    </div>

    <!-- ================= ОСТАТКИ ================= -->
    @if (tab() === 'balances') {
      <div class="panel">
        <div class="row">
          <input style="max-width:260px" [(ngModel)]="search" (ngModelChange)="applyFilter()" placeholder="🔍 поиск позиции…" />
          <select [(ngModel)]="catFilter" (ngModelChange)="applyFilter()">
            <option value="">все категории</option>
            @for (c of categories(); track c) { <option [value]="c">{{ c }}</option> }
          </select>
          <label class="f" style="flex-direction:row;align-items:center;gap:6px">
            <input type="checkbox" [(ngModel)]="onlyLow" (ngModelChange)="applyFilter()" /> только заканчивающиеся
          </label>
        </div>
        <hr class="hr" />
        <table class="tbl">
          <tr><th>Продукт</th><th>Категория</th><th class="num">Остаток</th><th class="num">Себестоимость</th><th class="num">Сумма</th><th></th><th></th></tr>
          @for (r of filteredRows(); track r.productId) {
            <tr>
              <td><b>{{ r.name }}</b></td>
              <td class="muted">{{ r.category }}</td>
              <td class="num">{{ fmtQty(r.qty, r.unitCode) }}</td>
              <td class="num muted">{{ fmtCost(r.avgCost, r.unitCode) }}</td>
              <td class="num">{{ fmtMoney(r.qty * r.avgCost) }}</td>
              <td>@if (r.low) { <span class="badge red"> ↓ ниже минимума</span> }</td>
              <td><button class="btn sm" (click)="startAdjust(r)">корректировать</button></td>
            </tr>
          } @empty { <tr class="empty"><td colspan="7">нет позиций</td></tr> }
        </table>
      </div>

      @if (adjusting(); as a) {
        <div class="panel">
          <h3>Корректировка: {{ a.name }} (сейчас {{ fmtQty(a.qty, a.unitCode) }})</h3>
          <div class="row">
            <label class="f">Новый фактический остаток (в {{ a.unitCode }})<input type="number" [(ngModel)]="adjustQty" /></label>
            <label class="f" style="flex:1">Комментарий<input [(ngModel)]="adjustComment" placeholder="инвентаризация, порча…" /></label>
            <button class="btn primary" (click)="doAdjust()">Провести</button>
            <button class="btn" (click)="adjusting.set(null)">Отмена</button>
          </div>
          <p class="muted" style="font-size:12px">Дельта = факт − текущий остаток; запишется в журнал как «корректировка».</p>
        </div>
      }
    }

    <!-- ================= НОМЕНКЛАТУРА ================= -->
    @if (tab() === 'catalog') {
      <div class="panel">
        <div class="row">
          <input style="max-width:260px" [(ngModel)]="search" (ngModelChange)="applyFilter()" placeholder="🔍 поиск…" />
          <select [(ngModel)]="catFilter" (ngModelChange)="applyFilter()">
            <option value="">все категории</option>
            @for (c of categories(); track c) { <option [value]="c">{{ c }}</option> }
          </select>
          <div class="spacer"></div>
          <button class="btn primary" (click)="newProduct()">+ Новая позиция</button>
        </div>
        <p class="muted" style="font-size:12px">Остатки хранятся в базовых единицах (г/мл/шт), крупные значения интерфейс сам показывает в кг/л.</p>
        <hr class="hr" />
        <table class="tbl">
          <tr><th>Название</th><th>Категория</th><th>Ед.</th><th class="num">Мин.</th><th class="num">Остаток</th><th>Статус</th><th></th></tr>
          @for (p of filteredProducts(); track p.id) {
            <tr>
              <td><b>{{ p.name }}</b></td>
              <td>{{ p.category }}</td>
              <td>{{ p.unitCode }}</td>
              <td class="num muted">{{ trim(p.minStock) }}</td>
              <td class="num">{{ fmtQty(p.stockQty, p.unitCode) }}</td>
              <td>@if (p.active) { <span class="badge green">активен</span> } @else { <span class="badge gray">архив</span> }</td>
              <td>
                <button class="btn sm" (click)="startEdit(p)">✏️</button>
                <button class="btn sm danger" (click)="deleteProduct(p)">🗑</button>
              </td>
            </tr>
          } @empty { <tr class="empty"><td colspan="7">пусто</td></tr> }
        </table>
      </div>

      @if (editOpen()) {
        <app-modal [title]="edit.id ? 'Редактировать позицию' : 'Новая позиция'" (closed)="cancelEdit()">
          @if (err()) { <div class="err">{{ err() }}</div> }
          <div class="row">
            <label class="f" style="flex:2">Название<input [(ngModel)]="edit.name" placeholder="Картофель" /></label>
            <label class="f">Категория<input [(ngModel)]="edit.category" list="cats" placeholder="овощи" /></label>
            <datalist id="cats">@for (c of categories(); track c) { <option [value]="c"></option> }</datalist>
            <label class="f">Ед. хранения (базовая)
              <select [(ngModel)]="edit.unitId">
                @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }} — {{ u.name }}</option> }
              </select>
            </label>
            <label class="f">Мин. остаток, {{ editUnitCode() }}<input type="number" [(ngModel)]="edit.minStock" /></label>
            <label class="f">Срок годности, дней<input type="number" min="0" step="1" [(ngModel)]="edit.shelfLifeDays" placeholder="напр. 90" /></label>
            @if (edit.id) {
              <label class="f" style="flex-direction:row;align-items:center;gap:6px">
                <input type="checkbox" [(ngModel)]="edit.active" /> активен
              </label>
            }
          </div>
          <div class="row" style="margin-top:12px;align-items:flex-end">
            <div class="muted" style="flex-basis:100%;font-size:12px">
              Доп. единицы и пересчёт — задайте только нужные связи; пустое = связь не задавать.
              Пересчёт работает между шт↔г (грамм в 1 шт), шт↔мл (мл в 1 шт) и г↔мл (плотность).
            </div>
            <label class="f">грамм в 1 шт<input type="number" min="0" [(ngModel)]="edit.gPerPcs" placeholder="напр. 55" /></label>
            <label class="f">мл в 1 шт<input type="number" min="0" [(ngModel)]="edit.mlPerPcs" placeholder="напр. 50" /></label>
            <label class="f">грамм в 1 мл (плотность)<input type="number" min="0" step="any" [(ngModel)]="edit.gPerMl" placeholder="напр. 1.4" /></label>
          </div>
          <div modalFooter>
            <button class="btn" (click)="cancelEdit()">Отмена</button>
            <button class="btn primary" (click)="saveProduct()">Сохранить</button>
          </div>
        </app-modal>
      }
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

  tab = signal<Tab>('balances');
  err = signal('');
  msg = signal('');

  rows = signal<StockRow[]>([]);
  filteredRows = signal<StockRow[]>([]);
  products = signal<Product[]>([]);
  filteredProducts = signal<Product[]>([]);
  categories = signal<string[]>([]);
  units = signal<Unit[]>([]);
  journal = signal<Movement[]>([]);

  search = '';
  catFilter = '';
  onlyLow = false;

  adjusting = signal<StockRow | null>(null);
  adjustQty: number | null = null;
  adjustComment = '';

  edit: {
    id: number | null; name: string; category: string; unitId: number | null; minStock: number; active: boolean;
    shelfLifeDays: number | null;
    gPerPcs: number | null; mlPerPcs: number | null; gPerMl: number | null;
  } = {
    id: null, name: '', category: '', unitId: null, minStock: 0, active: true,
    shelfLifeDays: null, gPerPcs: null, mlPerPcs: null, gPerMl: null,
  };
  /** Открытие модального окна редактирования/создания позиции номенклатуры. */
  editOpen = signal(false);

  jFrom = '';
  jTo = '';
  jType = '';

  fmtQty = fmtQty;
  fmtMoney = fmtMoney;
  fmtCost = fmtCost;
  trim = trim;
  fmtWhen = fmtDateTime;

  /** Только базовые единицы (г/мл/шт) — в них склад хранит остатки. */
  baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));
  editUnitCode = computed(() => this.units().find((u) => u.id === this.edit.unitId)?.code ?? '…');

  ngOnInit(): void {
    this.api.units$().subscribe((u) => this.units.set(u));
    this.api.categories$().subscribe((c) => this.categories.set(c));
    this.loadAll();
  }

  loadAll(): void {
    this.api.stock$().subscribe({
      next: (v) => { this.rows.set(v); this.applyFilter(); },
      error: (e) => this.err.set(httpErr(e)),
    });
    this.api.products$().subscribe({
      next: (v) => { this.products.set(v); this.applyFilter(); },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  go(t: Tab): void {
    this.tab.set(t);
    this.msg.set('');
    this.err.set('');
    if (t === 'journal' && this.journal().length === 0) this.loadJournal();
  }

  applyFilter(): void {
    const q = this.search.toLowerCase();
    const bal = this.rows().filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q)) &&
        (!this.catFilter || r.category === this.catFilter) &&
        (!this.onlyLow || r.low)
    );
    this.filteredRows.set(bal);
    const prods = this.products().filter(
      (p) => (!q || p.name.toLowerCase().includes(q)) && (!this.catFilter || p.category === this.catFilter)
    );
    this.filteredProducts.set(prods);
  }

  // -------- корректировки --------
  startAdjust(r: StockRow): void {
    this.adjusting.set(r);
    // пересчитываем базовое число в «его» единицах для простоты: базовая = unitCode продукта
    this.adjustQty = r.qty;
    this.adjustComment = '';
  }

  doAdjust(): void {
    const r = this.adjusting();
    if (!r || this.adjustQty === null) return;
    const delta = this.adjustQty - r.qty;
    if (delta === 0) { this.msg.set('Остаток не изменился'); return; }
    this.api.adjust({ productId: r.productId, delta, comment: this.adjustComment || 'инвентаризация' }).subscribe({
      next: () => {
        this.adjusting.set(null);
        this.msg.set(`Корректировка «${r.name}» на ${delta > 0 ? '+' : ''}${trim(delta)} ${r.unitCode} проведена ✓`);
        this.loadAll();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  // -------- номенклатура --------
  /** Открыть модалку редактирования существующей позиции. */
  startEdit(p: Product): void {
    this.err.set('');
    this.msg.set('');
    this.edit = {
      id: p.id, name: p.name, category: p.category, unitId: p.unitId, minStock: p.minStock, active: p.active,
      shelfLifeDays: p.shelfLifeDays ?? null,
      gPerPcs: p.gPerPcs ?? null, mlPerPcs: p.mlPerPcs ?? null, gPerMl: p.gPerMl ?? null,
    };
    this.editOpen.set(true);
  }

  /** Открыть модалку создания новой позиции. */
  newProduct(): void {
    this.err.set('');
    this.msg.set('');
    this.resetEdit();
    this.editOpen.set(true);
  }

  resetEdit(): void {
    this.edit = { id: null, name: '', category: '', unitId: null, minStock: 0, active: true,
      shelfLifeDays: null, gPerPcs: null, mlPerPcs: null, gPerMl: null };
  }

  /** Закрыть модалку без сохранения. */
  cancelEdit(): void {
    this.editOpen.set(false);
    this.resetEdit();
  }

  saveProduct(): void {
    this.err.set('');
    const conv = (v: number | string | null): number | null =>
      v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    const body: Record<string, unknown> = {
      name: this.edit.name,
      category: this.edit.category || 'прочее',
      unitId: this.edit.unitId,
      minStock: this.edit.minStock,
      shelfLifeDays: conv(this.edit.shelfLifeDays as number | string | null),
      gPerPcs: conv(this.edit.gPerPcs as number | string | null),
      mlPerPcs: conv(this.edit.mlPerPcs as number | string | null),
      gPerMl: conv(this.edit.gPerMl as number | string | null),
    };
    const sub = {
      next: () => {
        this.msg.set('Позиция сохранена ✓');
        this.editOpen.set(false);
        this.resetEdit();
        this.api.categories$().subscribe((c) => this.categories.set(c));
        this.loadAll();
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    };
    if (this.edit.id) {
      body['active'] = this.edit.active;
      this.api.patchProduct(this.edit.id, body).subscribe(sub);
    } else {
      this.api.createProduct(body).subscribe(sub);
    }
  }

  deleteProduct(p: Product): void {
    const zero = Math.abs(p.stockQty) < 1e-9;
    const warn = zero
      ? 'Остаток = 0 — позиция будет удалена физически (вместе с её историей движений).'
      : `На складе остаток ${fmtQty(p.stockQty, p.unitCode)} — позиция будет только скрыта в архив. Чтобы удалить, сначала обнулите остаток.`;
    if (!confirm(`Удалить позицию «${p.name}»?

${warn}`)) return;
    this.api.deleteProduct(p.id).subscribe({
      next: (res) => {
        const r = res as {
          deleted?: boolean; deactivated?: boolean; reason?: 'recipe' | 'stock'; stockQty?: number;
          cleaned?: { movements: number; waybillItems: number; batchItems: number };
        };
        if (r.deleted) {
          const c = r.cleaned!;
          const extra = c.movements || c.waybillItems || c.batchItems
            ? ` (убрано истории: движений ${c.movements}, строк накладных ${c.waybillItems}, партий ${c.batchItems})`
            : '';
          this.msg.set(`Позиция «${p.name}» удалена ✓${extra}`);
        } else if (r.reason === 'recipe') {
          this.msg.set(`«${p.name}» участвует в рецептурах (техкарты/полуфабрикаты) — переведена в архив. Сначала уберите её из рецептур.`);
        } else if (r.reason === 'stock') {
          this.msg.set(`«${p.name}» имеет остаток ${trim(r.stockQty ?? 0)} ${p.unitCode} — переведена в архив. Обнулите остаток для удаления.`);
        } else {
          this.msg.set('Позиция переведена в архив');
        }
        this.loadAll();
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  // -------- журнал --------
  loadJournal(): void {
    const params: Record<string, string> = {};
    if (this.jFrom) params['from'] = this.jFrom;
    if (this.jTo) params['to'] = this.jTo;
    if (this.jType) params['type'] = this.jType;
    this.api.movements$(params).subscribe({
      next: (v) => this.journal.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }
}
