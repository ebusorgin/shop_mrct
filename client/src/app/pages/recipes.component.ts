import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Recipe, RecipesData } from '../core/models';
import { fmtDateTime, fmtMoney, fmtQty, httpErr } from '../core/format';
import { currencySymbol } from '../core/currency';
import { SearchSelectComponent, SearchOption } from '../shared/search-select.component';
import { HintDirective } from '../shared/hint.directive';

const RECENT_KEY = 'recipes.recent';

interface RecipeRow extends Recipe {
  kind: 'output' | 'state';
}

interface NodeDraft {
  key: number;
  kind: 'material' | 'product';
  materialId: number | null;
  subProductId: number | null;
  qty: number;
  lossPct: number;
}

interface SkuDraft {
  key: number;
  id: number | null;
  name: string;
  qtyBase: number;
  priceBasis: 'unit' | 'portion';
  price: number;
  costPrice: number;
  isActive: boolean;
  archived: boolean;
  usedInOrders: number;
  packageIds: number[];
}

interface RecipeDraft {
  name: string;
  nameEn: string;
  nameSr: string;
  catalogId: number | null;
  unitId: number | null;
  portionQty: number;
  description: string;
  nodes: NodeDraft[];
  skus: SkuDraft[];
}

interface RecipeGroup {
  key: string;
  title: string;
  icon: string;
  color: string;
  items: RecipeRow[];
}

type Dim = 'mass' | 'volume' | 'count';
type Conv = { gPerPcs: number | null; mlPerPcs: number | null; gPerMl: number | null };

let draftKey = 1;
const nextKey = (): number => draftKey++;

/**
 * Раздел «Рецептуры»: блюда и заготовки на одном экране.
 * Вёрстка прежняя (вкладки, список по каталогам, карточка-редактор справа),
 * данные — из новой модели products / product_nodes / product_skus.
 * Выбор рецептуры сразу открывает форму; «Сохранить» пишет одной транзакцией.
 */
