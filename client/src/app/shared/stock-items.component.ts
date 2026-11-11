import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../core/api.service';
import { RawCategory, RawProductRef, StockRow } from '../core/models';
import { fmtCost, fmtMoney, fmtQty, httpErr, trim } from '../core/format';
import { ProductEditComponent } from './product-edit.component';
import { ModalComponent } from './modal.component';

/** Что выбрано в левой колонке: все позиции, нераспределённые или конкретная категория. */
type CatSel = number | 'all' | 'none';

/** Позиция номенклатуры с текущим остатком склада. */
interface ItemRow extends RawProductRef {
  qty: number;
  avgCost: number;
  low: boolean;
}

/**
 * Склад: номенклатура и остатки в одной таблице.
 * Слева категории-фильтр, справа позиции с остатком, себестоимостью и действиями
 * (корректировка, история, карточка). Категории управляются в Настройках.
 */
@Component({
  selector: 'app-stock-items',
  standalone: true,
  imports: [CommonModule, FormsModule, ProductEditComponent, RouterLink, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .nm { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 14px; align-items: start; }
    .side { border: 1px solid var(--border); border-radius: 10px; background: #fff; padding: 8px; position: sticky; top: 10px; }
    .side-t { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 4px 8px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
    .cat-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: none; font: inherit; font-size: 13px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
    .cat-row:hover { background: #f4f7fb; }
    .cat-row.on { background: #eaf1fb; color: var(--accent); font-weight: 600; }
    .cat-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cnt { flex: none; font-size: 11px; color: var(--muted); background: #eef1f5; border-radius: 10px; padding: 1px 7px; font-variant-numeric: tabular-nums; }
    .cnt.warn { background: var(--amber-soft); color: var(--amber); }
    .side-sep { height: 1px; background: var(--border); margin: 7px 4px; }

    .main { border: 1px solid var(--border); border-radius: 10px; background: #fff; overflow: hidden; }
    .tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 10px 12px; }
    .tools input[type=search] { flex: 1 1 220px; max-width: 320px; }
    .low-t { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); cursor: pointer; }
    .head { display: flex; align-items: baseline; gap: 8px; padding: 0 12px 8px; }
    .head b { font-size: 14px; }
    .head .muted { font-size: 12px; }
    .cn { width: 54px; }
    .acts { white-space: nowrap; text-align: right; }
    .acts .btn { padding: 2px 7px; }
    .empty { text-align: center; color: var(--muted); padding: 22px 12px; }
    .unit { display: inline-block; font-size: 11px; color: var(--muted); background: #eef1f5; border-radius: 8px; padding: 0 6px; }
    .red { color: var(--red); }
    .adj-head { display: flex; align-items: baseline; gap: 8px; }
    .adj-head b { font-size: 15px; }
    @media (max-width: 900px) {
      .nm { grid-template-columns: 1fr; }
      .side { position: static; }
    }
  `],
  template: `
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="nm">
      <aside class="side">
        <div class="side-t"><span>Категории</span><span>{{ cats().length }}</span></div>
        <button type="button" class="cat-row" [class.on]="selected() === 'all'" (click)="pick('all')">
          <span class="cat-nm">Все позиции</span>
          <span class="cnt">{{ all().length }}</span>
        </button>
        <button type="button" class="cat-row" [class.on]="selected() === 'none'" (click)="pick('none')">
          <span class="cat-nm">Без категории</span>
          <span class="cnt" [class.warn]="unassigned().length > 0">{{ unassigned().length }}</span>
        </button>
        <div class="side-sep"></div>

        @for (c of cats(); track c.id) {
          <button type="button" class="cat-row" [class.on]="selected() === c.id" (click)="pick(c.id)">
            <span class="cat-nm" [title]="c.name">{{ c.name }}</span>
            <span class="cnt">{{ countOf(c.id) }}</span>
          </button>
        } @empty {
          <div class="muted" style="padding:8px;font-size:12px">Категории не созданы</div>
        }
      </aside>

      <section class="main">
        <div class="tools">
          <input type="search" placeholder="🔍 поиск по названию…" [ngModel]="q()" (ngModelChange)="onSearch($event)" />
          <label class="low-t">
            <input type="checkbox" [ngModel]="onlyLow()" (ngModelChange)="onlyLow.set($event)" /> только заканчивающиеся
          </label>
          <span class="spacer"></span>
          <button type="button" class="btn primary" (click)="newProduct()">+ Новая позиция</button>
          <a class="btn primary" [routerLink]="wbLink" [queryParams]="wbQp">+ Принять товар</a>
        </div>

        <div class="head">
          <b>{{ selectedTitle() }}</b>
          <span class="muted">{{ rows().length }} поз.</span>
        </div>

        <table class="tbl">
          <tr>
            <th>Позиция</th>
            <th class="cn">Ед.</th>
            <th class="num">Остаток</th>
            <th class="num">Мин.</th>
            <th class="num">Себест.</th>
            <th class="num">Сумма</th>
            <th class="num">Срок</th>
            <th>Категория</th>
            <th></th>
          </tr>
          @for (p of rows(); track p.id) {
            <tr>
              <td>
                <b>{{ p.name }}</b>
                @if (p.low) { <span class="badge red" title="Ниже минимального остатка">↓</span> }
              </td>
              <td><span class="unit">{{ p.unitCode || '—' }}</span></td>
              <td class="num" [class.red]="p.low">{{ fmtQty(p.qty, p.unitCode || '') }}</td>
              <td class="num muted">{{ p.minStock && p.minStock > 0 ? fmtQty(p.minStock, p.unitCode || '') : '—' }}</td>
              <td class="num muted">{{ fmtCost(p.avgCost, p.unitCode || '') }}</td>
              <td class="num">{{ fmtMoney(p.qty * p.avgCost) }}</td>
              <td class="num muted">{{ p.shelfLifeDays ? p.shelfLifeDays + ' дн.' : '—' }}</td>
              <td class="muted">{{ catName(p.categoryId) }}</td>
              <td class="acts">
                <button type="button" class="btn sm" (click)="startAdjust(p)" title="Корректировать остаток">корр.</button>
                <button type="button" class="btn sm" (click)="showMovements(p.name)" title="История движений">история</button>
                <button type="button" class="btn sm" (click)="editProduct(p.id)" title="Редактировать позицию">✎</button>
              </td>
            </tr>
          } @empty {
            <tr>
              <td class="empty" colspan="9">
                @if (q().trim()) {
                  По запросу «{{ q().trim() }}» ничего не найдено
                } @else if (onlyLow()) {
                  Заканчивающихся позиций нет 👍
                } @else if (selected() === 'none') {
                  Без категории нет — всё распределено 👍
                } @else {
                  В этой категории пока нет позиций
                }
              </td>
            </tr>
          }
        </table>
      </section>
    </div>

    @if (adjusting(); as a) {
      <app-modal title="Корректировка остатка" (closed)="cancelAdjust()">
        <div class="adj-head">
          <b>{{ a.name }}</b>
          <span class="muted">сейчас {{ fmtQty(a.qty, a.unitCode || '') }}</span>
        </div>
        <div class="row" style="margin-top:12px">
          <label class="f">Новый фактический остаток, {{ a.unitCode || '—' }}
            <input type="number" [(ngModel)]="adjustQty" autofocus />
          </label>
          <label class="f" style="flex:1">Комментарий
            <input [(ngModel)]="adjustComment" placeholder="инвентаризация, порча…" />
          </label>
        </div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">
          Дельта: {{ deltaLabel(a) }} — запишется в журнал как «корректировка».
        </p>
        <div modalFooter>
          <button class="btn" (click)="cancelAdjust()">Отмена</button>
          <button class="btn primary" [disabled]="adjustQty === null || adjustQty === a.qty" (click)="doAdjust()">Провести</button>
        </div>
      </app-modal>
    }

    @if (editOpen()) {
      <app-product-edit [productId]="editId()" (saved)="onProductSaved()" (closed)="editOpen.set(false)" />
    }
  `,
})
export class StockItemsComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  err = signal('');
  msg = signal('');
  cats = signal<RawCategory[]>([]);
  all = signal<RawProductRef[]>([]);
  stock = signal<Map<number, StockRow>>(new Map());
  selected = signal<CatSel>('all');
  q = signal('');
  onlyLow = signal(false);

  editOpen = signal(false);
  editId = signal<number | null>(null);

  adjusting = signal<ItemRow | null>(null);
  adjustQty: number | null = null;
  adjustComment = '';

  fmtQty = fmtQty;
  fmtCost = fmtCost;
  fmtMoney = fmtMoney;

  wbLink = ['/waybills'];
  wbQp = { panel: 'new' };

  ngOnInit(): void {
    this.load();
    // переход с панели «заканчивающиеся» несёт ?low=1
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      this.onlyLow.set(p['low'] === '1');
    });
  }

  private load(): void {
    this.api.rawCategories$().subscribe({
      next: (r) => this.cats.set(r),
      error: (e) => this.err.set(httpErr(e)),
    });
    this.api.allRawProducts$().subscribe({
      next: (r) => this.all.set(r),
      error: (e) => this.err.set(httpErr(e)),
    });
    this.loadStock();
  }

  private loadStock(): void {
    this.api.stock$().subscribe({
      next: (r) => this.stock.set(new Map(r.map((s) => [s.productId, s]))),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  countOf(catId: number): number {
    return this.all().filter((p) => p.categoryId === catId).length;
  }

  catName(catId: number | null | undefined): string {
    if (catId == null) return '— без категории —';
    return this.cats().find((c) => c.id === catId)?.name ?? '—';
  }

  unassigned = computed(() => this.all().filter((p) => p.categoryId == null));

  rows = computed<ItemRow[]>(() => {
    const s = this.selected();
    const needle = this.q().trim().toLowerCase();
    const stock = this.stock();
    return this.all()
      .filter((p) => s === 'all' || (s === 'none' ? p.categoryId == null : p.categoryId === s))
      .filter((p) => !needle || p.name.toLowerCase().includes(needle))
      .map((p) => {
        const st = stock.get(p.id);
        const qty = st?.qty ?? 0;
        const min = p.minStock ?? 0;
        return { ...p, qty, avgCost: st?.avgCost ?? 0, low: min > 0 && qty < min };
      })
      .filter((p) => !this.onlyLow() || p.low)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  selectedTitle = computed(() => {
    const s = this.selected();
    if (s === 'all') return 'Все позиции';
    if (s === 'none') return 'Без категории';
    return this.cats().find((c) => c.id === s)?.name ?? 'Категория';
  });

  pick(s: CatSel): void {
    this.selected.set(s);
    this.q.set('');
  }

  onSearch(v: string): void {
    this.q.set(v);
  }

  showMovements(name: string): void {
    void this.router.navigate(['/stock'], { queryParams: { tab: 'journal', product: name } });
  }

  // ---------- корректировка ----------
  startAdjust(r: ItemRow): void {
    this.adjusting.set(r);
    this.adjustQty = r.qty;
    this.adjustComment = '';
  }

  cancelAdjust(): void {
    this.adjusting.set(null);
  }

  deltaLabel(a: ItemRow): string {
    if (this.adjustQty === null) return '—';
    const delta = this.adjustQty - a.qty;
    if (delta === 0) return '0 (без изменений)';
    return `${delta > 0 ? '+' : ''}${trim(delta)} ${a.unitCode ?? ''}`.trim();
  }

  doAdjust(): void {
    const r = this.adjusting();
    if (!r || this.adjustQty === null) return;
    const delta = this.adjustQty - r.qty;
    if (delta === 0) { this.msg.set('Остаток не изменился'); return; }
    this.err.set('');
    this.api.adjust({ productId: r.id, delta, comment: this.adjustComment || 'инвентаризация' }).subscribe({
      next: () => {
        this.adjusting.set(null);
        this.msg.set(`Корректировка «${r.name}» на ${delta > 0 ? '+' : ''}${trim(delta)} ${r.unitCode ?? ''} проведена ✓`);
        this.loadStock();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  // ---------- позиции ----------
  newProduct(): void {
    this.editId.set(null);
    this.editOpen.set(true);
  }

  editProduct(id: number): void {
    this.editId.set(id);
    this.editOpen.set(true);
  }

  onProductSaved(): void {
    this.editOpen.set(false);
    this.msg.set('Позиция сохранена ✓');
    this.load();
  }
}
