import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../core/api.service';
import { RawCategory, RawProductRef, StockRow } from '../core/models';
import { fmtCost, fmtMoney, fmtQty, httpErr, trim } from '../core/format';
import { ProductEditComponent } from './product-edit.component';
import { ProductCardComponent, ProductCardTab } from './product-card.component';
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
  imports: [CommonModule, FormsModule, ProductEditComponent, ProductCardComponent, RouterLink, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .nm { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 14px; align-items: start; }
    .side { border: 1px solid var(--border); border-radius: 10px; background: #fff; padding: 8px; position: sticky; top: 10px; }
    .side-t { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 4px 8px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
    .cat-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: none; font: inherit; font-size: 13px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
    .cat-row:hover { background: color-mix(in srgb, var(--cat, #eef1f5) 45%, #fff); }
    .cat-row.on { background: #eaf1fb; color: var(--accent); font-weight: 600; }
    .cat-ic { flex: none; display: grid; place-items: center; width: 22px; height: 22px;
      border-radius: 7px; font-size: 12px; line-height: 1; }
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
    .nm-cell { display: flex; align-items: center; gap: 8px; }
    .nm-name { flex: 1 1 auto; min-width: 0; }
    .cat-chip { flex: none; padding: 0 7px; border-radius: 999px;
      font-size: 11px; line-height: 16px; font-weight: 400; color: #26303f; white-space: nowrap; }
    .red { color: var(--red); }
    /* чередование строк: чётные — с лёгкой подложкой, чтобы глаз держал строку */
    .tbl tr:nth-child(even) td { background: #f6f9fc; }
    .tbl tr:hover td { background: #e9f1fa; }
    .tbl tr.clickable { cursor: pointer; }
    .more { padding: 12px 12px 16px; text-align: center; color: var(--muted); font-size: 12px; }
    .adj-head { display: flex; align-items: baseline; gap: 8px; }
    .adj-head b { font-size: 15px; }
    @media (max-width: 900px) {
      .nm { grid-template-columns: 1fr; }
      .side { position: static; }
    }
    /* на телефоне .tbl.stack — карточки: подложка чередования вешается на строку, а не на ячейки */
    @media (max-width: 700px) {
      .tbl tr:nth-child(even) td, .tbl tr:hover td { background: none; }
      .tbl tr:nth-child(even) { background: #f6f9fc; }
      .tbl tr:hover { background: #e9f1fa; }
      .tbl tr:nth-child(even):hover { background: #e9f1fa; }
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
          <button type="button" class="cat-row" [class.on]="selected() === c.id"
                  [style.--cat]="c.color || null" (click)="pick(c.id)">
            <span class="cat-ic" [style.background]="c.color || '#eef1f5'">{{ c.icon || '•' }}</span>
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
            <input type="checkbox" [ngModel]="onlyLow()" (ngModelChange)="onLow($event)" /> только заканчивающиеся
          </label>
          <span class="spacer"></span>
          <button type="button" class="btn primary" (click)="newProduct()">+ Новая позиция</button>
          <a class="btn primary" [routerLink]="wbLink" [queryParams]="wbQp">+ Принять товар</a>
        </div>

        <div class="head">
          <b>{{ selectedTitle() }}</b>
          <span class="muted">{{ rows().length }} поз.</span>
        </div>

        <table class="tbl stack">
          <tr class="th-row">
            <th>Позиция</th>
            <th class="cn">Ед.</th>
            <th class="num">Остаток</th>
            <th class="num">Мин.</th>
            <th class="num">Себест.</th>
            <th class="num">Сумма</th>
            <th class="num">Срок</th>
            <th></th>
          </tr>
          @for (p of displayRows(); track p.id) {
            <tr class="clickable" (click)="openCard(p)">
              <td class="nm-cell">
                <span class="nm-name">
                  <b>{{ p.name }}</b>
                  @if (p.low) { <span class="badge red" title="Ниже минимального остатка">↓</span> }
                </span>
                @if (catOf(p.categoryId); as cat) {
                  <span class="cat-chip" [style.background]="cat.color || '#eef2f7'">{{ cat.icon ? cat.icon + ' ' : '' }}{{ cat.name }}</span>
                }
              </td>
              <td data-l="ед."><span class="unit">{{ p.unitCode || '—' }}</span></td>
              <td class="num" data-l="остаток" [class.red]="p.low">{{ fmtQty(p.qty, p.unitCode || '') }}</td>
              <td class="num muted" data-l="мин.">{{ p.minStock && p.minStock > 0 ? fmtQty(p.minStock, p.unitCode || '') : '—' }}</td>
              <td class="num muted" data-l="себест.">{{ fmtCost(p.avgCost, p.unitCode || '') }}</td>
              <td class="num" data-l="сумма">{{ fmtMoney(p.qty * p.avgCost) }}</td>
              <td class="num muted" data-l="срок">{{ p.shelfLifeDays ? p.shelfLifeDays + ' дн.' : '—' }}</td>
              <td class="acts no-l">
                <button type="button" class="btn sm" (click)="$event.stopPropagation(); startAdjust(p)" title="Корректировать остаток">корр.</button>
                <button type="button" class="btn sm" (click)="$event.stopPropagation(); showMovements(p.name)" title="История движений">история</button>
                <button type="button" class="btn sm" (click)="$event.stopPropagation(); openCard(p, 'edit')" title="Редактировать позицию">✎</button>
              </td>
            </tr>
          } @empty {
            <tr>
              <td class="empty" colspan="8">
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
        @if (hasMore()) {
          <div #more class="more">⏳ подгружаем ещё · {{ displayRows().length }} из {{ rows().length }}</div>
        }
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
      <app-product-edit [productId]="null" (saved)="onProductSaved()" (closed)="editOpen.set(false)" />
    }

    @if (carding(); as p) {
      <app-product-card [product]="p" [initialTab]="cardTab()"
                        (saved)="onCardSaved()" (closed)="carding.set(null)" />
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
  carding = signal<ItemRow | null>(null);
  cardTab = signal<ProductCardTab>('usage');

  adjusting = signal<ItemRow | null>(null);
  adjustQty: number | null = null;
  adjustComment = '';

  fmtQty = fmtQty;
  fmtCost = fmtCost;
  fmtMoney = fmtMoney;

  wbLink = ['/waybills'];
  wbQp = { panel: 'new' };

  /** Подгружаемый список: показываем первые PAGE_SIZE строк, остальные — по мере прокрутки. */
  private static readonly PAGE_SIZE = 30;
  visible = signal(StockItemsComponent.PAGE_SIZE);
  displayRows = computed(() => this.rows().slice(0, this.visible()));
  hasMore = computed(() => this.rows().length > this.visible());

  private more = viewChild<ElementRef<HTMLElement>>('more');
  private observer = new IntersectionObserver(
    (entries) => { if (entries.some((e) => e.isIntersecting)) this.grow(); },
    { rootMargin: '240px' }
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.observer.disconnect());
    // маячок появляется только когда есть что подгружать — следим за его появлением
    effect((onCleanup) => {
      const el = this.more()?.nativeElement;
      if (!el) return;
      this.observer.observe(el);
      onCleanup(() => this.observer.unobserve(el));
    });
  }

  private grow(): void {
    if (!this.hasMore()) return;
    this.visible.update((v) => v + StockItemsComponent.PAGE_SIZE);
    // если после порции маячок всё ещё в кадре (высокий экран, короткий фильтр) — добираем
    requestAnimationFrame(() => {
      const el = this.more()?.nativeElement;
      if (el && this.hasMore() && el.getBoundingClientRect().top < window.innerHeight) this.grow();
    });
  }

  private resetPaging(): void {
    this.visible.set(StockItemsComponent.PAGE_SIZE);
  }

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

  catOf(catId: number | null | undefined): RawCategory | undefined {
    if (catId == null) return undefined;
    return this.cats().find((c) => c.id === catId);
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
    this.resetPaging();
  }

  onSearch(v: string): void {
    this.q.set(v);
    this.resetPaging();
  }

  onLow(v: boolean): void {
    this.onlyLow.set(v);
    this.resetPaging();
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
    this.editOpen.set(true);
  }

  openCard(p: ItemRow, tab: ProductCardTab = 'usage'): void {
    this.cardTab.set(tab);
    this.carding.set(p);
  }

  onCardSaved(): void {
    this.carding.set(null);
    this.msg.set('Позиция сохранена ✓');
    this.load();
  }

  onProductSaved(): void {
    this.editOpen.set(false);
    this.msg.set('Позиция сохранена ✓');
    this.load();
  }
}
