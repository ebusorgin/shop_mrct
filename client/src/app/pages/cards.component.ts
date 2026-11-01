import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { CardItem, ExpansionRow, Product, Semi, TechCard, Unit } from '../core/models';
import { fmtQty, httpErr, trim } from '../core/format';
import { Dim, dimOf, reachableDims } from '../core/units';

interface CardDraftItem {
  sourceType: 'raw' | 'semi';
  refId: number | null;
  qty: number | null;
  unitId: number | null;
}

interface CardDraft {
  id: number | null;
  name: string;
  note: string;
  portionQty: number | null;
  portionUnitId: number | null;
  items: CardDraftItem[];
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
      /* панель фильтра над списком техкарт */
      .card-filter { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 12px; }
      .cf-search { width: 100%; box-sizing: border-box; padding: 6px 10px; font-size: 13px;
        border: 1px solid #c9c9c9; border-radius: 6px; }
      .cf-search:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
      .cf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip { padding: 3px 11px; border: 1px solid #c9c9c9; border-radius: 999px; background: #f3f2f1;
        color: #242424; font-size: 12px; cursor: pointer; text-transform: capitalize; white-space: nowrap; }
      .chip:hover { border-color: var(--accent); color: #1d5c2e; }
      .chip.on { background: var(--accent); color: #fff; border-color: var(--accent); }
      /* заголовок категории — визуально отделяет группы в списке */
      .group-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: baseline; gap: 8px;
        margin: 10px 0 4px; padding: 4px 6px; border-radius: 5px; background: #e5efe6; color: #1d5c2e;
        font-weight: 700; font-size: 12px; letter-spacing: .2px; text-transform: capitalize; }
      .group-head:first-child { margin-top: 0; }
      .group-cnt { font-weight: 400; color: #5c7a63; font-size: 11px; }
      /* заголовок панели: название слева, заметная кнопка создания справа (всегда на виду, над списком) */
      .list-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 12px; }
      .list-head h3 { margin: 0; }
      .new-card { flex: 0 0 auto; white-space: nowrap; font-size: 13px; padding: 7px 14px; }
    `,
  ],
  template: `
    <h1 class="page-title">📐 Технологические карты</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid2" style="grid-template-columns: .55fr 1.45fr;">
      <!-- ===== список ===== -->
      <div class="panel" #listEl style="scroll-margin-top: 64px;">
        <div class="list-head">
          <h3>Техкарты</h3>
          <button class="btn primary new-card" (click)="newCard()">＋ Новая техкарта</button>
        </div>
        <div class="card-filter">
          <input type="search" class="cf-search" placeholder="🔍 Поиск по названию"
                 [ngModel]="q()" (ngModelChange)="q.set($event)" />
          <div class="cf-chips">
            <button class="chip" [class.on]="!cats().length" (click)="cats.set([])">Все</button>
            @for (c of categories(); track c) {
              <button class="chip" [class.on]="cats().includes(c)" (click)="toggleCat(c)">{{ c }}</button>
            }
          </div>
        </div>
        <div class="list-pick">
          @for (g of groups(); track g.name) {
            <div class="group-head">
              <span>{{ g.name ?? 'Без категории' }}</span>
              <span class="group-cnt">{{ g.cards.length }}</span>
            </div>
            @for (c of g.cards; track c.id) {
              <button [class.on]="draft()?.id === c.id" (click)="editCard(c)">
                <b>{{ c.name }}</b>
                <div class="muted" style="font-size:12px">
                  порция {{ trim(c.portionQty) }} {{ c.portionUnitCode }} · позиций {{ c.items.length }}
                </div>
              </button>
            }
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
            <label class="f" style="flex:2">Название<input [(ngModel)]="d.name" placeholder="Борщ (порция)" /></label>
            <label class="f">Размер порции<input type="number" [(ngModel)]="d.portionQty" /></label>
            <label class="f">Ед.
              <select [(ngModel)]="d.portionUnitId">
                @for (u of units(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
              </select>
            </label>
            <label class="f" style="flex:1">Примечание<input [(ngModel)]="d.note" /></label>
          </div>
          <hr class="hr" />

          <h3>Состав на порцию</h3>
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
              <select style="width:140px; min-width:0" [(ngModel)]="it.sourceType" (ngModelChange)="it.refId = null">
                <option value="raw">сырьё</option>
                <option value="semi">полуфабрикат</option>
              </select>
              <select style="flex:2 1 140px; min-width:0" [(ngModel)]="it.refId" (ngModelChange)="onPickRef(it)">
                <option [ngValue]="null">— выбрать —</option>
                @if (it.sourceType === 'raw') {
                  @for (p of products(); track p.id) { <option [ngValue]="p.id">{{ p.category }} · {{ p.name }}</option> }
                } @else {
                  @for (s of semis(); track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }
                }
              </select>
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
              <label class="f">Порций для проверки<input type="number" style="width:100px" [(ngModel)]="previewPortions" (ngModelChange)="loadPreview()" /></label>
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
          <h3>Блок-схема: сырьё → полуфабрикаты → продукция</h3>
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
          через полуфабрикаты (с учётом выхода после обработки) превращается в готовую продукцию.</p></div>
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
  draft = signal<CardDraft | null>(null);
  err = signal('');
  msg = signal('');

  showPreview = signal(false);
  previewPortions = 20;
  preview = signal<ExpansionRow[]>([]);

  diagram = signal<{ nodes: DNode[]; edges: DEdge[]; w: number; h: number }>({ nodes: [], edges: [], w: 10, h: 10 });

  /** Фильтр списка техкарт: поиск по названию и мультивыбор категорий (пусто — «Все»). */
  q = signal('');
  cats = signal<string[]>([]);

  /** Категории, реально представленные в списке, по алфавиту. */
  categories = computed(() => {
    const set = new Set<string>();
    for (const c of this.list()) if (c.category) set.add(c.category);
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
  });

  /** Список после фильтра по чипу/поиску, сгруппированный по категории; «без категории» — в конце. */
  groups = computed(() => {
    const needle = this.q().trim().toLowerCase();
    const sel = this.cats();
    const src = this.list().filter(
      (c) => (!sel.length || (c.category != null && sel.includes(c.category))) && (!needle || c.name.toLowerCase().includes(needle))
    );
    const map = new Map<string | null, TechCard[]>();
    for (const c of src) {
      const arr = map.get(c.category);
      if (arr) arr.push(c);
      else map.set(c.category, [c]);
    }
    const out = [...map.entries()].map(([name, cards]) => ({
      name,
      cards: cards.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    }));
    out.sort((a, b) => {
      if (a.name === null) return b.name === null ? 0 : 1;
      if (b.name === null) return -1;
      return a.name.localeCompare(b.name, 'ru');
    });
    return out;
  });

  /** Переключить категорию в мультивыборе: повторно нажатая — снимается. */
  toggleCat(c: string): void {
    this.cats.update((sel) => (sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c]));
  }

  trim = trim;
  fmtQty = fmtQty;

  ngOnInit(): void {
    this.reload();
    this.api.semis$().subscribe((s) => this.semis.set(s));
    this.api.products$({ active: 'true' }).subscribe((p) => this.products.set(p));
    this.api.units$().subscribe((u) => this.units.set(u));
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

  /**
   * Единицы для позиции состава: и для сырья, и для полуфабриката — только размерности,
   * достижимые из каноничной единицы по коэффициентам пересчёта (g_per_pcs/ml_per_pcs/g_per_ml).
   * Уже выбранная единица остаётся в списке, чтобы select не «слетал».
   */
  itemUnits(it: CardDraftItem): Unit[] {
    const all = this.units();
    if (!it.refId) return all;
    const ref =
      it.sourceType === 'raw'
        ? this.products().find((x) => x.id === it.refId)
        : this.semis().find((x) => x.id === it.refId);
    if (!ref) return all;
    const from =
      it.sourceType === 'raw'
        ? (ref as Product).dimension
        : dimOf(all, (ref as Semi).unitId);
    if (!from) return all;
    const conv = { gPerPcs: ref.gPerPcs, mlPerPcs: ref.mlPerPcs, gPerMl: ref.gPerMl };
    const dims = reachableDims(from as Dim, conv);
    const list = all.filter((u) => dims.has(u.dimension));
    if (it.unitId && !list.some((u) => u.id === it.unitId)) {
      const cur = all.find((u) => u.id === it.unitId);
      if (cur) list.push(cur);
    }
    return list;
  }

  /** При выборе сырья/полуфабриката: если текущая единица недоступна — ставим базовую в каноничной размерности. */
  onPickRef(it: CardDraftItem): void {
    if (!it.refId) return;
    const allowed = this.itemUnits(it);
    if (it.unitId && allowed.some((u) => u.id === it.unitId)) return;
    const from =
      it.sourceType === 'raw'
        ? this.products().find((x) => x.id === it.refId)?.dimension
        : dimOf(this.units(), this.semis().find((x) => x.id === it.refId)?.unitId);
    const base = allowed.find((u) => u.dimension === from && u.baseFactor === 1);
    it.unitId = base?.id ?? allowed[0]?.id ?? null;
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
    this.draft.set({
      id: null, name: '', note: '', portionQty: 400,
      portionUnitId: this.units().find((u) => u.code === 'г')?.id ?? null,
      items: [],
    });
    this.buildDiagram();
    this.revealEditor();
  }

  editCard(c: TechCard): void {
    this.msg.set('');
    this.showPreview.set(false);
    this.preview.set([]);
    this.draft.set({
      id: c.id, name: c.name, note: c.note,
      portionQty: c.portionQty, portionUnitId: c.portionUnitId,
      items: c.items.map((i) => ({ sourceType: i.sourceType, refId: i.refId, qty: i.qty, unitId: i.unitId })),
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
    d.items.push({ sourceType: 'raw', refId: null, qty: null, unitId: this.units().find((u) => u.code === 'г')?.id ?? null });
    this.draft.set({ ...d });
    this.buildDiagram();
  }

  save(): void {
    const d = this.draft();
    if (!d) return;
    this.err.set('');
    if (!d.name.trim() || !d.portionQty || !d.portionUnitId) {
      this.err.set('Заполните название и размер порции');
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
    const body = { name: d.name.trim(), note: d.note, portionQty: d.portionQty, portionUnitId: d.portionUnitId, items };
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

    const NODE_H = 42, GAP = 14, HCOL = 54, W1 = 190, W2 = 210, W3 = 220, X1 = 16, y0 = 14;
    const semiById = (id: number | null) => (id == null ? undefined : this.semis().find((x) => x.id === id));

    // рекурсивно собираем ВСЕ достижимые полуфабрикаты (включая вложенные) и листовое сырьё
    const allSemis = new Map<number, Semi>();
    const rawIds = new Set<number>();
    for (const i of d.items) if (i.sourceType === 'raw' && i.refId) rawIds.add(i.refId);

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
    for (const it of d.items) if (it.sourceType === 'semi' && it.refId) visitSemi(it.refId, new Set());

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
    // колонки полуфабрикатов по уровням: уровень 0 ближе к сырьём
    const semiBlockW = (maxLevel + 1) * W2 + maxLevel * HCOL;
    const X3 = X2 + semiBlockW + HCOL;

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

    const maxSemiRows = Math.max(1, ...[...perLevelCount.values()]);
    const contentH = Math.max(rowsPerCol, maxSemiRows) * (NODE_H + GAP) - GAP;

    // узел техкарты
    const cardNode: DNode = {
      id: 'card', label: d.name || 'новая техкарта',
      sub: d.portionQty ? `порция ${trim(d.portionQty)} ${this.unitCode(d.portionUnitId)}` : '',
      cls: 'card', x: X3, y: y0 + contentH / 2 - NODE_H / 2, w: W3, h: NODE_H,
    };
    nodes.push(cardNode);

    // рёбра составных позиций техкарты -> карточка
    for (const it of d.items) {
      if (!it.refId) continue;
      const from = posOf.get(it.sourceType === 'semi' ? `s${it.refId}` : `r${it.refId}`);
      if (!from) continue;
      edges.push({
        x1: from.x + from.w, y1: from.y + from.h / 2, x2: cardNode.x, y2: cardNode.y + cardNode.h / 2,
        label: `${trim(it.qty ?? 0)} ${this.unitCode(it.unitId)}`,
      });
    }

    const bottom = Math.max(y0 + contentH, cardNode.y + NODE_H) + 16;
    this.diagram.set({ nodes, edges, w: X3 + W3 + 16, h: bottom });
  }

  /** Адаптивная кривизна bezier: не больше половины горизонтального зазора, чтобы линии не петляли. */
  edgePath(e: DEdge): string {
    const bend = Math.max(18, Math.min(60, Math.abs(e.x2 - e.x1) * 0.5));
    return `M ${e.x1} ${e.y1} C ${e.x1 + bend} ${e.y1}, ${e.x2 - bend} ${e.y2}, ${e.x2} ${e.y2}`;
  }
}
