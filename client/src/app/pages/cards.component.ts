import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { CardItem, ExpansionRow, Product, ProductCatalog, Semi, TechCard, Unit } from '../core/models';
import { fmtQty, httpErr, trim } from '../core/format';
import { Conv, NO_CONV, dimOf, reachableDims } from '../core/units';

interface CardDraftItem {
  sourceType: 'raw' | 'semi' | 'product';
  refId: number | null;
  qty: number | null;
  unitId: number | null;
  /** текст поля поиска позиции; выбранный пункт хранится здесь же */
  refQuery?: string;
}

interface RefOption { id: number; label: string; }

interface CardDraftPackaging {
  id: number | null;
  /** Выход одной упаковки в единице выхода техкарты. */
  qtyBase: number | null;
  /** Минимальный заказ в упаковках. */
  minOrder: number | null;
  /** Можно ли уже заказывать эту фасовку магазинам. */
  available: boolean;
}

interface CardDraft {
  id: number | null;
  name: string;
  note: string;
  portionQty: number | null;
  portionUnitId: number | null;
  catalogId: number | null;
  items: CardDraftItem[];
  packagings: CardDraftPackaging[];
}

interface DNode { id: string; label: string; sub: string; cls: string; x: number; y: number; w: number; h: number; }
interface DEdge { x1: number; y1: number; x2: number; y2: number; label: string; }