@Component({
  selector: 'app-recipes',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchSelectComponent, HintDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .page-head { display: flex; align-items: flex-start; gap: 12px 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .page-head .page-title { margin: 0; }
    .recent-box { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
    .recent-label { margin-right: 2px; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .recent-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 230px; border: 1px solid var(--border); border-radius: 999px;
                   background: #fff; padding: 4px 10px; font: inherit; font-size: 12px; color: var(--ink); cursor: pointer; }
    .recent-chip:hover { border-color: #c3d5e6; background: #f6fafd; }
    .recent-chip.on { border-color: var(--brand-blue); background: #eef7fd; }
    .rc-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .recent-chip small { font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
    @media (max-width: 900px) { .recent-box { margin-left: 0; } }

    .recipes-grid { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 14px; align-items: start; }
    .recipes-grid > * { min-width: 0; }
    .recipes-grid.embedded { display: block; }
    @media (max-width: 900px) { .recipes-grid { grid-template-columns: 1fr; } }

    .editor-modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(10, 18, 32, .5); }
    .panel.editor-modal { position: fixed; z-index: 61; top: 3vh; left: 50%; transform: translateX(-50%);
      width: min(1180px, calc(100vw - 24px)); max-height: 94vh; overflow: auto; margin: 0; box-shadow: 0 18px 60px rgba(10, 18, 32, .35); }
    .editor-modal-top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 10px;
      margin: -16px -16px 14px; padding: 10px 14px; background: #f7f5ef; border-bottom: 1px solid var(--border);
      border-radius: var(--radius) var(--radius) 0 0; }
    .editor-modal-top span { font-size: 12px; font-weight: 700; color: #6b5a33; letter-spacing: .03em; }
    .em-x { border: 1px solid var(--border); background: #fff; color: var(--muted); width: 30px; height: 30px; border-radius: 8px;
            cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }
    .em-x:hover { color: var(--ink); border-color: #c3d5e6; background: #f4f8fb; }

    .side { position: sticky; top: 12px; max-height: calc(100vh - 24px); display: flex; flex-direction: column; padding: 12px 12px 6px; }
    .side-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    .side-tab { border: 1px solid var(--border); background: #fff; color: var(--muted); border-radius: 10px; padding: 8px 10px;
                font: inherit; font-weight: 700; font-size: 13px; cursor: pointer; transition: background-color .15s, border-color .15s; }
    .side-tab:hover { border-color: #b9d3e8; background: #f7fbfe; }
    .side-tab.on { background: var(--brand-blue); border-color: var(--brand-blue); color: #fff; }
    .side-tab.output.on { background: #dff2e7; border-color: #9fcfb6; color: #1f5c42; }
    .side-tab.state.on { background: #f1ece1; border-color: #d6c6a5; color: #6f5330; }
    .side-tab small { display: block; margin-top: 2px; font-size: 10px; font-weight: 600; opacity: .8; }

    .side-search { position: relative; margin-bottom: 8px; }
    .side-search input { width: 100%; padding: 8px 28px 8px 10px; font-size: 13px; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
    .side-search input:focus { outline: none; border-color: var(--brand-blue); }
    .side-search button { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); border: 0; background: transparent;
                          color: var(--muted); cursor: pointer; font-size: 11px; }
    .side-select { width: 100%; margin-bottom: 8px; padding: 7px 9px; font-size: 12.5px; border: 1px solid var(--border);
                   border-radius: 8px; background: #fff; color: var(--ink); }
    .side-select:focus { outline: none; border-color: var(--brand-blue); }
    .side-on-sale { display: flex; align-items: center; gap: 7px; margin: 0 0 8px; font-size: 12.5px; color: var(--muted);
                    cursor: pointer; user-select: none; }
    .side-on-sale input { width: 15px; height: 15px; accent-color: var(--brand-blue); cursor: pointer; }
    .side-on-sale b { color: var(--ink); font-weight: 600; }

    .side-list { overflow: auto; min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 9px; padding-right: 2px; }
    .list-group { display: flex; flex-direction: column; gap: 6px; }
    .lg-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; padding: 5px 9px;
               border: 1px solid #e7e1d5; border-left: 4px solid #cfc6b5; border-radius: 7px; background: #f7f5ef;
               font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: #5d5648; }
    .lg-count { margin-left: auto; font-size: 10px; font-weight: 800; color: var(--muted); background: #fff;
                border: 1px solid #e4dccd; border-radius: 999px; padding: 1px 7px; }
    .recipe-item { width: 100%; text-align: left; border: 1px solid var(--border); background: #fff; border-radius: 9px;
                   padding: 8px 11px; cursor: pointer; font: inherit; color: var(--ink);
                   transition: border-color .15s, background-color .15s, box-shadow .15s; }
    .recipe-item:hover { background: #f8fafc; border-color: #c3d5e6; }
    .recipe-item.on { border-color: var(--brand-blue); background: #f2f8fc; box-shadow: inset 3px 0 0 var(--brand-blue); }
    .ri-name { display: block; font-size: 13.5px; font-weight: 700; line-height: 1.25; }
    .ri-meta { display: flex; flex-wrap: wrap; gap: 3px 9px; margin-top: 5px; font-size: 11px; color: var(--muted); }
    .ri-meta span + span::before { content: '·'; margin-right: 6px; color: #c2ccd6; }

    .editor-pane { padding: 18px 20px 22px; }
    .editor-head { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    .editor-title { margin: 0; font-size: 20px; line-height: 1.25; letter-spacing: -.01em; }
    .editor-sub { margin-top: 6px; display: flex; gap: 6px 10px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--muted); }
    .editor-sub span.dot + span.dot::before { content: '·'; margin-right: 8px; color: #c2ccd6; }
    .kind-chip { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .kind-chip.state { background: #f1ece1; color: #7a5b2e; }
    .kind-chip.output { background: #dff2e7; color: #236b4c; }
    .cat-chip { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #21301f; }
    .editor-actions { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .editor-actions .btn { height: 32px; padding: 0 12px; }
    .dirty-note { margin-right: 4px; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .dirty-note.on { color: #8a6a1f; font-weight: 700; }

    .edit-top { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 16px; align-items: start; margin: 14px 0 4px; }
    @media (max-width: 760px) { .edit-top { grid-template-columns: 1fr; } }
    .edit-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 9px 12px; margin: 0; }
    .edit-fields .f { min-width: 0; }
    .edit-fields .f.full { grid-column: 1 / -1; }
    .edit-fields input, .edit-fields select, .edit-fields textarea { width: 100%; }
    .edit-fields textarea { resize: vertical; min-height: 48px; }
    .sum-card { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 14px 16px; border-radius: 12px;
                border: 1px solid #e4dccb; background: #faf7ef; }
    .sum-main { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .sum-output { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .sum-output .f { min-width: 0; }
    .sum-output input, .sum-output select { width: 100%; }
    .sum-label { font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #7a6a4a; }
    .sum-value { font-size: 26px; font-weight: 800; line-height: 1; color: var(--ink); font-variant-numeric: tabular-nums; }
    .sum-status { font-size: 12px; font-weight: 600; line-height: 1.4; color: #8a6a1f; }
    .sum-card.ok { background: #f0faf3; border-color: #bcdcc9; }
    .sum-card.ok .sum-status { color: #236b4c; }
    .sum-card.mismatch { background: #fff6e3; border-color: #efd39b; }
    .sum-card.mismatch .sum-value { color: #a8551b; }
    .sum-card.partial { background: #f4f2ee; border-color: #d9d3c7; }
    .sum-card.partial .sum-status { color: var(--muted); }
    .unit-code { margin-left: 4px; font-size: 12px; color: var(--muted); }

    .sec-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 20px 0 10px; }
    .sec-head h3 { margin: 0; font-size: 15px; display: flex; align-items: center; gap: 2px; }
    .sec-head h3 small { margin-left: 6px; font-size: 11px; font-weight: 600; color: var(--muted); }
    .btn.add { border-style: dashed; color: var(--brand-blue); background: #fff; }
    .btn.add:hover { border-color: var(--brand-blue); background: #f2f8fc; }
    .hint { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 5px;
            border: 0; border-radius: 50%; background: #e9e3d6; color: #6f6048; font-size: 10px; font-weight: 800;
            line-height: 1; padding: 0; cursor: help; vertical-align: middle; }
    .hint:hover, .hint:focus { background: #dcd2bf; outline: none; }
    .num { text-align: right; white-space: nowrap; }
    .table-wrap { overflow-x: auto; }
    .comp-table, .pack-table { margin: 0; }
    .comp-table { min-width: 660px; table-layout: fixed; }
    .comp-table th:nth-child(1) { width: 128px; }
    .comp-table th:nth-child(3) { width: 112px; }
    .comp-table th:nth-child(4) { width: 54px; text-align: center; }
    .comp-table th:nth-child(5) { width: 100px; }
    .comp-table th:nth-child(6) { width: 38px; }
    .pack-table { min-width: 780px; }
    .pack-table th:nth-child(1) { width: 170px; }
    .pack-table th:nth-child(2) { width: 110px; }
    .comp-table input, .comp-table select,
    .pack-table input, .pack-table select {
      width: 100%; height: 32px; padding: 4px 8px; font-size: 13px;
    }
    .comp-table .num input, .pack-table .num input { text-align: right; }
    .comp-table .type-select { width: 100%; }
    .unit-col { text-align: center; color: var(--muted); font-size: 12px; }
    .tare-cell { min-width: 150px; }
    .tare-select { width: 32px; min-width: 32px; padding: 2px; height: 26px; font-size: 13px; color: #1f8f4e;
                   border: 1px dashed var(--border); border-radius: 6px; background: #fff; cursor: pointer; }
    .tare-select:hover { border-color: #9fcfb6; background: #f4fbf6; }
    .icon-btn { border: 1px solid var(--border); background: #fff; color: var(--muted); width: 26px; height: 26px;
                border-radius: 7px; cursor: pointer; font-size: 11px; line-height: 1; padding: 0; }
    .icon-btn:hover { color: var(--red); border-color: #e5b4b4; background: #fdf4f4; }
    .icon-btn.danger { color: #c0392b; border-color: #e5b4b4; }
    .icon-btn:disabled { opacity: .4; cursor: not-allowed; }
    .used-note { margin-top: 2px; font-size: 9.5px; color: var(--muted); white-space: nowrap; }
    .sku-archive { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 8px; }
    .sku-archive summary { cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--muted); user-select: none; }
    .sku-archive summary:hover { color: var(--ink); }
    .archive-table { margin-top: 8px; }
    .archive-table td { color: var(--muted); }
    .pills { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
    .chip-x { border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 10px; padding: 0 0 0 2px; }
    .chip-x:hover { color: var(--red); }
    .empty-state { padding: 22px; text-align: center; color: var(--muted); font-size: 13px;
                   border: 1px dashed var(--border); border-radius: 10px; background: #fbfcfd; }
    .empty-state.placeholder { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 64px 24px;
                               border: 0; background: transparent; }
    .ph-icon { font-size: 42px; line-height: 1; opacity: .55; }
    .placeholder b { font-size: 16px; color: var(--ink); }
    .placeholder span { max-width: 390px; font-size: 12.5px; line-height: 1.5; }
    .pill.on { background: #e6f6ec; color: #1f8f4e; }
    .pill.off { background: #eef1f5; color: var(--muted); }

    @media (max-width: 1100px) { .recipes-grid { grid-template-columns: 300px minmax(0, 1fr); } }
    @media (max-width: 900px) {
      .recipes-grid { grid-template-columns: 1fr; }
      .side { position: static; max-height: none; }
      .side-list { max-height: 320px; }
    }
  `],
  template: `
    @if (!embedded()) {
      <div class="page-head">
        <h1 class="page-title">📖 Рецептуры</h1>
        @if (recentRecipes().length) {
          <div class="recent-box">
            <span class="recent-label">Недавние</span>
            @for (r of recentRecipes(); track r.id) {
              <button type="button" class="recent-chip" [class.on]="selectedId() === r.id" (click)="select(r.id)"
                      [title]="r.name + ' · ' + (r.kind === 'state' ? 'заготовка' : 'блюдо')">
                <span class="rc-name">{{ r.name }}</span>
                <small>{{ r.kind === 'state' ? 'заготовка' : 'блюдо' }}</small>
              </button>
            }
          </div>
        }
      </div>
      @if (err()) { <div class="err">{{ err() }}</div> }
      @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }
    }

    @if (embedded()) { <div class="editor-modal-backdrop" (click)="close()"></div> }

    <div class="recipes-grid" [class.embedded]="embedded()">
      @if (!embedded()) {
        <section class="panel side">
          <div class="side-tabs">
            <button type="button" class="side-tab output" [class.on]="tab() === 'output'" (click)="setTab('output')">
              Блюдо <small>{{ countOf('output') }}</small>
            </button>
            <button type="button" class="side-tab state" [class.on]="tab() === 'state'" (click)="setTab('state')">
              Заготовки <small>{{ countOf('state') }}</small>
            </button>
          </div>

          <div class="side-search">
            <input [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Поиск по названию…" />
            @if (query()) { <button type="button" (click)="query.set('')" title="Очистить">✕</button> }
          </div>

          <label class="side-on-sale" title="Показывать только рецепты, участвующие в продаже">
            <input type="checkbox" [ngModel]="onSaleOnly()" (ngModelChange)="setOnSaleOnly($event)" />
            <span><b>в продаже</b></span>
          </label>

          @if (tab() === 'output') {
            <select class="side-select" [ngModel]="catalogFilter()" (ngModelChange)="catalogFilter.set($event)" title="Фильтр по каталогу">
              <option value="">Все каталоги</option>
              @for (c of dishCatalogs(); track c.id) {
                <option [value]="c.id.toString()">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
              }
            </select>
          }

          <div class="side-list">
            @if (loading()) {
              <p class="muted" style="padding:10px">Загрузка…</p>
            } @else {
              @for (g of groups(); track g.key) {
                <div class="list-group">
                  <div class="lg-head" [style.border-left-color]="g.color || '#cfc6b5'">
                    <span>{{ g.icon ? g.icon + ' ' : '' }}{{ g.title }}</span>
                    <span class="lg-count">{{ g.items.length }}</span>
                  </div>
                  @for (r of g.items; track r.id) {
                    <button type="button" class="recipe-item" [class.on]="selectedId() === r.id" (click)="select(r.id)">
                      <span class="ri-name">{{ r.name }}</span>
                      <span class="ri-meta">
                        <span>{{ r.kind === 'state' ? 'заготовка' : 'блюдо' }}</span>
                        <span>состав {{ r.nodes.length }}</span>
                        <span>фасовок {{ openSkuCount(r) }}</span>
                      </span>
                    </button>
                  }
                </div>
              } @empty {
                <p class="muted" style="padding:10px">Ничего не найдено</p>
              }
            }
          </div>
        </section>
      }

      <section class="panel editor-pane" [class.editor-modal]="embedded()">
        @if (embedded()) {
          <div class="editor-modal-top">
            <span>✎ Редактирование рецептуры</span>
            <button type="button" class="em-x" (click)="close()" aria-label="Закрыть">✕</button>
          </div>
        }
        @if (loading()) {
          <p class="muted">Загрузка рецептуры…</p>
        } @else {
          @if (draft(); as d) {
            <div class="editor-head">
              <div>
                <h2 class="editor-title">{{ d.name || selected()?.name || 'Без названия' }}</h2>
                <div class="editor-sub">
                  <span class="kind-chip" [class.state]="draftKind() === 'state'" [class.output]="draftKind() === 'output'">
                    {{ draftKind() === 'state' ? 'заготовка' : 'блюдо' }}
                  </span>
                  @if (catalogOf(d.catalogId); as cat) {
                    <span class="cat-chip" [style.background]="cat.color || '#eef2f5'">{{ cat.icon ? cat.icon + ' ' : '' }}{{ cat.name }}</span>
                  }
                  @if (selected(); as r) {
                    <span class="dot">ID {{ r.id }}</span>
                    <span class="dot">создана {{ date(r.createdAt) }}</span>
                  }
                </div>
              </div>
              <div class="editor-actions">
                <span class="dirty-note" [class.on]="dirty()">{{ dirty() ? '● несохранённые изменения' : 'изменений нет' }}</span>
                <button type="button" class="btn primary" [disabled]="saving() || !dirty()" (click)="save()">
                  {{ saving() ? 'Сохраняю…' : '💾 Сохранить' }}
                </button>
                <button type="button" class="btn" [disabled]="saving() || !dirty()" (click)="cancel()">Отмена</button>
              </div>
            </div>

            <div class="edit-top">
              <div class="edit-fields">
                <label class="f full">Название (RU) *
                  <input [ngModel]="d.name" (ngModelChange)="setField({ name: $event })" placeholder="Название рецептуры" />
                </label>
                <label class="f">Название (EN)
                  <input [ngModel]="d.nameEn" (ngModelChange)="setField({ nameEn: $event })" placeholder="optional" />
                </label>
                <label class="f">Название (SR)
                  <input [ngModel]="d.nameSr" (ngModelChange)="setField({ nameSr: $event })" placeholder="opciono" />
                </label>
                <label class="f">Каталог
                  <select [ngModel]="d.catalogId" (ngModelChange)="setCatalog($event)">
                    <option [ngValue]="null">— без каталога —</option>
                    @for (c of data()?.catalogs ?? []; track c.id) {
                      <option [ngValue]="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
                    }
                  </select>
                </label>
                <label class="f full">Описание
                  <textarea rows="2" [ngModel]="d.description" (ngModelChange)="setField({ description: $event })"
                            placeholder="необязательно"></textarea>
                </label>
              </div>

              <div class="sum-card"
                   [class.ok]="sumClass() === 'ok'"
                   [class.mismatch]="sumClass() === 'mismatch'"
                   [class.partial]="sumClass() === 'partial'">
                <div class="sum-main">
                  <span class="sum-label">Σ ингредиентов</span>
                  <b class="sum-value">
                    @if (ingredientSum(); as s) {
                      {{ qtyFmt(s.value, s.unitCode) }}
                    } @else {
                      —
                    }
                  </b>
                </div>
                <div class="sum-output">
                  <label class="f">Выход *
                    <input type="number" min="0" step="any" [ngModel]="d.portionQty"
                           (ngModelChange)="setField({ portionQty: num($event) })" />
                  </label>
                  <label class="f">Единица
                    <select [ngModel]="d.unitId" (ngModelChange)="setUnit($event)">
                      @for (u of data()?.units ?? []; track u.id) {
                        <option [ngValue]="u.id">{{ u.code }} — {{ u.name }}</option>
                      }
                    </select>
                  </label>
                </div>
                <div class="sum-status">{{ sumStatus() }}</div>
              </div>
            </div>

            <div class="sec-head">
              <h3>
                Состав <small>{{ d.nodes.length }}</small>
                <button type="button" class="hint" aria-label="Как заполняется состав" hintTitle="Состав рецептуры"
                        [appHint]="'Каждая строка — сырьё (склад) или вложенная рецептура. Количество указывается в единице компонента, потери 0–100 % увеличивают расход (уварка, очистка).'">?</button>
              </h3>
              <button type="button" class="btn add" (click)="addNode()">＋ Добавить компонент</button>
            </div>
            @if (d.nodes.length) {
              <div class="table-wrap">
              <table class="tbl comp-table">
                <thead>
                  <tr>
                    <th>Тип</th>
                    <th style="width:38%">Компонент</th>
                    <th class="num">Количество</th>
                    <th>Ед.</th>
                    <th class="num">Потери %</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (n of d.nodes; track n.key; let i = $index) {
                    <tr>
                      <td>
                        <select class="type-select" [ngModel]="nodeKind(n)" (ngModelChange)="setNodeKind(i, $event)">
                          <option value="material">сырьё</option>
                          <option value="product">рецептура</option>
                        </select>
                      </td>
                      <td>
                        <app-search-select
                          [options]="nodeOptions(n)"
                          [value]="nodeValue(n)"
                          (valueChange)="setNodeComponent(i, $event)"
                          placeholder="— выберите компонент —"
                        />
                      </td>
                      <td class="num">
                        <input type="number" min="0" step="any" [ngModel]="n.qty"
                               (ngModelChange)="setNode(i, { qty: num($event) })" />
                      </td>
                      <td class="unit-col">{{ nodeUnit(n) }}</td>
                      <td class="num">
                        <input type="number" min="0" max="100" step="any" [ngModel]="n.lossPct"
                               (ngModelChange)="setNode(i, { lossPct: num($event) })" />
                      </td>
                      <td><button type="button" class="icon-btn" title="Удалить компонент" (click)="removeNode(i)">✕</button></td>
                    </tr>
                  }
                </tbody>
              </table>
              </div>
            } @else {
              <div class="empty-state">Состав пока не заполнен.</div>
            }

            <div class="sec-head">
              <h3>
                Фасовки и цены <small>{{ visibleSkus().length }}</small>
                <button type="button" class="hint" aria-label="Как заполняются фасовки" hintTitle="Фасовки (SKU)"
                        [appHint]="'Вариант продажи рецептуры: размер фасовки, цена и её база, себестоимость и тара. Наличие хотя бы одной фасовки делает рецептуру блюдом.'">?</button>
              </h3>
              <button type="button" class="btn add" (click)="addSku()">＋ Добавить фасовку</button>
            </div>
            @if (visibleSkus().length) {
              <div class="table-wrap">
              <table class="tbl pack-table">
                <thead>
                  <tr>
                    <th>
                      Тара
                      <button type="button" class="hint" aria-label="Что такое тара" hintTitle="Тара"
                              [appHint]="'Упаковки, в которые фасуется продукт: банка, крышка, контейнер. На одну фасовку можно добавить несколько позиций без повторов.'">?</button>
                    </th>
                    <th class="num">
                      Выход, {{ draftUnitCode() }}
                      <button type="button" class="hint" aria-label="Что значит выход фасовки" hintTitle="Выход фасовки"
                              [appHint]="'Вес, объём или количество одной упаковки в единице рецептуры. По нему пересчитываются заказы и печатный отчёт.'">?</button>
                    </th>
                    <th class="num">
                      Цена, {{ currency() }}
                      <button type="button" class="hint" aria-label="Как указывается цена" hintTitle="Цена продажи"
                              [appHint]="'Цена в валюте CRM за базу, выбранную в колонке «Цена за».'">?</button>
                    </th>
                    <th>
                      Цена за
                      <button type="button" class="hint" aria-label="База цены" hintTitle="База цены"
                              [appHint]="'За что указана цена: за единицу рецептуры, за упаковку (порцию) или за штуку. От этого зависит сумма в отчёте.'">?</button>
                    </th>
                    <th class="num">
                      Себест., {{ currency() }}
                      <button type="button" class="hint" aria-label="Что такое себестоимость" hintTitle="Себестоимость"
                              [appHint]="'Внутренняя стоимость за ту же базу, что и цена. Используется в отчёте «по себестоимости» и не показывается магазинам.'">?</button>
                    </th>
                    <th>
                      В доставке
                      <button type="button" class="hint" aria-label="Что значит «В доставке»" hintTitle="Доступна магазинам"
                              [appHint]="'Разрешает заказывать эту фасовку. В каталог заказов попадают только включённые фасовки.'">?</button>
                    </th>
                    <th style="width:42px"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of d.skus; track s.key; let i = $index) {
                    @if (!s.archived) {
                    <tr>
                      <td class="tare-cell">
                        <span class="pills">
                          @for (pid of s.packageIds; track pid) {
                            <span class="pill gray">{{ packageName(pid) }}<button type="button" class="chip-x" title="Убрать тару" (click)="removePackage(i, pid)">✕</button></span>
                          }
                        </span>
                        @if (packagesRemaining(s).length) {
                          <select class="tare-select" title="Добавить тару" (change)="addPackageFrom(i, $event)">
                            <option value="">＋</option>
                            @for (p of packagesRemaining(s); track p.id) {
                              <option [value]="p.id">{{ p.name }}</option>
                            }
                          </select>
                        }
                      </td>
                      <td class="num">
                        <input type="number" min="0" step="any" [ngModel]="s.qtyBase"
                               (ngModelChange)="setSku(i, { qtyBase: num($event) })" />
                      </td>
                      <td class="num">
                        <input type="number" min="0" step="any" [ngModel]="s.price"
                               (ngModelChange)="setSku(i, { price: num($event) })" />
                      </td>
                      <td>
                        <select [ngModel]="s.priceBasis" (ngModelChange)="setSkuBasis(i, $event)">
                          <option value="unit">за {{ draftUnitCode() }}</option>
                          <option value="portion">за упаковку</option>
                        </select>
                      </td>
                      <td class="num">
                        <input type="number" min="0" step="any" [ngModel]="s.costPrice"
                               (ngModelChange)="setSku(i, { costPrice: num($event) })" />
                      </td>
                      <td style="text-align:center">
                        <input type="checkbox" [ngModel]="s.isActive" (ngModelChange)="setSku(i, { isActive: $event })" />
                        @if (s.usedInOrders > 0) { <div class="used-note">в заказах: {{ s.usedInOrders }}</div> }
                      </td>
                      <td style="text-align:right">
                        <button type="button" class="icon-btn danger" title="Убрать фасовку в архив" (click)="removeSku(i)">✕</button>
                      </td>
                    </tr>
                    }
                  }
                </tbody>
              </table>
              </div>
            } @else {
              <div class="empty-state">Фасовок нет — добавьте вариант, и рецептура станет блюдом.</div>
            }
            @if (archivedSkus().length) {
              <details class="sku-archive">
                <summary>Архив фасовок ({{ archivedSkus().length }})</summary>
                <div class="table-wrap">
                  <table class="tbl pack-table archive-table">
                    <thead>
                      <tr>
                        <th>Вариант</th>
                        <th class="num">Выход, {{ draftUnitCode() }}</th>
                        <th class="num">Цена</th>
                        <th class="num">Себест.</th>
                        <th class="num">Заказы</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (s of archivedSkus(); track s.key) {
                        <tr>
                          <td>{{ s.name || '—' }}</td>
                          <td class="num">{{ s.qtyBase }}</td>
                          <td class="num">{{ money(s.price) }}</td>
                          <td class="num">{{ money(s.costPrice) }}</td>
                          <td class="num">{{ s.usedInOrders || '—' }}</td>
                          <td style="text-align:right">
                            <button type="button" class="btn" (click)="restoreSku(s.key)">Вернуть</button>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </details>
            }
          } @else {
            <div class="empty-state placeholder">
              <div class="ph-icon">📖</div>
              <b>Выберите рецептуру</b>
              <span>Слева — блюда и заготовки по каталогам. Карточка откроется сразу в режиме редактирования.</span>
            </div>
          }
        }
      </section>
    </div>
  `,
})
export class RecipesComponent implements OnInit {
  private readonly api = inject(ApiService);

  /** Встроенное окно с отчёта-отгрузки: показать одну рецептуру поверх страницы. */
  readonly embedded = input(false);
  readonly embedNodeId = input<number | null>(null);
  readonly editorClosed = output<void>();

  readonly data = signal<RecipesData | null>(null);
  readonly loading = signal(true);
  readonly err = signal('');
  readonly msg = signal('');
  readonly saving = signal(false);
  readonly query = signal('');
  readonly catalogFilter = signal('');
  readonly onSaleOnly = signal(true);
  readonly tab = signal<'output' | 'state'>('output');
  readonly selectedId = signal<number | null>(null);
  readonly recent = signal<number[]>([]);
  readonly draft = signal<RecipeDraft | null>(null);
  private readonly baseline = signal('');

  readonly date = fmtDateTime;
  readonly qtyFmt = fmtQty;
  readonly money = fmtMoney;
  readonly currency = currencySymbol;

  readonly rows = computed<RecipeRow[]>(() =>
    (this.data()?.recipes ?? []).map((r) => ({
      ...r,
      kind: r.skus.some((s) => !s.archived) ? 'output' : 'state',
    }))
  );

  readonly filtered = computed<RecipeRow[]>(() => {
    const tab = this.tab();
    const q = this.query().trim().toLowerCase();
    const cat = this.catalogFilter();
    return this.rows().filter((r) => {
      if (r.kind !== tab) return false;
      if (q && ![r.name, r.nameEn, r.nameSr].some((n) => n.toLowerCase().includes(q))) return false;
      if (tab === 'output') {
        if (cat && String(r.catalogId ?? '') !== cat) return false;
        if (this.onSaleOnly() && !r.skus.some((s) => !s.archived && s.isActive)) return false;
      }
      return true;
    });
  });

  readonly groups = computed<RecipeGroup[]>(() => {
    const items = this.filtered();
    const d = this.data();
    const order = (d?.catalogs ?? []).map((c) => c.id);
    const map = new Map<number | null, RecipeRow[]>();
    for (const r of items) {
      const list = map.get(r.catalogId) ?? [];
      list.push(r);
      map.set(r.catalogId, list);
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ia = a == null ? 9999 : order.indexOf(a);
      const ib = b == null ? 9999 : order.indexOf(b);
      return (ia < 0 ? 9998 : ia) - (ib < 0 ? 9998 : ib);
    });
    return keys.map((id) => {
      const cat = id == null ? null : d?.catalogs.find((c) => c.id === id) ?? null;
      return {
        key: id == null ? 'none' : String(id),
        title: cat?.name ?? 'Без каталога',
        icon: cat?.icon ?? '',
        color: cat?.color ?? '',
        items: map.get(id) ?? [],
      };
    });
  });

  readonly dishCatalogs = computed(() =>
    (this.data()?.catalogs ?? []).filter((c) => this.rows().some((r) => r.kind === 'output' && r.catalogId === c.id))
  );

  readonly selected = computed<RecipeRow | null>(() => {
    const id = this.selectedId();
    if (id == null) return null;
    return this.rows().find((r) => r.id === id) ?? null;
  });

  readonly draftKind = computed<'output' | 'state'>(() =>
    (this.draft()?.skus ?? []).some((s) => !s.archived) ? 'output' : 'state'
  );

  readonly visibleSkus = computed<SkuDraft[]>(() => (this.draft()?.skus ?? []).filter((s) => !s.archived));

  readonly archivedSkus = computed<SkuDraft[]>(() => (this.draft()?.skus ?? []).filter((s) => s.archived));

  readonly activeSkus = computed(() => this.visibleSkus().filter((s) => s.isActive).length);

  readonly draftUnitCode = computed(() => {
    const id = this.draft()?.unitId;
    if (id == null) return '';
    return this.data()?.units.find((u) => u.id === id)?.code ?? '';
  });

  readonly ingredientSum = computed<{ value: number; partial: boolean; unitCode: string } | null>(() => {
    const d = this.draft();
    if (!d || !d.nodes.length) return null;
    const target = (this.data()?.units ?? []).find((u) => u.id === d.unitId);
    if (!target) return null;
    let total = 0;
    let partial = false;
    for (const n of d.nodes) {
      const code = this.componentUnitCode(n);
      if (!code) {
        partial = true;
        continue;
      }
      const conv = n.materialId != null ? this.materialConv(n.materialId) : null;
      const value = this.convertQty(n.qty, code, target.code, conv);
      if (value == null) {
        partial = true;
        continue;
      }
      total += value;
    }
    return { value: Math.round(total * 1000) / 1000, partial, unitCode: target.code };
  });

  readonly sumDiff = computed<number | null>(() => {
    const s = this.ingredientSum();
    if (!s || s.partial) return null;
    const out = this.draft()?.portionQty ?? 0;
    return Math.round((s.value - out) * 1000) / 1000;
  });

  readonly sumStatus = computed<string>(() => {
    const s = this.ingredientSum();
    if (!s) return 'Добавьте компоненты состава';
    if (s.partial) return 'расчёт неполный — не хватает пересчёта единиц';
    const diff = this.sumDiff() ?? 0;
    if (Math.abs(diff) <= 0.01) return 'совпадает с партией';
    return diff > 0
      ? `больше партии на ${fmtQty(diff, s.unitCode)}`
      : `меньше партии на ${fmtQty(-diff, s.unitCode)}`;
  });

  readonly sumClass = computed<'ok' | 'mismatch' | 'partial'>(() => {
    const s = this.ingredientSum();
    if (!s || s.partial) return 'partial';
    return Math.abs(this.sumDiff() ?? 0) <= 0.01 ? 'ok' : 'mismatch';
  });

  readonly dirty = computed(() => {
    const d = this.draft();
    return !!d && JSON.stringify(d) !== this.baseline();
  });

  readonly recentRecipes = computed<RecipeRow[]>(() => {
    const byId = new Map(this.rows().map((r) => [r.id, r] as const));
    return this.recent()
      .map((id) => byId.get(id))
      .filter((r): r is RecipeRow => r != null);
  });

  ngOnInit(): void {
    try {
      this.onSaleOnly.set(localStorage.getItem('recipes.onSale') !== '0');
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      if (Array.isArray(raw)) {
        this.recent.set(raw.filter((id) => Number.isInteger(id) && id > 0).slice(0, 8));
      }
    } catch {
      /* приватный режим */
    }
    this.load();
  }

  private load(keepId: number | null = null): void {
    this.api.recipes$().subscribe({
      next: (d) => {
        this.data.set(d);
        const hasDishes = d.recipes.some((r) => r.skus.some((s) => !s.archived));
        if (!this.embedded() && keepId == null) this.tab.set(hasDishes ? 'output' : 'state');
        const wanted = keepId ?? (this.embedded() ? this.embedNodeId() : this.selectedId());
        const found = wanted == null ? null : this.rows().find((r) => r.id === wanted) ?? null;
        const fallback = found ?? this.filtered()[0] ?? this.rows()[0] ?? null;
        this.selectedId.set(fallback?.id ?? null);
        if (fallback) this.openDraft(fallback);
        else this.draft.set(null);
        this.loading.set(false);
      },
      error: (e) => {
        this.err.set(httpErr(e));
        this.loading.set(false);
      },
    });
  }

  /** Роутер вызывает перед уходом со страницы: несохранённые правки не теряем молча. */
  canDeactivate(): boolean {
    return !this.dirty() || confirm('В рецептуре есть несохранённые изменения. Уйти со страницы и потерять их?');
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(ev: BeforeUnloadEvent): void {
    if (!this.dirty()) return;
    ev.preventDefault();
    ev.returnValue = '';
  }

  close(): void {
    if (this.dirty() && !confirm('Есть несохранённые изменения. Закрыть без сохранения?')) return;
    this.editorClosed.emit();
  }

  setTab(kind: 'output' | 'state'): void {
    if (this.tab() === kind) return;
    if (this.dirty() && !confirm('В рецептуре есть несохранённые изменения. Переключить вкладку и потерять их?')) return;
    this.tab.set(kind);
    const visible = this.filtered();
    if (!visible.some((r) => r.id === this.selectedId())) {
      const first = visible[0];
      this.selectedId.set(first?.id ?? null);
      if (first) this.openDraft(first);
    }
  }

  setOnSaleOnly(value: boolean): void {
    this.onSaleOnly.set(value);
    try {
      localStorage.setItem('recipes.onSale', value ? '1' : '0');
    } catch {
      /* приватный режим */
    }
  }

  select(id: number): void {
    if (id === this.selectedId()) return;
    if (this.dirty() && !confirm('В рецептуре есть несохранённые изменения. Переключиться и потерять их?')) return;
    this.selectedId.set(id);
    const row = this.rows().find((r) => r.id === id);
    if (row) this.openDraft(row);
    const next = [id, ...this.recent().filter((x) => x !== id)].slice(0, 8);
    this.recent.set(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* приватный режим */
    }
    this.msg.set('');
    this.err.set('');
  }

  openRecent(id: number): void {
    this.select(id);
  }

  countOf(kind: 'output' | 'state'): number {
    return this.rows().filter((r) => r.kind === kind).length;
  }

  openSkuCount(recipe: Recipe): number {
    return recipe.skus.filter((s) => !s.archived).length;
  }

  catalogOf(id: number | null): RecipesData['catalogs'][number] | null {
    if (id == null) return null;
    return this.data()?.catalogs.find((c) => c.id === id) ?? null;
  }

  num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  private trimNum(n: number): string {
    return String(Math.round(n * 1000) / 1000);
  }

  // ---- черновик ----

  private openDraft(recipe: Recipe): void {
    const d: RecipeDraft = {
      name: recipe.name,
      nameEn: recipe.nameEn,
      nameSr: recipe.nameSr,
      catalogId: recipe.catalogId,
      unitId: recipe.unitId,
      portionQty: recipe.portionQty,
      description: recipe.description,
      nodes: recipe.nodes.map((n) => ({
        key: nextKey(),
        kind: n.subProductId != null ? 'product' : 'material',
        materialId: n.materialId,
        subProductId: n.subProductId,
        qty: n.qty,
        lossPct: n.lossPct,
      })),
      skus: recipe.skus.map((s) => ({
        key: nextKey(),
        id: s.id,
        name: s.name,
        qtyBase: s.qtyBase,
        priceBasis: s.priceBasis === 'portion' ? 'portion' : 'unit',
        price: s.price,
        costPrice: s.costPrice,
        isActive: s.isActive,
        archived: s.archived === true,
        usedInOrders: s.usedInOrders,
        packageIds: s.packages.map((p) => p.id),
      })),
    };
    this.draft.set(d);
    this.baseline.set(JSON.stringify(d));
  }

  setField(patch: Partial<RecipeDraft>): void {
    this.draft.update((d) => (d ? { ...d, ...patch } : d));
  }

  setCatalog(value: number | string | null): void {
    const id = value == null || value === '' ? null : Number(value);
    this.setField({ catalogId: Number.isInteger(id) ? (id as number) : null });
  }

  setUnit(value: unknown): void {
    const id = Number(value);
    this.setField({ unitId: Number.isInteger(id) && id > 0 ? id : null });
  }

  private componentUnitCode(n: NodeDraft): string | null {
    if (n.materialId != null) {
      return this.data()?.materials.find((m) => m.id === n.materialId)?.unitCode ?? null;
    }
    if (n.subProductId != null) {
      return this.data()?.recipes.find((r) => r.id === n.subProductId)?.unitCode ?? null;
    }
    return null;
  }

  private materialConv(materialId: number): Conv | null {
    const m = this.data()?.materials.find((x) => x.id === materialId);
    return m ? { gPerPcs: m.gPerPcs, mlPerPcs: m.mlPerPcs, gPerMl: m.gPerMl } : null;
  }

  /** Пересчёт количества в единицу рецептуры: напрямую, через плотность или штучный вес. */
  private convertQty(qty: number, fromCode: string, toCode: string, conv: Conv | null): number | null {
    if (fromCode === toCode) return qty;
    const units = this.data()?.units ?? [];
    const dimOf = (code: string): Dim | null => {
      const u = units.find((x) => x.code === code);
      const d = u?.dimension;
      return d === 'mass' || d === 'volume' || d === 'count' ? d : null;
    };
    const pos = (n: number | null | undefined): number | null =>
      n != null && n > 0 && Number.isFinite(n) ? n : null;
    const edge = (a: Dim, b: Dim): number | null => {
      if (!conv) return null;
      if (a === 'count' && b === 'mass') return pos(conv.gPerPcs);
      if (a === 'mass' && b === 'count') {
        const g = pos(conv.gPerPcs);
        return g ? 1 / g : null;
      }
      if (a === 'count' && b === 'volume') return pos(conv.mlPerPcs);
      if (a === 'volume' && b === 'count') {
        const ml = pos(conv.mlPerPcs);
        return ml ? 1 / ml : null;
      }
      if (a === 'mass' && b === 'volume') {
        const d = pos(conv.gPerMl);
        return d ? 1 / d : null;
      }
      if (a === 'volume' && b === 'mass') return pos(conv.gPerMl);
      return null;
    };
    const f = dimOf(fromCode);
    const t = dimOf(toCode);
    if (!f || !t) return null;
    const direct = edge(f, t);
    if (direct != null) return qty * direct;
    const third = (['mass', 'volume', 'count'] as Dim[]).find((x) => x !== f && x !== t);
    if (!third) return null;
    const a = edge(f, third);
    const b = edge(third, t);
    if (a != null && b != null) return qty * a * b;
    return null;
  }

  setNode(index: number, patch: Partial<NodeDraft>): void {
    this.draft.update((d) => {
      if (!d) return d;
      return { ...d, nodes: d.nodes.map((n, i) => (i === index ? { ...n, ...patch } : n)) };
    });
  }

  nodeKind(n: NodeDraft): 'material' | 'product' {
    return n.kind;
  }

  setNodeKind(index: number, kind: string): void {
    this.setNode(index, {
      kind: kind === 'product' ? 'product' : 'material',
      materialId: null,
      subProductId: null,
    });
  }

  nodeValue(n: NodeDraft): number | null {
    return n.kind === 'material' ? n.materialId : n.subProductId;
  }

  setNodeComponent(index: number, value: number | null): void {
    const d = this.draft();
    const node = d?.nodes[index];
    if (!node) return;
    if (node.kind === 'material') this.setNode(index, { materialId: value, subProductId: null });
    else this.setNode(index, { subProductId: value, materialId: null });
  }

  nodeOptions(n: NodeDraft): SearchOption[] {
    const d = this.draft();
    if (!d) return [];
    if (n.kind === 'material') {
      const used = new Set(d.nodes.filter((x) => x !== n && x.materialId != null).map((x) => x.materialId));
      return (this.data()?.materials ?? [])
        .filter((m) => !used.has(m.id))
        .map((m) => ({ id: m.id, label: `${m.name} (${m.unitCode})`, group: m.category }));
    }
    const used = new Set(d.nodes.filter((x) => x !== n && x.subProductId != null).map((x) => x.subProductId));
    return (this.data()?.recipes ?? [])
      .filter((r) => r.id !== this.selectedId() && !used.has(r.id))
      .map((r) => ({ id: r.id, label: r.name, group: this.catalogOf(r.catalogId)?.name ?? 'Без каталога' }));
  }

  nodeUnit(n: NodeDraft): string {
    if (n.materialId != null) {
      return this.data()?.materials.find((m) => m.id === n.materialId)?.unitCode ?? '—';
    }
    if (n.subProductId != null) {
      return this.data()?.recipes.find((r) => r.id === n.subProductId)?.unitCode ?? '—';
    }
    return '—';
  }

  addNode(): void {
    this.draft.update((d) =>
      d
        ? {
            ...d,
            nodes: [
              ...d.nodes,
              { key: nextKey(), kind: 'material', materialId: null, subProductId: null, qty: 1, lossPct: 0 },
            ],
          }
        : d
    );
  }

  removeNode(index: number): void {
    const d = this.draft();
    const node = d?.nodes[index];
    if (!node) return;
    if (!confirm('Удалить компонент из состава?')) return;
    this.draft.update((x) => (x ? { ...x, nodes: x.nodes.filter((_, i) => i !== index) } : x));
  }

  // ---- фасовки ----

  setSku(index: number, patch: Partial<SkuDraft>): void {
    this.draft.update((d) => {
      if (!d) return d;
      return { ...d, skus: d.skus.map((s, i) => (i === index ? { ...s, ...patch } : s)) };
    });
  }

  setSkuBasis(index: number, value: string): void {
    this.setSku(index, { priceBasis: value === 'portion' ? 'portion' : 'unit' });
  }

  addSku(): void {
    this.draft.update((d) =>
      d
        ? {
            ...d,
            skus: [
              ...d.skus,
              {
                key: nextKey(),
                id: null,
                name: '',
                qtyBase: 0,
                priceBasis: 'unit',
                price: 0,
                costPrice: 0,
                isActive: true,
                archived: false,
                usedInOrders: 0,
                packageIds: [],
              },
            ],
          }
        : d
    );
  }

  removeSku(index: number): void {
    const d = this.draft();
    const sku = d?.skus[index];
    if (!sku) return;
    if (!confirm('Убрать фасовку в архив? Она останется в истории заказов, но исчезнет из продажи.')) return;
    this.setSku(index, { archived: true, isActive: false });
  }

  restoreSku(key: number): void {
    this.draft.update((d) =>
      d ? { ...d, skus: d.skus.map((s) => (s.key === key ? { ...s, archived: false } : s)) } : d
    );
  }

  packagesRemaining(s: SkuDraft): RecipesData['packages'] {
    return (this.data()?.packages ?? []).filter((p) => !s.packageIds.includes(p.id));
  }

  packageName(id: number): string {
    return this.data()?.packages.find((p) => p.id === id)?.name ?? `тара #${id}`;
  }

  addPackageFrom(index: number, ev: Event): void {
    const select = ev.target as HTMLSelectElement;
    const id = Number(select.value);
    select.value = '';
    if (!Number.isInteger(id) || id <= 0) return;
    const sku = this.draft()?.skus[index];
    if (!sku || sku.packageIds.includes(id)) return;
    this.setSku(index, { packageIds: [...sku.packageIds, id] });
  }

  removePackage(index: number, packageId: number): void {
    const sku = this.draft()?.skus[index];
    if (!sku) return;
    this.setSku(index, { packageIds: sku.packageIds.filter((x) => x !== packageId) });
  }

  // ---- сохранение ----

  save(): void {
    const d = this.draft();
    const recipe = this.selected();
    if (!d || !recipe) return;
    if (!d.name.trim()) {
      this.err.set('Название рецептуры не может быть пустым');
      return;
    }
    for (const n of d.nodes) {
      if (n.materialId == null && n.subProductId == null) {
        this.err.set('В составе есть строка без компонента — выберите сырьё или рецептуру');
        return;
      }
      if (!(n.qty > 0)) {
        this.err.set('Количество компонента должно быть больше 0');
        return;
      }
      if (!(n.lossPct >= 0 && n.lossPct <= 100)) {
        this.err.set('Потери должны быть от 0 до 100 %');
        return;
      }
    }
    if (d.skus.some((s) => s.price < 0 || s.costPrice < 0)) {
      this.err.set('Цена и себестоимость не могут быть отрицательными');
      return;
    }
    if (d.unitId == null) {
      this.err.set('Выберите единицу рецептуры');
      return;
    }
    if (!(d.portionQty >= 0)) {
      this.err.set('Выход не может быть отрицательным');
      return;
    }
    if (d.skus.some((s) => s.qtyBase < 0)) {
      this.err.set('Размер фасовки не может быть отрицательным');
      return;
    }

    const unitCode = this.draftUnitCode();
    const skuName = (s: SkuDraft): string =>
      s.name.trim() || (s.qtyBase > 0 ? `${this.trimNum(s.qtyBase)} ${unitCode}`.trim() : '');

    const payload = {
      name: d.name.trim(),
      nameEn: d.nameEn.trim(),
      nameSr: d.nameSr.trim(),
      catalogId: d.catalogId,
      unitId: d.unitId,
      portionQty: d.portionQty,
      description: d.description,
      nodes: d.nodes.map((n) => ({
        materialId: n.materialId,
        subProductId: n.subProductId,
        qty: n.qty,
        lossPct: n.lossPct,
      })),
      skus: d.skus.map((s) => ({
        id: s.id,
        name: skuName(s),
        qtyBase: s.qtyBase,
        priceBasis: s.priceBasis,
        price: s.price,
        costPrice: s.costPrice,
        isActive: s.isActive,
        archived: s.archived,
        packageIds: s.packageIds,
      })),
    };

    this.saving.set(true);
    this.err.set('');
    this.msg.set('');
    const keepId = recipe.id;
    this.api.saveRecipe(keepId, payload).subscribe({
      next: () => {
        this.saving.set(false);
        this.msg.set('Сохранено');
        this.load(keepId);
      },
      error: (e) => {
        this.saving.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  cancel(): void {
    const row = this.selected();
    if (row) this.openDraft(row);
    this.err.set('');
    this.msg.set('');
  }
}
