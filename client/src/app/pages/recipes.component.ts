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
import {
  MapNode,
  MapOp,
  Product,
  ProductCatalog,
  ProductionMap,
  RawCategory,
  Unit,
} from '../core/models';
import { fmtQty, httpErr } from '../core/format';
import { batchMinOrder } from '../core/production-map-calc';
import { toBaseClient } from '../core/units';
import { SearchOption, SearchSelectComponent } from '../shared/search-select.component';
import { ProductCardComponent, ProductCardItem } from '../shared/product-card.component';

/** Количество с округлением до десятых в его единице (кг/л для крупных). */
function fmtTenths(baseQty: number, unitCode: string): string {
  const abs = Math.abs(baseQty);
  const one = (n: number) => String(Math.round(n * 10) / 10);
  if (unitCode === 'г' && abs >= 1000) return `${one(abs / 1000)} кг`;
  if (unitCode === 'мл' && abs >= 1000) return `${one(abs / 1000)} л`;
  return `${one(abs)} ${unitCode}`;
}

type RecipeTab = 'output' | 'state';
type AddKind = 'raw' | 'semi' | 'dish';
const RECENT_KEY = 'recipes.recent';

interface DraftInput {
  nodeId: number;
  qty: number;
  lossPct: number | null;
  inMass: boolean;
  /** Ввод в единице компонента, рецептуры или альтернативной (стрелка ⇄). */
  displayUnit: 'source' | 'target' | 'alt';
}

interface DraftPackaging {
  uid?: number;
  qtyBase: number;
  minOrder: number;
  price: number;
  priceBasis: 'unit' | 'portion' | 'piece';
  cost: number;
  available: boolean;
  isDefault: boolean;
  /** Тара: несколько складских позиций категории «упаковка», без повторов. */
  tareProductIds: number[];
}

interface RecipeRow {
  id: number;
  kind: RecipeTab;
  name: string;
  nameEn: string;
  catalogId: number | null;
  unitId: number;
  unitCode: string;
  portionQty: number;
  packagings: number;
  inputs: number;
  note: string;
}

interface RecipeGroup {
  key: string;
  title: string;
  icon: string;
  color: string;
  items: RecipeRow[];
}

interface ComponentEditState {
  index: number;
  nodeId: number;
  kind: 'raw' | 'recipe';
  productId: number | null;
}

interface EditorSnapshot {
  selectedId: number | null;
  tab: RecipeTab;
  draft: DraftInput[];
  packagings: DraftPackaging[];
  name: string;
  nameEn: string;
  nameSr: string;
  note: string;
  catalogId: number | null;
  portionQty: number;
  unitId: number | null;
  editing: boolean;
  addOpen: boolean;
  query: string;
  catalogFilter: string;
}

/**
 * Раздел «Рецептуры»: блюда и заготовки на одном экране.
 * Слева — вкладки и список, справа — состав выбранной рецептуры
 * в виде таблицы, как в старых техкартах. Количества и потери можно править
 * и сохранять в общую карту производства.
 */