@Component({
  selector: 'app-cards',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      /* панель фильтров над списком продукции */
      .card-filter { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 12px; }
      .cf-search { width: 100%; box-sizing: border-box; padding: 6px 10px; font-size: 13px;
        border: 1px solid #c9c9c9; border-radius: 6px; }
      .cf-search:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
      .cf-row { display: flex; gap: 8px; flex-wrap: wrap; }
      .cf-row select { flex: 1 1 140px; min-width: 0; padding: 6px 8px; font-size: 13px;
        border: 1px solid #c9c9c9; border-radius: 6px; background: #fff; }
      .cf-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
      /* позиция состава: поле с поиском по вводу */
      .combo { position: relative; flex: 2 1 140px; min-width: 0; }
      .combo-input { width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px;
        border: 1px solid #c9c9c9; border-radius: 6px; }
      .combo-input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
      .combo-list { position: absolute; z-index: 20; top: 100%; left: 0; right: 0; margin-top: 2px;
        max-height: 240px; overflow-y: auto; background: #fff; border: 1px solid #c9c9c9;
        border-radius: 6px; box-shadow: 0 6px 18px rgba(0, 0, 0, .12); }
      .combo-list button { display: block; width: 100%; text-align: left; padding: 6px 8px;
        border: 0; background: none; font-size: 13px; cursor: pointer; }
      .combo-list button:hover { background: #eef3fb; }
      .combo-empty { padding: 6px 8px; color: #6b7488; font-size: 12px; }
      /* шапка страницы как в «Полуфабрикатах»: заголовок, счётчик, действия справа */
      .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
      .head .page-title { margin: 0; }
      /* заголовок панели списка */
      .list-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 12px; }
      .list-head h3 { margin: 0; }
      /* метка каталога в списке: фон и иконка из настроек каталога */
      .cat-chip { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
        line-height: 16px; color: #26303f; vertical-align: baseline; }
    `,
  ],
  template: `
    <div class="head">
      <h1 class="page-title">📐 Техкарты</h1>
      <span class="badge blue">{{ list().length }} техкарт</span>
      <div class="spacer"></div>
      <button class="btn" (click)="duplicate()" [disabled]="!draft()">⧉ Дублировать</button>
      <button class="btn primary" (click)="newCard()">＋ Новая техкарта</button>
    </div>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid2" style="grid-template-columns: .55fr 1.45fr;">
      <!-- ===== список ===== -->
      <div class="panel" #listEl style="scroll-margin-top: 64px;">
        <div class="list-head">
          <h3>Техкарты</h3>
        </div>
        <div class="card-filter">
          <input type="search" class="cf-search" placeholder="🔍 Название, примечание или ингредиент"
                 [ngModel]="q()" (ngModelChange)="q.set($event)" />
          <div class="cf-row">
            <select [ngModel]="catalogFilter()" (ngModelChange)="catalogFilter.set($event)">
              <option value="">Все каталоги</option>
              <option value="none">— без каталога —</option>
              @for (c of catalogs(); track c.id) { <option [value]="c.id.toString()">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option> }
            </select>
            <select [ngModel]="ingredientFilter()" (ngModelChange)="ingredientFilter.set($event)">
              <option value="">Любой ингредиент</option>
              <optgroup label="Сырьё">
                @for (p of products(); track p.id) { <option [value]="'raw:' + p.id">{{ p.name }}</option> }
              </optgroup>
              <optgroup label="Полуфабрикаты">
                @for (s of semis(); track s.id) { <option [value]="'semi:' + s.id">{{ s.name }}</option> }
              </optgroup>
            </select>
          </div>
          <div class="cf-meta">
            <span class="muted">Найдено: {{ filtered().length }} из {{ list().length }}</span>
            @if (hasFilters()) { <button class="btn sm" (click)="resetFilters()">Сбросить фильтры</button> }
          </div>
        </div>
        <div class="list-pick">
          @for (c of filtered(); track c.id) {
            <button [class.on]="draft()?.id === c.id" (click)="editCard(c)">
              <b>{{ c.name }}</b>
              <div class="muted" style="font-size:12px">
                выход {{ trim(c.portionQty) }} {{ c.portionUnitCode }} · позиций {{ c.items.length }}
                · фасовок {{ c.packagings.length }}
                @if (catOf(c.catalogId); as cat) {
                  · <span class="cat-chip" [style.background]="cat.color || '#eef2f7'">{{ cat.icon ? cat.icon + ' ' : '' }}{{ cat.name }}</span>
                } @else if (c.catalogName) { · {{ c.catalogName }} }
              </div>
            </button>
          } @empty {
            <p class="muted">{{ list().length ? 'Ничего не найдено' : 'Техкарт пока нет' }}</p>
          }
        </div>
      </div>

      <!-- ===== редактор ===== -->
      @if (draft(); as d) {
        <div class="panel" #editorEl style="scroll-margin-top: 64px;">
          <h3>{{ d.id ? 'Редактирование' : 'Создание' }} техкарты</h3>
          <div class="row">
            <label class="f" style="flex:2">Название<input [(ngModel)]="d.name" placeholder="напр. Борщ (400 г)" /></label>
            <label class="f">Выход<input type="number" [(ngModel)]="d.portionQty" /></label>
            <label class="f">Ед.
              <select [(ngModel)]="d.portionUnitId">
                @for (u of units(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
              </select>
            </label>
            <label class="f" style="flex:1">Примечание<input [(ngModel)]="d.note" /></label>
            <label class="f" style="flex:1">Каталог
              <select [(ngModel)]="d.catalogId">
                <option [ngValue]="null">— без каталога —</option>
                @for (c of catalogs(); track c.id) { <option [ngValue]="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option> }
              </select>
            </label>
          </div>
          <hr class="hr" />

          <h3>Фасовка</h3>
          <p class="muted" style="font-size:12px; margin:0 0 8px">
            Выход упаковки — в единице выхода техкарты ({{ unitCode(d.portionUnitId) }}).
            Галочка «в доставке» разрешает магазинам заказывать продукт в этой фасовке.
          </p>
          @for (pk of d.packagings; track $index) {
            <div class="row" style="align-items:center;margin-bottom:6px">
              <label class="f">Выход, {{ unitCode(d.portionUnitId) }}
                <input type="number" [(ngModel)]="pk.qtyBase" />
              </label>
              <label class="f">Мин. заказ, уп.<input type="number" [(ngModel)]="pk.minOrder" min="1" step="1" /></label>
              <label class="f" style="flex:0 0 auto; flex-direction:row; align-items:center; gap:6px">
                <input type="checkbox" [(ngModel)]="pk.available" /> в доставке
              </label>
              <button class="btn sm danger" (click)="removePackaging($index)"
                      [disabled]="d.packagings.length <= 1" title="Удалить фасовку">✕</button>
            </div>
          }
          <button class="btn sm" (click)="addPackaging()">+ фасовка</button>

          <hr class="hr" />

          <h3>Состав техкарты</h3>
          @if (sumHint(); as sh) {
            <div class="row" style="align-items:center; margin-bottom:8px">
              <span class="muted" style="font-size:12px">{{ sh.parts }}</span>
              @if (sh.verdict) {
                <span class="badge" [class.amber]="sh.over" [class.green]="!sh.over">{{ sh.verdict }}</span>
              }
            </div>
          }
          @for (it of d.items; track $index) {
            <div class="row" style="align-items:center;margin-bottom:6px">
              <select style="width:140px; min-width:0" [(ngModel)]="it.sourceType" (ngModelChange)="it.refId = null; it.unitId = null; it.refQuery = ''">
                <option value="raw">сырьё</option>
                <option value="semi">полуфабрикат</option>
                <option value="product">техкарта</option>
              </select>
              <div class="combo">
                <input type="text" class="combo-input" placeholder="— выбрать —"
                       [ngModel]="it.refQuery ?? ''"
                       (ngModelChange)="onRefQuery(it, $event)"
                       (focus)="openRef($index)"
                       (blur)="openRefIdx.set(null)"
                       (keydown.enter)="pickFirst(it)"
                       (keydown.escape)="openRefIdx.set(null)" />
                @if (openRefIdx() === $index) {
                  <div class="combo-list">
                    @for (o of comboOptions(it); track o.id) {
                      <button type="button" (mousedown)="$event.preventDefault(); pickRef(it, o)">{{ o.label }}</button>
                    } @empty {
                      <div class="combo-empty">Ничего не найдено</div>
                    }
                  </div>
                }
              </div>
              <input style="width:100px; min-width:0" type="number" [(ngModel)]="it.qty" placeholder="кол-во" />
              <select style="width:75px; min-width:0" [(ngModel)]="it.unitId">
                @for (u of itemUnits(it); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
              </select>
              <button class="btn sm danger" (click)="d.items.splice($index, 1)">✕</button>
            </div>
          }
          <button class="btn sm" (click)="addItem()">+ позиция</button>

          <hr class="hr" />
          <div class="row">
            <button class="btn primary" (click)="save()">💾 Сохранить техкарту</button>
            @if (d.id) {
              <button class="btn" (click)="togglePreview()" [class.primary]="preview().length > 0">🔎 Проверка расхода</button>
              <button class="btn danger" (click)="remove()">Удалить</button>
            }
            <div class="spacer"></div>
            <button class="btn" (click)="closeEditor()">Закрыть</button>
          </div>

          @if (d.id && showPreview()) {
            <div class="row" style="margin-top:10px; align-items:center">
              <label class="f">Единиц для проверки<input type="number" style="width:100px" [(ngModel)]="previewPortions" (ngModelChange)="loadPreview()" /></label>
            </div>
            <table class="tbl">
              <tr><th>Сырьё (с учётом выхода после обработки)</th><th class="num">Нужно</th><th class="num">На складе</th><th></th></tr>
              @for (r of preview(); track r.productId) {
                <tr>
                  <td>{{ r.name }}</td>
                  <td class="num">{{ fmtQty(r.qty, r.unitCode) }}</td>
                  <td class="num">{{ fmtQty(r.stockQty, r.unitCode) }}</td>
                  <td>@if (r.qty > r.stockQty) { <span class="badge red">не хватает</span> } @else { <span class="badge green">ok</span> }</td>
                </tr>
              }
            </table>
          }

          <!-- ===== блок-схема ===== -->
          <hr class="hr" />
          <h3>Блок-схема: сырьё → полуфабрикаты → техкарты</h3>
          <div class="diagram-wrap">
            <svg class="diagram" [attr.width]="diagram().w" [attr.height]="diagram().h" [attr.viewBox]="'0 0 ' + diagram().w + ' ' + diagram().h">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#93a3bc"></path>
                </marker>
              </defs>
              @for (e of diagram().edges; track $index) {
                <path class="d-edge" [attr.d]="edgePath(e)"></path>
                <text class="d-elabel" [attr.x]="(e.x1 + e.x2) / 2" [attr.y]="(e.y1 + e.y2) / 2 - 4" text-anchor="middle">{{ e.label }}</text>
              }
              @for (n of diagram().nodes; track n.id) {
                <g>
                  <rect [attr.x]="n.x" [attr.y]="n.y" [attr.width]="n.w" [attr.height]="n.h" rx="8"
                        [class]="'d-node-' + n.cls"></rect>
                  <text [attr.x]="n.x + 10" [attr.y]="n.y + (n.sub ? 15 : n.h / 2 + 4)" font-size="12.5" font-weight="600" fill="#1d2433">{{ n.label }}</text>
                  @if (n.sub) {
                    <text [attr.x]="n.x + 10" [attr.y]="n.y + 29" font-size="10.5" fill="#6b7488">{{ n.sub }}</text>
                  }
                </g>
              }
            </svg>
            @if (diagram().nodes.length === 0) { <p class="muted">Добавьте позиции состава — схема построится автоматически.</p> }
          </div>
        </div>
      } @else {
        <div class="panel"><p class="muted">Выберите техкарту из списка или создайте новую. Блок-схема показывает, как складское сырьё
          через полуфабрикаты (с учётом выхода после обработки) превращается в готовое блюдо.</p></div>
      }
    </div>
  `,
})
export class CardsComponent implements OnInit {
  private api = inject(ApiService);
  private listEl = viewChild<ElementRef<HTMLElement>>('listEl');
  private editorEl = viewChild<ElementRef<HTMLElement>>('editorEl');

  list = signal<TechCard[]>([]);
  semis = signal<Semi[]>([]);
  products = signal<Product[]>([]);
  units = signal<Unit[]>([]);
  catalogs = signal<ProductCatalog[]>([]);
  draft = signal<CardDraft | null>(null);
  err = signal('');
  msg = signal('');

  showPreview = signal(false);
  previewPortions = 20;
  preview = signal<ExpansionRow[]>([]);

  diagram = signal<{ nodes: DNode[]; edges: DEdge[]; w: number; h: number }>({ nodes: [], edges: [], w: 10, h: 10 });

  /** Фильтры списка продукции: строка поиска, каталог ('' — все, 'none' — без каталога) и ингредиент ('raw:id' | 'semi:id'). */
  q = signal('');
  catalogFilter = signal('');
  ingredientFilter = signal('');

  hasFilters = computed(() => !!this.q().trim() || !!this.catalogFilter() || !!this.ingredientFilter());

  /** Каталог продукта — для иконки и фонового цвета в списке. */
  catOf(catalogId: number | null | undefined): ProductCatalog | undefined {
    return catalogId == null ? undefined : this.catalogs().find((c) => c.id === catalogId);
  }

  filtered = computed(() => {
    const needle = this.q().trim().toLowerCase();
    const cat = this.catalogFilter();
    const ing = this.ingredientFilter();
    return [...this.list()]
      .filter((c) => {
        if (needle) {
          const hay = [c.name, c.note, ...c.items.map((i) => i.refName ?? '')].join(' ').toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        if (cat) {
          if (cat === 'none' ? c.catalogId != null : c.catalogId !== Number(cat)) return false;
        }
        if (ing) {
          const sep = ing.indexOf(':');
          const type = ing.slice(0, sep);
          const id = Number(ing.slice(sep + 1));
          if (!c.items.some((i) => i.sourceType === type && i.refId === id)) return false;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  resetFilters(): void {
    this.q.set('');
    this.catalogFilter.set('');
    this.ingredientFilter.set('');
  }

  /** Продукты для состава: все, кроме текущего (нельзя вкладывать продукт сам в себя). */
  productRefs = computed(() => {
    const self = this.draft()?.id;
    return this.list()
      .filter((c) => c.id !== self)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  /** Индекс позиции, для которой открыт список поиска. */
  openRefIdx = signal<number | null>(null);

  openRef(index: number): void {
    this.openRefIdx.set(index);
  }

  /** Все варианты позиции выбранного типа. */
  refOptions(it: CardDraftItem): RefOption[] {
    if (it.sourceType === 'raw') {
      return this.products().map((p) => ({ id: p.id, label: `${p.category} · ${p.name}` }));
    }
    if (it.sourceType === 'semi') {
      return this.semis().map((s) => ({ id: s.id, label: s.name }));
    }
    return this.productRefs().map((c) => ({ id: c.id, label: c.name }));
  }

  /** Варианты с учётом введённого текста; ровно выбранный пункт не прячет остальные. */
  comboOptions(it: CardDraftItem): RefOption[] {
    const opts = this.refOptions(it);
    let q = (it.refQuery ?? '').trim().toLowerCase();
    if (q && q === this.refLabel(it).toLowerCase()) q = '';
    return q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts;
  }

  /** Ввод в поле поиска: точное совпадение сразу фиксирует выбор и единицу. */
  onRefQuery(it: CardDraftItem, value: string): void {
    it.refQuery = value;
    const exact = this.refOptions(it).find((o) => o.label.toLowerCase() === value.trim().toLowerCase());
    if (exact) {
      it.refId = exact.id;
      this.onPickRef(it);
      return;
    }
    it.refId = null;
    it.unitId = null;
  }

  pickRef(it: CardDraftItem, o: RefOption): void {
    it.refQuery = o.label;
    it.refId = o.id;
    this.onPickRef(it);
    this.openRefIdx.set(null);
  }

  pickFirst(it: CardDraftItem): void {
    const first = this.comboOptions(it)[0];
    if (first) this.pickRef(it, first);
  }

  /** Подпись выбранной позиции (для поля поиска при открытии существующего продукта). */
  private refLabel(it: { sourceType: 'raw' | 'semi' | 'product'; refId: number | null }): string {
    if (!it.refId) return '';
    if (it.sourceType === 'raw') {
      const p = this.products().find((x) => x.id === it.refId);
      return p ? `${p.category} · ${p.name}` : '';
    }
    if (it.sourceType === 'semi') return this.semis().find((x) => x.id === it.refId)?.name ?? '';
    return this.list().find((x) => x.id === it.refId)?.name ?? '';
  }

  trim = trim;
  fmtQty = fmtQty;

  ngOnInit(): void {
    this.reload();
    this.api.semis$().subscribe((s) => this.semis.set(s));
    this.api.products$({ active: 'true' }).subscribe((p) => this.products.set(p));
    this.api.units$().subscribe((u) => this.units.set(u));
    this.api.productCatalogs$().subscribe((c) => this.catalogs.set(c));
  }

  reload(): void {
    this.api.cards$().subscribe({
      next: (v) => this.list.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  unitCode(id: number | null): string {
    return this.units().find((u) => u.id === id)?.code ?? '';
  }

  /** Каноничная единица позиции: у сырья/полуфабриката — единица хранения, у продукта — единица выхода. */
  private refUnitId(it: CardDraftItem): number | null {
    if (!it.refId) return null;
    if (it.sourceType === 'raw') return this.products().find((p) => p.id === it.refId)?.unitId ?? null;
    if (it.sourceType === 'semi') return this.semis().find((s) => s.id === it.refId)?.unitId ?? null;
    return this.list().find((c) => c.id === it.refId)?.portionUnitId ?? null;
  }

  /** Коэффициенты пересчёта размерностей позиции; у продукта (tech_card) их нет. */
  private refConv(it: CardDraftItem): Conv {
    if (it.sourceType === 'raw') {
      const p = this.products().find((x) => x.id === it.refId);
      return p ? { gPerPcs: p.gPerPcs, mlPerPcs: p.mlPerPcs, gPerMl: p.gPerMl } : NO_CONV;
    }
    if (it.sourceType === 'semi') {
      const s = this.semis().find((x) => x.id === it.refId);
      return s ? { gPerPcs: s.gPerPcs, mlPerPcs: s.mlPerPcs, gPerMl: s.gPerMl } : NO_CONV;
    }
    return NO_CONV;
  }

  /**
   * Единицы для позиции состава: только размерности, достижимые из каноничной единицы
   * по коэффициентам пересчёта (g_per_pcs/ml_per_pcs/g_per_ml). Уже выбранная единица
   * остаётся в списке, чтобы select не «слетал».
   */
  itemUnits(it: CardDraftItem): Unit[] {
    const all = this.units();
    if (!it.refId) return all;
    const from = dimOf(all, this.refUnitId(it));
    if (!from) return all;
    const dims = reachableDims(from, this.refConv(it));
    const list = all.filter((u) => dims.has(u.dimension));
    if (it.unitId && !list.some((u) => u.id === it.unitId)) {
      const cur = all.find((u) => u.id === it.unitId);
      if (cur) list.push(cur);
    }
    return list;
  }

  /** При выборе позиции сразу подставляем её каноничную единицу (г/мл/шт). */
  onPickRef(it: CardDraftItem): void {
    if (!it.refId) return;
    it.unitId = this.refUnitId(it) ?? this.itemUnits(it)[0]?.id ?? null;
  }

  /**
   * Подсказка: Σ сырья на порцию по размерностям (масса/объём/штуки не смешиваем, объём ≈ масса 1:1 для воды)
   * и ожидаемый выход после обработки, если вход заметно больше порции. Для варки превышение — норма, поэтому только намёк.
   */
  sumHint(): { parts: string; verdict: string; over: boolean } | null {
    const d = this.draft();
    if (!d || !d.items.length) return null;
    const sum: Record<'mass' | 'volume' | 'count', number> = { mass: 0, volume: 0, count: 0 };
    for (const it of d.items) {
      if (!it.qty || !it.unitId) continue;
      const u = this.units().find((x) => x.id === it.unitId);
      if (!u) continue;
      sum[u.dimension as 'mass' | 'volume' | 'count'] += it.qty * u.baseFactor;
    }
    const parts: string[] = [];
    if (sum.mass) parts.push(fmtQty(sum.mass, 'г'));
    if (sum.volume) parts.push(fmtQty(sum.volume, 'мл'));
    if (sum.count) parts.push(`${trim(sum.count)} шт`);
    if (!parts.length) return null;
    const label = `Σ сырья: ${parts.join(' + ')}`;

    const pu = this.units().find((x) => x.id === d.portionUnitId);
    if (!pu || !d.portionQty || pu.dimension === 'count') return { parts: label, verdict: '', over: false };
    const inBase = pu.dimension === 'mass' ? sum.mass + sum.volume : sum.volume + sum.mass;
    const ratio = inBase / (d.portionQty * pu.baseFactor);
    if (ratio <= 1.05) return { parts: label, verdict: 'укладывается в порцию ✓', over: false };
    return {
      parts: `${label} vs порция ${fmtQty(d.portionQty * pu.baseFactor, pu.code)}`,
      verdict: `вход в ×${trim(Math.round(ratio * 10) / 10)} больше порции — ожидаемый выход после обработки ≈ ${Math.round(100 / ratio)}%`,
      over: true,
    };
  }

  newCard(): void {
    this.msg.set('');
    this.showPreview.set(false);
    const unit = this.units().find((u) => u.code === 'г');
    this.draft.set({
      id: null, name: '', note: '', portionQty: 1000,
      portionUnitId: unit?.id ?? null,
      catalogId: null,
      items: [],
      packagings: [{ id: null, qtyBase: 1000, minOrder: 1, available: true }],
    });
    this.buildDiagram();
    this.revealEditor();
  }

  editCard(c: TechCard): void {
    this.msg.set('');
    this.showPreview.set(false);
    this.preview.set([]);
    const packagings = (c.packagings ?? []).map((pk) => ({
      id: pk.id, qtyBase: pk.qtyBase, minOrder: pk.minOrder, available: pk.available !== false,
    }));
    this.draft.set({
      id: c.id, name: c.name, note: c.note,
      portionQty: c.portionQty, portionUnitId: c.portionUnitId,
      catalogId: c.catalogId ?? null,
      items: c.items.map((i) => ({
        sourceType: i.sourceType, refId: i.refId, qty: i.qty, unitId: i.unitId,
        refQuery: this.refLabel(i),
      })),
      packagings: packagings.length ? packagings : [{ id: null, qtyBase: c.portionQty, minOrder: 1, available: true }],
    });
    this.buildDiagram();
    this.revealEditor();
  }

  /**
   * На телефоне/узком окне панели идут одна под другой, и редактор оказывается ниже экрана:
   * без прокрутки тап по карте выглядит так, будто ничего не произошло.
   */
  private revealEditor(): void {
    setTimeout(() => {
      const el = this.editorEl()?.nativeElement;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight - 120) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /** Закрыть редактор и вернуться к списку: на телефоне он остался выше экрана. */
  closeEditor(): void {
    this.draft.set(null);
    setTimeout(() => {
      const el = this.listEl()?.nativeElement;
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  addItem(): void {
    const d = this.draft();
    if (!d) return;
    d.items.push({ sourceType: 'raw', refId: null, qty: null, unitId: this.units().find((u) => u.code === 'г')?.id ?? null, refQuery: '' });
    this.draft.set({ ...d });
    this.buildDiagram();
  }

  // ================== фасовки ==================

  addPackaging(): void {
    const d = this.draft();
    if (!d) return;
    d.packagings.push({ id: null, qtyBase: null, minOrder: 1, available: true });
    this.draft.set({ ...d });
  }

  removePackaging(index: number): void {
    const d = this.draft();
    if (!d || d.packagings.length <= 1) return;
    d.packagings.splice(index, 1);
    this.draft.set({ ...d });
  }

  save(): void {
    const d = this.draft();
    if (!d) return;
    this.err.set('');
    if (!d.name.trim() || !d.portionQty || !d.portionUnitId) {
      this.err.set('Заполните название и выход');
      return;
    }
    const items = d.items
      .filter((i): i is CardDraftItem & { refId: number; qty: number; unitId: number } =>
        !!i.refId && !!i.unitId && (i.qty ?? 0) > 0)
      .map((i, idx) => ({ ...i, position: idx }));
    if (!items.length) {
      this.err.set('Добавьте хотя бы одну позицию состава');
      return;
    }
    const packagings = d.packagings.map((pk) => ({
      ...(pk.id == null ? {} : { id: pk.id }),
      qtyBase: pk.qtyBase,
      minOrder: pk.minOrder,
      available: pk.available,
    }));
    if (!packagings.length) {
      this.err.set('Добавьте хотя бы одну фасовку');
      return;
    }
    if (packagings.some((pk) => !pk.qtyBase || !(pk.qtyBase > 0) || !pk.minOrder || pk.minOrder < 1)) {
      this.err.set('У фасовки укажите выход и минимальный заказ');
      return;
    }
    const weights = new Set<number>();
    for (const pk of packagings) {
      const weight = pk.qtyBase!;
      if (weights.has(weight)) {
        this.err.set('Фасовки с одинаковым выходом повторяются');
        return;
      }
      weights.add(weight);
    }
    const body = {
      name: d.name.trim(), note: d.note, portionQty: d.portionQty, portionUnitId: d.portionUnitId,
      catalogId: d.catalogId, items, packagings,
    };
    const sub = {
      next: () => {
        this.msg.set(`Техкарта «${d.name}» сохранена ✓`);
        this.reload();
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    };
    if (d.id) this.api.patchCard(d.id, body).subscribe(sub);
    else this.api.createCard(body).subscribe(sub);
  }

  /** Копия продукта как новый черновик (без сохранения) — проверьте и сохраните. */
  duplicate(): void {
    const d = this.draft();
    if (!d) return;
    const name = d.name.trim() || 'техкарта';
    this.err.set('');
    this.showPreview.set(false);
    this.preview.set([]);
    this.draft.set({
      ...d,
      id: null,
      name: `${name} (копия)`,
      items: d.items.map((i) => ({ ...i })),
      packagings: d.packagings.map((pk) => ({ ...pk, id: null })),
    });
    this.msg.set(`Копия «${name}» создана — измените название и сохраните`);
    this.buildDiagram();
    this.revealEditor();
  }

  remove(): void {
    const d = this.draft();
    if (!d?.id || !confirm(`Удалить техкарту «${d.name}»?`)) return;
    this.api.deleteCard(d.id).subscribe({
      next: () => { this.draft.set(null); this.msg.set('Техкарта удалена'); this.reload(); },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  togglePreview(): void {
    const on = !this.showPreview();
    this.showPreview.set(on);
    if (on) this.loadPreview();
  }

  loadPreview(): void {
    const d = this.draft();
    if (!d?.id) return;
    this.api.cardExpansion$(d.id, this.previewPortions || 1).subscribe({
      next: (v) => this.preview.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  // ================== блок-схема ==================
  buildDiagram(): void {
    const d = this.draft();
    if (!d) { this.diagram.set({ nodes: [], edges: [], w: 10, h: 10 }); return; }

    const NODE_H = 42, GAP = 14, HCOL = 54, W1 = 190, W2 = 210, W3 = 210, W4 = 220, X1 = 16, y0 = 14;
    const semiById = (id: number) => this.semis().find((x) => x.id === id);
    const cardById = new Map(this.list().map((c) => [c.id, c]));

    // рекурсивно собираем все достижимые полуфабрикаты, продукты-ингредиенты и листовое сырьё
    const allSemis = new Map<number, Semi>();
    const allProducts = new Map<number, TechCard>();
    const rawIds = new Set<number>();

    const visitSemi = (sid: number, path: Set<number>) => {
      if (path.has(sid)) return; // цикл
      const s = semiById(sid);
      if (!s) return;
      if (!allSemis.has(sid)) allSemis.set(sid, s);
      const npath = new Set([...path, sid]);
      for (const inp of s.inputs) {
        if (inp.sourceType === 'raw') rawIds.add(inp.refId);
        else visitSemi(inp.refId, npath);
      }
    };

    const visitProduct = (pid: number, path: Set<number>) => {
      if (path.has(pid)) return; // цикл
      const c = cardById.get(pid);
      if (!c) return;
      allProducts.set(pid, c);
      const npath = new Set([...path, pid]);
      for (const it of c.items) {
        if (it.sourceType === 'raw') rawIds.add(it.refId);
        else if (it.sourceType === 'semi') visitSemi(it.refId, new Set());
        else visitProduct(it.refId, npath);
      }
    };

    for (const it of d.items) {
      if (!it.refId) continue;
      if (it.sourceType === 'raw') rawIds.add(it.refId);
      else if (it.sourceType === 'semi') visitSemi(it.refId, new Set());
      else visitProduct(it.refId, new Set<number>(d.id ? [d.id] : []));
    }

    const rawList = [...rawIds]
      .map((id) => this.products().find((p) => p.id === id))
      .filter(Boolean) as Product[];

    // уровень (глубина) полуфабриката = 1 + max(уровней вложенных полуфабрикатов-входов)
    const levelCache = new Map<number, number>();
    const levelOf = (sid: number, guard: Set<number>): number => {
      if (levelCache.has(sid)) return levelCache.get(sid)!;
      if (guard.has(sid)) return 0;
      const s = semiById(sid);
      let lvl = 0;
      for (const inp of s?.inputs ?? []) {
        if (inp.sourceType === 'semi') lvl = Math.max(lvl, 1 + levelOf(inp.refId, new Set([...guard, sid])));
      }
      levelCache.set(sid, lvl);
      return lvl;
    };
    const semiList = [...allSemis.values()];
    const maxLevel = semiList.reduce((m, s) => Math.max(m, levelOf(s.id, new Set())), 0);

    // сырьевые подколонки
    const rowsPerCol = Math.max(1, Math.min(rawList.length || 1, Math.max(6, semiList.length)));
    const rawCols = Math.ceil((rawList.length || 1) / rowsPerCol);
    const rawBlockW = rawCols * W1 + (rawCols - 1) * HCOL;
    const X2 = X1 + rawBlockW + HCOL;
    // колонки полуфабрикатов по уровням: уровень 0 ближе к сырью
    const semiBlockW = (maxLevel + 1) * W2 + maxLevel * HCOL;
    const X3 = X2 + semiBlockW + HCOL; // продукты, входящие в состав
    const X4 = X3 + W3 + HCOL; // текущий продукт

    const nodes: DNode[] = [];
    const edges: DEdge[] = [];
    const posOf = new Map<string, DNode>();

    rawList.forEach((p, idx) => {
      const col = Math.floor(idx / rowsPerCol), row = idx % rowsPerCol;
      const n: DNode = {
        id: `r${p.id}`, label: p.name, sub: `склад · ${p.unitCode}`, cls: 'raw',
        x: X1 + col * (W1 + HCOL), y: y0 + row * (NODE_H + GAP), w: W1, h: NODE_H,
      };
      nodes.push(n); posOf.set(n.id, n);
    });

    // раскладка полуфабрикатов: в пределах уровня столбцом слева-направо
    const perLevelCount = new Map<number, number>();
    semiList.forEach((s) => {
      const lvl = levelOf(s.id, new Set());
      const row = perLevelCount.get(lvl) ?? 0;
      perLevelCount.set(lvl, row + 1);
      const first = s.inputs[0];
      const n: DNode = {
        id: `s${s.id}`, label: s.name,
        sub: s.inputs.length
          ? `партия ${trim(Number(s.outQty))} ${s.unitCode} · ${s.inputs.length} сост. · ${first?.sourceType === 'semi' ? '🟨' : '🟦'} ${first?.name ?? ''}`
          : 'без состава',
        cls: 'semi', x: X2 + lvl * (W2 + HCOL), y: y0 + row * (NODE_H + GAP), w: W2, h: NODE_H,
      };
      nodes.push(n); posOf.set(n.id, n);
    });

    // продукты-ингредиенты одной колонкой после полуфабрикатов
    let productRow = 0;
    for (const c of allProducts.values()) {
      const n: DNode = {
        id: `p${c.id}`, label: c.name,
        sub: `техкарта · выход ${trim(c.portionQty)} ${c.portionUnitCode}`,
        cls: 'card', x: X3, y: y0 + productRow * (NODE_H + GAP), w: W3, h: NODE_H,
      };
      nodes.push(n); posOf.set(n.id, n); productRow++;
    }

    // рёбра входов -> полуфабрикат (сырьё->semi и semi->semi одинаково)
    for (const s of semiList) {
      const to = posOf.get(`s${s.id}`)!;
      for (const inp of s.inputs) {
        const from = posOf.get(inp.sourceType === 'semi' ? `s${inp.refId}` : `r${inp.refId}`);
        if (!from) continue;
        // состав хранится абсолютными количествами на партию — на схеме показываем их как есть
        const inQty = trim(Number(inp.qty) || 0);
        const loss = inp.yieldPct != null && Number(inp.yieldPct) > 0 && Number(inp.yieldPct) < 100
          ? ` · −${trim(100 - Number(inp.yieldPct))}%`
          : '';
        edges.push({
          x1: from.x + from.w, y1: from.y + from.h / 2, x2: to.x, y2: to.y + to.h / 2,
          label: `${inQty} ${inp.unitCode ?? ''} на партию${loss}`,
        });
      }
    }

    // рёбра состава продукта-ингредиента -> узел продукта
    for (const c of allProducts.values()) {
      const to = posOf.get(`p${c.id}`)!;
      for (const it of c.items) {
        const from = posOf.get(this.nodeIdOf(it.sourceType, it.refId));
        if (!from) continue;
        edges.push({
          x1: from.x + from.w, y1: from.y + from.h / 2, x2: to.x, y2: to.y + to.h / 2,
          label: `${trim(it.qty)} ${it.unitCode ?? ''}`,
        });
      }
    }

    const maxSemiRows = Math.max(1, ...[...perLevelCount.values()]);
    const contentH = Math.max(rowsPerCol, maxSemiRows, allProducts.size) * (NODE_H + GAP) - GAP;

    // узел продукта
    const cardNode: DNode = {
      id: 'card', label: d.name || 'новая техкарта',
      sub: d.portionQty ? `выход ${trim(d.portionQty)} ${this.unitCode(d.portionUnitId)}` : '',
      cls: 'card', x: X4, y: y0 + contentH / 2 - NODE_H / 2, w: W4, h: NODE_H,
    };
    nodes.push(cardNode);

    // рёбра составных позиций продукта -> карточка
    for (const it of d.items) {
      if (!it.refId) continue;
      const from = posOf.get(this.nodeIdOf(it.sourceType, it.refId));
      if (!from) continue;
      edges.push({
        x1: from.x + from.w, y1: from.y + from.h / 2, x2: cardNode.x, y2: cardNode.y + cardNode.h / 2,
        label: `${trim(it.qty ?? 0)} ${this.unitCode(it.unitId)}`,
      });
    }

    const bottom = Math.max(y0 + contentH, cardNode.y + NODE_H) + 16;
    this.diagram.set({ nodes, edges, w: X4 + W4 + 16, h: bottom });
  }

  /** id узла схемы для позиции состава. */
  private nodeIdOf(sourceType: 'raw' | 'semi' | 'product', refId: number): string {
    return sourceType === 'semi' ? `s${refId}` : sourceType === 'product' ? `p${refId}` : `r${refId}`;
  }

  /** Адаптивная кривизна bezier: не больше половины горизонтального зазора, чтобы линии не петляли. */
  edgePath(e: DEdge): string {
    const bend = Math.max(18, Math.min(60, Math.abs(e.x2 - e.x1) * 0.5));
    return `M ${e.x1} ${e.y1} C ${e.x1 + bend} ${e.y1}, ${e.x2 - bend} ${e.y2}, ${e.x2} ${e.y2}`;
  }
}