@Component({
  selector: 'app-recipes',
  standalone: true,
  imports: [CommonModule, FormsModule, SearchSelectComponent, ProductCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .page-head { display: flex; align-items: flex-start; gap: 12px 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .page-head .page-title { margin: 0; }
    .recent-box { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
    .recent-label {
      margin-right: 2px; font-size: 10px; font-weight: 800; letter-spacing: .08em;
      text-transform: uppercase; color: var(--muted);
    }
    .recent-chip {
      display: inline-flex; align-items: center; gap: 6px; max-width: 230px;
      border: 1px solid var(--border); border-radius: 999px; background: #fff;
      padding: 4px 10px; font: inherit; font-size: 12px; color: var(--ink); cursor: pointer;
    }
    .recent-chip:hover { border-color: #c3d5e6; background: #f6fafd; }
    .recent-chip.on { border-color: var(--brand-blue); background: #eef7fd; }
    .rc-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .recent-chip small { font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
    @media (max-width: 900px) { .recent-box { margin-left: 0; } }
    .recipes-grid { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 14px; align-items: start; }
    .recipes-grid.embedded { display: block; }
    @media (max-width: 900px) { .recipes-grid { grid-template-columns: 1fr; } }
    .editor-modal-backdrop {
      position: fixed; inset: 0; z-index: 60; background: rgba(10, 18, 32, .5);
    }
    .panel.editor-modal {
      position: fixed; z-index: 61; top: 3vh; left: 50%; transform: translateX(-50%);
      width: min(1120px, calc(100vw - 24px)); max-height: 94vh; overflow: auto;
      margin: 0; box-shadow: 0 18px 60px rgba(10, 18, 32, .35);
    }
    .editor-modal-top {
      position: sticky; top: 0; z-index: 5;
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      margin: -16px -16px 14px; padding: 10px 14px;
      background: #f7f5ef; border-bottom: 1px solid var(--border);
      border-radius: var(--radius) var(--radius) 0 0;
    }
    .editor-modal-top span { font-size: 12px; font-weight: 700; color: #6b5a33; letter-spacing: .03em; }
    .em-x {
      border: 1px solid var(--border); background: #fff; color: var(--muted);
      width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
      font-size: 15px; line-height: 1; padding: 0;
    }
    .em-x:hover { color: var(--ink); border-color: #c3d5e6; background: #f4f8fb; }

    .side { position: sticky; top: 12px; max-height: calc(100vh - 24px); display: flex; flex-direction: column; }
    .side-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
    .side-tab {
      border: 1px solid var(--border); background: #fff; color: var(--muted);
      border-radius: 9px; padding: 8px 10px; font: inherit; font-weight: 700; font-size: 13px; cursor: pointer;
    }
    .side-tab.on { background: var(--brand-blue); border-color: var(--brand-blue); color: #fff; }
    .side-tab.output.on { background: #dff2e7; border-color: #9fcfb6; color: #1f5c42; }
    .side-tab.state.on { background: #f1ece1; border-color: #d6c6a5; color: #6f5330; }
    .side-tab small { display: block; margin-top: 2px; font-size: 10px; font-weight: 600; opacity: .8; }

    .side-search { position: relative; margin-bottom: 8px; }
    .side-search input {
      width: 100%; padding: 8px 28px 8px 10px; font-size: 13px;
      border: 1px solid var(--border); border-radius: 8px; background: #fff;
    }
    .side-search input:focus { outline: none; border-color: var(--brand-blue); }
    .side-search button {
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 11px;
    }
    .side-select {
      width: 100%; margin-bottom: 8px; padding: 7px 9px; font-size: 12.5px;
      border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--ink);
    }
    .side-select:focus { outline: none; border-color: var(--brand-blue); }
    .side-on-sale {
      display: flex; align-items: center; gap: 7px; margin: 0 0 8px;
      font-size: 12.5px; color: var(--muted); cursor: pointer; user-select: none;
    }
    .side-on-sale input { width: 15px; height: 15px; accent-color: var(--brand-blue); cursor: pointer; }
    .side-on-sale b { color: var(--ink); font-weight: 600; }

    .side-list { overflow: auto; min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; }
    .list-group { display: flex; flex-direction: column; gap: 6px; }
    .lg-head {
      position: sticky; top: 0; z-index: 1;
      display: flex; align-items: center; gap: 6px;
      padding: 5px 9px; border: 1px solid #e7e1d5; border-left: 4px solid #cfc6b5;
      border-radius: 8px; background: #f7f5ef;
      font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: #5d5648;
    }
    .lg-count {
      margin-left: auto; font-size: 10px; font-weight: 800; color: var(--muted);
      background: #fff; border: 1px solid #e4dccd; border-radius: 999px; padding: 1px 7px;
    }
    .recipe-item {
      width: 100%; text-align: left; border: 1px solid var(--border); background: #fff;
      border-radius: 10px; padding: 8px 10px; cursor: pointer; font: inherit; color: var(--ink);
      transition: border-color .15s, background-color .15s, box-shadow .15s;
    }
    .recipe-item:hover { background: #f8fafc; border-color: #c3d5e6; }
    .recipe-item.on { border-color: var(--brand-blue); background: #f2f8fc; box-shadow: inset 3px 0 0 var(--brand-blue); }
    .ri-name { display: block; font-size: 13.5px; font-weight: 700; line-height: 1.25; }
    .ri-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 4px; font-size: 11px; color: var(--muted); }
    .ri-cat { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-weight: 600; }

    .editor-head { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
    .editor-title { margin: 0; font-size: 21px; line-height: 1.2; }
    .editor-sub { margin-top: 5px; display: flex; gap: 6px 10px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--muted); }
    .kind-chip { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .kind-chip.state { background: #f1ece1; color: #7a5b2e; }
    .kind-chip.output { background: #dff2e7; color: #236b4c; }
    .cat-chip { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #21301f; }
    .editor-actions { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .dirty-note { margin-right: 4px; font-size: 11px; color: var(--muted); white-space: nowrap; }
    .dirty-note.on { color: #8a6a1f; font-weight: 700; }
    .edit-top {
      display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px;
      align-items: start; margin: 12px 0 6px;
    }
    @media (max-width: 760px) { .edit-top { grid-template-columns: 1fr; } }
    .edit-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; margin: 0; }
    .edit-fields .f { min-width: 0; }
    .edit-fields .f.full { grid-column: 1 / -1; }
    .edit-fields input, .edit-fields select, .edit-fields textarea { width: 100%; }
    .edit-fields textarea { resize: vertical; min-height: 52px; }
    .formula { margin: 10px 0 4px; font-size: 12px; color: var(--muted); }
    .pack-section { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--border); }
    .pack-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .pack-head h3 { margin: 0; font-size: 15px; }
    .pack-table input[type=number] { width: 95px; }
    .pack-table select { min-width: 120px; }
    .pack-table .tare-select { min-width: 165px; width: 100%; }
    .tare-cell { min-width: 200px; }
    .tare-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 6px; }
    .tare-chip {
      display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
      padding: 2px 3px 2px 9px; border-radius: 999px; font-size: 12px;
      border: 1px solid #cfe3c8; background: #eef6ea; white-space: nowrap;
    }
    .tare-chip button {
      border: 0; background: transparent; color: var(--muted); cursor: pointer;
      padding: 0 3px; font-size: 11px; line-height: 1;
    }
    .tare-chip button:hover { color: var(--red); }
    .tare-add {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; padding: 0; border-radius: 6px; cursor: pointer;
      border: 1px dashed var(--border); background: #fff; color: var(--green);
      font-size: 14px; font-weight: 700; line-height: 1;
    }
    .tare-add:hover { border-color: var(--green); background: var(--green-soft); }
    .tare-pop-backdrop { position: fixed; inset: 0; z-index: 80; }
    .tare-pop {
      position: fixed; z-index: 81; width: 250px; max-height: 300px; overflow: auto;
      padding: 6px; border: 1px solid var(--border); border-radius: 10px; background: #fff;
      box-shadow: 0 12px 32px rgba(15, 23, 42, .18);
    }
    .tare-pop-head {
      padding: 5px 8px 6px; font-size: 10px; font-weight: 800; letter-spacing: .06em;
      text-transform: uppercase; color: var(--muted);
    }
    .tare-pop-item {
      display: block; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px;
      background: transparent; color: var(--text); font: inherit; font-size: 13px;
      text-align: left; cursor: pointer;
    }
    .tare-pop-item:hover { background: var(--accent-soft); }
    .tare-pop-empty { padding: 8px; color: var(--muted); font-size: 12px; }
    .pack-add { margin-top: 8px; }
    .edit-hint { display: block; margin-top: 4px; color: #7a6a4a; line-height: 1.4; }
    .sum-card {
      display: flex; flex-direction: column; align-items: stretch; gap: 8px;
      margin: 0; padding: 12px 14px; border-radius: 12px;
      border: 1px solid #e4dccb; background: #faf7ef;
    }
    .sum-output { margin-left: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .sum-output .f { min-width: 0; }
    .sum-output input { width: 100%; }
    .sum-main { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .sum-label {
      font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
      color: #7a6a4a;
    }
    .sum-value {
      font-size: 26px; font-weight: 800; line-height: 1; color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .sum-status { flex-basis: auto; margin-left: 0; font-size: 12px; font-weight: 600; line-height: 1.35; color: #8a6a1f; }
    .sum-card.ok { background: #f0faf3; border-color: #bcdcc9; }
    .sum-card.ok .sum-status { color: #236b4c; }
    .sum-card.mismatch { background: #fff6e3; border-color: #efd39b; }
    .sum-card.mismatch .sum-value { color: #a8551b; }
    .sum-card.partial { background: #f4f2ee; border-color: #d9d3c7; }
    .sum-card.partial .sum-status { color: var(--muted); }
    .hint {
      position: relative; display: inline-flex; align-items: center; justify-content: center;
      width: 15px; height: 15px; margin-left: 4px; border-radius: 50%;
      background: #e9e3d6; color: #6f6048; font-size: 9.5px; font-weight: 800;
      cursor: help; text-transform: none; vertical-align: middle;
    }
    .hint:hover, .hint:focus { background: #dcd2bf; outline: none; }
    .hint-pop {
      display: none; position: absolute; top: calc(100% + 7px); right: 0; z-index: 60;
      width: min(300px, 78vw); padding: 9px 11px; border-radius: 9px;
      background: #2f2a22; color: #f7f2e8; box-shadow: 0 10px 28px rgba(30, 25, 15, .25);
      font-size: 11.5px; font-weight: 400; line-height: 1.45; letter-spacing: 0;
      text-align: left; text-transform: none; white-space: normal;
    }
    .hint-pop b { display: block; margin-bottom: 3px; color: #fff; font-size: 11.5px; }
    .hint:hover .hint-pop, .hint:focus .hint-pop { display: block; }
    .hint-pop.left { left: 0; right: auto; }
    .add-wrap { margin: 10px 0 6px; }
    .add-box {
      display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap;
      padding: 10px; border: 1px dashed #d6cbb5; border-radius: 10px; background: #fbf8f1;
    }
    .add-box .f { min-width: 110px; }
    .add-box .f input, .add-box .f select { min-width: 90px; }
    .add-unit { padding-bottom: 9px; min-width: 22px; font-size: 12px; font-weight: 700; color: var(--muted); }
    .add-unit-box { padding-bottom: 7px; min-width: 64px; }
    .add-unit-box .unit-line { font-size: 12px; font-weight: 700; color: var(--muted); }
    .add-check { display: flex; align-items: center; gap: 5px; padding-bottom: 9px; font-size: 12px; white-space: nowrap; }
    .cmp-cell { position: relative; display: flex; align-items: flex-start; gap: 4px; }
    .cmp-cell app-search-select { flex: 1; min-width: 0; }
    .cmp-edit {
      flex: none; width: 30px; height: 32px; padding: 0;
      border: 1px solid var(--border); border-radius: 8px; background: #fff;
      color: var(--muted); font-size: 13px; cursor: pointer;
    }
    .cmp-edit:hover, .cmp-edit.on { color: var(--ink); border-color: #9dc3dd; background: #f2f8fc; }
    .cmp-pop {
      position: absolute; top: calc(100% + 5px); left: 0; z-index: 70;
      width: min(330px, 82vw); padding: 10px 12px;
      background: #fff; border: 1px solid var(--border); border-radius: 11px;
      box-shadow: 0 14px 34px rgba(40, 35, 25, .18);
    }
    .cmp-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .cmp-pop-head b { font-size: 13px; }
    .cmp-pop-x {
      border: 0; background: transparent; color: var(--muted); cursor: pointer;
      font-size: 16px; line-height: 1; padding: 2px 4px;
    }
    .cmp-name { margin-top: 7px; font-size: 13px; font-weight: 700; }
    .cmp-pop .f { margin-top: 8px; }
    .cmp-pop .f input, .cmp-pop .f select { width: 100%; }
    .cmp-pop-actions { display: flex; gap: 6px; margin-top: 10px; }
    .comp-table input[type=number] { width: 100px; }
    .comp-table .cmp-select { width: 100%; min-width: 180px; }
    .comp-table .type-select { width: 120px; }
    .unit-line { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
    .unit-swap {
      border: 1px solid var(--border); background: #fff; color: var(--muted);
      width: 20px; height: 20px; padding: 0; border-radius: 6px; cursor: pointer;
      font-size: 11px; line-height: 1;
    }
    .unit-swap:hover { color: var(--ink); border-color: #c3d5e6; background: #f4f8fb; }
    .conv-hint { margin-top: 2px; font-size: 10px; line-height: 1.2; color: var(--muted); white-space: nowrap; }
    .conv-hint.missing { color: #b08a2a; }
    .row-type { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .row-type.raw { color: #33639c; }
    .row-type.semi { color: #7a5b2e; }
    .row-type.dish { color: #236b4c; }
    .empty-state { padding: 28px; text-align: center; color: var(--muted); }
    .empty-state.placeholder {
      display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 64px 24px;
    }
    .ph-icon { font-size: 42px; line-height: 1; opacity: .55; }
    .placeholder b { font-size: 16px; color: var(--ink); }
    .placeholder span { max-width: 390px; font-size: 12.5px; line-height: 1.5; }
    .warn-note { margin-top: 8px; font-size: 12px; color: #8a6a1f; }
    .muted-sm { font-size: 12px; color: var(--muted); }
  `],
  template: `
    @if (!embedded()) {
      <div class="page-head">
        <h1 class="page-title">📖 Рецептуры</h1>
        @if (recentRecipes().length) {
          <div class="recent-box">
            <span class="recent-label">Недавние</span>
            @for (r of recentRecipes(); track r.id) {
              <button type="button" class="recent-chip" [class.on]="selectedId() === r.id"
                      (click)="openRecent(r.id)"
                      [title]="r.name + ' · ' + (roleOf(r) === 'state' ? 'заготовка' : 'блюдо')">
                <span class="rc-name">{{ r.name }}</span>
                <small>{{ roleOf(r) === 'state' ? 'заготовка' : 'блюдо' }}</small>
              </button>
            }
          </div>
        }
      </div>
      @if (err()) { <div class="err">{{ err() }}</div> }
      @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }
    }

    @if (editorModal()) {
      <div class="editor-modal-backdrop" (click)="closeEditorModal()"></div>
    }

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
          <select class="side-select" [ngModel]="catalogFilter()" (ngModelChange)="setCatalog($event)" title="Фильтр по каталогу">
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
                      <span>выход {{ fmtQty(r.portionQty, r.unitCode) }}</span>
                      <span>состав {{ r.inputs }}</span>
                      <span>фасовок {{ r.packagings }}</span>
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

      <section class="panel" [class.editor-modal]="editorModal()">
        @if (editorModal()) {
          <div class="editor-modal-top">
            <span>✎ Редактирование рецептуры</span>
            <button type="button" class="em-x" (click)="closeEditorModal()" aria-label="Закрыть">✕</button>
          </div>
        }
        @if (embedded() && err()) { <div class="err">{{ err() }}</div> }
        @if (embedded() && msg()) { <div class="ok-msg">{{ msg() }}</div> }
        @if (node(); as n) {
          <div class="editor-head">
            <div>
              <h2 class="editor-title">{{ draftName() || n.name || 'Без названия' }}</h2>
              <div class="editor-sub">
                <span class="kind-chip" [class.state]="currentRole() === 'state'" [class.output]="currentRole() === 'output'">
                  {{ currentRole() === 'state' ? 'заготовка' : 'блюдо' }}
                </span>
                @if (catalogOf(draftCatalogId()); as cat) {
                  <span class="cat-chip" [style.background]="cat.color || '#eef2f5'">{{ cat.icon ? cat.icon + ' ' : '' }}{{ cat.name }}</span>
                }
                @if (n.note) { <span>{{ n.note }}</span> }
              </div>
            </div>
            <div class="editor-actions">
              <span class="dirty-note" [class.on]="dirty()">
                {{ dirty() ? '● несохранённые изменения' : 'изменений нет' }}
              </span>
              <button type="button" class="btn primary" [disabled]="saving() || !dirty()" (click)="save()">
                {{ saving() ? 'Сохраняю…' : '💾 Сохранить' }}
              </button>
              <button type="button" class="btn" [disabled]="saving() || !dirty()" (click)="cancelEdit()">Отмена</button>
            </div>
          </div>

          <div class="edit-top">
            <div class="edit-fields">
              <label class="f full">Название (RU) *
                <input [ngModel]="draftName()" (ngModelChange)="draftName.set($event)" placeholder="Название рецептуры" />
              </label>
              <label class="f">Название (EN)
                <input [ngModel]="draftNameEn()" (ngModelChange)="draftNameEn.set($event)" placeholder="optional" />
              </label>
              <label class="f">Название (SR)
                <input [ngModel]="draftNameSr()" (ngModelChange)="draftNameSr.set($event)" placeholder="opciono" />
              </label>
              @if (showCatalog()) {
                <label class="f">Каталог
                  <select [ngModel]="draftCatalogId()" (ngModelChange)="draftCatalogId.set($event)">
                    <option [ngValue]="null">— без каталога —</option>
                    @for (c of catalogs(); track c.id) {
                      <option [ngValue]="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
                    }
                  </select>
                </label>
              }
              <label class="f full">Заметка
                <textarea rows="2" [ngModel]="draftNote()" (ngModelChange)="draftNote.set($event)"
                          placeholder="необязательно"></textarea>
              </label>
            </div>

            <div class="sum-card"
                 [class.ok]="ingredientSum() && !ingredientSum()?.partial && !sumDiffers()"
                 [class.mismatch]="sumDiffers()"
                 [class.partial]="ingredientSum()?.partial">
              <div class="sum-main">
                <span class="sum-label">Σ ингредиентов</span>
                <b class="sum-value">
                  @if (ingredientSum(); as s) {
                    {{ fmtQty(s.value, draftUnitCode()) }}
                  } @else {
                    —
                  }
                </b>
              </div>

              <div class="sum-output">
                <label class="f">Выход *
                  <input type="number" min="0" step="any" [ngModel]="draftPortionQty()"
                         (ngModelChange)="setDraftPortionQty($event)"
                         (blur)="alignMinOrders()" />
                </label>
                <label class="f">Единица
                  <select [ngModel]="draftUnitId()" (ngModelChange)="draftUnitId.set($event)">
                    @for (u of baseUnits(); track u.id) {
                      <option [ngValue]="u.id">{{ u.code }} — {{ u.name }}</option>
                    }
                  </select>
                </label>
              </div>

              <div class="sum-status">
                @if (ingredientSum()) { {{ sumStatus() }} } @else { Добавьте компоненты состава }
              </div>
            </div>
          </div>

          <div class="formula">
            <span class="edit-hint">
              Количество — в единице компонента. «Потери» увеличивают расход (уварка, очистка).
              «В массе» учитывается при проверке выхода.
            </span>
          </div>

          @if (op()) {
            <table class="tbl comp-table">
              <thead>
                <tr>
                  <th>
                    Тип
                    <span class="hint" tabindex="0" aria-label="Что значит «Тип»">
                      ?
                      <span class="hint-pop left">
                        <b>Тип компонента</b>
                        Откуда берётся позиция: сырьё — складская номенклатура, заготовка —
                        промежуточная рецептура цеха, блюдо — готовая рецептура. Тип фильтрует
                        список компонентов справа.
                      </span>
                    </span>
                  </th>
                  <th style="width:40%">
                    Компонент
                    <span class="hint" tabindex="0" aria-label="Что значит «Компонент»">
                      ?
                      <span class="hint-pop left">
                        <b>Компонент состава</b>
                        Позиция, которая входит в рецептуру. Количество ниже указывается в её
                        собственной единице. Уже добавленные компоненты повторно не предлагаются.
                      </span>
                    </span>
                  </th>
                  <th class="num">
                    Количество
                    <span class="hint" tabindex="0" aria-label="Как считается количество">
                      ?
                      <span class="hint-pop">
                        <b>Количество на партию</b>
                        Сколько компонента нужно на всю партию, а не на одну порцию. Указывается
                        в единице компонента. Потери задаются отдельно.
                      </span>
                    </span>
                  </th>
                  <th>
                    Ед.
                    <span class="hint" tabindex="0" aria-label="Что значит «Единица»">
                      ?
                      <span class="hint-pop">
                        <b>Единица компонента</b>
                        Берётся из справочника номенклатуры этого компонента (г, мл или шт)
                        и меняется вместе с выбранным компонентом.
                      </span>
                    </span>
                  </th>
                  <th class="num">
                    Потери, %
                    <span class="hint" tabindex="0" aria-label="Как считаются потери">
                      ?
                      <span class="hint-pop">
                        <b>Потери при обработке</b>
                        Уварка, очистка и другие потери на этой связи. Расход сырья
                        увеличивается: брутто = количество ÷ (1 − потери/100).
                        На сумму нетто и проверку партии не влияет.
                      </span>
                    </span>
                  </th>
                  <th>
                    В массе
                    <span class="hint" tabindex="0" aria-label="Что значит «В массе»">
                      ?
                      <span class="hint-pop">
                        <b>Учитывать в массе</b>
                        Компонент входит в сумму ингредиентов и в проверку «партия = сумма нетто».
                        Считается по количеству без потерь, с пересчётом в единицу рецептуры.
                        Если снять галочку, компонент всё равно списывается при выпуске, но не
                        включается в сумму и не влияет на контроль выхода.
                      </span>
                    </span>
                  </th>
                  <th style="width:42px"></th>
                </tr>
              </thead>
              <tbody>
                @for (row of draft(); track row.nodeId; let i = $index) {
                  <tr>
                    <td>
                      <select class="type-select" [ngModel]="rowKind(row.nodeId)"
                              (ngModelChange)="setRowKind(i, $event)"
                              title="Тип компонента">
                        <option value="raw">сырьё</option>
                        <option value="semi">заготовка</option>
                        <option value="dish">блюдо</option>
                      </select>
                    </td>
                    <td>
                      <div class="cmp-cell">
                        <app-search-select
                          [options]="rowOptions(i)"
                          [value]="row.nodeId"
                          placeholder="— выберите компонент —"
                          (valueChange)="setRowNode(i, $event)" />
                        <button type="button" class="cmp-edit"
                                [class.on]="componentEdit()?.index === i"
                                (click)="openComponentEditor(i, $event)"
                                title="Быстро редактировать компонент">✎</button>

                        @if (componentEdit()?.index === i) {
                          <div class="cmp-pop">
                            <div class="cmp-pop-head">
                              <b>Компонент</b>
                              <button type="button" class="cmp-pop-x" (click)="closeComponentEditor()">×</button>
                            </div>

                            @if (componentEdit()?.kind === 'raw') {
                              <label class="f">Название
                                <input [ngModel]="componentEditName()"
                                       (ngModelChange)="componentEditName.set($event)" />
                              </label>
                              <label class="f">Складская категория
                                <select [ngModel]="componentEditCategory()"
                                        (ngModelChange)="componentEditCategory.set($event)">
                                  @for (c of rawCategories(); track c.id) {
                                    <option [ngValue]="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
                                  }
                                </select>
                              </label>
                              <div class="cmp-pop-actions">
                                <button type="button" class="btn sm primary"
                                        [disabled]="componentEditSaving()"
                                        (click)="saveComponentEdit()">
                                  {{ componentEditSaving() ? 'Сохраняю…' : 'Сохранить' }}
                                </button>
                                <button type="button" class="btn sm" (click)="closeComponentEditor()">Отмена</button>
                              </div>
                            } @else {
                              <label class="f">Название (RU) *
                                <input [ngModel]="componentEditName()"
                                       (ngModelChange)="componentEditName.set($event)" />
                              </label>
                              <label class="f">Название (EN)
                                <input [ngModel]="componentEditNameEn()"
                                       (ngModelChange)="componentEditNameEn.set($event)" placeholder="optional" />
                              </label>
                              <label class="f">Название (SR)
                                <input [ngModel]="componentEditNameSr()"
                                       (ngModelChange)="componentEditNameSr.set($event)" placeholder="opciono" />
                              </label>
                              <label class="f">Каталог
                                <select [ngModel]="componentEditCatalogId()"
                                        (ngModelChange)="componentEditCatalogId.set($event)">
                                  <option [ngValue]="null">— без каталога —</option>
                                  @for (c of catalogs(); track c.id) {
                                    <option [ngValue]="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
                                  }
                                </select>
                              </label>
                              <div class="cmp-pop-actions">
                                <button type="button" class="btn sm primary"
                                        [disabled]="componentEditSaving()"
                                        (click)="saveComponentEdit()">
                                  {{ componentEditSaving() ? 'Сохраняю…' : 'Сохранить' }}
                                </button>
                                <button type="button" class="btn sm" (click)="openRecipeComponent()">
                                  Открыть рецептуру
                                </button>
                                <button type="button" class="btn sm" (click)="closeComponentEditor()">Закрыть</button>
                              </div>
                            }
                          </div>
                        }
                      </div>
                    </td>
                    <td class="num">
                      <input type="number" min="0" step="1" inputmode="numeric"
                             [ngModel]="rowQty(row)"
                             (ngModelChange)="setRowQty(i, $event)" />
                    </td>
                    <td>
                      <div class="unit-line">
                        <span>{{ rowUnitCode(row) }}</span>
                        @if (rowCanToggle(row)) {
                          <button type="button" class="unit-swap" (click)="toggleRowUnit(i)"
                                  title="Переключить единицу ввода: компонент ⇄ рецептура">⇄</button>
                        }
                      </div>
                      @if (rowConversion(row); as c) {
                        <div class="conv-hint" [class.missing]="c.missing">{{ c.text }}</div>
                      }
                    </td>
                    <td class="num">
                      <input type="number" min="0" max="99.9" step="any"
                             [ngModel]="row.lossPct ?? 0"
                             (ngModelChange)="patch(i, 'lossPct', $event)" />
                    </td>
                    <td style="text-align:center">
                      <input type="checkbox" [ngModel]="row.inMass" (ngModelChange)="patch(i, 'inMass', $event)" />
                    </td>
                    <td style="text-align:right">
                      <button type="button" class="btn sm danger" title="Удалить компонент"
                              (click)="removeRow(i)">✕</button>
                    </td>
                  </tr>
                } @empty {
                  <tr class="empty">
                    <td colspan="7">У этой рецептуры пока нет состава</td>
                  </tr>
                }
              </tbody>
            </table>

            <div class="add-wrap">
              @if (addOpen()) {
                  <div class="add-box">
                    <label class="f">Тип
                      <select [ngModel]="addKind()" (ngModelChange)="setAddKind($event)">
                        <option value="raw">Сырьё</option>
                        <option value="semi">Заготовка</option>
                        <option value="dish">Блюдо</option>
                      </select>
                    </label>
                    <label class="f" style="flex:1;min-width:220px">Компонент
                      <app-search-select
                        [options]="addOptions()"
                        [value]="addNodeId()"
                        placeholder="— выберите компонент —"
                        (valueChange)="setAddNode($event)" />
                    </label>
                    <label class="f">Количество
                      <input type="number" min="0" step="1" inputmode="numeric" [ngModel]="addDisplayQty() ?? ''"
                             (ngModelChange)="setAddQty($event)" />
                    </label>
                    <div class="add-unit-box">
                      <div class="unit-line">
                        <span>{{ addUnitCode() || '—' }}</span>
                        @if (addCanToggle()) {
                          <button type="button" class="unit-swap" (click)="toggleAddUnit()"
                                  title="Переключить единицу ввода: компонент ⇄ рецептура">⇄</button>
                        }
                      </div>
                      @if (addConversionHint(); as hint) {
                        <div class="conv-hint">{{ hint }}</div>
                      }
                    </div>
                    <label class="f">Потери, %
                      <input type="number" min="0" max="99.9" step="any" [ngModel]="addLoss() ?? 0"
                             (ngModelChange)="setAddLoss($event)" />
                    </label>
                    <label class="add-check">
                      <input type="checkbox" [ngModel]="addInMass" (ngModelChange)="addInMass.set($event)" /> в массе
                      <span class="hint" tabindex="0" aria-label="Что значит «В массе»">
                        ?
                        <span class="hint-pop">
                          <b>Учитывать в массе</b>
                          Компонент входит в сумму ингредиентов и в проверку «партия = сумма нетто».
                          Считается по количеству без потерь, с пересчётом в единицу рецептуры.
                          Если снять галочку, компонент всё равно списывается при выпуске, но не
                          включается в сумму и не влияет на контроль выхода.
                        </span>
                      </span>
                    </label>
                    <button type="button" class="btn sm primary" (click)="addRow()">Добавить</button>
                    <button type="button" class="btn sm" (click)="cancelAdd()">Отмена</button>
                    @if (!addCandidates().length) {
                      <span class="muted-sm">Все компоненты этого типа уже добавлены</span>
                    }
                  </div>
              } @else {
                <button type="button" class="btn sm" (click)="openAdd()">＋ Добавить компонент</button>
              }
            </div>

            <p class="muted-sm">
              Позиций: {{ draft().length }}.
              Изменения применятся в карте производства после «Сохранить».
            </p>

            <div class="pack-section">
              <div class="pack-head">
                <h3>Фасовки и цены</h3>
              </div>
              @if (draftPackagings().length) {
                <table class="tbl pack-table">
                  <thead>
                    <tr>
                      <th>
                        Тара
                        <span class="hint" tabindex="0" aria-label="Что такое тара">
                          ?
                          <span class="hint-pop left">
                            <b>Тара</b>
                            Складские упаковки, в которые фасуется продукт: банка, крышка,
                            контейнер или одноразовая посуда из категории «упаковка».
                            На одну фасовку можно добавить несколько позиций без повторов.
                          </span>
                        </span>
                      </th>
                      <th class="num">
                        Выход, {{ draftUnitCode() }}
                        <span class="hint" tabindex="0" aria-label="Что значит выход фасовки">
                          ?
                          <span class="hint-pop left">
                            <b>Выход фасовки</b>
                            Вес, объём или количество одной упаковки в единице рецептуры
                            ({{ draftUnitCode() }}). По нему пересчитываются заказы и печатный отчёт.
                          </span>
                        </span>
                      </th>
                      <th class="num">
                        Мин. заказ
                        <span class="hint" tabindex="0" aria-label="Что значит минимальный заказ">
                          ?
                          <span class="hint-pop">
                            <b>Минимальный заказ</b>
                            Сколько упаковок минимум можно заказать магазину. Всегда кратно
                            одной партии: выход рецептуры ÷ выход фасовки, округление вверх.
                            Целое число от 1.
                          </span>
                        </span>
                      </th>
                      <th class="num">
                        Цена, RSD
                        <span class="hint" tabindex="0" aria-label="Как указывается цена">
                          ?
                          <span class="hint-pop">
                            <b>Цена продажи</b>
                            В RSD за базу, выбранную в колонке «Цена за». Для фасовки,
                            доступной магазинам, цена обязательна.
                          </span>
                        </span>
                      </th>
                      <th>
                        Цена за
                        <span class="hint" tabindex="0" aria-label="База цены">
                          ?
                          <span class="hint-pop">
                            <b>База цены</b>
                            За что указана цена: за единицу ({{ draftUnitCode() }}), за упаковку
                            (порцию) или за штуку. От этого зависит сумма в отчёте.
                          </span>
                        </span>
                      </th>
                      <th class="num">
                        Себест., RSD
                        <span class="hint" tabindex="0" aria-label="Что такое себестоимость">
                          ?
                          <span class="hint-pop">
                            <b>Себестоимость</b>
                            Внутренняя стоимость в RSD за ту же базу, что и цена. Используется
                            в отчёте «по себестоимости» и не показывается магазинам.
                          </span>
                        </span>
                      </th>
                      <th>
                        В доставке
                        <span class="hint" tabindex="0" aria-label="Что значит «В доставке»">
                          ?
                          <span class="hint-pop">
                            <b>Доступна магазинам</b>
                            Разрешает заказывать эту фасовку. В каталог заказов попадают только
                            включённые фасовки.
                          </span>
                        </span>
                      </th>
                      <th style="width:42px"></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of draftPackagings(); track $index; let i = $index) {
                      <tr>
                        <td class="tare-cell">
                          @if (p.tareProductIds.length) {
                            <div class="tare-chips">
                              @for (tareId of p.tareProductIds; track tareId) {
                                <span class="tare-chip">
                                  {{ tareName(tareId) }}
                                  <button type="button" (click)="removeTare(i, tareId)"
                                          title="Убрать тару">✕</button>
                                </span>
                              }
                            </div>
                          }
                          @if (tareOptionsFor(p).length) {
                            <button type="button" class="tare-add" (click)="openTarePicker($event, i)"
                                    title="Добавить упаковку" aria-label="Добавить упаковку">＋</button>
                          }
                        </td>
                        <td class="num">
                          <input type="number" min="0" step="any" [ngModel]="p.qtyBase"
                                 (ngModelChange)="patchPackaging(i, 'qtyBase', $event)"
                                 (blur)="normalizeMinOrder(i)" />
                        </td>
                        <td class="num">
                          <input type="number" min="1" step="1" [ngModel]="p.minOrder"
                                 (ngModelChange)="patchPackaging(i, 'minOrder', $event)"
                                 (blur)="normalizeMinOrder(i)" />
                        </td>
                        <td class="num">
                          <input type="number" min="0" step="0.01" [ngModel]="p.price"
                                 (ngModelChange)="patchPackaging(i, 'price', $event)" />
                        </td>
                        <td>
                          <select [ngModel]="p.priceBasis" (ngModelChange)="patchPackaging(i, 'priceBasis', $event)">
                            <option value="unit">за {{ draftUnitCode() }}</option>
                            <option value="portion">за упаковку</option>
                            <option value="piece">за шт</option>
                          </select>
                        </td>
                        <td class="num">
                          <input type="number" min="0" step="0.01" [ngModel]="p.cost"
                                 (ngModelChange)="patchPackaging(i, 'cost', $event)" />
                        </td>
                        <td style="text-align:center">
                          <input type="checkbox" [ngModel]="p.available"
                                 (ngModelChange)="patchPackaging(i, 'available', $event)" />
                        </td>
                        <td style="text-align:right">
                          <button type="button" class="btn sm danger" title="Удалить фасовку"
                                  (click)="removePackaging(i)">✕</button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="muted-sm">Фасовок пока нет — добавьте, если рецептура продаётся.</p>
              }
              <button type="button" class="btn sm pack-add" (click)="addPackaging()">＋ Добавить фасовку</button>
            </div>
          } @else {
            <div class="empty-state">У этой рецептуры нет операции-производителя, состава нет.</div>
          }
        } @else {
          <div class="empty-state placeholder">
            <div class="ph-icon">📖</div>
            <b>Выберите рецептуру слева</b>
            <span>Список сгруппирован по каталогам. После выбора сразу откроется форма редактирования состава.</span>
          </div>
        }
      </section>
    </div>

    @if (tarePicker(); as tp) {
      <div class="tare-pop-backdrop" (click)="closeTarePicker()"></div>
      <div class="tare-pop" role="dialog" aria-label="Добавить упаковку"
           [style.top]="tp.top != null ? tp.top + 'px' : null"
           [style.bottom]="tp.bottom != null ? tp.bottom + 'px' : null"
           [style.left.px]="tp.left">
        <div class="tare-pop-head">Добавить упаковку</div>
        @for (t of tareOptionsForIndex(tp.index); track t.id) {
          <button type="button" class="tare-pop-item" (click)="pickTare(tp.index, t.id)">{{ t.name }}</button>
        } @empty {
          <div class="tare-pop-empty">Все позиции «упаковки» уже добавлены</div>
        }
      </div>
    }

    @if (rawCard(); as p) {
      <app-product-card [product]="p" [initialTab]="'edit'"
                        (saved)="onRawCardSaved()" (closed)="rawCard.set(null)" />
    }
  `,
})
export class RecipesComponent implements OnInit {
  private api = inject(ApiService);

  /** Встроенный режим: скрыть шапку и список, показать только окно редактора одной рецептуры. */
  readonly embedded = input(false);
  /** Какую рецептуру открыть во встроенном режиме. */
  readonly embedNodeId = input<number | null>(null);
  /** Окно закрыто пользователем — хост сам решает, что делать дальше. */
  readonly editorClosed = output<void>();

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly err = signal('');
  readonly msg = signal('');

  readonly map = signal<ProductionMap | null>(null);
  readonly products = signal<Product[]>([]);
  readonly units = signal<Unit[]>([]);
  readonly catalogs = signal<ProductCatalog[]>([]);

  /** Вкладки раздельные; поиск по названию общий для обеих. */
  readonly tab = signal<RecipeTab>('output');
  readonly query = signal('');
  /** Каталог блюд; запоминается между открытиями раздела. */
  readonly catalogFilter = signal('');
  /** Показывать только рецепты, участвующие в продаже (по умолчанию — да). */
  readonly onSaleOnly = signal(true);
  readonly selectedId = signal<number | null>(null);
  readonly recentIds = signal<number[]>([]);
  readonly draft = signal<DraftInput[]>([]);
  readonly editing = signal(false);

  readonly draftName = signal('');
  readonly draftNameEn = signal('');
  readonly draftNameSr = signal('');
  readonly draftNote = signal('');
  readonly draftCatalogId = signal<number | null>(null);
  readonly draftPortionQty = signal(0);
  readonly draftUnitId = signal<number | null>(null);
  readonly draftPackagings = signal<DraftPackaging[]>([]);
  /** Всплывающий выбор упаковки для «＋» в фасовке (фиксированные координаты). */
  readonly tarePicker = signal<{
    index: number;
    left: number;
    top: number | null;
    bottom: number | null;
  } | null>(null);

  readonly draftUnitCode = computed(
    () =>
      this.units().find((u) => u.id === this.draftUnitId())?.code ??
      this.node()?.unitCode ??
      ''
  );

  readonly baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));

  /** id категории «упаковка» из справочника — по нему фильтруем тару. */
  readonly packagingCategoryId = computed(() =>
    this.rawCategories().find((c) => c.name.trim().toLowerCase() === 'упаковка')?.id ?? null
  );

  /** Тара: активные складские позиции категории «упаковка». */
  readonly tareOptions = computed(() => {
    const packagingId = this.packagingCategoryId();
    return this.products()
      .filter((p) => packagingId != null && p.categoryId === packagingId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });
  /** Каталог нужен только когда у рецептуры есть заполненная фасовка. */
  readonly showCatalog = computed(() =>
    this.draftPackagings().some((p) => Number(p.qtyBase) > 0)
  );

  readonly componentEdit = signal<ComponentEditState | null>(null);
  readonly componentEditName = signal('');
  readonly componentEditNameEn = signal('');
  readonly componentEditNameSr = signal('');
  readonly componentEditCatalogId = signal<number | null>(null);
  readonly componentEditCategory = signal<number | null>(null);
  readonly componentEditSaving = signal(false);
  readonly rawCategories = signal<RawCategory[]>([]);
  private rawCategoriesLoaded = false;

  /** Карточка складской позиции (тот же редактор, что на «Складе»). */
  readonly rawCard = signal<ProductCardItem | null>(null);
  /** Редактор рецептуры во всплывающем окне. */
  readonly editorModal = signal(false);
  private editorReturn: EditorSnapshot | null = null;

  readonly addOpen = signal(false);
  readonly addKind = signal<AddKind>('raw');
  readonly addNodeId = signal<number | null>(null);
  readonly addQty = signal<number | null>(null);
  readonly addLoss = signal<number | null>(null);
  readonly addInMass = signal(true);
  readonly addDisplayUnit = signal<'source' | 'target' | 'alt'>('source');

  readonly node = computed<MapNode | null>(() => {
    const id = this.selectedId();
    return id == null ? null : this.map()?.nodes.find((n) => n.id === id) ?? null;
  });

  /** Роль в редакторе — по текущим (ещё не сохранённым) фасовкам. */
  readonly currentRole = computed<RecipeTab>(() =>
    this.draftPackagings().length > 0 ? 'output' : 'state'
  );

  readonly op = computed<MapOp | null>(() => {
    const id = this.selectedId();
    return id == null ? null : this.map()?.ops.find((o) => o.outputNodeId === id) ?? null;
  });

  /** Список сгруппирован по каталогам в порядке их настройки. */
  readonly groups = computed<RecipeGroup[]>(() => {
    const order = new Map(this.catalogs().map((c, i) => [String(c.id), i] as const));
    const by = new Map<string, RecipeGroup>();
    for (const row of this.rows()) {
      const cat = this.catalogOf(row.catalogId);
      const key = cat ? String(cat.id) : 'none';
      const group =
        by.get(key) ??
        ({
          key,
          title: cat?.name ?? 'Без каталога',
          icon: cat?.icon ?? '',
          color: cat?.color ?? '#eef2f5',
          items: [],
        } as RecipeGroup);
      group.items.push(row);
      by.set(key, group);
    }
    return [...by.values()]
      .map((g) => ({ ...g, items: g.items.sort((a, b) => a.name.localeCompare(b.name, 'ru')) }))
      .sort((a, b) => {
        const oa = order.get(a.key) ?? Number.MAX_SAFE_INTEGER;
        const ob = order.get(b.key) ?? Number.MAX_SAFE_INTEGER;
        return oa - ob || a.title.localeCompare(b.title, 'ru');
      });
  });

  /** Блюдо — только рецептура с хотя бы одной фасовкой; без фасовок это заготовка. */
  private isDishNode(n: MapNode): boolean {
    return (n.packagings?.length ?? 0) > 0;
  }

  roleOf(n: MapNode): RecipeTab {
    return this.isDishNode(n) ? 'output' : 'state';
  }

  /** Есть ли несохранённые правки состава. */
  readonly dirty = computed(() => {
    if (!this.editing()) return false;
    const node = this.node();
    const op = this.op();
    if (!node || !op) return false;

    if (
      this.draftName().trim() !== node.name ||
      (this.draftNameEn() ?? '') !== (node.nameEn ?? '') ||
      (this.draftNameSr() ?? '') !== (node.nameSr ?? '') ||
      (this.draftNote() ?? '') !== (node.note ?? '') ||
      this.draftCatalogId() !== node.catalogId ||
      Math.abs(Number(this.draftPortionQty()) - Number(node.portionQty || 0)) > 1e-9 ||
      this.draftUnitId() !== node.unitId
    ) {
      return true;
    }

    const before = op.inputs.map((i) => ({
      nodeId: i.nodeId,
      qty: Number(i.qty),
      lossPct: i.lossPct == null ? null : Number(i.lossPct),
      inMass: i.inMass !== false,
    }));
    const after = this.draft();
    if (before.length !== after.length) return true;
    if (
      before.some((b, i) => {
        const a = after[i];
        return (
          b.nodeId !== a.nodeId ||
          Math.abs(b.qty - a.qty) > 1e-9 ||
          (b.lossPct ?? 0) !== (a.lossPct ?? 0) ||
          b.inMass !== a.inMass
        );
      })
    ) {
      return true;
    }

    const packsBefore = (node.packagings ?? []).map((p) => ({
      uid: p.id,
      qtyBase: Number(p.qtyBase),
      minOrder: Number(p.minOrder),
      price: Number(p.price),
      priceBasis: p.priceBasis,
      cost: Number(p.cost),
      available: p.available !== false,
      isDefault: !!p.isDefault,
      tareProductIds: [...(p.tareProductIds ?? [])],
    }));
    const packsAfter = this.draftPackagings();
    if (packsBefore.length !== packsAfter.length) return true;
    return packsBefore.some((b, i) => {
      const a = packsAfter[i];
      return (
        b.uid !== a.uid ||
        Math.abs(b.qtyBase - a.qtyBase) > 1e-9 ||
        b.minOrder !== a.minOrder ||
        Math.abs(b.price - a.price) > 1e-9 ||
        b.priceBasis !== a.priceBasis ||
        Math.abs(b.cost - a.cost) > 1e-9 ||
        b.available !== a.available ||
        b.isDefault !== a.isDefault ||
        b.tareProductIds.join(',') !== a.tareProductIds.join(',')
      );
    });
  });

  private matchesKind(n: MapNode, kind: AddKind): boolean {
    if (kind === 'raw') return n.kind === 'product';
    if (n.kind === 'product') return false;
    const dish = (n.packagings?.length ?? 0) > 0;
    return kind === 'dish' ? dish : !dish;
  }

  /** Сумма ингредиентов «в массе», пересчитанная в единицу партии. */
  readonly ingredientSum = computed<{ value: number; partial: boolean } | null>(() => {
    const node = this.node();
    const m = this.map();
    if (!node || !m || !this.draft().length) return null;
    const targetUnitId = this.draftUnitId() ?? node.unitId;
    let sum = 0;
    let partial = false;
    for (const row of this.draft()) {
      if (!row.inMass) continue;
      const src = m.nodes.find((n) => n.id === row.nodeId);
      if (!src || !(row.qty > 0)) continue;
      const product =
        src.kind === 'product' && src.refId != null
          ? this.products().find((p) => p.id === src.refId)
          : undefined;
      const conv = product
        ? { gPerPcs: product.gPerPcs, mlPerPcs: product.mlPerPcs, gPerMl: product.gPerMl }
        : null;
      const converted = toBaseClient(this.units(), row.qty, src.unitId, targetUnitId, conv);
      if (converted == null) {
        partial = true;
        continue;
      }
      sum += converted;
    }
    return { value: Math.round(sum * 1000) / 1000, partial };
  });

  readonly sumDiffers = computed(() => {
    const sum = this.ingredientSum();
    const plan = this.draftPortionQty() > 0 ? this.draftPortionQty() : this.num(this.node()?.portionQty);
    if (!sum || !(plan > 0) || sum.partial) return false;
    return Math.abs(sum.value - plan) > 0.01;
  });

  readonly sumStatus = computed(() => {
    const sum = this.ingredientSum();
    if (!sum) return '';
    if (sum.partial) {
      return 'рассчитано частично: не все компоненты переводятся в единицу партии';
    }
    const plan = this.draftPortionQty() > 0 ? this.draftPortionQty() : this.num(this.node()?.portionQty);
    if (!(plan > 0)) return '';
    const diff = Math.round((sum.value - plan) * 1000) / 1000;
    const unit = this.draftUnitCode();
    if (Math.abs(diff) <= 0.01) return 'совпадает с партией';
    return `${diff > 0 ? 'больше' : 'меньше'} партии на ${fmtQty(Math.abs(diff), unit)}`;
  });

  readonly addCandidates = computed<MapNode[]>(() => {
    const m = this.map();
    if (!m) return [];
    const used = new Set(this.draft().map((d) => d.nodeId));
    const self = this.selectedId();
    return m.nodes
      .filter((n) => this.matchesKind(n, this.addKind()) && n.id !== self && !used.has(n.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  readonly addUnitCode = computed(() => {
    const model = this.addModel();
    return model ? this.rowUnitCode(model) : '';
  });

  private addSrc(): MapNode | null {
    const id = this.addNodeId();
    return id == null ? null : this.map()?.nodes.find((n) => n.id === id) ?? null;
  }

  private addModel(): DraftInput | null {
    const id = this.addNodeId();
    if (id == null) return null;
    return {
      nodeId: id,
      qty: this.addQty() ?? 0,
      lossPct: this.addLoss(),
      inMass: this.addInMass(),
      displayUnit: this.addDisplayUnit(),
    };
  }

  addCanToggle(): boolean {
    const model = this.addModel();
    return !!model && this.rowCanToggle(model);
  }

  addDisplayQty(): number | null {
    const model = this.addModel();
    if (!model || this.addQty() == null) return null;
    return this.rowQty(model);
  }

  addConversionHint(): string {
    const model = this.addModel();
    if (!model || this.addQty() == null || !(this.addQty()! > 0)) return '';
    return this.rowConversion(model)?.text ?? '';
  }

  toggleAddUnit(): void {
    const model = this.addModel();
    if (!model) return;
    const choices = this.rowChoices(model);
    if (choices.length < 2) return;
    const at = Math.max(0, choices.indexOf(model.displayUnit));
    this.addDisplayUnit.set(choices[(at + 1) % choices.length]);
  }

  setAddNode(id: number | null): void {
    this.addNodeId.set(id);
    this.addDisplayUnit.set('source');
  }

  /** Каталоги, в которых реально есть блюда (рецептуры с фасовками). */
  readonly dishCatalogs = computed<ProductCatalog[]>(() => {
    const m = this.map();
    if (!m) return [];
    const used = new Set(
      m.nodes
        .filter((n) => n.kind !== 'product' && (n.packagings?.length ?? 0) > 0 && n.catalogId != null)
        .map((n) => Number(n.catalogId))
    );
    return this.catalogs().filter((c) => used.has(c.id));
  });

  private componentOptions(candidates: MapNode[], kind: AddKind): SearchOption[] {
    const catalogRank = new Map(this.catalogs().map((c, i) => [c.id, i] as const));
    const rows = candidates.map((n) => {
      let group: string | undefined;
      let rank = 0;
      if (kind === 'raw') {
        group = this.products().find((p) => p.id === n.refId)?.categoryName?.trim() || 'прочее';
        rank = group === 'прочее' ? 999 : 0;
      } else if (kind === 'dish') {
        const cat = this.catalogOf(n.catalogId);
        group = cat
          ? `${cat.icon ? cat.icon + ' ' : ''}${cat.name}`
          : 'Без каталога';
        rank = cat ? catalogRank.get(cat.id) ?? 999 : 999;
      }
      return { id: n.id, label: `${n.name} · ${n.unitCode}`, group, rank };
    });
    rows.sort((a, b) => {
      const ga = a.group ?? '';
      const gb = b.group ?? '';
      return a.rank - b.rank || ga.localeCompare(gb, 'ru') || a.label.localeCompare(b.label, 'ru');
    });
    return rows.map(({ id, label, group }) => ({ id, label, group }));
  }

  readonly addOptions = computed<SearchOption[]>(() =>
    this.componentOptions(this.addCandidates(), this.addKind())
  );

  rowOptions(index: number): SearchOption[] {
    const row = this.draft()[index];
    if (!row) return [];
    return this.componentOptions(
      this.rowCandidates(this.rowKind(row.nodeId), index),
      this.rowKind(row.nodeId)
    );
  }

  readonly recentRecipes = computed<MapNode[]>(() => {
    const m = this.map();
    if (!m) return [];
    return this.recentIds()
      .map((id) => m.nodes.find((n) => n.id === id && n.kind !== 'product'))
      .filter((n): n is MapNode => !!n);
  });

  /**
   * Рецептуры, участвующие в продаже: блюда с доступной фасовкой и вся их
   * цепочка заготовок вверх по составу. Всё остальное не попадает в выборку.
   */
  readonly saleNodeIds = computed<Set<number>>(() => {
    const m = this.map();
    const set = new Set<number>();
    if (!m) return set;
    const opByOut = new Map(m.ops.map((o) => [o.outputNodeId, o] as const));
    const queue: number[] = [];
    for (const n of m.nodes) {
      if (n.kind === 'product') continue;
      if ((n.packagings ?? []).some((p) => p.available)) {
        set.add(n.id);
        queue.push(n.id);
      }
    }
    while (queue.length) {
      const id = queue.pop() as number;
      const op = opByOut.get(id);
      if (!op) continue;
      for (const i of op.inputs) {
        if (set.has(i.nodeId)) continue;
        const src = m.nodes.find((n) => n.id === i.nodeId);
        if (!src || src.kind === 'product') continue;
        set.add(i.nodeId);
        queue.push(i.nodeId);
      }
    }
    return set;
  });

  readonly rows = computed<RecipeRow[]>(() => {
    const m = this.map();
    if (!m) return [];
    const q = this.query().trim().toLowerCase();
    // Фильтр каталога относится только к блюдам; поиск общий для двух вкладок.
    const cat = this.tab() === 'output' ? this.catalogFilter() : '';
    return m.nodes
      .filter((n) => n.kind !== 'product')
      .filter((n) => this.roleOf(n) === this.tab())
      .filter((n) => !this.onSaleOnly() || this.saleNodeIds().has(n.id))
      .filter((n) => !cat || String(n.catalogId ?? '') === cat)
      .filter((n) => !q || n.name.toLowerCase().includes(q))
      .map((n) => {
        const op = m.ops.find((o) => o.outputNodeId === n.id);
        return {
          id: n.id,
          kind: this.roleOf(n),
          name: n.name,
          nameEn: n.nameEn ?? '',
          catalogId: n.catalogId,
          unitId: n.unitId,
          unitCode: n.unitCode,
          portionQty: Number(n.portionQty) || 0,
          packagings: n.packagings?.length ?? 0,
          inputs: op?.inputs.length ?? 0,
          note: n.note ?? '',
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  ngOnInit(): void {
    try {
      this.catalogFilter.set(localStorage.getItem('recipes.catalog') ?? '');
      this.onSaleOnly.set(localStorage.getItem('recipes.onSale') !== '0');
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      if (Array.isArray(raw)) {
        this.recentIds.set(
          raw.filter((id) => Number.isInteger(id) && id > 0).slice(0, 8)
        );
      }
    } catch {
      /* приватный режим */
    }
    this.api.rawCategories$().subscribe({
      next: (cats) => {
        this.rawCategories.set(cats);
        this.rawCategoriesLoaded = true;
      },
      error: () => {
        this.rawCategoriesLoaded = false;
      },
    });
    this.reload();
  }

  private reload(): void {
    this.loading.set(true);
    this.err.set('');
    let done = 0;
    const finish = (e?: string): void => {
      if (e) this.err.set(e);
      if (++done === 4) {
        this.loading.set(false);
        const cat = this.catalogFilter();
        if (cat && !this.dishCatalogs().some((c) => String(c.id) === cat)) {
          this.catalogFilter.set('');
          try {
            localStorage.removeItem('recipes.catalog');
          } catch {
            /* приватный режим */
          }
        }
        const keep = this.selectedId();
        let chosen = keep == null ? null : this.rows().find((r) => r.id === keep) ?? null;
        const embeddedId = this.embedded() ? this.embedNodeId() : null;
        if (embeddedId != null) {
          // Встроенное окно с отчёта: сразу открываем нужную рецептуру в редакторе.
          const node = this.map()?.nodes.find((n) => n.id === embeddedId && n.kind !== 'product');
          if (node) {
            this.editing.set(false);
            this.componentEdit.set(null);
            this.select(node.id, false);
            this.editorModal.set(true);
          } else {
            this.err.set('Рецептура не найдена — возможно, её удалили');
          }
          return;
        }
        if (!chosen && keep != null) {
          // Рецептура могла сменить роль (заготовка с фасовкой стала блюдом) —
          // переключаем вкладку и показываем её там.
          const node = this.map()?.nodes.find((n) => n.id === keep);
          if (node && node.kind !== 'product') {
            const role = this.roleOf(node);
            if (role !== this.tab()) {
              this.tab.set(role);
              // Если каталог-фильтр скрывает новую роль, сбрасываем его.
              if (role === 'output' && !this.rows().some((r) => r.id === keep)) {
                this.catalogFilter.set('');
                try {
                  localStorage.removeItem('recipes.catalog');
                } catch {
                  /* приватный режим */
                }
              }
              chosen = this.rows().find((r) => r.id === keep) ?? null;
            }
          }
        }
        if (chosen) this.select(chosen.id, false);
        else this.clearSelection();
      }
    };
    this.api.productionMap$().subscribe({
      next: (m) => { this.map.set(m); finish(); },
      error: (e) => finish(httpErr(e)),
    });
    this.api.products$({ active: 'true' }).subscribe({
      next: (p) => { this.products.set(p); finish(); },
      error: (e) => finish(httpErr(e)),
    });
    this.api.units$().subscribe({
      next: (u) => { this.units.set(u); finish(); },
      error: (e) => finish(httpErr(e)),
    });
    this.api.productCatalogs$().subscribe({
      next: (c) => { this.catalogs.set(c); finish(); },
      error: (e) => finish(httpErr(e)),
    });
  }

  openRecent(id: number): void {
    if (id === this.selectedId()) return;
    if (!this.confirmDiscard()) return;
    const node = this.map()?.nodes.find((n) => n.id === id && n.kind !== 'product');
    if (!node) return;
    this.componentEdit.set(null);
    this.query.set('');
    this.editing.set(false);
    this.addOpen.set(false);
    const role = this.roleOf(node);
    this.tab.set(role);
    if (role === 'output' && this.catalogFilter() && !this.rows().some((r) => r.id === id)) {
      this.catalogFilter.set('');
    }
    this.select(id, false);
  }

  /** Роутер вызывает перед уходом со страницы: несохранённые правки не теряем молча. */
  canDeactivate(): boolean {
    if (!this.editing() || !this.dirty()) return true;
    return confirm('В рецептуре есть несохранённые изменения. Уйти со страницы и потерять их?');
  }

  /** Закрытие/обновление вкладки: браузер покажет своё предупреждение. */
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(ev: BeforeUnloadEvent): void {
    if (!this.dirty()) return;
    ev.preventDefault();
    ev.returnValue = '';
  }

  private confirmDiscard(): boolean {
    if (!this.editing() || !this.dirty()) return true;
    return confirm('В составе есть несохранённые изменения. Отменить их?');
  }

  setCatalog(value: string): void {
    if (!this.confirmDiscard()) return;
    const id = value || '';
    this.catalogFilter.set(id);
    try {
      if (id) localStorage.setItem('recipes.catalog', id);
      else localStorage.removeItem('recipes.catalog');
    } catch {
      /* приватный режим */
    }
    this.msg.set('');
    const current = this.selectedId();
    if (current != null && this.rows().some((r) => r.id === current)) {
      // Рецептура осталась в отфильтрованном списке — оставляем её и сбрасываем правки.
      this.addOpen.set(false);
      this.loadDraft(current);
      return;
    }
    this.clearSelection();
  }

  setOnSaleOnly(value: boolean): void {
    if (this.onSaleOnly() === value) return;
    if (!this.confirmDiscard()) return;
    this.onSaleOnly.set(value);
    try {
      localStorage.setItem('recipes.onSale', value ? '1' : '0');
    } catch {
      /* приватный режим */
    }
    this.msg.set('');
    const current = this.selectedId();
    if (current != null && !this.rows().some((r) => r.id === current)) {
      this.clearSelection();
    }
  }

  setTab(kind: RecipeTab): void {
    if (this.tab() === kind) return;
    if (!this.confirmDiscard()) return;
    this.tab.set(kind);
    this.msg.set('');
    // Поиск не сбрасываем: он общий для блюд и заготовок.
    this.clearSelection();
  }

  private clearSelection(): void {
    this.componentEdit.set(null);
    this.selectedId.set(null);
    this.draft.set([]);
    this.draftPackagings.set([]);
    this.draftName.set('');
    this.draftNameEn.set('');
    this.draftNameSr.set('');
    this.draftNote.set('');
    this.draftCatalogId.set(null);
    this.draftPortionQty.set(0);
    this.draftUnitId.set(null);
    this.editing.set(false);
    this.addOpen.set(false);
  }

  countOf(kind: RecipeTab): number {
    const set = this.saleNodeIds();
    return (
      this.map()?.nodes.filter(
        (n) => n.kind !== 'product' && this.roleOf(n) === kind && (!this.onSaleOnly() || set.has(n.id))
      ).length ?? 0
    );
  }

  select(id: number, clearMessage = true): void {
    // Клик по уже выбранной рецептуре в режиме правки не должен сбрасывать изменения.
    if (id === this.selectedId() && this.editing()) return;
    if (id !== this.selectedId() && !this.confirmDiscard()) return;
    // Выбрали рецептуру — сразу показываем форму редактирования состава.
    this.componentEdit.set(null);
    this.editing.set(true);
    this.addOpen.set(false);
    this.selectedId.set(id);
    if (clearMessage) this.msg.set('');
    this.loadDraft(id);
    this.rememberRecent(id);
  }

  private rememberRecent(id: number): void {
    this.recentIds.update((list) => [id, ...list.filter((x) => x !== id)].slice(0, 8));
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recentIds()));
    } catch {
      /* приватный режим */
    }
  }

  private loadDraft(id: number): void {
    this.closeTarePicker();
    const m = this.map();
    const node = m?.nodes.find((n) => n.id === id) ?? null;
    const op = m?.ops.find((o) => o.outputNodeId === id);
    this.draftName.set(node?.name ?? '');
    this.draftNameEn.set(node?.nameEn ?? '');
    this.draftNameSr.set(node?.nameSr ?? '');
    this.draftNote.set(node?.note ?? '');
    this.draftCatalogId.set(node?.catalogId ?? null);
    this.draftPortionQty.set(Number(node?.portionQty) || 0);
    this.draftUnitId.set(node?.unitId ?? null);
    this.draftPackagings.set(
      (node?.packagings ?? []).map((p) => {
        const qtyBase = Number(p.qtyBase);
        return {
          uid: p.id,
          qtyBase,
          minOrder: batchMinOrder(Number(node?.portionQty) || 0, qtyBase, Number(p.minOrder) || 1),
          price: Number(p.price) || 0,
          priceBasis: p.priceBasis,
          cost: Number(p.cost) || 0,
          available: p.available !== false,
          isDefault: !!p.isDefault,
          tareProductIds: [...(p.tareProductIds ?? [])],
        };
      })
    );
    this.draft.set(
      (op?.inputs ?? []).map((i) => ({
        nodeId: i.nodeId,
        qty: Number(i.qty),
        lossPct: i.lossPct == null ? null : Number(i.lossPct),
        inMass: i.inMass !== false,
        displayUnit: 'source' as const,
      }))
    );
  }

  setDraftPortionQty(value: unknown): void {
    const n = value === '' || value == null ? 0 : Number(value);
    this.draftPortionQty.set(Number.isFinite(n) ? n : 0);
  }

  beginEdit(): void {
    if (!this.op()) return;
    this.editing.set(true);
    this.addOpen.set(false);
    this.msg.set('');
    this.err.set('');
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.addOpen.set(false);
    this.err.set('');
    const id = this.selectedId();
    if (id != null) this.select(id, false);
  }

  private catalogIdByName(name: string): number | null {
    return this.catalogs().find((c) => c.name.trim().toLowerCase() === name)?.id ?? null;
  }

  addPackaging(): void {
    const portion = this.draftPortionQty() || this.num(this.node()?.portionQty) || 1000;
    const hadPacks = this.draftPackagings().length > 0;
    const hasDefault = this.draftPackagings().some((p) => p.isDefault);
    this.draftPackagings.update((list) => [
      ...list,
      {
        qtyBase: portion,
        minOrder: 1,
        price: 0,
        priceBasis: 'unit',
        cost: 0,
        available: false,
        isDefault: !hasDefault,
        tareProductIds: [],
      },
    ]);
    if (!hadPacks) {
      // Первая фасовка превращает заготовку в блюдо; по умолчанию — каталог «прочее».
      const current = this.catalogOf(this.draftCatalogId());
      const currentName = (current?.name ?? '').trim().toLowerCase();
      if (!current || currentName === 'заготовки') {
        const other = this.catalogIdByName('прочее');
        if (other != null) this.draftCatalogId.set(other);
      }
    }
  }

  removePackaging(index: number): void {
    const p = this.draftPackagings()[index];
    if (!p) return;
    if (!confirm(`Удалить фасовку «${this.packWeight(p)}»?`)) return;
    this.closeTarePicker();
    const next = this.draftPackagings().filter((_, i) => i !== index);
    if (next.length && !next.some((x) => x.isDefault)) next[0].isDefault = true;
    this.draftPackagings.set(next);

    if (!next.length) {
      // Последняя фасовка убрана — блюдо сразу становится заготовкой, каталог сбрасывается.
      const prep = this.catalogIdByName('заготовки');
      this.draftCatalogId.set(prep);
    }
  }

  patchPackaging(index: number, field: keyof DraftPackaging, value: unknown): void {
    this.draftPackagings.update((list) =>
      list.map((p, i) => {
        if (i !== index) return p;
        if (field === 'available') return { ...p, available: !!value };
        if (field === 'priceBasis') {
          const basis = value === 'portion' || value === 'piece' ? value : 'unit';
          return { ...p, priceBasis: basis as DraftPackaging['priceBasis'] };
        }
        if (field === 'uid' || field === 'isDefault') return p;
        const n = Number(value);
        return { ...p, [field]: Number.isFinite(n) ? n : 0 } as DraftPackaging;
      })
    );
  }

  /** Мин. заказ — целое число партий рецептуры; выравниваем после правки выхода или фасовки. */
  normalizeMinOrder(index: number): void {
    const p = this.draftPackagings()[index];
    if (!p) return;
    const minOrder = batchMinOrder(this.draftPortionQty(), p.qtyBase, p.minOrder);
    if (minOrder !== p.minOrder) this.patchPackaging(index, 'minOrder', minOrder);
  }

  alignMinOrders(): void {
    const portion = this.draftPortionQty();
    this.draftPackagings.update((list) =>
      list.map((p) => ({ ...p, minOrder: batchMinOrder(portion, p.qtyBase, p.minOrder) }))
    );
  }

  /** Тара, которую ещё можно добавить к этой фасовке (без повторов). */
  tareOptionsFor(p: DraftPackaging): { id: number; name: string }[] {
    const chosen = new Set(p.tareProductIds);
    return this.tareOptions().filter((t) => !chosen.has(t.id));
  }

  tareOptionsForIndex(index: number): { id: number; name: string }[] {
    const p = this.draftPackagings()[index];
    return p ? this.tareOptionsFor(p) : [];
  }

  /** «＋» у фасовки: окошко со свободными позициями категории «упаковка». */
  openTarePicker(e: MouseEvent, index: number): void {
    if (this.tarePicker()?.index === index) {
      this.closeTarePicker();
      return;
    }
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const width = 250;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const openUp = rect.bottom + 320 > window.innerHeight;
    this.tarePicker.set({
      index,
      left,
      top: openUp ? null : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : null,
    });
  }

  closeTarePicker(): void {
    this.tarePicker.set(null);
  }

  pickTare(index: number, id: number): void {
    this.addTare(index, id);
    this.closeTarePicker();
  }

  tareName(id: number): string {
    return this.tareOptions().find((t) => t.id === id)?.name ?? `#${id}`;
  }

  addTare(index: number, value: unknown): void {
    const id = value == null || value === '' ? null : Number(value);
    if (id == null || !Number.isFinite(id)) return;
    this.draftPackagings.update((list) =>
      list.map((p, i) =>
        i === index && !p.tareProductIds.includes(id)
          ? { ...p, tareProductIds: [...p.tareProductIds, id] }
          : p
      )
    );
  }

  removeTare(index: number, id: number): void {
    this.draftPackagings.update((list) =>
      list.map((p, i) =>
        i === index ? { ...p, tareProductIds: p.tareProductIds.filter((x) => x !== id) } : p
      )
    );
  }

  packWeight(p: DraftPackaging): string {
    return `${Number(p.qtyBase.toFixed(3))} ${this.draftUnitCode()}`;
  }

  removeRow(index: number): void {
    const row = this.draft()[index];
    if (!row) return;
    if (!confirm(`Удалить «${this.nodeName(row.nodeId)}» из состава?`)) return;
    this.componentEdit.set(null);
    this.draft.update((list) => list.filter((_, i) => i !== index));
  }

  openAdd(): void {
    this.addOpen.set(true);
    this.addKind.set('raw');
    this.addNodeId.set(null);
    this.addQty.set(null);
    this.addLoss.set(0);
    this.addInMass.set(true);
    this.addDisplayUnit.set('source');
  }

  setAddKind(kind: AddKind): void {
    this.addKind.set(kind);
    this.addNodeId.set(null);
    this.addDisplayUnit.set('source');
  }

  setAddQty(value: unknown): void {
    const raw = value === '' || value == null ? null : Number(value);
    if (raw == null || !Number.isFinite(raw)) {
      this.addQty.set(null);
      return;
    }
    const n = Math.max(0, Math.round(raw));
    const model = this.addModel();
    if (!model) {
      this.addQty.set(n);
      return;
    }
    const { src, conv } = this.rowNodes({ ...model, qty: n });
    const displayId = this.rowDisplayUnitId({ ...model, qty: n });
    if (!src || displayId == null || displayId === src.unitId) {
      this.addQty.set(n);
      return;
    }
    const sourceQty = toBaseClient(this.units(), n, displayId, src.unitId, conv);
    this.addQty.set(sourceQty == null ? n : Math.round(sourceQty * 1e6) / 1e6);
  }

  setAddLoss(value: unknown): void {
    const n = value === '' || value == null ? 0 : Number(value);
    this.addLoss.set(Number.isFinite(n) ? n : 0);
  }

  cancelAdd(): void {
    this.addOpen.set(false);
    this.err.set('');
  }

  addRow(): void {
    const nodeId = this.addNodeId();
    if (nodeId == null) {
      this.err.set('Выберите компонент');
      return;
    }
    if (this.draft().some((d) => d.nodeId === nodeId)) {
      this.err.set('Этот компонент уже есть в составе');
      return;
    }
    const qty = Number(this.addQty() ?? 0);
    if (!(qty > 0)) {
      this.err.set('Укажите количество больше нуля');
      return;
    }
    const loss = this.addLoss();
    if (loss != null && (loss < 0 || loss >= 100)) {
      this.err.set('Потери должны быть меньше 100 %');
      return;
    }
    this.draft.update((list) => [
      ...list,
      {
        nodeId,
        qty,
        lossPct: loss == null ? null : Number(loss),
        inMass: this.addInMass(),
        displayUnit: 'source',
      },
    ]);
    this.err.set('');
    this.addOpen.set(false);
  }

  /** Тип компонента в строке состава. */
  rowKind(nodeId: number): AddKind {
    const node = this.map()?.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind === 'product') return 'raw';
    return (node.packagings?.length ?? 0) > 0 ? 'dish' : 'semi';
  }

  /** Компоненты для строки: без самой рецептуры и без повторов с другими строками. */
  rowCandidates(kind: AddKind, rowIndex: number): MapNode[] {
    const m = this.map();
    if (!m) return [];
    const current = this.draft()[rowIndex]?.nodeId;
    const used = new Set(
      this.draft()
        .map((row, i) => (i === rowIndex ? null : row.nodeId))
        .filter((id): id is number => id != null)
    );
    return m.nodes
      .filter(
        (n) =>
          this.matchesKind(n, kind) &&
          n.id !== this.selectedId() &&
          (!used.has(n.id) || n.id === current)
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  setRowKind(index: number, kind: AddKind): void {
    const candidates = this.rowCandidates(kind, index);
    if (!candidates.length) {
      this.err.set('Нет доступных компонентов этого типа');
      return;
    }
    this.err.set('');
    this.draft.update((list) =>
      list.map((row, i) =>
        i === index ? { ...row, nodeId: candidates[0].id, displayUnit: 'source' } : row
      )
    );
  }

  setRowNode(index: number, nodeId: number | null): void {
    if (nodeId == null) return;
    const duplicate = this.draft().some((row, i) => i !== index && row.nodeId === nodeId);
    if (duplicate) {
      this.err.set('Этот компонент уже есть в составе');
      return;
    }
    this.err.set('');
    this.draft.update((list) =>
      list.map((row, i) => (i === index ? { ...row, nodeId, displayUnit: 'source' } : row))
    );
  }

  /** Значок «✎» у компонента — быстрое редактирование. */
  openComponentEditor(index: number, ev: Event): void {
    ev.stopPropagation();
    if (this.componentEdit()?.index === index) {
      this.componentEdit.set(null);
      return;
    }
    const row = this.draft()[index];
    const node = this.map()?.nodes.find((n) => n.id === row?.nodeId);
    if (!row || !node) return;
    const product =
      node.kind === 'product' && node.refId != null
        ? this.products().find((p) => p.id === node.refId)
        : undefined;

    // Сырьё редактируем в той же карточке, что на «Складе».
    if (product) {
      this.componentEdit.set(null);
      this.rawCard.set({
        id: product.id,
        name: product.name,
        unitCode: product.unitCode,
        qty: product.stockQty,
        avgCost: product.avgCost,
        minStock: product.minStock,
      });
      return;
    }

    // Блюдо или заготовку сразу открываем в полноценном редакторе рецептуры.
    if (node.kind !== 'product') {
      this.componentEdit.set(null);
      this.openRecipeComponent(node.id);
      return;
    }

    this.componentEdit.set({
      index,
      nodeId: node.id,
      kind: node.kind === 'product' ? 'raw' : 'recipe',
      productId: null,
    });
    this.componentEditName.set(node.name);
    this.componentEditNameEn.set(node.nameEn ?? '');
    this.componentEditNameSr.set(node.nameSr ?? '');
    this.componentEditCatalogId.set(node.catalogId);
    this.componentEditCategory.set(this.defaultRawCategoryId());
    this.err.set('');
    if (node.kind === 'product' && !this.rawCategoriesLoaded) {
      this.rawCategoriesLoaded = true;
      this.api.rawCategories$().subscribe({
        next: (cats) => this.rawCategories.set(cats),
        error: () => {
          this.rawCategoriesLoaded = false;
        },
      });
    }
  }

  closeComponentEditor(): void {
    this.componentEdit.set(null);
  }

  defaultRawCategoryId(): number | null {
    return this.rawCategories().find((c) => c.name.trim().toLowerCase() === 'прочее')?.id ?? this.rawCategories()[0]?.id ?? null;
  }

  saveComponentEdit(): void {
    const state = this.componentEdit();
    if (!state) return;
    const name = this.componentEditName().trim();
    if (!name) {
      this.err.set('Укажите название компонента');
      return;
    }
    this.err.set('');

    if (state.kind === 'raw') {
      if (state.productId == null) return;
      const categoryId = this.componentEditCategory() ?? this.defaultRawCategoryId();
      const categoryName = this.rawCategories().find((c) => c.id === categoryId)?.name ?? 'прочее';
      const patch: Record<string, unknown> = { name };
      if (categoryId != null) patch['categoryId'] = categoryId;
      this.componentEditSaving.set(true);
      this.api.patchProduct(state.productId, patch).subscribe({
        next: () => {
          this.componentEditSaving.set(false);
          this.products.update((list) =>
            list.map((p) =>
              p.id === state.productId
                ? { ...p, name, ...(categoryId != null ? { categoryId, categoryName } : {}) }
                : p
            )
          );
          this.map.update((m) =>
            m
              ? {
                  ...m,
                  nodes: m.nodes.map((n) =>
                    n.kind === 'product' && n.refId === state.productId ? { ...n, name } : n
                  ),
                }
              : m
          );
          this.msg.set(`Компонент «${name}» обновлён`);
          this.componentEdit.set(null);
        },
        error: (e) => {
          this.componentEditSaving.set(false);
          this.err.set(httpErr(e));
        },
      });
      return;
    }

    // Рецептура: правим название и каталог сразу, не уходя со страницы.
    const m = this.map();
    if (!m) return;
    const nameEn = this.componentEditNameEn().trim();
    const nameSr = this.componentEditNameSr().trim();
    const catalogId = this.componentEditCatalogId();
    this.componentEditSaving.set(true);
    const body = {
      version: m.version,
      nodes: m.nodes.map((n) => ({
        uid: n.id,
        kind: n.kind,
        refId: n.refId,
        name: n.id === state.nodeId ? name : n.name,
        nameEn: n.id === state.nodeId ? nameEn : n.nameEn,
        nameSr: n.id === state.nodeId ? nameSr : n.nameSr,
        catalogId: n.id === state.nodeId ? catalogId : n.catalogId,
        unitId: n.unitId,
        x: n.x,
        y: n.y,
        portionQty: n.portionQty,
        price: n.price,
        note: n.note,
        packagings: (n.packagings ?? []).map((p) => ({
          uid: p.id,
          name: p.name,
          qtyBase: p.qtyBase,
          minOrder: p.minOrder,
          isDefault: p.isDefault,
          price: p.price,
          priceBasis: p.priceBasis,
          cost: p.cost,
          available: p.available,
          tareProductIds: p.tareProductIds ?? [],
        })),
      })),
      ops: m.ops.map((o) => ({
        uid: o.id,
        name: o.name,
        yieldPct: o.yieldPct,
        planQty: o.planQty,
        planUnitId: o.planUnitId,
        laborHours: o.laborHours,
        outputUid: o.outputNodeId,
        note: o.note,
        x: o.x,
        y: o.y,
        inputs: o.inputs.map((i) => ({
          nodeUid: i.nodeId,
          qty: i.qty,
          inMass: i.inMass,
          lossPct: i.lossPct,
        })),
      })),
    };
    this.api.saveProductionMap(body).subscribe({
      next: (r) => {
        this.componentEditSaving.set(false);
        this.map.update((cur) =>
          cur
            ? {
                ...cur,
                version: r.version,
                nodes: cur.nodes.map((n) =>
                  n.id === state.nodeId ? { ...n, name, nameEn, nameSr, catalogId } : n
                ),
              }
            : cur
        );
        this.msg.set(`Рецептура «${name}» обновлена`);
        this.componentEdit.set(null);
      },
      error: (e) => {
        this.componentEditSaving.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  /** Рецептуру редактируем в её собственной карточке на этой же странице. */
  private snapshotEditor(): EditorSnapshot {
    return {
      selectedId: this.selectedId(),
      tab: this.tab(),
      draft: this.draft().map((r) => ({ ...r })),
      packagings: this.draftPackagings().map((p) => ({ ...p })),
      name: this.draftName(),
      nameEn: this.draftNameEn(),
      nameSr: this.draftNameSr(),
      note: this.draftNote(),
      catalogId: this.draftCatalogId(),
      portionQty: this.draftPortionQty(),
      unitId: this.draftUnitId(),
      editing: this.editing(),
      addOpen: this.addOpen(),
      query: this.query(),
      catalogFilter: this.catalogFilter(),
    };
  }

  /** Открыть рецептуру-компонент в том же редакторе, но во всплывающем окне. */
  openRecipeComponent(nodeId?: number): void {
    const id = nodeId ?? this.componentEdit()?.nodeId;
    if (id == null) return;
    if (!this.confirmDiscard()) return;
    const node = this.map()?.nodes.find((n) => n.id === id);
    if (!node || node.kind === 'product') return;

    if (!this.editorModal()) this.editorReturn = this.snapshotEditor();
    this.componentEdit.set(null);
    this.query.set('');
    this.editing.set(false);
    this.addOpen.set(false);
    const role = this.roleOf(node);
    this.tab.set(role);
    if (role === 'output' && this.catalogFilter() && !this.rows().some((r) => r.id === node.id)) {
      this.catalogFilter.set('');
    }
    this.select(node.id, false);
    this.editorModal.set(true);
  }

  closeEditorModal(): void {
    if (this.editing() && this.dirty()) {
      if (!confirm('Закрыть рецептуру без сохранения изменений?')) return;
    }
    if (this.embedded()) {
      this.editorModal.set(false);
      this.editorReturn = null;
      this.editorClosed.emit();
      return;
    }
    this.editorModal.set(false);
    const back = this.editorReturn;
    this.editorReturn = null;
    if (!back) {
      this.clearSelection();
      return;
    }
    this.selectedId.set(back.selectedId);
    this.tab.set(back.tab);
    this.draft.set(back.draft);
    this.draftPackagings.set(back.packagings);
    this.draftName.set(back.name);
    this.draftNameEn.set(back.nameEn);
    this.draftNameSr.set(back.nameSr);
    this.draftNote.set(back.note);
    this.draftCatalogId.set(back.catalogId);
    this.draftPortionQty.set(back.portionQty);
    this.draftUnitId.set(back.unitId);
    this.editing.set(back.editing);
    this.addOpen.set(back.addOpen);
    this.query.set(back.query);
    this.catalogFilter.set(back.catalogFilter);
  }

  onRawCardSaved(): void {
    this.rawCard.set(null);
    this.api.products$({ active: 'true' }).subscribe({
      next: (list) => {
        this.products.set(list);
        const byId = new Map(list.map((p) => [p.id, p] as const));
        this.map.update((m) =>
          m
            ? {
                ...m,
                nodes: m.nodes.map((n) => {
                  const p = n.kind === 'product' && n.refId != null ? byId.get(n.refId) : undefined;
                  return p ? { ...n, name: p.name } : n;
                }),
              }
            : m
        );
      },
      error: () => undefined,
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.editorModal()) {
      this.closeEditorModal();
      return;
    }
    this.componentEdit.set(null);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentDown(ev: PointerEvent): void {
    if (!this.componentEdit()) return;
    const t = ev.target as HTMLElement;
    if (t.closest('.cmp-pop') || t.closest('.cmp-edit')) return;
    this.componentEdit.set(null);
  }

  patch(index: number, field: keyof DraftInput, value: unknown): void {
    this.draft.update((list) =>
      list.map((row, i) => {
        if (i !== index) return row;
        if (field === 'nodeId') return row;
        if (field === 'inMass') return { ...row, inMass: !!value };
        if (field === 'lossPct') {
          const v = value === '' || value == null ? 0 : Number(value);
          return { ...row, lossPct: Number.isFinite(v) ? v : 0 };
        }
        const n = Number(value);
        return { ...row, qty: Number.isFinite(n) ? n : 0 };
      })
    );
  }

  nodeName(id: number): string {
    return this.map()?.nodes.find((n) => n.id === id)?.name ?? `#${id}`;
  }

  nodeKind(id: number): 'product' | 'state' | 'output' {
    return this.map()?.nodes.find((n) => n.id === id)?.kind ?? 'product';
  }

  unitCode(id: number): string {
    return this.map()?.nodes.find((n) => n.id === id)?.unitCode ?? '';
  }

  private rowNodes(row: DraftInput): { src: MapNode | null; target: MapNode | null; conv: {
    gPerPcs: number | null; mlPerPcs: number | null; gPerMl: number | null;
  } | null } {
    const m = this.map();
    const base = this.node();
    const target = base
      ? {
          ...base,
          unitId: this.draftUnitId() ?? base.unitId,
          unitCode: this.draftUnitCode(),
        }
      : null;
    const src = m?.nodes.find((n) => n.id === row.nodeId) ?? null;
    const product =
      src?.kind === 'product' && src.refId != null
        ? this.products().find((p) => p.id === src.refId)
        : undefined;
    return {
      src,
      target,
      conv: product
        ? { gPerPcs: product.gPerPcs, mlPerPcs: product.mlPerPcs, gPerMl: product.gPerMl }
        : null,
    };
  }

  private unitById(id: number | null | undefined): Unit | undefined {
    return this.units().find((u) => u.id === id);
  }

  private baseUnitId(dim: 'mass' | 'volume' | 'count'): number | null {
    return this.units().find((u) => u.dimension === dim && u.baseFactor === 1)?.id ?? null;
  }

  /** Альтернативная единица из коэффициентов товара (шт ↔ г, мл ↔ г и т. п.). */
  private altUnitId(src: MapNode, target: MapNode, conv: {
    gPerPcs: number | null; mlPerPcs: number | null; gPerMl: number | null;
  } | null): number | null {
    const dim = this.unitById(src.unitId)?.dimension;
    if (!dim) return null;
    let alt: number | null = null;
    if (dim === 'count') {
      if (conv?.gPerPcs && conv.gPerPcs > 0) alt = this.baseUnitId('mass');
      else if (conv?.mlPerPcs && conv.mlPerPcs > 0) alt = this.baseUnitId('volume');
    } else if (dim === 'mass') {
      if (conv?.gPerMl && conv.gPerMl > 0) alt = this.baseUnitId('volume');
      else if (conv?.gPerPcs && conv.gPerPcs > 0) alt = this.baseUnitId('count');
    } else if (dim === 'volume') {
      if (conv?.gPerMl && conv.gPerMl > 0) alt = this.baseUnitId('mass');
      else if (conv?.mlPerPcs && conv.mlPerPcs > 0) alt = this.baseUnitId('count');
    }
    if (alt == null || alt === src.unitId || alt === target.unitId) return null;
    return toBaseClient(this.units(), 1, src.unitId, alt, conv) == null ? null : alt;
  }

  private rowChoices(row: DraftInput): Array<'source' | 'target' | 'alt'> {
    const { src, target, conv } = this.rowNodes(row);
    if (!src || !target) return ['source'];
    const choices: Array<'source' | 'target' | 'alt'> = ['source'];
    if (src.unitId !== target.unitId &&
        toBaseClient(this.units(), 1, src.unitId, target.unitId, conv) != null) {
      choices.push('target');
    }
    if (this.altUnitId(src, target, conv) != null) choices.push('alt');
    return choices;
  }

  private rowDisplayUnitId(row: DraftInput): number | null {
    const { src, target, conv } = this.rowNodes(row);
    if (!src || !target) return null;
    if (row.displayUnit === 'target') return target.unitId;
    if (row.displayUnit === 'alt') return this.altUnitId(src, target, conv);
    return src.unitId;
  }

  rowCanToggle(row: DraftInput): boolean {
    return this.rowChoices(row).length > 1;
  }

  /** Количество для поля ввода — в выбранной пользователем единице; только целые. */
  rowQty(row: DraftInput): number {
    const whole = (v: number): number => (v > 0 ? Math.max(1, Math.round(v)) : 0);
    const { src, target, conv } = this.rowNodes(row);
    const displayId = this.rowDisplayUnitId(row);
    if (!src || !target || displayId == null || displayId === src.unitId) return whole(row.qty);
    const value = toBaseClient(this.units(), row.qty, src.unitId, displayId, conv);
    return value == null ? whole(row.qty) : whole(value);
  }

  rowUnitCode(row: DraftInput): string {
    const { src, target, conv } = this.rowNodes(row);
    const displayId = this.rowDisplayUnitId(row);
    if (displayId != null) {
      const code = this.unitById(displayId)?.code;
      if (code) return code;
    }
    return src && row.displayUnit === 'source' ? src.unitCode : this.node()?.unitCode ?? '';
  }

  /** Количество в другой единице — мелкая подпись под полем ввода. */
  rowConversion(row: DraftInput): { text: string; missing: boolean } | null {
    const { src, target, conv } = this.rowNodes(row);
    if (!src || !target) return null;
    const choices = this.rowChoices(row);
    if (choices.length < 2) return null;

    if (row.displayUnit !== 'source') {
      return { text: `≈ ${fmtTenths(row.qty, src.unitCode)}`, missing: false };
    }

    // В исходной единице показываем следующую доступную (единицу рецептуры или альтернативу).
    const next = choices[1];
    const nextId =
      next === 'target'
        ? target.unitId
        : this.altUnitId(src, target, conv);
    if (nextId == null) return null;
    const code = this.unitById(nextId)?.code ?? '';
    const converted = toBaseClient(this.units(), row.qty, src.unitId, nextId, conv);
    if (converted == null) {
      return { text: 'нет коэффициента для пересчёта', missing: true };
    }
    return { text: `≈ ${fmtTenths(converted, code)}`, missing: false };
  }

  toggleRowUnit(index: number): void {
    this.draft.update((list) =>
      list.map((row, i) => {
        if (i !== index) return row;
        const choices = this.rowChoices(row);
        if (choices.length < 2) return row;
        const at = Math.max(0, choices.indexOf(row.displayUnit));
        return { ...row, displayUnit: choices[(at + 1) % choices.length] };
      })
    );
  }

  setRowQty(index: number, value: unknown): void {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return;
    const n = Math.max(0, Math.round(raw));
    this.draft.update((list) =>
      list.map((row, i) => {
        if (i !== index) return row;
        const { src, target, conv } = this.rowNodes(row);
        const displayId = this.rowDisplayUnitId(row);
        if (!src || !target || displayId == null || displayId === src.unitId) {
          return { ...row, qty: n };
        }
        const sourceQty = toBaseClient(this.units(), n, displayId, src.unitId, conv);
        return { ...row, qty: sourceQty == null ? n : Math.round(sourceQty * 1000) / 1000 };
      })
    );
  }

  typeLabel(kind: 'product' | 'state' | 'output'): string {
    return kind === 'product' ? 'сырьё' : kind === 'state' ? 'заготовка' : 'блюдо';
  }

  catalogOf(id: number | null): ProductCatalog | null {
    return id == null ? null : this.catalogs().find((c) => c.id === id) ?? null;
  }

  num(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  fmtQty(value: number, unit: string): string {
    return fmtQty(value, unit);
  }

  save(): void {
    if (!this.editing()) return;
    const m = this.map();
    const op = this.op();
    if (!m || !op) return;
    const name = this.draftName().trim();
    if (!name) {
      this.err.set('Укажите название рецептуры');
      return;
    }
    if (!(this.draftPortionQty() > 0)) {
      this.err.set('Укажите выход больше нуля');
      return;
    }
    if (this.draftUnitId() == null) {
      this.err.set('Выберите единицу выхода');
      return;
    }
    for (const row of this.draft()) {
      if (!(row.qty > 0)) {
        this.err.set(`Укажите количество для «${this.nodeName(row.nodeId)}»`);
        return;
      }
      if (row.lossPct != null && (row.lossPct < 0 || row.lossPct >= 100)) {
        this.err.set(`Потери для «${this.nodeName(row.nodeId)}» должны быть меньше 100 %`);
        return;
      }
    }
    for (const p of this.draftPackagings()) {
      if (!(p.qtyBase > 0)) {
        this.err.set('Выход фасовки должен быть больше нуля');
        return;
      }
      if (!Number.isInteger(p.minOrder) || p.minOrder < 1) {
        this.err.set('Минимальный заказ — целое число от 1');
        return;
      }
      if (p.price < 0 || p.cost < 0) {
        this.err.set('Цена и себестоимость не могут быть отрицательными');
        return;
      }
      if (p.available && !(p.price > 0)) {
        this.err.set(`Укажите цену для доступной фасовки «${this.packWeight(p)}»`);
        return;
      }
    }
    this.saving.set(true);
    this.err.set('');
    this.msg.set('');
    const draft = this.draft();
    const selectedId = this.selectedId();
    const packs = this.draftPackagings().map((p) => ({
      uid: p.uid,
      name: `${Number(p.qtyBase.toFixed(3))} ${this.node()?.unitCode ?? ''}`.trim(),
      qtyBase: p.qtyBase,
      minOrder: batchMinOrder(this.draftPortionQty(), p.qtyBase, p.minOrder),
      isDefault: p.isDefault,
      price: p.price,
      priceBasis: p.priceBasis,
      cost: p.cost,
      available: p.available,
      tareProductIds: p.tareProductIds,
    }));
    if (packs.length && !packs.some((p) => p.isDefault)) packs[0].isDefault = true;
    const selectedCatalog =
      packs.length > 0 && this.draftCatalogId() == null
        ? this.catalogIdByName('прочее')
        : this.draftCatalogId();
    const body = {
      version: m.version,
      nodes: m.nodes.map((n) => {
        const selected = n.id === selectedId;
        return {
          uid: n.id,
          kind: n.kind,
          refId: n.refId,
          name: selected ? name : n.name,
          nameEn: selected ? this.draftNameEn().trim() : n.nameEn,
          nameSr: selected ? this.draftNameSr().trim() : n.nameSr,
          catalogId: selected ? selectedCatalog : n.catalogId,
          unitId: selected ? this.draftUnitId() : n.unitId,
          x: n.x,
          y: n.y,
          portionQty: selected ? this.draftPortionQty() : n.portionQty,
          price: n.price,
          note: selected ? this.draftNote().trim() : n.note,
          packagings: selected
            ? packs
            : (n.packagings ?? []).map((p) => ({
                uid: p.id,
                name: p.name,
                qtyBase: p.qtyBase,
                minOrder: p.minOrder,
                isDefault: p.isDefault,
                price: p.price,
                priceBasis: p.priceBasis,
                cost: p.cost,
                available: p.available,
                tareProductIds: p.tareProductIds ?? [],
              })),
        };
      }),
      ops: m.ops.map((o) => ({
        uid: o.id,
        name: o.name,
        yieldPct: o.yieldPct,
        laborHours: o.laborHours,
        outputUid: o.outputNodeId,
        note: o.note,
        x: o.x,
        y: o.y,
        planQty: o.id === op.id ? this.draftPortionQty() : o.planQty,
        planUnitId: o.id === op.id ? this.draftUnitId() : o.planUnitId,
        inputs: (o.id === op.id
          ? draft.map((i) => ({ nodeUid: i.nodeId, qty: i.qty, inMass: i.inMass, lossPct: i.lossPct }))
          : o.inputs.map((i) => ({ nodeUid: i.nodeId, qty: i.qty, inMass: i.inMass, lossPct: i.lossPct }))
        ),
      })),
    };
    this.api.saveProductionMap(body).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.editing.set(false);
        this.addOpen.set(false);
        const warnings = r.warnings?.length ?? 0;
        this.msg.set(warnings ? `Сохранено, предупреждений: ${warnings}` : 'Состав сохранён');
        this.reload();
      },
      error: (e) => {
        this.saving.set(false);
        this.err.set(httpErr(e));
      },
    });
  }
}
