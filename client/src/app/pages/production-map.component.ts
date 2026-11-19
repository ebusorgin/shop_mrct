import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { MapNodeKind, Product, ProductCatalog, Unit } from '../core/models';
import { calcProductionMap, ProductionMapCalc } from '../core/production-map-calc';
import { fmtMoney, fmtQty, trim } from '../core/format';
import { toBaseClient } from '../core/units';

interface VPackaging {
  uid: number;
  name: string;
  qtyBase: string;
  minOrder: string;
  isDefault: boolean;
  price: string;
  priceBasis: 'unit' | 'portion' | 'piece';
  cost: string;
  available: boolean;
  tareProductIds?: number[];
}

interface VNode {
  uid: number;
  kind: MapNodeKind;
  refId: number | null;
  name: string;
  nameEn: string;
  nameSr: string;
  catalogId: number | null;
  unitId: number;
  unitCode: string;
  x: number;
  y: number;
  portionQty: string;
  price: string;
  note: string;
  packagings: VPackaging[];
}

interface VInput {
  nodeUid: number;
  qty: string;
  inMass: boolean;
  /** Потери на связи, % (уварка, очистки). */
  lossPct?: string;
}

interface VOp {
  uid: number;
  name: string;
  yieldPct: string;
  /** План выхода (в единице результата); пусто — без плана. */
  planQty?: string;
  /** Единица партии (г/мл). */
  planUnitId?: number;
  laborHours: string;
  outputUid: number;
  note: string;
  x: number;
  y: number;
  inputs: VInput[];
}

interface Selection {
  kind: 'none' | 'node' | 'op';
  uid?: number;
}

interface Moving {
  kind: 'node' | 'op';
  uid: number;
  offX: number;
  offY: number;
  sx: number;
  sy: number;
  /** исходная позиция — чтобы вернуть карточку, если бросок отменён */
  origX: number;
  origY: number;
  moved: boolean;
}

interface Linking {
  nodeUid: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface CtxItem {
  label: string;
  danger?: boolean;
  sep?: boolean;
  run: () => void;
}

interface CtxMenu {
  x: number;
  y: number;
  items: CtxItem[];
}

interface Wire {
  id: string;
  d: string;
  kind: 'input' | 'output';
  opUid: number;
  nodeUid?: number;
  mx: number;
  my: number;
  label: string;
  /** Цвет входящей связи = цвет блока, в который она входит. */
  color: string;
}

interface Highlight {
  nodes: Set<number>;
  ops: Set<number>;
  wires: Set<string>;
}

const NODE_W = 236;
const NODE_H = 92;
const BLOCK_W = 250;
const BLOCK_H = 142;
const PORT_DY = 30;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const num = (v: string | number | null | undefined): number => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isFinite(n) ? n : 0;
};

/** #rrggbb из настроек каталога; null — цвета нет. */
function hexColor(value: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((value ?? '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

function tint(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Затемнить цвет для линии: тот же оттенок, но читаемый на светлом фоне. */
function shade(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Тёмный или белый текст поверх цвета каталога — по яркости. */
function inkOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#1f2d1e' : '#ffffff';
}

/**
 * Единая карта производства: один глобальный граф.
 * Сырьё — общие узлы слева; результаты — общие узлы справа.
 * Наведение на результат подсвечивает всю цепочку вверх и гасит остальные.
 */
@Component({
  selector: 'app-production-map',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (err()) { <div class="err">{{ err() }} <button type="button" class="mini" (click)="reload()">Повторить</button></div> }

      <section class="workspace">
        <aside class="raw-panel" [class.drop-target]="!!dragGhost()">
          <div class="raw-head">
            <button type="button" class="raw-tab" [class.on]="panel() === 'raw'" (click)="panel.set('raw')">Сырьё</button>
            <button type="button" class="raw-tab" [class.on]="panel() === 'recipes'" (click)="panel.set('recipes')">Рецептуры</button>
            <span class="raw-count">{{ panel() === 'raw' ? filteredProducts().length : recipes().length }}</span>
          </div>
          @if (panel() === 'recipes') {
            <div class="raw-search">
              <input [ngModel]="recipeQuery()" (ngModelChange)="recipeQuery.set($event)" placeholder="Поиск рецептуры…" />
              @if (recipeQuery()) { <button type="button" class="raw-clear" (click)="recipeQuery.set('')" title="Очистить">✕</button> }
            </div>
            <div class="raw-list">
              @for (r of recipes(); track r.uid) {
                <button type="button" class="raw-item recipe-item"
                        [class.on-map]="selected().kind === 'node' && selected().uid === r.uid"
                        (click)="selected.set({ kind: 'node', uid: r.uid })">
                  <span class="raw-name" [title]="r.name">{{ r.name }}</span>
                  <span class="kind-badge" [class.state]="r.kind === 'state'">{{ r.kindLabel }}</span>
                  <span class="raw-unit">{{ r.packs }}</span>
                  @if (r.warning) { <span class="recipe-warn" [title]="r.warning">!</span> }
                </button>
              } @empty {
                <div class="raw-empty">Рецептуры не найдены</div>
              }
            </div>
            <div class="raw-hint">Клик — открыть состав и фасовки. «!» — партия не равна сумме нетто.</div>
          } @else {
            <div class="raw-search">
              <input [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Поиск по названию…" />
              @if (query()) { <button type="button" class="raw-clear" (click)="query.set('')" title="Очистить">✕</button> }
            </div>
            <select class="raw-cat" [ngModel]="rawCat()" (ngModelChange)="rawCat.set($event)" title="Фильтр по каталогу">
              <option value="">Все каталоги</option>
              @for (c of rawCats(); track c) { <option [value]="c">{{ c }}</option> }
            </select>
            <label class="raw-filter">
              <input type="checkbox" [ngModel]="onlyUnused()" (ngModelChange)="onlyUnused.set($event)" />
              не использованные
            </label>
            <div class="raw-list">
              @if (loading()) {
                <div class="raw-empty">Загрузка…</div>
              } @else {
                @for (p of filteredProducts(); track p.id) {
                  <button type="button" class="raw-item" [class.on-map]="onMapRefIds().has(p.id)"
                          (pointerdown)="onRawDown(p, $event)">
                    <span class="raw-dot"></span>
                    <span class="raw-name" [title]="p.name">{{ p.name }}</span>
                    <span class="raw-unit">{{ p.unitCode }}</span>
                  </button>
                } @empty {
                  <div class="raw-empty">Сырьё не найдено</div>
                }
              }
            </div>
            <div class="raw-hint">Тяните сырьё на схему · клик по зелёному — подсветить карточку</div>
            @if (dragGhost(); as g) {
              <div class="raw-drop" [class.warn]="!g.canDelete">
                {{ g.canDelete ? 'Отпустите, чтобы убрать «' + g.name + '» со стола' : '«' + g.name + '» участвует в операциях — сначала отвяжите' }}
              </div>
            }
          }
        </aside>
        <div class="canvas-shell">
          <div class="canvas-bar">
            <button type="button" class="tool accent" (click)="createOpCenter()">＋ Операция</button>
            <button type="button" class="tool accent" [disabled]="layouting()" (click)="aiLayout()">
              {{ layouting() ? 'ИИ раскладывает…' : '✨ Разложить ИИ' }}
            </button>
            <span class="bar-divider"></span>
            <div class="zoom">
              <button type="button" (click)="zoomBy(1 / 1.2)" title="Уменьшить">−</button>
              <button type="button" class="z-val" (click)="zoomReset()" title="Сбросить масштаб">{{ zoomPct() }}%</button>
              <button type="button" (click)="zoomBy(1.2)" title="Увеличить">+</button>
              <button type="button" class="fit" (click)="fitView()">Показать всё</button>
            </div>
            <div class="legend">
              <span><i class="ld raw-dot"></i>сырьё</span>
              <span><i class="ld out-dot"></i>результат</span>
            </div>
            <div class="spacer"></div>
            <span class="bar-hint">Колесо — масштаб · пустое место — сдвиг · наведите на результат</span>
            <button type="button" class="ghost" (click)="loadSample()">Пример</button>
            <button type="button" class="save" [disabled]="saving()" (click)="save()">
              {{ saving() ? 'Сохраняю…' : 'Сохранить' }}
            </button>
            @if (nodes().length) {
              <button type="button" class="tool danger" (click)="clearMap()">Очистить</button>
            }
          </div>

          <div class="canvas-wrap" #wrap>
            <div
              class="canvas"
              [class.panning]="panning()"
              [style.--fs]="textScale()"
              (pointerdown)="onCanvasDown($event)"
              (contextmenu)="onCanvasContextMenu($event)"
            >
              <div
                class="scene"
                [style.transform]="sceneTransform()"
                [style.width.px]="canvasWidth()"
                [style.height.px]="canvasH()"
              >
                @if (cloudsVisible()) {
                  @for (c of rawClouds(); track c.key) {
                    <div class="raw-cloud"
                         [style.left.px]="c.x"
                         [style.top.px]="c.y"
                         [style.width.px]="c.w"
                         [style.height.px]="c.h">
                      <span class="raw-cloud-label">{{ c.label }} · {{ c.count }}</span>
                    </div>
                  }
                }

                <svg class="wires" [attr.width]="canvasWidth()" [attr.height]="canvasH()">
                  @for (w of wires(); track w.id) {
                    <g [class.dim]="isWireDim(w.id)" [class.lit]="isWireLit(w.id)">
                      <path class="wire" [class.out]="w.kind === 'output'" [style.--wire-color]="w.color" [attr.d]="w.d" />
                      @if (w.kind === 'input') {
                        <path class="wire-hit" [attr.d]="w.d" (click)="openEdgeEditor(w, $event)">
                          <title>Нажмите, чтобы задать потери на связи</title>
                        </path>
                      }
                      @if (w.label) {
                        <text class="wire-label" [attr.x]="w.mx" [attr.y]="w.my - 6" text-anchor="middle">{{ w.label }}</text>
                      }
                      @if (w.kind === 'input') {
                        <g class="wire-x" (click)="removeInput(w.opUid, w.nodeUid || 0, $event)">
                          <title>Убрать вход</title>
                          <circle [attr.cx]="w.mx" [attr.cy]="w.my" r="8" />
                          <text [attr.x]="w.mx" [attr.y]="w.my + 3.5" text-anchor="middle">×</text>
                        </g>
                      }
                    </g>
                  }
                  @if (linking(); as lk) {
                    <path class="wire temp" [attr.d]="wireD(lk.x1, lk.y1, lk.x2, lk.y2)" />
                  }
                </svg>

                @for (b of blocks(); track b.op.uid) {
                  <div
                    class="map-block"
                    [attr.data-op-uid]="b.op.uid"
                    [class.sel]="selected().kind === 'op' && selected().uid === b.op.uid"
                    [class.sell]="blockSell(b.op)"
                    [class.has-packs]="blockHasPacks(b.op)"
                    [style.--card-accent]="blockAccent(b.op)"
                    [style.--card-border]="blockBorder(b.op)"
                    [style.--card-bg]="blockBg(b.op)"
                    [style.--card-ink]="blockInk(b.op)"
                    [class.target]="opTarget() === b.op.uid"
                    [class.dim]="isOpDim(b.op.uid)"
                    [class.lit]="isOpLit(b.op.uid)"
                    [style.left.px]="b.op.x"
                    [style.top.px]="b.op.y"
                    (pointerdown)="onOpDown(b.op, $event)"
                    (contextmenu)="onOpMenu(b.op, $event)"
                    (mouseenter)="onBlockEnter(b)"
                    (mouseleave)="onBlockLeave(b)"
                  >
                    <div class="mb-rail">
                      <span class="op-icon" title="Операция">⚙</span>
                      <span class="mb-vname" [title]="b.op.name || 'Операция'">{{ b.op.name || 'Операция' }}</span>
                      <div class="mb-stats">
                        <span [title]="planTitle(b.op)">{{ planShort(b.op) }}</span>
                        <span [title]="laborLabel(b.op)">{{ laborShort(b.op) }}</span>
                        <span [title]="'Входов операции: ' + b.op.inputs.length">{{ b.op.inputs.length }} вх</span>
                        @if (opCalc(b.op.uid)?.warnings?.length) {
                          <span class="op-warn" [title]="opCalc(b.op.uid)?.warnings?.join('; ')">!</span>
                        }
                      </div>
                    </div>
                    <div class="mb-main">
                      <div class="mb-result">
                        <b class="mb-name">{{ b.out?.name || 'Без выхода' }}</b>
                        <span class="mb-qty">{{ blockQty(b.op) }}</span>
                      </div>
                      @if (blockNeedText(b.op)) {
                        <div class="mb-need">на порцию: {{ blockNeedText(b.op) }}</div>
                      }
                      @if (blockPortion(b.op)) {
                        <div class="mb-portion">{{ blockPortion(b.op) }}</div>
                      }
                      @if (b.out && b.out.kind !== 'product') {
                        @if (blockSell(b.op) && b.out) {
                          <div class="mb-shop">
                            <span class="mb-cat">◆ {{ catalogName(b.out.catalogId) }}</span>
                            <div class="mb-packs">
                              @for (p of b.out.packagings; track p.uid) {
                                <div class="mb-pack-row">
                                  <span class="mp-name">{{ packLabel(b.out, p) }}</span>
                                  <span class="mp-price">{{ packPrice(p) }}</span>
                                  <span
                                    class="pack-port"
                                    [title]="'Фасовка ' + packLabel(b.out, p) + ' · ' + packPrice(p) + ' — потяните к операции'"
                                    (pointerdown)="onPackPortDown(b.op, $event)"
                                  ></span>
                                </div>
                              }
                            </div>
                          </div>
                        } @else {
                          <div class="mb-pack" [class.empty]="!b.out.packagings.length">
                            {{ b.out.packagings.length ? packCountLabel(b.out) + ' · ' + packSummary(b.out) : 'нет фасовок' }}
                          </div>
                        }
                      }
                    </div>
                    <span class="port in" title="Вход операции"></span>
                    <span class="port out" title="Выход операции" (pointerdown)="onBlockPortDown(b.op, $event)"></span>
                  </div>
                }

                @for (n of freeNodes(); track n.uid) {
                  <div
                    class="node"
                    [class.product]="n.kind === 'product'"
                    [class.state]="n.kind !== 'product'"
                    [class.has-packs]="nodeHasPacks(n)"
                    [style.--card-accent]="nodeAccent(n)"
                    [style.--card-border]="nodeBorder(n)"
                    [style.--card-bg]="nodeBg(n)"
                    [style.--card-ink]="nodeInk(n)"
                    [class.sel]="selected().kind === 'node' && selected().uid === n.uid"
                    [class.dim]="isNodeDim(n.uid)"
                    [class.lit]="isNodeLit(n.uid)"
                    [class.flash]="flashUid() === n.uid"
                    [style.left.px]="n.x"
                    [style.top.px]="n.y"
                    (pointerdown)="onNodeDown(n, $event)"
                    (contextmenu)="onNodeMenu(n, $event)"
                    (mouseenter)="onNodeEnter(n)"
                    (mouseleave)="onNodeLeave(n)"
                  >
                    <div class="node-head">
                      <span class="kind" [class.product]="n.kind === 'product'" [class.state]="n.kind !== 'product'">
                        {{ n.kind === 'product' ? 'сырьё' : 'результат' }}
                      </span>
                      <b class="node-name" [title]="n.name">{{ n.name || '—' }}</b>
                    </div>
                    <div class="node-body">
                      @if (n.kind === 'product') {
                        <span class="unit">{{ n.unitCode }}</span>
                        <span class="cost">{{ usageCount(n.uid) }} связей</span>
                      } @else {
                        <span class="qty-ro">{{ nodeQty(n.uid) }}</span>
                        <span class="unit">{{ n.unitCode }}</span>
                        <span class="cost">{{ nodeCostLabel(n.uid) }}</span>
                      }
                    </div>
                    @if (n.kind === 'output' && n.portionQty) {
                      <div class="node-portion">порция {{ trimNum(n.portionQty) }} {{ n.unitCode }}</div>
                    }
                    @if (nodeNeedText(n)) {
                      <div class="node-need">нужно: {{ nodeNeedText(n) }}</div>
                    }
                    <span class="port out" title="Потяните к операции" (pointerdown)="onPortDown(n, $event)"></span>
                  </div>
                }
              </div>
            </div>

            @if (!nodes().length && !ops().length) {
              <div class="empty">
                <div class="empty-mark">◇</div>
                <b>Соберите единую карту производства</b>
                <span>Добавьте сырьё из нижней панели, создайте операции и заполните карточки результатов. Можно нажать «Пример».</span>
              </div>
            }
          </div>

          <div class="ticket">
            @if (summaryResult(); as r) {
              <div class="ticket-cell"><span>результат</span><b>{{ r.name || 'без названия' }}</b></div>
              <div class="ticket-cell"><span>выход</span><b>{{ fmtQty(r.producedQty, r.unit) }}</b></div>
              <div class="ticket-cell"><span>фасовки</span><b>{{ r.packs }}</b></div>
              <div class="ticket-cell"><span>себестоимость</span><b>{{ fmtMoney(r.cost) }}</b></div>
              <div class="ticket-cell"><span>часы</span><b>{{ r.labor }}</b></div>
              <div class="spacer"></div>
              @if (r.noPrice) {
                <button type="button" class="ticket-warn on" (click)="selected.set({ kind: 'node', uid: r.uid })">
                  {{ r.noPrice }} фасовок без цены
                </button>
              } @else {
                <span class="ticket-hint">Подсвечена цепочка производства результата</span>
              }
            } @else {
              <div class="ticket-cell"><span>сырья</span><b>{{ freeNodes().length }}</b></div>
              <div class="ticket-cell"><span>блоков</span><b>{{ ops().length }}</b></div>
              <div class="spacer"></div>
              <span class="ticket-hint">Наведите на результат — подсветится цепочка его производства</span>
            }
          </div>
        </div>

        @if (selected().kind !== 'none') {
          <div class="drawer-backdrop" (click)="selected.set({ kind: 'none' })"></div>
          <aside class="drawer">
            <div class="drawer-head">
              <div>
                <span class="drawer-kicker">инспектор</span>
                <h3>{{ inspTitle() }}</h3>
              </div>
              <button type="button" class="drawer-x" (click)="selected.set({ kind: 'none' })">×</button>
            </div>
            <div class="drawer-body">
              @if (selectedOp(); as op) {
                <label class="f">Название
                  <input [ngModel]="op.name" (ngModelChange)="patchOp(op.uid, 'name', $event)" placeholder="варка, обжарка, сборка" />
                </label>
                <label class="f">Человекочасы
                  <input type="number" min="0" step="any" [ngModel]="op.laborHours" (ngModelChange)="patchOp(op.uid, 'laborHours', $event)" />
                </label>
                <label class="f">Заметка
                  <input [ngModel]="op.note" (ngModelChange)="patchOp(op.uid, 'note', $event)" />
                </label>

                <div class="inp-list">
                  <div class="inp-title">Входы операции</div>
                  <div class="batch-line">
                    <span>На</span>
                    <input class="batch-qty" type="number" min="0" step="1" placeholder="N"
                           [ngModel]="op.planQty ?? ''" (ngModelChange)="patchOp(op.uid, 'planQty', $event)" />
                    <select class="batch-unit" [ngModel]="planUnitIdOf(op)" (ngModelChange)="setPlanUnit(op.uid, $event)">
                      @for (u of batchUnits(); track u.id) {
                        <option [ngValue]="u.id">{{ u.code === 'г' ? 'гр.' : u.code }}</option>
                      }
                    </select>
                    <span>продукции:</span>
                  </div>
                  <p class="plan-hint batch-hint" [class.ok]="batchOk(op)" [class.bad]="batchMismatch(op)">{{ batchText(op) }}</p>
                  @for (i of op.inputs; track i.nodeUid) {
                    <div class="inp-row map-input">
                      <span class="inp-name">{{ nodeName(i.nodeUid) }}</span>
                      <input class="inp-qty" type="number" min="0" step="any"
                             [ngModel]="i.qty" (ngModelChange)="patchInputQty(op.uid, i.nodeUid, $event)" />
                      <span class="inp-unit">{{ nodeUnit(i.nodeUid) }}</span>
                      @if (numLoss(i)) {
                        <span class="inp-loss" title="Потери на связи">−{{ trimNum(i.lossPct ?? '') }}%</span>
                      }
                      @if (!i.inMass) {
                        <span class="inp-nomass" title="Не входит в вес продукта">не в массе</span>
                      }
                      <button type="button" class="inp-x" (click)="removeInput(op.uid, i.nodeUid)">×</button>
                    </div>
                  } @empty {
                    <p class="muted">Нет входов — потяните от узла к операции.</p>
                  }
                </div>

                <div class="calc-box">
                  <div><span>выход</span><b>{{ opOutputLabel(op.uid) }}</b></div>
                  <div><span>себестоимость</span><b>{{ fmtMoney(opCalc(op.uid)?.cost ?? 0) }}</b></div>
                  <div><span>часы</span><b>{{ opLabor(op.uid) }}</b></div>
                </div>

                <div class="prod-actions">
                  <button type="button" class="mini primary" [disabled]="producing()" (click)="produceOp(op)">
                    Выпустить партию
                  </button>
                  <button type="button" class="mini" [disabled]="producing()" (click)="shipOp(op)">
                    Списать при отгрузке
                  </button>
                </div>

                @if (selectedOut(); as out) {
                  <div class="result-box">
                    <div class="inp-title">Результат операции</div>
                    <label class="f">Название результата
                      <input [ngModel]="out.name" (ngModelChange)="patchNode(out.uid, 'name', $event)" placeholder="Пюре, варёная картошка…" />
                    </label>
                    <div class="dp-grid">
                      <label class="f">Название EN
                        <input [ngModel]="out.nameEn" (ngModelChange)="patchNode(out.uid, 'nameEn', $event)" placeholder="Mashed potatoes" />
                      </label>
                      <label class="f">Название SR
                        <input [ngModel]="out.nameSr" (ngModelChange)="patchNode(out.uid, 'nameSr', $event)" placeholder="Pire krompir" />
                      </label>
                      <label class="f">Единица
                        <select [ngModel]="out.unitId" (ngModelChange)="setNodeUnit(out.uid, $event)">
                          @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
                        </select>
                      </label>
                      <label class="f">Порция
                        <input type="number" min="0" step="any" [ngModel]="out.portionQty" (ngModelChange)="patchNode(out.uid, 'portionQty', $event)" />
                      </label>
                      @if (out.packagings.length) {
                        <label class="f grow req">
                          Каталог{{ out.catalogId == null ? ' *' : '' }}
                          <select [class.missing]="out.catalogId == null" [ngModel]="out.catalogId" (ngModelChange)="setNodeCatalog(out.uid, $event)">
                            <option [ngValue]="null">— выберите каталог —</option>
                            @for (c of catalogs(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
                          </select>
                        </label>
                      }
                    </div>
                    <label class="f">Заметка
                      <textarea [ngModel]="out.note" (ngModelChange)="patchNode(out.uid, 'note', $event)"></textarea>
                    </label>
                    <div class="calc-box">
                      <div><span>произведено</span><b>{{ blockQty(op) }}</b></div>
                      <div><span>себестоимость</span><b>{{ fmtMoney(opCalc(op.uid)?.cost ?? 0) }}</b></div>
                      <div><span>человекочасы</span><b>{{ opLabor(op.uid) }}</b></div>
                    </div>
                    <ng-container *ngTemplateOutlet="packEditor; context: { $implicit: out }"></ng-container>
                  </div>
                }

                <button type="button" class="mini danger" (click)="deleteOp(op.uid)">Удалить операцию</button>
              } @else {
                @if (selectedNode(); as n) {
                  @if (n.kind === 'product') {
                    <div class="calc-box">
                      <div><span>сырьё</span><b>{{ n.name }}</b></div>
                      <div><span>единица</span><b>{{ n.unitCode }}</b></div>
                      <div><span>связей</span><b>{{ usageCount(n.uid) }}</b></div>
                    </div>
                    <p class="muted">Один и тот же продукт используется всеми операциями карты. Количество задаётся на каждой связи.</p>
                    <button type="button" class="mini danger" (click)="deleteNode(n.uid)">Удалить сырьё</button>
                  } @else {
                    <label class="f">Название
                      <input [ngModel]="n.name" (ngModelChange)="patchNode(n.uid, 'name', $event)" placeholder="Пюре, варёная картошка…" />
                    </label>
                    <div class="dp-grid">
                      <label class="f">Название EN
                        <input [ngModel]="n.nameEn" (ngModelChange)="patchNode(n.uid, 'nameEn', $event)" placeholder="Mashed potatoes" />
                      </label>
                      <label class="f">Название SR
                        <input [ngModel]="n.nameSr" (ngModelChange)="patchNode(n.uid, 'nameSr', $event)" placeholder="Pire krompir" />
                      </label>
                      <label class="f">Единица
                        <select [ngModel]="n.unitId" (ngModelChange)="setNodeUnit(n.uid, $event)">
                          @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
                        </select>
                      </label>
                      <label class="f">Порция
                        <input type="number" min="0" step="any" [ngModel]="n.portionQty" (ngModelChange)="patchNode(n.uid, 'portionQty', $event)" />
                      </label>
                      @if (n.packagings.length) {
                        <label class="f grow req">
                          Каталог{{ n.catalogId == null ? ' *' : '' }}
                          <select [class.missing]="n.catalogId == null" [ngModel]="n.catalogId" (ngModelChange)="setNodeCatalog(n.uid, $event)">
                            <option [ngValue]="null">— выберите каталог —</option>
                            @for (c of catalogs(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
                          </select>
                        </label>
                      }
                    </div>
                    <label class="f">Заметка
                      <textarea [ngModel]="n.note" (ngModelChange)="patchNode(n.uid, 'note', $event)"></textarea>
                    </label>
                    <div class="calc-box">
                      <div><span>произведено</span><b>{{ nodeQty(n.uid) }}</b></div>
                      <div><span>себестоимость</span><b>{{ fmtMoney(nodeCost(n.uid)) }}</b></div>
                      <div><span>человекочасы</span><b>{{ nodeLabor(n.uid) }}</b></div>
                      @if (n.kind === 'output') {
                        <div><span>порций</span><b>{{ dishOf(n.uid)?.portions ?? 0 }}</b></div>
                      }
                    </div>
                    <ng-container *ngTemplateOutlet="packEditor; context: { $implicit: n }"></ng-container>
                    <button type="button" class="mini danger" (click)="deleteNode(n.uid)">Удалить узел</button>
                  }
                }
              }
            </div>
          </aside>
        }
      </section>
    </div>

    @if (rawDrag(); as rd) {
      @if (rd.moved) {
        <div class="raw-ghost" [style.left.px]="rd.x + 14" [style.top.px]="rd.y + 12">{{ rd.p.name }}</div>
      }
    }

    @if (edgeEdit(); as e) {
      <div class="edge-backdrop" (click)="edgeEdit.set(null)"></div>
      <div class="edge-card" [style.left.px]="e.x" [style.top.px]="e.y">
        <div class="edge-title">связь</div>
        <div class="edge-route">{{ nodeName(e.nodeUid) }} → {{ edgeOp()?.name || 'операция' }}</div>
        <label class="f">Потери, % · уварка, очистки
          <input type="number" min="0" max="100" step="any" placeholder="0"
                 [ngModel]="edgeInput()?.lossPct ?? ''" (ngModelChange)="patchInputLoss(e.opUid, e.nodeUid, $event)" />
        </label>
        <label class="chk edge-chk">
          <input type="checkbox" [ngModel]="edgeInput()?.inMass" (ngModelChange)="setInMass(e.opUid, e.nodeUid, $event)" />
          в массе (входит в вес продукта)
        </label>
        <div class="edge-net">{{ edgeNetText(e) }}</div>
        <button type="button" class="mini danger" (click)="removeInputAndClose(e.opUid, e.nodeUid)">Удалить связь</button>
      </div>
    }

    @if (ctxMenu(); as m) {
      <div class="ctx-backdrop" (click)="closeCtx()" (contextmenu)="closeCtx()"></div>
      <div class="ctx" [style.left.px]="m.x" [style.top.px]="m.y">
        @for (it of m.items; track it.label) {
          @if (it.sep) { <hr /> }
          <button type="button" [class.danger]="it.danger" (click)="it.run(); closeCtx()">{{ it.label }}</button>
        }
      </div>
    }

    <ng-template #packEditor let-out>
      <div class="pack-box">
        <div class="inp-title">Фасовки <span class="muted">· {{ packCountLabel(out) }}</span></div>
        @for (p of out.packagings; track p.uid) {
          <div class="pack-card">
            <div class="pack-line">
              <input class="pack-qty" type="number" min="0" step="any" placeholder="выход"
                     [ngModel]="p.qtyBase" (ngModelChange)="patchPack(out.uid, p.uid, 'qtyBase', $event)" />
              <span class="inp-unit">{{ out.unitCode }}</span>
              <input class="pack-price" [class.missing]="!packPriceOk(p)" type="number" min="0" step="any" placeholder="цена *"
                     [ngModel]="p.price" (ngModelChange)="patchPack(out.uid, p.uid, 'price', $event)" />
              <label class="chk" title="Основная фасовка">
                <input type="radio" [name]="'def-' + out.uid" [checked]="p.isDefault" (change)="setDefaultPack(out.uid, p.uid)" /> осн.
              </label>
              <button type="button" class="inp-x" (click)="removePack(out.uid, p.uid)">×</button>
            </div>
            <div class="pack-line">
              <input class="pack-min" type="number" min="1" step="1" placeholder="мин"
                     [ngModel]="p.minOrder" (ngModelChange)="patchPack(out.uid, p.uid, 'minOrder', $event)" />
              <input class="pack-cost" type="number" min="0" step="any" placeholder="себест."
                     [ngModel]="p.cost" (ngModelChange)="patchPack(out.uid, p.uid, 'cost', $event)" />
              <select class="pack-basis" [ngModel]="p.priceBasis" (ngModelChange)="patchPack(out.uid, p.uid, 'priceBasis', $event)">
                <option value="portion">за упаковку</option>
                <option value="unit">за ед.</option>
                <option value="piece">за шт</option>
              </select>
              <label class="chk"><input type="checkbox" [ngModel]="p.available" (ngModelChange)="patchPack(out.uid, p.uid, 'available', $event)" /> в продаже</label>
            </div>
          </div>
        } @empty {
          <p class="muted small">Нет фасовок — добавьте хотя бы одну, чтобы задать цену.</p>
        }
        @if (packMissingPrice(out)) {
          <p class="pack-warn">Цена обязательна для каждой фасовки.</p>
        }
        @if (out.catalogId != null && out.packagings.length && !packMissingPrice(out)) {
          <div class="shop-preview">
            <span class="sp-title">так карточка выглядит на карте</span>
            <div class="sp-head"><span class="sp-cat">◆ {{ catalogName(out.catalogId) }}</span><b>{{ out.name || 'без названия' }}</b></div>
            @for (p of out.packagings; track p.uid) {
              <div class="sp-row"><span>{{ packLabel(out, p) }}</span><b>{{ packPrice(p) }}</b></div>
            }
          </div>
        }
        <button type="button" class="mini" (click)="addPack(out.uid)">＋ Фасовка</button>
      </div>
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: block;
        --ink: #1f2a24;
        --paper: #f7f4ec;
        --card: #ffffff;
        --line: #e3ddd0;
        --muted: #7b7568;
        --green: #2f7d5b;
        --green-soft: #e9f4ee;
        --orange: #c97b2e;
        --orange-soft: #fdf1e2;
        --blue: #4a7dbd;
        --blue-soft: #eaf1fb;
        --red: #b4483e;
        --red-soft: #fbeceb;
        color: var(--ink);
      }
      * { box-sizing: border-box; }

      .page { display: flex; flex-direction: column; gap: 12px; height: calc(100vh - 48px); min-height: 620px; }

      /* ---------- верхняя панель ---------- */
      .kitchen-top {
        display: grid; grid-template-columns: minmax(280px, 1fr) auto; align-items: center; gap: 10px 18px;
        background: var(--card); border: 1px solid var(--line); border-top: 3px solid var(--green);
        border-radius: 16px; padding: 12px 18px; box-shadow: 0 6px 20px rgba(60, 48, 30, .05);
      }
      .brand { grid-column: 1; grid-row: 1; min-width: 0; }
      .kicker { display: block; font-size: 9.5px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
      .title-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
      .title-row h1 { margin: 2px 0 0; font: 600 23px/1.15 Georgia, 'Times New Roman', serif; color: var(--ink); letter-spacing: -.01em; }
      .switch { display: flex; gap: 3px; background: #f0ece2; border: 1px solid var(--line); border-radius: 9px; padding: 3px; }
      .switch-link { padding: 4px 9px; border-radius: 6px; font-size: 11.5px; font-weight: 600; color: var(--muted); text-decoration: none; }
      .switch-link.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(60, 48, 30, .1); }

      .dish-line { grid-column: 1 / -1; grid-row: 2; display: flex; align-items: center; gap: 9px; min-width: 0; }
      .dish-name {
        flex: 1; min-width: 160px; max-width: 420px; border: 0; border-bottom: 2px solid transparent;
        background: transparent; padding: 3px 1px; font: 600 18px/1.2 Georgia, 'Times New Roman', serif; color: var(--ink);
      }
      .dish-name:focus { outline: none; border-bottom-color: var(--green); }
      .status { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; background: #f3efe6; color: var(--muted); white-space: nowrap; }
      .status.saved { background: var(--green-soft); color: var(--green); }
      .portion-chip {
        display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: #fffdf8;
        border-radius: 9px; padding: 5px 9px; font: inherit; cursor: pointer; white-space: nowrap;
      }
      .portion-chip span { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
      .portion-chip b { font-size: 12px; }
      .portion-chip:hover { border-color: #c9bfae; }

      .top-actions { grid-column: 2; grid-row: 1; display: flex; align-items: center; gap: 7px; justify-self: end; }
      .ghost {
        border: 1px solid var(--line); background: #fff; border-radius: 9px; padding: 7px 11px;
        font: inherit; font-size: 12px; font-weight: 600; color: var(--ink); cursor: pointer;
      }
      .ghost:hover { background: #f7f3ea; border-color: #c9bfae; }
      .save {
        border: 1px solid var(--green); background: var(--green); color: #fff; border-radius: 9px;
        padding: 8px 15px; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 12px rgba(47, 125, 91, .22);
      }
      .save:hover { background: #276a4d; }
      .save:disabled { opacity: .6; cursor: default; }

      .err { display: flex; align-items: center; gap: 8px; background: var(--red-soft); color: var(--red); border: 1px solid #edcfcb; border-radius: 10px; padding: 8px 12px; font-size: 12px; }

      /* ---------- стол ---------- */
      .workspace { flex: 1; min-height: 0; display: flex; gap: 12px; }
      .canvas-shell {
        flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
        background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 26px rgba(60, 48, 30, .06);
      }
      .canvas-bar {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 8px 12px; border-bottom: 1px solid var(--line); background: #fffdf8;
      }
      .tool {
        border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 10px;
        font: inherit; font-size: 12px; font-weight: 600; color: var(--ink); cursor: pointer; white-space: nowrap;
      }
      .tool:hover { background: #f7f3ea; border-color: #c9bfae; }
      .tool.accent { border-color: #bcdcc9; background: var(--green-soft); color: var(--green); }
      .tool.accent:hover { background: #dff0e6; }
      .tool.danger { color: var(--red); border-color: #eccfca; }
      .tool.danger:hover { background: var(--red-soft); }
      .bar-divider { width: 1px; height: 20px; background: var(--line); }
      .zoom { display: flex; align-items: center; gap: 3px; }
      .zoom button {
        border: 1px solid var(--line); background: #fff; border-radius: 7px; min-width: 27px; height: 26px;
        font: inherit; font-size: 12px; color: var(--ink); cursor: pointer; padding: 0 6px; white-space: nowrap;
      }
      .zoom button:hover { background: #f7f3ea; }
      .zoom .z-val { font-variant-numeric: tabular-nums; font-weight: 600; }
      .zoom .fit { font-size: 11px; }
      .layout-toggle { display: flex; gap: 2px; }
      .layout-toggle button {
        border: 1px solid var(--line); background: #fff; border-radius: 7px; min-width: 27px; height: 26px;
        font: inherit; font-size: 13px; color: var(--muted); cursor: pointer; padding: 0 5px;
      }
      .layout-toggle button:hover { background: #f7f3ea; }
      .layout-toggle button.on { background: var(--ink); border-color: var(--ink); color: #fff; }
      .bar-hint { font-size: 11px; color: var(--muted); white-space: nowrap; }
      .legend { display: flex; align-items: center; gap: 10px; font-size: 10.5px; color: var(--muted); white-space: nowrap; }
      .legend span { display: flex; align-items: center; gap: 4px; }
      .ld { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
      .ld.raw-dot { background: var(--blue); }
      .ld.op-dot { background: var(--orange); }
      .ld.out-dot { background: var(--green); }
      .spacer { flex: 1; }

      .canvas-wrap {
        flex: 1; min-height: 0; overflow: hidden; position: relative;
        background-color: #fbf8f1;
        background-image: radial-gradient(#e8e1d3 1px, transparent 1px);
        background-size: 20px 20px;
        touch-action: none;
      }
      .canvas { position: absolute; inset: 0; cursor: grab; }
      .canvas.panning { cursor: grabbing; }
      .scene { position: absolute; left: 0; top: 0; transform-origin: top left; }
      .wires { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
      .wire {
        fill: none; stroke: var(--wire-color, #b9ac95); stroke-width: 2;
        transition: stroke .24s ease, stroke-width .24s ease, opacity .24s ease;
      }
      .wires g { transition: opacity .24s ease, filter .24s ease; }
      /* широкая невидимая зона, чтобы по проводу было удобно попасть кликом */
      .wire-hit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; cursor: pointer; }
      .wire-hit:hover { stroke: rgba(47, 125, 91, .16); }
      .wire.out { stroke: #c9a86a; stroke-dasharray: 5 4; }
      .wire.temp { stroke: var(--green); stroke-width: 2.4; stroke-dasharray: 4 4; }
      .wire-x { pointer-events: all; cursor: pointer; }
      .wire-x circle { fill: #fffdf8; stroke: #d8cebd; }
      .wire-x text { fill: var(--muted); font-size: 11px; }

      .node {
        position: absolute; width: 236px; height: 92px; padding: 9px 12px;
        background: #fff; border: 1px solid var(--line); border-left: 5px solid var(--blue);
        border-radius: 12px; box-shadow: 0 5px 16px rgba(60, 48, 30, .07);
        cursor: grab; user-select: none;
        transition: opacity .24s ease, filter .24s ease, box-shadow .24s ease,
                    border-color .24s ease, background-color .24s ease;
      }
      .node:hover { box-shadow: 0 8px 22px rgba(60, 48, 30, .12); }
      .node.dish { border-left-color: var(--orange); }
      .node.state { border-left-color: #a99c86; }
      .node.output { border-color: #b7dcc8; border-left-color: var(--green); background: #f4fbf7; }
      .node.sel { border-color: var(--green); box-shadow: 0 0 0 3px var(--green-soft), 0 8px 22px rgba(60, 48, 30, .12); }
      .node.flash { border-color: var(--green); animation: nodeFlash 1.5s ease-out; z-index: 6; }
      @keyframes nodeFlash {
        0% { box-shadow: 0 0 0 2px rgba(47, 125, 91, .9), 0 0 0 12px rgba(47, 125, 91, .35); }
        45% { box-shadow: 0 0 0 5px rgba(47, 125, 91, .55), 0 0 30px rgba(47, 125, 91, .55); }
        75% { box-shadow: 0 0 0 3px rgba(47, 125, 91, .3), 0 0 16px rgba(47, 125, 91, .35); }
        100% { box-shadow: 0 5px 16px rgba(60, 48, 30, .07); }
      }

      .node-head { display: flex; align-items: flex-start; gap: 7px; min-width: 0; }
      .kind {
        font-size: calc(9px * min(var(--fs, 1), 1.15)); font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
        padding: 2px 5px; border-radius: 4px; background: #f0ece2; color: #6f6352; flex: none;
        margin-top: 2px;
      }
      .kind.product { background: var(--blue-soft); color: #33639c; }
      .kind.dish { background: var(--orange-soft); color: #9a5b1d; }
      .kind.state { background: #f1ece1; color: #6f6352; }
      .kind.output { background: #dff2e7; color: #236b4c; }
      .node-name {
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
        overflow: hidden; text-overflow: ellipsis; white-space: normal; word-break: break-word;
        font-size: calc(16px * var(--fs, 1)); font-weight: 600; line-height: 1.1; color: var(--ink);
      }
      .node-body { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
      .qty {
        width: 84px; padding: 5px 7px; font-size: 12px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 7px; background: #fffdf8;
      }
      .qty:focus { outline: none; border-color: var(--green); background: #fff; }
      .qty-ro { font-weight: 600; font-size: calc(13px * var(--fs, 1)); font-variant-numeric: tabular-nums; }
      .unit { font-size: calc(10.5px * var(--fs, 1)); color: var(--muted); }
      .cost { margin-left: auto; font-size: calc(10.5px * var(--fs, 1)); color: var(--muted); white-space: nowrap; }

      .op {
        position: absolute; width: 190px; height: 96px; padding: 9px 12px;
        background: var(--orange-soft); border: 1px solid #e8c79e; border-radius: 12px;
        box-shadow: 0 5px 16px rgba(120, 80, 20, .09); cursor: grab; user-select: none;
        transition: box-shadow .12s, border-color .12s;
      }
      .op:hover { box-shadow: 0 8px 22px rgba(120, 80, 20, .15); }
      .op.sel { border-color: var(--orange); box-shadow: 0 0 0 3px #fbe7cd, 0 8px 22px rgba(120, 80, 20, .15); }
      .op.target { border-color: var(--green); background: #eef8f1; }
      .op-head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; min-width: 0; }
      .op-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .op-icon { font-size: 12px; color: var(--orange); }
      .op-meta { margin-top: 7px; font-size: 11px; font-weight: 600; color: #8a6a3a; }
      .op-sub { margin-top: 3px; font-size: calc(10.5px * var(--fs, 1)); color: var(--muted); }

      .port {
        position: absolute; width: 14px; height: 14px; border-radius: 50%; top: 23px; z-index: 2;
        background: #fffdf8; border: 2px solid #a8987f;
      }
      .port.out { right: -8px; cursor: crosshair; }
      .port.out:hover { border-color: var(--green); background: var(--green-soft); }
      .port.in { left: -8px; background: #f3eee3; }

      /* вертикальная лента: порты сверху/снизу, карточки друг под другом */
      .canvas.vertical .node .port.out { left: calc(50% - 7px); right: auto; top: auto; bottom: -8px; }
      .canvas.vertical .op .port.in { left: calc(50% - 7px); top: -8px; right: auto; }
      .canvas.vertical .op .port.out { left: calc(50% - 7px); top: auto; bottom: -8px; right: auto; }

      .empty {
        position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 7px; text-align: center; padding: 24px; color: var(--muted); pointer-events: none;
      }
      .empty-mark { font-size: 38px; line-height: 1; color: #d8cbb5; }
      .empty b { font: 600 16px/1.2 Georgia, 'Times New Roman', serif; color: var(--ink); }
      .empty span { font-size: 12px; max-width: 360px; }

      /* ---------- квитанция ---------- */
      .ticket {
        display: flex; align-items: center; gap: 22px; flex-wrap: wrap;
        padding: 9px 16px; border: 1px dashed #ddd3c2; border-radius: 12px; background: #fffdf7;
      }
      .ticket-cell { display: flex; flex-direction: column; gap: 1px; }
      .ticket-cell span { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
      .ticket-cell b { font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
      .ticket-warn {
        border: 1px solid #bcdcc9; background: var(--green-soft); color: var(--green);
        border-radius: 999px; padding: 5px 10px; font: inherit; font-size: 10.5px; font-weight: 700; cursor: pointer;
      }
      .ticket-warn.on { border-color: #f0d9a8; background: #fff8ec; color: #8a6a1f; }

      /* ---------- нижний док ингредиентов ---------- */
      .dock {
        background: var(--card); border: 1px solid var(--line); border-radius: 16px;
        padding: 10px 14px; box-shadow: 0 6px 20px rgba(60, 48, 30, .05);
      }
      .dock-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
      .dock-title { font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
      .dock-search { position: relative; display: flex; }
      .dock-search input {
        width: 220px; max-width: 60vw; padding: 6px 28px 6px 9px; font-size: 12px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 8px; background: #fffdf8;
      }
      .dock-search input:focus { outline: none; border-color: var(--green); background: #fff; }
      .dock-clear { position: absolute; right: 3px; top: 3px; border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; padding: 3px 5px; border-radius: 5px; }
      .dock-clear:hover { background: #f2eee4; }
      .dock-tabs { display: flex; align-items: center; gap: 4px; }
      .dock-tabs button {
        border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 5px 9px;
        font: inherit; font-size: 11px; font-weight: 700; color: var(--muted); cursor: pointer;
      }
      .dock-tabs button span { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 3px; border-radius: 999px; background: #f1ece1; font-size: 9.5px; }
      .dock-tabs button.on { background: var(--ink); border-color: var(--ink); color: #fff; }
      .dock-tabs button.on span { background: rgba(255, 255, 255, .2); }
      .dock-refresh { border: 0 !important; background: transparent !important; color: var(--muted) !important; font-size: 14px !important; padding: 2px 7px !important; }
      .dock-hint { font-size: 10.5px; color: var(--muted); white-space: nowrap; }

      /* ---------- левая панель сырья ---------- */
      .raw-cloud {
        position: absolute; pointer-events: none; z-index: 0;
        border: 1px dashed #cbbfa8; border-radius: 26px;
        background: radial-gradient(120% 80% at 30% 20%, rgba(255, 252, 244, .95), rgba(246, 240, 227, .62));
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .55);
      }
      .raw-cloud-label {
        position: absolute; top: 2px; left: 16px;
        max-width: calc(100% - 32px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 20px; font-weight: 800; line-height: 1; letter-spacing: .04em; text-transform: uppercase;
        color: #8a7a5c; background: rgba(255, 253, 247, .9); padding: 3px 12px; border-radius: 999px;
      }
      .raw-panel {
        flex: 0 0 236px; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
        background: var(--card); border: 1px solid var(--line); border-radius: 16px;
        box-shadow: 0 8px 26px rgba(60, 48, 30, .06); position: relative;
      }
      .raw-panel.drop-target {
        border-color: var(--red);
        box-shadow: 0 0 0 3px var(--red-soft), 0 8px 26px rgba(60, 48, 30, .08);
      }
      .raw-drop {
        position: absolute; inset: 8px; z-index: 3; pointer-events: none;
        display: flex; align-items: center; justify-content: center; text-align: center; padding: 14px;
        border: 2px dashed var(--red); border-radius: 12px; background: rgba(251, 236, 235, .94);
        color: var(--red); font-size: 12px; font-weight: 700; line-height: 1.35;
      }
      .raw-drop.warn {
        border-color: #d9b25a; color: #8a6a1f; background: rgba(255, 248, 236, .95);
      }
      .raw-head { display: flex; align-items: center; gap: 8px; padding: 11px 12px 7px; }
      .raw-head b { font-size: 10.5px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
      .raw-tab {
        border: 0; background: transparent; cursor: pointer; padding: 3px 5px 4px;
        font-size: 10.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
        color: var(--muted); border-bottom: 2px solid transparent;
      }
      .raw-tab.on { color: var(--ink); border-bottom-color: var(--ink); }
      .recipe-item { gap: 6px; }
      .kind-badge {
        flex: 0 0 auto; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 6px;
        background: #eef3ea; color: #3d5a2e; white-space: nowrap;
      }
      .kind-badge.state { background: #f1ece2; color: #7a5b2e; }
      .recipe-warn { color: var(--red); font-weight: 800; flex: 0 0 auto; }
      .raw-count {
        margin-left: auto; font-size: 11px; font-weight: 700; color: var(--muted);
        padding: 2px 7px; border-radius: 999px; background: #f3efe6;
      }
      .raw-search { position: relative; margin: 0 10px 6px; }
      .raw-search input {
        width: 100%; padding: 7px 26px 7px 9px; font-size: 13px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 8px; background: #fffdf8;
      }
      .raw-search input:focus { outline: none; border-color: var(--green); background: #fff; }
      .raw-clear {
        position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
        border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 11px; padding: 3px 5px; border-radius: 5px;
      }
      .raw-clear:hover { background: #f2eee4; }
      .raw-cat {
        margin: 0 10px 8px; padding: 6px 8px; font: inherit; font-size: 12.5px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 8px; background: #fffdf8; cursor: pointer;
      }
      .raw-cat:focus { outline: none; border-color: var(--green); background: #fff; }
      .raw-filter {
        display: flex; align-items: center; gap: 6px; margin: 0 12px 8px;
        font-size: 12.5px; color: var(--ink); cursor: pointer; user-select: none;
      }
      .raw-filter input { accent-color: var(--green); cursor: pointer; }
      .raw-list { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 2px; }
      .raw-item {
        display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
        border: 1px solid transparent; background: transparent; border-radius: 8px;
        padding: 6px 7px; cursor: grab; font: inherit; color: var(--ink);
        touch-action: pan-y;
      }
      .raw-item:hover { background: #f7f3ea; border-color: var(--line); }
      .raw-item:active { cursor: grabbing; }
      /* сырьё, которое уже стоит на карте */
      .raw-item.on-map { background: #eef8f2; }
      .raw-item.on-map .raw-dot { background: var(--green); }
      .raw-item.on-map .raw-name { color: var(--green); }
      .raw-item.on-map .raw-unit { color: #5c8a73; }
      .raw-ghost {
        position: fixed; z-index: 95; pointer-events: none;
        background: #fff; border: 1px solid var(--line); border-radius: 8px;
        padding: 4px 9px; font-size: 11.5px; font-weight: 600; color: var(--ink);
        box-shadow: 0 6px 18px rgba(30, 24, 14, .2);
      }
      .raw-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--blue); }
      .raw-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
      .raw-unit { flex: 0 0 auto; font-size: 10.5px; color: var(--muted); }
      .raw-empty { padding: 10px 6px; font-size: 11.5px; color: var(--muted); }
      .raw-hint { padding: 7px 12px 10px; border-top: 1px solid var(--line); font-size: 10.5px; color: var(--muted); }

      .dock-track { display: flex; align-items: stretch; gap: 8px; overflow-x: auto; padding-bottom: 4px; min-height: 52px; }
      .chip {
        flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
        background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 7px 10px;
        font: inherit; color: inherit; text-align: left; cursor: grab; transition: transform .1s, box-shadow .1s, border-color .1s;
      }
      .chip:hover { transform: translateY(-1px); box-shadow: 0 5px 14px rgba(60, 48, 30, .1); border-color: #c9bfae; }
      .chip.raw { border-left: 3px solid var(--blue); }
      .chip.dish { border-left: 3px solid var(--orange); }
      .chip-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--blue); flex: none; }
      .chip.dish .chip-dot { background: var(--orange); }
      .chip-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .chip-text b { font-size: 11.5px; font-weight: 600; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip-text span { font-size: 9.5px; color: var(--muted); }
      .chip-main { border: 0; background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 1px; padding: 0; min-width: 0; }
      .chip-main b { font-size: 11.5px; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chip-main span { font-size: 9.5px; color: var(--muted); }
      .chip-open, .chip-del { border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; padding: 1px 4px; border-radius: 5px; }
      .chip-open:hover, .chip-del:hover { background: #f2eee4; color: var(--ink); }
      .chip-del:hover { color: var(--red); }
      .dock-empty { font-size: 11.5px; color: var(--muted); padding: 12px 6px; }

      /* ---------- всплывающий инспектор поверх всего ---------- */
      .drawer-backdrop {
        position: fixed; inset: 0; z-index: 70;
        background: rgba(34, 28, 18, .3); backdrop-filter: blur(1.5px);
        animation: backdropIn .15s ease-out;
      }
      @keyframes backdropIn { from { opacity: 0; } to { opacity: 1; } }
      .drawer {
        position: fixed; z-index: 72; left: 50%; top: 50%; transform: translate(-50%, -50%);
        width: min(420px, calc(100% - 44px)); max-height: min(80vh, 760px);
        display: flex; flex-direction: column; overflow: hidden;
        background: #fff; border: 1px solid var(--line); border-radius: 16px;
        box-shadow: 0 28px 70px rgba(25, 20, 12, .32), 0 8px 22px rgba(25, 20, 12, .16);
        animation: drawerIn .16s ease-out;
      }
      /* только прозрачность: позицию задаёт transform центрирования */
      @keyframes drawerIn { from { opacity: 0; } to { opacity: 1; } }
      .drawer-head {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
        padding: 16px 18px; background: var(--green); color: #fff;
      }
      .drawer-kicker { font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; opacity: .7; }
      .drawer-head h3 { margin: 2px 0 0; font: 600 18px/1.2 Georgia, 'Times New Roman', serif; }
      .drawer-x { border: 0; background: rgba(255, 255, 255, .16); color: #fff; width: 30px; height: 30px; border-radius: 8px; font-size: 18px; line-height: 1; cursor: pointer; }
      .drawer-x:hover { background: rgba(255, 255, 255, .28); }
      .drawer-body { flex: 1; min-height: 0; padding: 16px 18px 28px; overflow: auto; }

      .f { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; font-size: 11px; color: var(--muted); }
      .f input, .f select, .f textarea {
        width: 100%; font: inherit; font-size: 13px; color: var(--ink); padding: 7px 9px;
        border: 1px solid var(--line); border-radius: 8px; background: #fffdf8;
      }
      .f input:focus, .f select:focus, .f textarea:focus { outline: none; border-color: var(--green); background: #fff; }
      .f textarea { min-height: 62px; resize: vertical; }
      .dp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
      .dp-grid .grow { grid-column: 1 / -1; }

      .inp-list { border-top: 1px solid var(--line); padding-top: 11px; margin: 2px 0 12px; }
      .inp-title { font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
      .inp-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; }
      .inp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chk { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--muted); }
      .inp-x { border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 14px; padding: 0 4px; }
      .inp-x:hover { color: var(--red); }

      .calc-box { background: #f8f4ea; border: 1px solid #e8dfcd; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
      .calc-box div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .calc-box span { font-size: 10.5px; color: var(--muted); }
      .prod-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
      .calc-box b { font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--ink); }

      .warns { border: 1px solid #f0d9a8; background: #fff8ec; border-radius: 10px; padding: 10px 12px; }
      .warn-title { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: #8a6a1f; margin-bottom: 4px; }
      .warn { font-size: 11.5px; color: #8a6a1f; padding: 1px 0; }
      .muted { color: var(--muted); font-size: 11.5px; }

      .mini { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 7px 11px; font: inherit; font-size: 12px; font-weight: 600; color: var(--ink); cursor: pointer; }
      .mini:hover { background: #f7f3ea; }
      .mini.primary { border-color: var(--green); background: var(--green); color: #fff; }
      .mini.primary:hover { background: #276a4d; }
      .mini.danger { border-color: #eccfca; color: var(--red); }
      .mini.danger:hover { background: var(--red-soft); }
      .pill { display: inline-block; padding: 4px 9px; border-radius: 999px; font-size: 10.5px; font-weight: 700; }
      .pill.green { background: var(--green-soft); color: var(--green); }

      /* ---------- редактор связи ---------- */
      .edge-backdrop { position: fixed; inset: 0; z-index: 86; }
      .edge-card {
        position: fixed; z-index: 87; width: 268px;
        background: #fff; border: 1px solid var(--line); border-radius: 12px;
        box-shadow: 0 18px 46px rgba(30, 24, 14, .25); padding: 12px 14px 14px;
      }
      .edge-title { font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
      .edge-route {
        margin: 2px 0 10px; font-size: 13px; font-weight: 600; color: var(--ink);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .edge-net { margin: -2px 0 10px; font-size: 11px; font-weight: 600; color: #8a6a1f; }
      .edge-card .f { margin-bottom: 9px; }

      /* ---------- контекстное меню ---------- */
      .ctx-backdrop { position: fixed; inset: 0; z-index: 90; }
      .ctx { position: fixed; z-index: 91; min-width: 226px; background: #fff; border: 1px solid var(--line); border-radius: 11px; box-shadow: 0 14px 40px rgba(40, 30, 20, .2); padding: 4px; }
      .ctx button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 8px 10px; border-radius: 7px; font: inherit; font-size: 12px; color: var(--ink); cursor: pointer; }
      .ctx button:hover { background: #f7f3ea; }
      .ctx button.danger { color: var(--red); }
      .ctx hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }

      @media (max-width: 1100px) {
        .brand { min-width: 0; }
        .title-row h1 { font-size: 20px; }
        .drawer { width: min(400px, calc(100% - 36px)); }
      }
      @media (max-width: 900px) {
        .page { height: auto; min-height: 0; }
        .workspace { flex-direction: column; }
        .canvas-shell { min-height: 420px; }
        .raw-panel { flex: 0 0 auto; max-height: 38vh; }
        .drawer { width: calc(100% - 24px); max-height: 76vh; }
      }
      @media (max-width: 760px) {
        .page { height: auto; min-height: 0; }
        .kitchen-top { grid-template-columns: 1fr; }
        .brand, .top-actions, .dish-line { grid-column: 1; grid-row: auto; }
        .top-actions { justify-self: start; flex-wrap: wrap; }
        .canvas-shell { min-height: 520px; }
        .raw-panel { max-height: 34vh; }
        .drawer { max-height: 60vh; }
        .dock-search input { width: 100%; }
        .dock-search { flex: 1; min-width: 180px; }
        .bar-hint { display: none; }
      }
    

      /* ===== единая карта производства ===== */
      .node.has-packs {
        border-color: var(--card-border, #b7dcc8);
        border-left-color: var(--card-accent, var(--green));
        background: linear-gradient(180deg, var(--card-bg, #f4fbf7) 0%, #fffdf8 78%);
      }
      .node.dim, .op.dim, g.dim { opacity: .2; filter: grayscale(.8); }
      .node.lit, .op.lit { box-shadow: 0 0 0 2px rgba(47, 125, 91, .35), 0 8px 22px rgba(60, 48, 30, .12); }
      /* подсвеченная цепочка сохраняет цвет своей карточки, только линия толще */
      g.lit .wire { stroke: var(--wire-color, #7fae92); stroke-width: 2.8; }
      .node.output { cursor: pointer; }
      .node-portion { margin-top: 4px; font-size: calc(10px * var(--fs, 1)); color: var(--muted); }
      .wire-label {
        fill: #8a6a3a; font-size: 10px; font-weight: 700;
        paint-order: stroke; stroke: #fffdf8; stroke-width: 3px;
      }
      .dock-count {
        font-size: 10px; font-weight: 700; color: var(--muted);
        padding: 2px 7px; border-radius: 999px; background: #f3efe6;
      }
      .ticket-hint { font-size: 10.5px; color: var(--muted); }
      .ld.state-dot { background: #a99c86; }
      .map-input { gap: 5px; }
      .inp-qty {
        width: 70px; padding: 4px 6px; font-size: 11.5px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 6px; background: #fffdf8;
      }
      .inp-unit { font-size: 10px; color: var(--muted); min-width: 16px; }
      .inp-loss { font-size: 10.5px; font-weight: 700; color: var(--red); white-space: nowrap; }
      .inp-nomass { font-size: 10px; font-weight: 600; color: #8a6a1f; white-space: nowrap; }
      .edge-chk { margin: -2px 0 10px; font-size: 11.5px; color: var(--ink); }

      /* операция + её результат — один блок */
      .map-block {
        position: absolute; width: 250px; height: 142px; padding: 0; display: flex;
        background: #fff; border: 1px solid var(--line); border-left: 5px solid var(--orange);
        border-radius: 12px; box-shadow: 0 5px 16px rgba(120, 80, 20, .09);
        cursor: grab; user-select: none;
        transition: opacity .24s ease, filter .24s ease, box-shadow .24s ease,
                    border-color .24s ease, background-color .24s ease;
        overflow: visible;
      }
      .map-block:hover { box-shadow: 0 8px 22px rgba(120, 80, 20, .15); }
      .map-block.output { border-color: #b7dcc8; border-left-color: var(--green); background: #f4fbf7; }
      .map-block.state { border-left-color: #a99c86; }
      .map-block.sel { border-color: var(--green); box-shadow: 0 0 0 3px var(--green-soft), 0 8px 22px rgba(60, 48, 30, .12); }
      /* карточка-витрина: каталог + цена каждой фасовки */
      .map-block.sell {
        height: auto; min-height: 142px;
        box-shadow: 0 6px 18px rgba(47, 125, 91, .16);
      }
      .map-block.sell:hover { box-shadow: 0 9px 24px rgba(47, 125, 91, .24); }
      .mb-shop { margin-top: 5px; padding-top: 5px; border-top: 1px dashed var(--card-border, #bcdcc9); }
      .mb-cat {
        display: inline-block; font-size: calc(9.5px * var(--fs, 1)); font-weight: 600; letter-spacing: .08em;
        text-transform: uppercase; color: #fff; background: var(--green);
        border-radius: 999px; padding: 2px 7px; max-width: 100%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .mb-packs { margin-top: 5px; display: flex; flex-direction: column; gap: 4px; }
      .mb-pack-row { position: relative; display: flex; align-items: baseline; gap: 6px; font-size: calc(11px * var(--fs, 1)); line-height: 1.25; }
      .mp-name { color: #3e4a43; font-weight: 500; white-space: nowrap; }
      .mp-price { margin-left: auto; font-weight: 600; color: var(--green); white-space: nowrap; }
      .pack-port {
        position: absolute; right: -16px; top: 50%; transform: translateY(-50%);
        width: 11px; height: 11px; border-radius: 50%; z-index: 3;
        background: #fff; border: 2px solid var(--green); cursor: crosshair;
        box-shadow: 0 0 0 2px rgba(47, 125, 91, .14);
      }
      .pack-port:hover { background: var(--green-soft); transform: translateY(-50%) scale(1.25); }
      .map-block.target { border-color: var(--green); background: #eef8f1; }
      .map-block.dim { opacity: .2; filter: grayscale(.8); }
      .map-block.lit { box-shadow: 0 0 0 2px rgba(47, 125, 91, .35), 0 8px 22px rgba(60, 48, 30, .12); }
      .map-block .port.in { left: -8px; top: 50%; transform: translateY(-50%); }
      .map-block .port.out { right: -8px; }
      /* левая вертикальная полоса операции: название и весь контекст + разделитель */
      .mb-rail {
        flex: 0 0 44px; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 2px;
        padding: 4px 0 4px; border-right: 1px solid #ded4c0;
        background: linear-gradient(90deg, #faf4e8, #fffdf8);
        border-radius: 11px 0 0 11px;
      }
      .map-block.sell .mb-rail {
        border-right-color: #bcdcc9;
        background: linear-gradient(90deg, #e8f5ee, #f5fcf8);
      }
      .mb-rail .op-icon { flex: 0 0 auto; }
      .mb-vname {
        writing-mode: vertical-rl; transform: rotate(180deg);
        flex: 1; min-height: 0; max-height: 100%;
        font-size: calc(12px * min(var(--fs, 1), 1.1)); font-weight: 600; letter-spacing: 0; color: var(--ink);
        white-space: nowrap; overflow: hidden;
      }
      .op-warn {
        color: var(--red); font-weight: 900; padding: 0 2px;
        text-shadow: 0 0 8px rgba(190, 60, 40, .18);
      }
      .mb-stats {
        flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 1px;
        font-size: calc(9px * var(--fs, 1)); font-weight: 500; line-height: 1.15; color: #8a6a3a; white-space: nowrap;
      }
      /* карточки с фасовками окрашены по цвету своего каталога */
      .map-block.has-packs {
        border-color: var(--card-border, #b7dcc8);
        border-left-color: var(--card-accent, var(--green));
        background: linear-gradient(180deg, var(--card-bg, #f5fcf8) 0%, #fffdf8 78%);
      }
      .map-block.has-packs .mb-rail {
        border-right-color: var(--card-border, #bcdcc9);
        background: linear-gradient(90deg, var(--card-bg, #e8f5ee), #fffdf8);
      }
      .map-block.has-packs .mb-result { border-top-color: var(--card-border, #bcdcc9); }
      .map-block.has-packs .mb-cat {
        background: var(--card-accent, var(--green));
        color: var(--card-ink, #fff);
      }
      .mb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 8px 11px 8px 9px; }
      .mb-main > .mb-result:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
      .mb-result {
        display: flex; align-items: flex-start; gap: 6px; margin-top: 5px; padding-top: 4px;
        border-top: 1px dashed #e8dfcd;
      }
      .mb-name {
        flex: 1; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical;
        -webkit-line-clamp: 2; overflow: hidden; text-overflow: ellipsis;
        white-space: normal; word-break: break-word;
        font-size: calc(16px * var(--fs, 1)); font-weight: 600; line-height: 1.1; color: var(--ink);
      }
      .mb-qty { font-size: calc(12.5px * var(--fs, 1)); font-weight: 600; white-space: nowrap; margin-top: 1px; }
      .mb-portion { margin-top: 2px; font-size: calc(10.5px * var(--fs, 1)); color: var(--muted); }
      .mb-need { margin-top: 2px; font-size: calc(10px * var(--fs, 1)); font-weight: 600; color: #8a6a1f; }
      .node-need { margin-top: 3px; font-size: calc(9.5px * var(--fs, 1)); font-weight: 600; color: #8a6a1f; }
      .mb-pack {
        margin-top: 3px; font-size: calc(10.5px * var(--fs, 1)); color: var(--muted);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .mb-pack.empty { color: #b08a2a; }
      .result-box { border-top: 1px solid var(--line); padding-top: 10px; margin: 4px 0 10px; }
      .missing { border-color: var(--red) !important; background: var(--red-soft) !important; }
      .f.req { color: var(--ink); }
      .pack-warn { margin: 2px 0 8px; font-size: 10.5px; font-weight: 600; color: var(--red); }
      .plan-hint { margin: -6px 0 10px; font-size: 11.5px; font-weight: 600; color: #8a6a1f; }
      .plan-hint.ok { color: var(--green); }
      .plan-hint.bad { color: var(--red); }
      .plan-hint.batch-hint { margin: 0 0 8px; }
      .batch-line { display: flex; align-items: center; gap: 5px; margin: 2px 0 6px; font-size: 12px; color: var(--ink); }
      .batch-qty {
        width: 74px; padding: 5px 6px; font: inherit; font-size: 12.5px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 7px; background: #fffdf8;
      }
      .batch-qty:focus, .batch-unit:focus { outline: none; border-color: var(--green); background: #fff; }
      .batch-unit {
        padding: 5px 4px; font: inherit; font-size: 12px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 7px; background: #fffdf8; cursor: pointer;
      }
      .shop-preview {
        margin: 0 0 9px; padding: 7px 8px; border: 1px solid #bcdcc9; border-radius: 8px;
        background: linear-gradient(180deg, #f5fcf8, #e8f5ee);
      }
      .sp-title { display: block; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--green); margin-bottom: 4px; }
      .sp-head { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 4px; }
      .sp-cat {
        font-size: 8.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
        color: #fff; background: var(--green); border-radius: 999px; padding: 2px 7px;
      }
      .sp-row { display: flex; align-items: baseline; gap: 6px; font-size: 10.5px; color: #3e4a43; padding: 1px 0; }
      .sp-row b { margin-left: auto; color: var(--green); font-weight: 800; }
      .mini:disabled { opacity: .45; cursor: not-allowed; }

      /* фасовки */
      .pack-box { margin-bottom: 10px; }
      .pack-card {
        border: 1px solid var(--line); border-radius: 8px; padding: 6px;
        margin-bottom: 6px; background: #fffdf8;
      }
      .pack-line { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
      .pack-line + .pack-line { margin-top: 4px; }
      .pack-qty { width: 64px; }
      .pack-price { width: 78px; }
      .pack-min { width: 56px; }
      .pack-cost { width: 72px; }
      .pack-qty, .pack-price, .pack-min, .pack-cost, .pack-basis {
        padding: 4px 6px; font-size: 11px; color: var(--ink);
        border: 1px solid var(--line); border-radius: 6px; background: #fff;
      }
      .pack-basis { font-size: 10px; }

      /* на узком экране док не должен накрывать квитанцию с результатом */
      @media (max-width: 760px) {
        .dock { position: static; }
      }
    `,
  ],
})
export class ProductionMapComponent implements OnInit, AfterViewInit, OnDestroy {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private wrapEl = viewChild<ElementRef<HTMLDivElement>>('wrap');

  loading = signal(true);
  err = signal('');
  saving = signal(false);
  /** Идёт выпуск/списание — блокируем повторные нажатия. */
  /** Версия карты для оптимистичной блокировки. */
  mapVersion = signal(1);
  producing = signal(false);

  products = signal<Product[]>([]);
  units = signal<Unit[]>([]);
  catalogs = signal<ProductCatalog[]>([]);

  nodes = signal<VNode[]>([]);
  ops = signal<VOp[]>([]);
  selected = signal<Selection>({ kind: 'none' });
  /** Наведение: временная подсветка цепочки. */
  hovered = signal<number | null>(null);
  /** Клик по блоку закрепляет подсветку цепочки до повторного клика. */
  pinnedRoot = signal<number | null>(null);
  activeRoot = computed(() => this.pinnedRoot() ?? this.hovered());
  query = signal('');
  /** Левая панель: сырьё или список рецептур. */
  panel = signal<'raw' | 'recipes'>('raw');
  recipeQuery = signal('');
  /** ИИ-раскладка выполняется. */
  layouting = signal(false);
  /** Показывать облака категорий после ИИ-раскладки. */
  cloudsVisible = signal(false);
  /** Перетаскивание сырья из левой панели на стол (pointer-based, без HTML5 DnD). */
  rawDrag = signal<{ p: Product; x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null);
  /** Редактор конкретной связи: количество и потери %. */
  edgeEdit = signal<{ opUid: number; nodeUid: number; x: number; y: number } | null>(null);
  edgeOp = computed(() => {
    const e = this.edgeEdit();
    return e ? this.ops().find((o) => o.uid === e.opUid) ?? null : null;
  });
  edgeInput = computed(() => {
    const e = this.edgeEdit();
    return e ? this.edgeOp()?.inputs.find((i) => i.nodeUid === e.nodeUid) ?? null : null;
  });

  /** Какой узел сейчас подсвечен-вспышкой после броска. */
  flashUid = signal<number | null>(null);
  /** Карточку тащат над левым списком: подсветить зону удаления. */
  dragGhost = signal<{ x: number; y: number; name: string; canDelete: boolean } | null>(null);
  /** refId сырья, которое уже стоит на карте. */
  onMapRefIds = computed(
    () => new Set(this.nodes().filter((n) => n.kind === 'product' && n.refId != null).map((n) => n.refId))
  );
  rawCat = signal('');
  /** Показывать только сырьё, которого ещё нет на карте. */
  onlyUnused = signal(false);
  /** Каталоги, которые реально встречаются у активного сырья. */
  rawCats = computed(() =>
    [...new Set(this.products().map((p) => p.category).filter((c) => !!c))].sort((a, b) => a.localeCompare(b, 'ru'))
  );

  pan = signal({ x: 0, y: 0 });
  panning = signal(false);
  zoom = signal(1);
  zoomPct = computed(() => Math.round(this.zoom() * 100));
  /** Лёгкое увеличение подписей при отдалении (карточка не упрощается). */
  textScale = computed(() => Math.min(1.35, 1 + (1 - Math.min(1, this.zoom())) * 0.35));
  readonly zoomMin = 0.2;
  readonly zoomMax = 1.5;
  sceneTransform = computed(() => `translate(${this.pan().x}px, ${this.pan().y}px) scale(${this.zoom()})`);

  moving = signal<Moving | null>(null);
  linking = signal<Linking | null>(null);
  opTarget = signal<number | null>(null);
  ctxMenu = signal<CtxMenu | null>(null);

  private panStart: { sx: number; sy: number; px: number; py: number } | null = null;
  private nextNodeUid = 1;
  private nextOpUid = 1;
  private nextPackUid = 1;
  /** Прошлый одиночный клик — для распознавания двойного. */
  private lastMapClick: { kind: 'node' | 'op'; uid: number; at: number } | null = null;

  calc = computed<ProductionMapCalc>(() =>
    calcProductionMap(
      this.nodes().map((n) => ({
        uid: n.uid,
        kind: n.kind,
        refId: n.refId,
        name: n.name,
        unitId: n.unitId,
        unitCode: n.unitCode,
        portionQty: num(n.portionQty),
      })),
      this.ops().map((o) => ({
        uid: o.uid,
        name: o.name,
        yieldPct: num(o.yieldPct) || null,
        planQty: num(o.planQty) || null,
        planUnitId: o.planUnitId ?? null,
        laborHours: num(o.laborHours),
        outputUid: o.outputUid,
        inputs: o.inputs.map((i) => ({ nodeUid: i.nodeUid, qty: num(i.qty), inMass: i.inMass, lossPct: num(i.lossPct) || null })),
      })),
      this.products(),
      this.units()
    )
  );

  baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));
  filteredProducts = computed(() => {
    const q = this.query().trim().toLowerCase();
    const cat = this.rawCat();
    const unusedOnly = this.onlyUnused();
    const onMap = this.onMapRefIds();
    return this.products().filter(
      (p) =>
        (!q || p.name.toLowerCase().includes(q)) &&
        (!cat || p.category === cat) &&
        (!unusedOnly || !onMap.has(p.id))
    );
  });

  selectedNode = computed<VNode | null>(() => {
    const s = this.selected();
    return s.kind === 'node' ? this.nodes().find((n) => n.uid === s.uid) ?? null : null;
  });
  selectedOp = computed<VOp | null>(() => {
    const s = this.selected();
    return s.kind === 'op' ? this.ops().find((o) => o.uid === s.uid) ?? null : null;
  });

  /** Облака сырья по категориям — рамка вокруг сгруппированных карточек. */
  rawClouds = computed(() => {
    const byId = new Map(this.products().map((p) => [p.id, p]));
    const groups = new Map<string, VNode[]>();
    for (const n of this.nodes()) {
      if (n.kind !== 'product' || n.refId == null) continue;
      const category = (byId.get(n.refId)?.category ?? '').trim() || 'прочее';
      const arr = groups.get(category) ?? [];
      arr.push(n);
      groups.set(category, arr);
    }
    return [...groups.entries()]
      .map(([label, list]) => {
        const xs = list.map((n) => n.x);
        const ys = list.map((n) => n.y);
        const x = Math.min(...xs) - 18;
        const y = Math.min(...ys) - 34;
        const w = Math.max(...xs) - Math.min(...xs) + 236 + 36;
        const h = Math.max(...ys) - Math.min(...ys) + 92 + 34;
        return { key: label, label, x, y, w, h, count: list.length };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  });

  /** Список всех рецептур (заготовки и блюда) для левой панели. */
  recipes = computed(() => {
    const q = this.recipeQuery().trim().toLowerCase();
    const calc = this.calc();
    return this.nodes()
      .filter((n) => n.kind !== 'product')
      .filter((n) => !q || n.name.toLowerCase().includes(q))
      .map((n) => {
        const op = this.producerByOutput().get(n.uid);
        const warnings = op ? calc.ops[op.uid]?.warnings ?? [] : [];
        return {
          uid: n.uid,
          name: n.name,
          kind: n.kind,
          kindLabel: n.kind === 'state' ? 'заготовка' : 'блюдо',
          packs: n.packagings.length,
          warning: warnings.length ? warnings[0] : '',
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  /** выход-узел каждой операции: операция и её результат — один визуальный блок */
  producerByOutput = computed(() => {
    const map = new Map<number, VOp>();
    for (const op of this.ops()) map.set(op.outputUid, op);
    return map;
  });

  /** узлы без производителя — сырьё и ещё не собранные результаты */
  freeNodes = computed(() => {
    const producers = this.producerByOutput();
    return this.nodes().filter((n) => !producers.has(n.uid));
  });

  blocks = computed(() =>
    this.ops().map((op) => ({
      op,
      out: this.nodes().find((n) => n.uid === op.outputUid) ?? null,
    }))
  );

  selectedOut = computed<VNode | null>(() => {
    const op = this.selectedOp();
    return op ? this.nodes().find((n) => n.uid === op.outputUid) ?? null : null;
  });

  /** Сводка по выбранному/подсвеченному результату: выход, фасовки, себестоимость, часы. */
  summaryResult = computed(() => {
    const n = this.selectedNode();
    const out = this.selectedOut();
    const uid = this.activeRoot() ?? (out ? out.uid : n && n.kind !== 'product' ? n.uid : null);
    if (uid == null) return null;
    const node = this.nodes().find((x) => x.uid === uid);
    if (!node || node.kind === 'product') return null;
    const c = this.calc().nodes[uid];
    const packs = node.packagings ?? [];
    return {
      uid: node.uid,
      name: node.name,
      unit: node.unitCode,
      producedQty: c?.producedQty ?? 0,
      cost: c?.cost ?? 0,
      labor: Math.round((c?.labor ?? 0) * 1000) / 1000,
      packs: packs.length,
      noPrice: packs.filter((p) => !this.packPriceOk(p)).length,
    };
  });

  /** Сколько каждого узла нужно на одну порцию подсвеченного результата (потери — в обратную сторону). */
  hoverNeed = computed<Map<number, number>>(() => {
    const need = new Map<number, number>();
    const rootUid = this.activeRoot();
    if (rootUid == null) return need;
    const root = this.nodes().find((n) => n.uid === rootUid);
    if (!root || root.kind === 'product') return need;
    const portion = num(root.portionQty) > 0 ? num(root.portionQty) : this.calc().nodes[rootUid]?.producedQty ?? 0;
    if (!(portion > 0)) return need;
    const producers = new Map<number, VOp>();
    for (const op of this.ops()) producers.set(op.outputUid, op);
    const visit = (uid: number, required: number, depth: number): void => {
      if (depth > 40) return;
      const node = this.nodes().find((n) => n.uid === uid);
      if (!node) return;
      const prev = need.get(uid);
      if (prev != null && prev >= required - 0.001) return;
      need.set(uid, Math.round(required * 1000) / 1000);
      const op = producers.get(uid);
      if (!op) return;
      const outQty = this.opCalc(op.uid)?.outputQty ?? 0;
      if (!(outQty > 0)) return;
      for (const inp of op.inputs) {
        const q = num(inp.qty);
        if (!(q > 0)) continue;
        const loss = Math.min(100, Math.max(0, num(inp.lossPct)));
        const net = (q / outQty) * required;
        const gross = loss >= 100 ? net : net / (1 - loss / 100);
        visit(inp.nodeUid, gross, depth + 1);
      }
    };
    visit(rootUid, portion, 0);
    return need;
  });

  blockNeed(op: VOp): number | null {
    if (op.outputUid === this.activeRoot()) return null;
    return this.hoverNeed().get(op.outputUid) ?? null;
  }

  blockNeedText(op: VOp): string {
    const n = this.blockNeed(op);
    if (n == null) return '';
    const out = this.nodes().find((x) => x.uid === op.outputUid);
    return fmtQty(n, out?.unitCode ?? '');
  }

  nodeNeedText(n: VNode): string {
    if (n.uid === this.activeRoot()) return '';
    const v = this.hoverNeed().get(n.uid);
    return v == null ? '' : fmtQty(v, n.unitCode);
  }

  highlight = computed<Highlight | null>(() => {
    const root = this.activeRoot();
    if (root == null) return null;
    const rootNode = this.nodes().find((n) => n.uid === root);
    if (!rootNode) return null;

    const producer = new Map<number, VOp>();
    for (const op of this.ops()) producer.set(op.outputUid, op);

    const nodesSet = new Set<number>();
    const opsSet = new Set<number>();
    const wiresSet = new Set<string>();

    /** только вверх: что нужно, чтобы получить этот узел */
    const visitUp = (uid: number): void => {
      if (nodesSet.has(uid)) return;
      nodesSet.add(uid);
      const op = producer.get(uid);
      if (!op) return;
      opsSet.add(op.uid);
      for (const input of op.inputs) {
        wiresSet.add(`i${op.uid}-${input.nodeUid}`);
        visitUp(input.nodeUid);
      }
    };

    /**
     * Сырьё: подсвечиваем все блоки, где оно используется — прямо и через
     * промежуточные заготовки/блюда, вниз по цепочке.
     */
    const visitDown = (uid: number): void => {
      if (nodesSet.has(uid)) return;
      nodesSet.add(uid);
      for (const op of this.ops()) {
        if (opsSet.has(op.uid)) continue;
        if (!op.inputs.some((i) => i.nodeUid === uid)) continue;
        opsSet.add(op.uid);
        nodesSet.add(op.outputUid);
        wiresSet.add(`i${op.uid}-${uid}`);
        visitDown(op.outputUid);
      }
    };

    if (rootNode.kind === 'product') visitDown(root);
    else visitUp(root);
    return { nodes: nodesSet, ops: opsSet, wires: wiresSet };
  });

  wires = computed<Wire[]>(() => {
    const byUid = new Map(this.nodes().map((n) => [n.uid, n]));
    const producers = new Map<number, VOp>();
    for (const op of this.ops()) producers.set(op.outputUid, op);
    const out: Wire[] = [];
    for (const op of this.ops()) {
      for (const input of op.inputs) {
        const src = byUid.get(input.nodeUid);
        if (!src) continue;
        const srcBlock = producers.get(src.uid);
        const x1 = srcBlock ? srcBlock.x + BLOCK_W : src.x + NODE_W;
        const y1 = srcBlock ? srcBlock.y + PORT_DY : src.y + PORT_DY;
        const x2 = op.x;
        const y2 = op.y + BLOCK_H / 2;
        const qty = num(input.qty);
        const loss = num(input.lossPct);
        const lossTxt = loss > 0 ? ` −${Math.round(loss * 10) / 10}%` : '';
        const outNode = byUid.get(op.outputUid) ?? null;
        const accent = this.accentOf(outNode);
        out.push({
          id: `i${op.uid}-${input.nodeUid}`,
          d: this.wireD(x1, y1, x2, y2),
          kind: 'input',
          opUid: op.uid,
          nodeUid: input.nodeUid,
          mx: (x1 + x2) / 2,
          my: (y1 + y2) / 2,
          // на связи показываем только коэффициент потерь
          label: loss > 0 ? lossTxt.trim() : '',
          // без фасовок у блока — его штатный оранжевый
          color: accent ? shade(accent, 0.72) : '#c97b2e',
        });
      }
    }
    return out;
  });

  ngOnInit(): void {
    try {
      // Облака категорий — часть дефолтного вида карты.
      this.cloudsVisible.set(localStorage.getItem('map.clouds') !== '0');
    } catch {
      this.cloudsVisible.set(true);
    }
    this.reload();
  }

  ngAfterViewInit(): void {
    this.wrapEl()?.nativeElement.addEventListener('wheel', this.wheelListener, { passive: false });
  }

  ngOnDestroy(): void {
    this.wrapEl()?.nativeElement.removeEventListener('wheel', this.wheelListener);
  }

  private wheelListener = (ev: WheelEvent): void => this.onWheel(ev);

  reload(): void {
    this.loading.set(true);
    this.err.set('');
    let done = 0;
    const finish = (e?: string): void => {
      if (e) this.err.set(e);
      if (++done === 4) this.loading.set(false);
    };
    this.api.products$({ active: 'true' }).subscribe({ next: (p) => { this.products.set(p); finish(); }, error: (e) => finish(this.errText(e)) });
    this.api.units$().subscribe({ next: (u) => { this.units.set(u); finish(); }, error: (e) => finish(this.errText(e)) });
    this.api.productCatalogs$().subscribe({ next: (c) => { this.catalogs.set(c); finish(); }, error: (e) => finish(this.errText(e)) });
    this.api.productionMap$().subscribe({
      next: (m) => {
        const nodes: VNode[] = m.nodes.map((n) => ({
          uid: n.id,
          kind: n.kind,
          refId: n.refId,
          name: n.name,
          nameEn: n.nameEn ?? '',
          nameSr: n.nameSr ?? '',
          catalogId: n.catalogId ?? null,
          unitId: n.unitId,
          unitCode: n.unitCode,
          x: n.x,
          y: n.y,
          portionQty: n.portionQty ? String(n.portionQty) : '',
          price: n.price ? String(n.price) : '',
          note: n.note ?? '',
          packagings: (n.packagings ?? []).map((p) => ({
            uid: p.id,
            name: p.name || `${p.qtyBase} ${n.unitCode}`,
            qtyBase: String(p.qtyBase),
            minOrder: String(p.minOrder ?? 1),
            isDefault: p.isDefault,
            price: p.price ? String(p.price) : '',
            priceBasis: p.priceBasis,
            cost: p.cost ? String(p.cost) : '',
            available: p.available !== false,
            tareProductIds: p.tareProductIds ?? [],
          })),
        }));
        const ops: VOp[] = m.ops.map((o) => ({
          uid: o.id,
          name: o.name,
          yieldPct: o.yieldPct == null ? '100' : String(o.yieldPct),
          planQty: o.planQty == null ? '' : String(o.planQty),
          planUnitId: o.planUnitId ?? undefined,
          laborHours: o.laborHours ? String(o.laborHours) : '',
          outputUid: o.outputNodeId,
          note: o.note ?? '',
          x: o.x,
          y: o.y,
          inputs: o.inputs.map((i) => ({ nodeUid: i.nodeId, qty: i.qty ? String(i.qty) : '', inMass: i.inMass, lossPct: i.lossPct == null ? "" : String(i.lossPct) })),
        }));
        this.nodes.set(nodes);
        this.mapVersion.set(m.version ?? 1);
        this.ops.set(ops);
        this.nextNodeUid = nodes.reduce((mx, n) => Math.max(mx, n.uid), 0) + 1;
        this.nextOpUid = ops.reduce((mx, o) => Math.max(mx, o.uid), 0) + 1;
        this.nextPackUid = nodes.reduce(
          (mx, n) => Math.max(mx, ...n.packagings.map((p) => p.uid), 0),
          0
        ) + 1;
        this.selected.set({ kind: 'none' });
        this.hovered.set(null);
        this.pinnedRoot.set(null);
        if (nodes.length) {
          // Раскладываем автоматически только «пустую» карту без сохранённых позиций,
          // иначе уважаем расстановку, с которой карту сохранили.
          const needsLayout = ops.length > 0 && ops.every((o) => !o.x && !o.y);
          // По умолчанию сырьё сразу собирается кустами по категориям.
          if (needsLayout) setTimeout(() => this.compactLayout(false), 60);
          else setTimeout(() => this.fitView(), 60);
        }
        finish();
      },
      error: (e) => finish(this.errText(e)),
    });
  }

  private errText(e: unknown): string {
    const any = e as { error?: { error?: string }; message?: string };
    return any?.error?.error ?? any?.message ?? 'Не удалось загрузить карту';
  }

  /** Выпуск партии: сырьё списывается со склада по составу с потерями. */
  produceOp(op: VOp): void {
    if (this.producing()) return;
    const out = this.nodes().find((n) => n.uid === op.outputUid);
    const qty = this.planInOutput(op) ?? this.opCalc(op.uid)?.outputQty ?? 0;
    if (!(qty > 0) || !out) {
      this.toast.show('Сначала задайте партию операции', 'warn', 2600);
      return;
    }
    if (!confirm(`Выпустить ${fmtQty(qty, out.unitCode)} «${out.name}»?\nСырьё будет списано со склада.`)) return;
    this.producing.set(true);
    this.api.produceMapBatch$(op.uid, qty).subscribe({
      next: (r) => {
        this.producing.set(false);
        this.toast.show(`Партия #${r.batchId} выпущена · ${fmtMoney(r.costTotal)}`, 'ok', 3200);
      },
      error: (e) => {
        this.producing.set(false);
        this.toast.show(this.errText(e), 'err', 4200);
      },
    });
  }

  /** Отгрузка готового: сырьё списывается обратным разворотом состава. */
  shipOp(op: VOp): void {
    if (this.producing()) return;
    const out = this.nodes().find((n) => n.uid === op.outputUid);
    const qty = this.planInOutput(op) ?? this.opCalc(op.uid)?.outputQty ?? 0;
    if (!(qty > 0) || !out) {
      this.toast.show('Сначала задайте партию операции', 'warn', 2600);
      return;
    }
    if (!confirm(`Списать сырьё за ${fmtQty(qty, out.unitCode)} «${out.name}» при отгрузке?`)) return;
    this.producing.set(true);
    this.api.shipMapOutput$(out.uid, qty).subscribe({
      next: (r) => {
        this.producing.set(false);
        this.toast.show(`Списано сырьё за ${fmtQty(r.qty, out.unitCode)}`, 'ok', 3200);
      },
      error: (e) => {
        this.producing.set(false);
        this.toast.show(this.errText(e), 'err', 4200);
      },
    });
  }

  /** Карточка готова к продаже: есть каталог и у каждой фасовки задана цена. */
  blockSell(op: VOp): boolean {
    const out = this.nodes().find((n) => n.uid === op.outputUid);
    if (!out || out.kind === 'product' || !out.packagings.length || out.catalogId == null) return false;
    return out.packagings.every((p) => this.packPriceOk(p));
  }

  private outOf(op: VOp): VNode | null {
    return this.nodes().find((n) => n.uid === op.outputUid) ?? null;
  }

  private accentOf(node: VNode | null): string {
    if (!node || node.kind === 'product' || !node.packagings.length) return '';
    const catalog = this.catalogs().find((c) => c.id === node.catalogId);
    return hexColor(catalog?.color) ?? '#2f7d5b';
  }

  blockHasPacks(op: VOp): boolean {
    const out = this.outOf(op);
    return !!out && out.kind !== 'product' && out.packagings.length > 0;
  }
  nodeHasPacks(node: VNode): boolean {
    return node.kind !== 'product' && node.packagings.length > 0;
  }

  blockAccent(op: VOp): string { return this.accentOf(this.outOf(op)); }
  blockBg(op: VOp): string { return tint(this.blockAccent(op), 0.13); }
  blockBorder(op: VOp): string { return tint(this.blockAccent(op), 0.45); }
  blockInk(op: VOp): string { return inkOn(this.blockAccent(op)); }

  nodeAccent(node: VNode): string { return this.accentOf(node); }
  nodeBg(node: VNode): string { return tint(this.nodeAccent(node), 0.13); }
  nodeBorder(node: VNode): string { return tint(this.nodeAccent(node), 0.45); }
  nodeInk(node: VNode): string { return inkOn(this.nodeAccent(node)); }

  /** У фасовки задана цена — обязательное поле. */
  packPriceOk(p: VPackaging | null | undefined): boolean {
    return !!p && num(p.price) > 0;
  }

  packMissingPrice(n: VNode | null | undefined): boolean {
    return !!n && n.packagings.some((p) => !this.packPriceOk(p));
  }

  inspTitle(): string {
    if (this.selectedOp()) return 'Операция';
    const n = this.selectedNode();
    if (!n) return 'Карта';
    return n.kind === 'product' ? 'Сырьё' : 'Результат';
  }

  nodeName(uid: number): string {
    return this.nodes().find((n) => n.uid === uid)?.name ?? '—';
  }

  nodeUnit(uid: number): string {
    return this.nodes().find((n) => n.uid === uid)?.unitCode ?? '';
  }

  outputUnitOf(uid: number): string {
    return this.nodes().find((n) => n.uid === uid)?.unitCode ?? '';
  }

  usageCount(uid: number): number {
    let n = 0;
    for (const op of this.ops()) if (op.inputs.some((i) => i.nodeUid === uid)) n++;
    return n;
  }

  nodeCalc(uid: number): { producedQty: number; cost: number; labor: number; usedQty: number; warnings: string[] } | undefined {
    return this.calc().nodes[uid];
  }

  opCalc(uid: number): { outputQty: number; massQty: number; grossMassQty: number; cost: number; labor: number; warnings: string[] } | undefined {
    return this.calc().ops[uid];
  }

  dishOf(uid: number): { portions: number; costPerPortion: number | null; laborPerPortion: number | null } | undefined {
    return this.calc().dishes[uid];
  }

  nodeQty(uid: number): string {
    const n = this.nodes().find((x) => x.uid === uid);
    const c = this.nodeCalc(uid);
    return n ? fmtQty(c?.producedQty ?? 0, n.unitCode) : '—';
  }

  nodeCost(uid: number): number {
    return this.nodeCalc(uid)?.cost ?? 0;
  }

  nodeCostLabel(uid: number): string {
    const c = this.nodeCost(uid);
    return c > 0 ? `≈ ${fmtMoney(c)}` : '';
  }

  nodeLabor(uid: number): number {
    return Math.round((this.nodeCalc(uid)?.labor ?? 0) * 1000) / 1000;
  }

  opLabor(uid: number): number {
    return Math.round((this.opCalc(uid)?.labor ?? 0) * 1000) / 1000;
  }

  yieldLabel(op: VOp): string {
    const y = num(op.yieldPct) || 100;
    return `выход ${y} %`;
  }

  /** План выхода операции в единице результата. */
  planShort(op: VOp): string {
    const p = num(op.planQty);
    return p > 0 ? fmtQty(p, this.planUnitCode(op)) : '—';
  }

  planTitle(op: VOp): string {
    const p = num(op.planQty);
    return p > 0 ? `Партия: ${fmtQty(p, this.planUnitCode(op))}` : 'Партия не задана';
  }

  batchUnits = computed(() => this.units().filter((u) => u.code === 'г' || u.code === 'мл'));

  /** Единица партии: выбранная у операции или единица результата (г/мл). */
  planUnitIdOf(op: VOp): number {
    if (op.planUnitId) return op.planUnitId;
    const out = this.nodes().find((n) => n.uid === op.outputUid);
    const ids = this.batchUnits().map((u) => u.id);
    return out?.unitId && ids.includes(out.unitId) ? out.unitId : this.batchUnits()[0]?.id ?? 1;
  }

  planUnitCode(op: VOp): string {
    return this.units().find((u) => u.id === this.planUnitIdOf(op))?.code ?? '';
  }

  setPlanUnit(opUid: number, unitId: number): void {
    this.ops.update((list) => list.map((o) => (o.uid === opUid ? { ...o, planUnitId: unitId } : o)));
  }

  /** Единица результата операции. */
  private outUnitId(op: VOp): number | null {
    return this.nodes().find((n) => n.uid === op.outputUid)?.unitId ?? null;
  }

  /** Партия N, приведённая к единице результата. */
  private planInOutput(op: VOp): number | null {
    const p = num(op.planQty);
    const out = this.outUnitId(op);
    if (!(p > 0) || !out) return null;
    return toBaseClient(this.units(), p, this.planUnitIdOf(op), out, null);
  }

  /** Сумма нетто-ингредиентов в единице результата (потери не вычитаются). */
  private netInOutput(op: VOp): number | null {
    const out = this.outUnitId(op);
    if (!out) return null;
    let sum = 0;
    for (const i of op.inputs) {
      if (!i.inMass) continue;
      const q = num(i.qty);
      if (!(q > 0)) continue;
      const src = this.nodes().find((n) => n.uid === i.nodeUid);
      if (!src) return null;
      const prod = src.kind === 'product' ? this.products().find((p) => p.id === src.refId) : undefined;
      const conv = prod ? { gPerPcs: prod.gPerPcs, mlPerPcs: prod.mlPerPcs, gPerMl: prod.gPerMl } : null;
      const m = toBaseClient(this.units(), q, src.unitId, out, conv);
      if (m == null) return null;
      sum += m;
    }
    return Math.round(sum * 1000) / 1000;
  }

  batchOk(op: VOp): boolean {
    const p = this.planInOutput(op);
    const net = this.netInOutput(op);
    return p != null && net != null && Math.abs(p - net) <= 0.01;
  }

  batchMismatch(op: VOp): boolean {
    const p = num(op.planQty);
    return p > 0 && !this.batchOk(op);
  }

  batchText(op: VOp): string {
    const p = num(op.planQty);
    if (!(p > 0)) {
      const net = this.netInOutput(op);
      const out = this.outUnitId(op);
      const code = this.units().find((u) => u.id === out)?.code ?? '';
      return net == null ? 'Ингредиенты нельзя привести к единице результата' : `Сумма ингредиентов: ${fmtQty(net, code)}`;
    }
    const plan = this.planInOutput(op);
    if (plan == null) return 'Единица партии не совпадает с единицей результата';
    const net = this.netInOutput(op);
    if (net == null) return 'Ингредиенты нельзя привести к единице результата';
    const unit = this.units().find((u) => u.id === this.outUnitId(op))?.code ?? '';
    const diff = Math.round((plan - net) * 1000) / 1000;
    if (Math.abs(diff) <= 0.01) return `a + b + c = N · ${fmtQty(net, unit)}`;
    return diff > 0
      ? `Сумма ингредиентов ${fmtQty(net, unit)} · не хватает ${fmtQty(diff, unit)}`
      : `Сумма ингредиентов ${fmtQty(net, unit)} · лишних ${fmtQty(-diff, unit)}`;
  }

  /** Короткие подписи для вертикальной полосы операции. */
  yieldShort(op: VOp): string {
    return `${num(op.yieldPct) || 100} %`;
  }

  laborShort(op: VOp): string {
    const h = num(op.laborHours);
    return h > 0 ? `${h} ч` : '—';
  }

  laborLabel(op: VOp): string {
    const h = num(op.laborHours);
    return h > 0 ? `${h} ч` : 'часы не заданы';
  }

  opOutputLabel(uid: number): string {
    const n = this.ops().find((o) => o.uid === uid);
    const out = n ? this.nodes().find((x) => x.uid === n.outputUid) : null;
    return fmtQty(this.opCalc(uid)?.outputQty ?? 0, out?.unitCode ?? '');
  }

  opOutputNode(op: VOp): VNode | null {
    return this.nodes().find((n) => n.uid === op.outputUid) ?? null;
  }

  blockQty(op: VOp): string {
    const out = this.opOutputNode(op);
    return fmtQty(this.opCalc(op.uid)?.outputQty ?? 0, out?.unitCode ?? '');
  }

  blockCost(op: VOp): string {
    const cost = this.opCalc(op.uid)?.cost ?? 0;
    return cost > 0 ? fmtMoney(cost) : '';
  }

  blockPortion(op: VOp): string {
    const out = this.opOutputNode(op);
    if (!out || out.kind !== 'output' || !num(out.portionQty)) return '';
    return `порция ${trim(num(out.portionQty))} ${out.unitCode}`;
  }

  onBlockEnter(b: { op: VOp; out: VNode | null }): void {
    if (b.out) this.hovered.set(b.out.uid);
  }

  onBlockLeave(b: { op: VOp; out: VNode | null }): void {
    if (b.out && this.hovered() === b.out.uid) this.hovered.set(null);
  }

  isNodeDim(uid: number): boolean {
    const h = this.highlight();
    return !!h && !h.nodes.has(uid);
  }

  isNodeLit(uid: number): boolean {
    const h = this.highlight();
    return !!h && h.nodes.has(uid);
  }

  isOpDim(uid: number): boolean {
    const h = this.highlight();
    return !!h && !h.ops.has(uid);
  }

  isOpLit(uid: number): boolean {
    const h = this.highlight();
    return !!h && h.ops.has(uid);
  }

  isWireDim(id: string): boolean {
    const h = this.highlight();
    return !!h && !h.wires.has(id);
  }

  isWireLit(id: string): boolean {
    const h = this.highlight();
    return !!h && h.wires.has(id);
  }

  onNodeEnter(n: VNode): void {
    // Сырьё тоже подсвечивает цепочку — вниз, где оно используется.
    this.hovered.set(n.uid);
  }

  onNodeLeave(n: VNode): void {
    if (this.hovered() === n.uid) this.hovered.set(null);
  }

  // ---------- загрузка / сохранение ----------
  save(): void {
    if (this.saving()) return;
    for (const op of this.ops()) {
      if (!op.inputs.length) continue;
      for (const i of op.inputs) {
        if (!(num(i.qty) > 0)) {
          this.toast.show(`Укажите количество для «${this.nodeName(i.nodeUid)}»`, 'warn', 2600);
          return;
        }
        if (num(i.lossPct) >= 100) {
          this.toast.show(`Потери на связи «${this.nodeName(i.nodeUid)}» должны быть меньше 100 %`, 'warn', 3000);
          return;
        }
      }
      // Расхождение партии и суммы нетто не блокирует сохранение:
      // оно показывается предупреждением в карточке операции.
    }
    for (const n of this.nodes()) {
      if (n.kind === 'product' || !n.packagings.length) continue;
      const hasAvailable = n.packagings.some((p) => p.available);
      const noPrice = n.packagings.find((p) => p.available && !this.packPriceOk(p));
      if (noPrice) {
        this.selected.set({ kind: 'node', uid: n.uid });
        this.toast.show(`Укажите цену фасовки «${this.packLabel(n, noPrice)}» у «${n.name || 'результата'}»`, 'warn', 3200);
        return;
      }
      if (hasAvailable && n.catalogId == null) {
        this.selected.set({ kind: 'node', uid: n.uid });
        this.toast.show(`Выберите каталог для «${n.name || 'результата'}»`, 'warn', 3200);
        return;
      }
    }
    const body = {
      version: this.mapVersion(),
      nodes: this.nodes().map((n) => ({
        uid: n.uid,
        kind: n.kind,
        refId: n.refId,
        name: n.name,
        nameEn: n.nameEn,
        nameSr: n.nameSr,
        catalogId: n.catalogId,
        unitId: n.unitId,
        x: n.x,
        y: n.y,
        portionQty: n.kind === 'product' ? 0 : num(n.portionQty),
        price: n.kind === 'product' ? 0 : num(n.price),
        note: n.note,
        packagings: n.kind === 'product' ? [] : n.packagings.map((p) => ({
          uid: p.uid,
          name: p.name,
          qtyBase: num(p.qtyBase),
          minOrder: Math.max(1, Math.round(num(p.minOrder) || 1)),
          isDefault: p.isDefault,
          price: num(p.price),
          priceBasis: p.priceBasis,
          cost: num(p.cost),
          available: p.available,
          tareProductIds: p.tareProductIds ?? [],
        })),
      })),
      ops: this.ops().map((o) => ({
        uid: o.uid,
        name: o.name,
        yieldPct: num(o.yieldPct) || null,
        planQty: num(o.planQty) || null,
        planUnitId: o.planUnitId ?? null,
        laborHours: num(o.laborHours),
        outputUid: o.outputUid,
        note: o.note,
        x: o.x,
        y: o.y,
        inputs: o.inputs.map((i) => ({ nodeUid: i.nodeUid, qty: num(i.qty), inMass: i.inMass, lossPct: num(i.lossPct) || null })),
      })),
    };
    this.saving.set(true);
    this.api.saveProductionMap(body).subscribe({
      next: (r) => {
        this.saving.set(false);
        const n = r.warnings?.length ?? 0;
        this.toast.show(
          n
            ? `Карта сохранена. Предупреждений: ${n} — партия не равна сумме нетто`
            : 'Карта производства сохранена',
          n ? 'warn' : 'ok',
          n ? 4200 : 2000
        );
        this.reload();
      },
      error: (e) => {
        this.saving.set(false);
        const status = (e as { status?: number })?.status;
        this.toast.show(this.errText(e), 'err', 4000);
        if (status === 409) this.reload();
      },
    });
  }

  clearMap(): void {
    if (!confirm('Очистить всю карту производства?')) return;
    this.nodes.set([]);
    this.ops.set([]);
    this.selected.set({ kind: 'none' });
    this.hovered.set(null);
    this.pinnedRoot.set(null);
    this.nextNodeUid = 1;
    this.nextOpUid = 1;
    this.save();
  }

  // ---------- добавление ----------
  /** Клик по сырью ничего не добавляет: только подсветить уже стоящую карточку. */
  private onRawClick(p: Product): void {
    const existing = this.nodes().find((n) => n.kind === 'product' && n.refId === p.id);
    if (existing) {
      this.revealNode(existing);
      this.flashNode(existing.uid);
      return;
    }
    this.toast.show('Перетащите сырьё на стол', 'info', 1600);
  }

  createOpCenter(): void {
    const c = this.visibleCenter();
    this.createOpAt(c.x - BLOCK_W / 2, c.y - BLOCK_H / 2);
  }

  private createOpAt(x: number, y: number): void {
    const unit = this.baseUnits().find((u) => u.code === 'г') ?? this.baseUnits()[0];
    if (!unit) {
      this.toast.show('Нет базовых единиц', 'err', 2400);
      return;
    }
    const opPos = this.keepInView(x, y, BLOCK_W, BLOCK_H);
    const nodeUid = this.nextNodeUid++;
    const outNode: VNode = {
      uid: nodeUid,
      kind: 'state',
      refId: null,
      name: 'Полуфабрикат',
      nameEn: '',
      nameSr: '',
      catalogId: null,
      unitId: unit.id,
      unitCode: unit.code,
      x: opPos.x,
      y: opPos.y,
      portionQty: '',
      price: '',
      note: '',
      packagings: [],
    };
    const op: VOp = {
      uid: this.nextOpUid++,
      name: 'Операция',
      yieldPct: '100',
      planQty: '1000',
      planUnitId: unit.id,
      laborHours: '',
      outputUid: nodeUid,
      note: '',
      x: opPos.x,
      y: opPos.y,
      inputs: [],
    };
    this.nodes.update((list) => [...list, outNode]);
    this.ops.update((list) => [...list, op]);
    this.selected.set({ kind: 'op', uid: op.uid });
  }

  // ---------- каталог ----------
  /** Начало перетаскивания сырья из левой панели; клик без движения = добавить/выбрать. */
  onRawDown(p: Product, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    if (ev.pointerType === 'mouse' || ev.pointerType === 'pen') ev.preventDefault();
    this.rawDrag.set({ p, x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY, moved: false });
  }

  /** Бросить сырьё в точку экрана: создаём узел на столе либо выбираем уже существующий. */
  private dropProductAt(p: Product, clientX: number, clientY: number): void {
    const wrap = this.wrapEl()?.nativeElement;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return;
    const pos = this.toContent(clientX, clientY);
    const existing = this.nodes().find((n) => n.kind === 'product' && n.refId === p.id);
    if (existing) {
      this.revealNode(existing);
      this.flashNode(existing.uid);
      this.toast.show(`«${p.name}» уже на карте — подсвечено`, 'info', 1800);
      return;
    }
    const placed = this.keepInView(pos.x - NODE_W / 2, pos.y - 30, NODE_W, NODE_H);
    const node: VNode = {
      uid: this.nextNodeUid++,
      kind: 'product',
      refId: p.id,
      name: p.name,
      nameEn: '',
      nameSr: '',
      catalogId: null,
      unitId: p.unitId,
      unitCode: p.unitCode,
      x: placed.x,
      y: placed.y,
      portionQty: '',
      price: '',
      note: '',
      packagings: [],
    };
    this.nodes.update((list) => [...list, node]);
    this.flashNode(node.uid);
  }

  /** Карточка на столе вспыхивает и на время выделяется рамкой. */
  private flashNode(uid: number): void {
    this.flashUid.set(null);
    window.setTimeout(() => this.flashUid.set(uid), 20);
    window.setTimeout(() => {
      if (this.flashUid() === uid) this.flashUid.set(null);
    }, 1500);
  }

  /** Если карточка за пределами видимой области — подводим стол к ней. */
  private revealNode(n: VNode): void {
    const wrap = this.wrapEl()?.nativeElement;
    if (!wrap) return;
    const z = this.zoom() || 1;
    const p = this.pan();
    const sx = p.x + (n.x + NODE_W / 2) * z;
    const sy = p.y + (n.y + NODE_H / 2) * z;
    const pad = 48;
    if (sx < pad || sx > wrap.clientWidth - pad || sy < pad || sy > wrap.clientHeight - pad) {
      this.pan.set({
        x: Math.round(wrap.clientWidth / 2 - (n.x + NODE_W / 2) * z),
        y: Math.round(wrap.clientHeight / 2 - (n.y + NODE_H / 2) * z),
      });
    }
  }

  // ---------- свойства ----------
  patchOp(uid: number, field: 'name' | 'yieldPct' | 'planQty' | 'laborHours' | 'note', value: string | number): void {
    const v = String(value ?? '');
    this.ops.update((list) => list.map((o) => (o.uid === uid ? { ...o, [field]: v } : o)));
  }

  patchNode(uid: number, field: 'name' | 'nameEn' | 'nameSr' | 'portionQty' | 'price' | 'note', value: string | number): void {
    const v = String(value ?? '');
    this.nodes.update((list) => list.map((n) => (n.uid === uid ? { ...n, [field]: v } : n)));
  }

  setNodeUnit(uid: number, unitId: number): void {
    const code = this.baseUnits().find((u) => u.id === unitId)?.code ?? '';
    this.nodes.update((list) => list.map((n) => (n.uid === uid ? { ...n, unitId, unitCode: code } : n)));
  }

  setNodeCatalog(uid: number, catalogId: number | null): void {
    this.nodes.update((list) => list.map((n) => (n.uid === uid ? { ...n, catalogId } : n)));
  }

  addPack(nodeUid: number): void {
    const n = this.nodes().find((x) => x.uid === nodeUid);
    if (!n) return;
    const qty = num(n.portionQty) > 0 ? String(num(n.portionQty)) : '100';
    const p: VPackaging = {
      uid: this.nextPackUid++,
      name: `${trim(num(qty))} ${n.unitCode}`,
      qtyBase: qty,
      minOrder: '1',
      isDefault: n.packagings.length === 0,
      price: '',
      priceBasis: 'portion',
      cost: '',
      available: true,
    };
    this.nodes.update((list) =>
      list.map((x) =>
        x.uid === nodeUid
          ? {
              ...x,
              catalogId: x.catalogId ?? this.catalogs()[0]?.id ?? null,
              packagings: [...x.packagings, p],
            }
          : x
      )
    );
    if (n.catalogId == null && this.catalogs()[0]) {
      this.toast.show(`Каталог: ${this.catalogs()[0].name} — при необходимости измените`, 'info', 2200);
    }
  }

  removePack(nodeUid: number, packUid: number): void {
    this.nodes.update((list) =>
      list.map((n) => {
        if (n.uid !== nodeUid) return n;
        const removedDefault = n.packagings.find((p) => p.uid === packUid)?.isDefault;
        const rest = n.packagings.filter((p) => p.uid !== packUid);
        if (removedDefault && rest.length) rest[0] = { ...rest[0], isDefault: true };
        return { ...n, packagings: rest };
      })
    );
  }

  patchPack(
    nodeUid: number,
    packUid: number,
    field: 'qtyBase' | 'minOrder' | 'price' | 'cost' | 'priceBasis' | 'available',
    value: string | number | boolean
  ): void {
    this.nodes.update((list) =>
      list.map((n) => {
        if (n.uid !== nodeUid) return n;
        return {
          ...n,
          packagings: n.packagings.map((p) => {
            if (p.uid !== packUid) return p;
            if (field === 'available') return { ...p, available: value === true };
            if (field === 'priceBasis') {
              const basis = String(value) as VPackaging['priceBasis'];
              return { ...p, priceBasis: basis };
            }
            return { ...p, [field]: String(value ?? '') };
          }),
        };
      })
    );
  }

  setDefaultPack(nodeUid: number, packUid: number): void {
    this.nodes.update((list) =>
      list.map((n) =>
        n.uid === nodeUid
          ? { ...n, packagings: n.packagings.map((p) => ({ ...p, isDefault: p.uid === packUid })) }
          : n
      )
    );
  }

  packLabel(n: VNode, p: VPackaging): string {
    const qty = num(p.qtyBase);
    return qty > 0 ? fmtQty(qty, n.unitCode) : 'фасовка';
  }

  catalogName(id: number | null): string {
    return this.catalogs().find((c) => c.id === id)?.name ?? '';
  }

  /** Цена фасовки для карточки-витрины. */
  packPrice(p: VPackaging): string {
    return fmtMoney(num(p.price));
  }

  packCountLabel(n: VNode): string {
    const c = n.packagings.length;
    const word =
      c % 10 === 1 && c % 100 !== 11
        ? 'фасовка'
        : c % 10 >= 2 && c % 10 <= 4 && (c % 100 < 10 || c % 100 >= 20)
          ? 'фасовки'
          : 'фасовок';
    return `${c} ${word}`;
  }

  packSummary(n: VNode): string {
    const list = n.packagings.map((p) => this.packLabel(n, p));
    return list.length > 3 ? `${list.slice(0, 3).join(' · ')}…` : list.join(' · ');
  }

  packCountOf(uid: number): string {
    const n = this.nodes().find((x) => x.uid === uid);
    return n ? this.packCountLabel(n) : '';
  }

  patchInputQty(opUid: number, nodeUid: number, value: string | number): void {
    const v = String(value ?? '');
    this.ops.update((list) =>
      list.map((o) => (o.uid === opUid ? { ...o, inputs: o.inputs.map((i) => (i.nodeUid === nodeUid ? { ...i, qty: v } : i)) } : o))
    );
  }

  /** Потери на связи в процентах (уварка, очистки). */
  patchInputLoss(opUid: number, nodeUid: number, value: string | number): void {
    const v = String(value ?? '');
    this.ops.update((list) =>
      list.map((o) =>
        o.uid === opUid ? { ...o, inputs: o.inputs.map((i) => (i.nodeUid === nodeUid ? { ...i, lossPct: v } : i)) } : o
      )
    );
  }

  numLoss(i: VInput): boolean {
    return num(i.lossPct) > 0;
  }

  /** Открыть редактор связи по клику на провод. */
  openEdgeEditor(w: Wire, ev: MouseEvent): void {
    ev.stopPropagation();
    if (w.kind !== 'input' || w.nodeUid == null) return;
    this.edgeEdit.set({
      opUid: w.opUid,
      nodeUid: w.nodeUid,
      x: clamp(ev.clientX + 8, 6, Math.max(6, window.innerWidth - 300)),
      y: clamp(ev.clientY + 8, 6, Math.max(6, window.innerHeight - 280)),
    });
  }

  /** Сколько от входа реально попадёт в выход с учётом потерь. */
  edgeNetText(e: { opUid: number; nodeUid: number }): string {
    const inp = this.edgeInput();
    const src = this.nodes().find((n) => n.uid === e.nodeUid);
    if (!inp || !src) return '';
    const qty = num(inp.qty);
    const loss = Math.min(100, Math.max(0, num(inp.lossPct)));
    const net = Math.round(qty * (100 - loss)) / 100;
    return `В выход пойдёт: ${trim(net)} ${src.unitCode}${loss > 0 ? ` (−${Math.round(loss * 10) / 10}%)` : ''}`;
  }

  setInMass(opUid: number, nodeUid: number, value: boolean): void {
    this.ops.update((list) =>
      list.map((o) =>
        o.uid === opUid ? { ...o, inputs: o.inputs.map((i) => (i.nodeUid === nodeUid ? { ...i, inMass: value } : i)) } : o
      )
    );
  }

  // ---------- связи ----------
  onBlockPortDown(op: VOp, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const x1 = op.x + BLOCK_W;
    const y1 = op.y + PORT_DY;
    this.linking.set({ nodeUid: op.outputUid, x1, y1, x2: x1, y2: y1 });
    this.opTarget.set(null);
  }

  /** Коннектор конкретной фасовки: тянет ту же связь от результата операции. */
  onPackPortDown(op: VOp, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const c = this.toContent(ev.clientX, ev.clientY);
    this.linking.set({ nodeUid: op.outputUid, x1: c.x, y1: c.y, x2: c.x, y2: c.y });
    this.opTarget.set(null);
  }

  onPortDown(n: VNode, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const x1 = n.x + NODE_W;
    const y1 = n.y + PORT_DY;
    this.linking.set({ nodeUid: n.uid, x1, y1, x2: x1, y2: y1 });
    this.opTarget.set(null);
  }

  @HostListener('document:pointermove', ['$event'])
  onDocMove(ev: PointerEvent): void {
    const rd = this.rawDrag();
    if (rd) {
      const moved = rd.moved || Math.hypot(ev.clientX - rd.sx, ev.clientY - rd.sy) > 4;
      this.rawDrag.set({ ...rd, x: ev.clientX, y: ev.clientY, moved });
      return;
    }
    if (this.panning()) {
      const ps = this.panStart;
      if (ps) this.pan.set({ x: ps.px + (ev.clientX - ps.sx), y: ps.py + (ev.clientY - ps.sy) });
      return;
    }
    const mv = this.moving();
    if (mv) {
      if (!mv.moved && Math.hypot(ev.clientX - mv.sx, ev.clientY - mv.sy) > 3) {
        mv.moved = true;
        this.selected.set({ kind: 'none' });
      }
      const c = this.toContent(ev.clientX, ev.clientY);
      if (mv.kind === 'node') {
        const pos = this.keepInView(c.x - mv.offX, c.y - mv.offY, NODE_W, NODE_H);
        this.nodes.update((list) => list.map((n) => (n.uid === mv.uid ? { ...n, x: pos.x, y: pos.y } : n)));
      } else {
        const pos = this.keepInView(c.x - mv.offX, c.y - mv.offY, BLOCK_W, BLOCK_H);
        this.ops.update((list) => list.map((o) => (o.uid === mv.uid ? { ...o, x: pos.x, y: pos.y } : o)));
      }
      // подсказка «бросьте сюда, чтобы убрать со стола»
      const overPanel = !!(document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('.raw-panel');
      const draggedNode = mv.kind === 'node' ? this.nodes().find((n) => n.uid === mv.uid) : null;
      if (mv.moved && overPanel && draggedNode?.kind === 'product') {
        const used = this.ops().some((o) => o.inputs.some((i) => i.nodeUid === draggedNode.uid));
        this.dragGhost.set({ x: ev.clientX, y: ev.clientY, name: draggedNode.name, canDelete: !used });
      } else {
        this.dragGhost.set(null);
      }
      return;
    }
    const lk = this.linking();
    if (!lk) return;
    const c = this.toContent(ev.clientX, ev.clientY);
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const opEl = el?.closest<HTMLElement>('[data-op-uid]');
    const target = opEl ? Number(opEl.dataset['opUid']) : null;
    this.opTarget.set(target);
    this.linking.set({ ...lk, x2: c.x, y2: c.y });
  }

  @HostListener('document:pointerup', ['$event'])
  onDocUp(ev: PointerEvent): void {
    const rd = this.rawDrag();
    if (rd) {
      this.rawDrag.set(null);
      if (rd.moved) this.dropProductAt(rd.p, ev.clientX, ev.clientY);
      else this.onRawClick(rd.p);
      return;
    }
    if (this.panning()) {
      this.panning.set(false);
      this.panStart = null;
      return;
    }
    const mv = this.moving();
    if (mv) {
      this.moving.set(null);
      this.dragGhost.set(null);
      if (!mv.moved) {
        this.onMapClick(mv.kind, mv.uid);
        return;
      }
      // Бросок карточки сырья обратно в левый список — убираем её со стола.
      const overPanel = !!(document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('.raw-panel');
      if (overPanel && mv.kind === 'node') {
        const n = this.nodes().find((x) => x.uid === mv.uid);
        if (n && n.kind === 'product') {
          const used = this.ops().some((o) => o.inputs.some((i) => i.nodeUid === n.uid));
          if (used) {
            this.nodes.update((list) =>
              list.map((x) => (x.uid === n.uid ? { ...x, x: mv.origX, y: mv.origY } : x))
            );
            this.toast.show('Сначала отвяжите сырьё от операций', 'warn', 2800);
          } else {
            this.nodes.update((list) => list.filter((x) => x.uid !== n.uid));
            this.hovered.set(null);
            if (this.pinnedRoot() === n.uid) this.pinnedRoot.set(null);
            this.toast.show(`«${n.name}» убрано со стола`, 'info', 1600);
          }
        }
      }
      return;
    }
    const lk = this.linking();
    if (!lk) return;
    const target = this.opTarget();
    this.linking.set(null);
    this.opTarget.set(null);
    if (target != null) this.addInput(target, lk.nodeUid);
  }

  @HostListener('document:pointercancel')
  onDocCancel(): void {
    this.rawDrag.set(null);
    this.moving.set(null);
    this.dragGhost.set(null);
    this.linking.set(null);
    this.opTarget.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeCtx();
    this.linking.set(null);
    this.opTarget.set(null);
    this.moving.set(null);
    this.panning.set(false);
    this.panStart = null;
    this.rawDrag.set(null);
    this.moving.set(null);
    this.dragGhost.set(null);
    this.edgeEdit.set(null);
    if (this.selected().kind !== 'none') this.selected.set({ kind: 'none' });
  }

  private addInput(opUid: number, nodeUid: number): void {
    const op = this.ops().find((o) => o.uid === opUid);
    const src = this.nodes().find((n) => n.uid === nodeUid);
    if (!op || !src) return;
    if (op.inputs.some((i) => i.nodeUid === nodeUid)) return;
    if (this.createsCycle(nodeUid, opUid)) {
      this.toast.show('Такая связь замкнёт цепочку в кольцо', 'warn', 2400);
      return;
    }
    const srcCalc = this.nodeCalc(nodeUid);
    const defaultQty = src.kind === 'product' ? 100 : Math.max(1, Math.round(srcCalc?.producedQty ?? 100));
    this.ops.update((list) =>
      list.map((o) =>
        o.uid === opUid ? { ...o, inputs: [...o.inputs, { nodeUid, qty: String(defaultQty), inMass: true, lossPct: "" }] } : o
      )
    );
    this.selected.set({ kind: 'op', uid: opUid });
  }

  removeInput(opUid: number, nodeUid: number, ev?: Event): boolean {
    ev?.stopPropagation();
    const op = this.ops().find((o) => o.uid === opUid);
    const input = this.nodes().find((n) => n.uid === nodeUid);
    const out = op ? this.nodes().find((n) => n.uid === op.outputUid) : null;
    const from = input?.name || `позиция #${nodeUid}`;
    const to = out?.name || (op?.name ? `операция «${op.name}»` : 'блок');
    if (!confirm(`Удалить связь «${from}» → «${to}»?`)) return false;
    this.ops.update((list) =>
      list.map((o) => (o.uid === opUid ? { ...o, inputs: o.inputs.filter((i) => i.nodeUid !== nodeUid) } : o))
    );
    return true;
  }

  /** Удаление из редактора связи: закрываем панель только после подтверждения. */
  removeInputAndClose(opUid: number, nodeUid: number): void {
    if (this.removeInput(opUid, nodeUid)) this.edgeEdit.set(null);
  }

  private createsCycle(sourceNodeUid: number, targetOpUid: number): boolean {
    const producer = this.ops().find((o) => o.outputUid === sourceNodeUid);
    if (!producer) return false;
    if (producer.uid === targetOpUid) return true;
    const reaches = (fromOp: number, toOp: number, seen: Set<number>): boolean => {
      if (fromOp === toOp) return true;
      if (seen.has(fromOp)) return false;
      seen.add(fromOp);
      const op = this.ops().find((o) => o.uid === fromOp);
      if (!op) return false;
      const consumers = this.ops().filter((o) => o.inputs.some((i) => i.nodeUid === op.outputUid));
      return consumers.some((c) => reaches(c.uid, toOp, seen));
    };
    return reaches(targetOpUid, producer.uid, new Set<number>());
  }

  // ---------- удаление ----------
  deleteNode(uid: number): void {
    if (this.ops().some((o) => o.inputs.some((i) => i.nodeUid === uid))) {
      this.toast.show('Сначала отвяжите узел от операций', 'warn', 2800);
      return;
    }
    const producer = this.ops().find((o) => o.outputUid === uid);
    if (producer) {
      this.deleteOp(producer.uid);
      return;
    }
    this.nodes.update((list) => list.filter((n) => n.uid !== uid));
    if (this.selected().uid === uid) this.selected.set({ kind: 'none' });
    if (this.hovered() === uid) this.hovered.set(null);
    if (this.pinnedRoot() === uid) this.pinnedRoot.set(null);
  }

  deleteOp(uid: number): void {
    const op = this.ops().find((o) => o.uid === uid);
    if (!op) return;
    if (this.ops().some((o) => o.uid !== uid && o.inputs.some((i) => i.nodeUid === op.outputUid))) {
      this.toast.show('Сначала отвяжите выход операции от следующих операций', 'warn', 3200);
      return;
    }
    this.ops.update((list) => list.filter((o) => o.uid !== uid));
    this.nodes.update((list) => list.filter((n) => n.uid !== op.outputUid));
    if (this.selected().uid === uid) this.selected.set({ kind: 'none' });
    if (this.hovered() === op.outputUid) this.hovered.set(null);
    if (this.pinnedRoot() === op.outputUid) this.pinnedRoot.set(null);
  }

  // ---------- меню ----------
  onCanvasContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const target = ev.target as HTMLElement;
    if (target.closest('.node') || target.closest('.op')) return;
    const pos = this.toContent(ev.clientX, ev.clientY);
    const menu = this.menuPos(ev, 1);
    this.ctxMenu.set({ x: menu.x, y: menu.y, items: [{ label: '⚙ Создать операцию', run: () => this.createOpAt(pos.x, pos.y) }] });
  }

  onNodeMenu(n: VNode, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.selected.set({ kind: 'node', uid: n.uid });
    const items: CtxItem[] = [];
    items.push({ label: '🗑 Удалить', danger: true, run: () => this.deleteNode(n.uid) });
    const menu = this.menuPos(ev, items.length);
    this.ctxMenu.set({ x: menu.x, y: menu.y, items });
  }

  onOpMenu(op: VOp, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.selected.set({ kind: 'op', uid: op.uid });
    const items: CtxItem[] = [];
    items.push({ label: '🗑 Удалить операцию', danger: true, run: () => this.deleteOp(op.uid) });
    const menu = this.menuPos(ev, items.length);
    this.ctxMenu.set({ x: menu.x, y: menu.y, items });
  }

  private menuPos(ev: MouseEvent, count: number): { x: number; y: number } {
    const W = 230;
    const H = count * 36 + 20;
    return {
      x: clamp(ev.clientX, 6, Math.max(6, window.innerWidth - W - 6)),
      y: clamp(ev.clientY, 6, Math.max(6, window.innerHeight - H - 6)),
    };
  }

  closeCtx(): void {
    this.ctxMenu.set(null);
  }

  // ---------- движение / панорамирование ----------
  onCanvasDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    if (t.closest('.node') || t.closest('.op') || t.closest('.port') || t.closest('.pack-port') || t.closest('.wire-hit') || t.closest('.ctx')) return;
    if (this.moving() || this.linking()) return;
    this.panning.set(true);
    this.panStart = { sx: ev.clientX, sy: ev.clientY, px: this.pan().x, py: this.pan().y };
    if (this.selected().kind !== 'none') this.selected.set({ kind: 'none' });
    this.pinnedRoot.set(null);
    this.hovered.set(null);
    ev.preventDefault();
  }

  /**
   * Клик по блоку: первый — закрепить подсветку цепочки, повторный — снять.
   * Двойной клик открывает панель настроек.
   */
  private onMapClick(kind: 'node' | 'op', uid: number): void {
    const now = Date.now();
    const last = this.lastMapClick;
    const isDouble = !!last && last.kind === kind && last.uid === uid && now - last.at < 320;
    if (isDouble) {
      this.lastMapClick = null;
      this.selected.set({ kind, uid });
      return;
    }
    this.lastMapClick = { kind, uid, at: now };

    const node = kind === 'node' ? this.nodes().find((n) => n.uid === uid) : null;
    const op = kind === 'op' ? this.ops().find((o) => o.uid === uid) : null;
    // Сырьё тоже можно закрепить: подсветятся все блоки, где оно используется.
    const root = kind === 'op' ? op?.outputUid ?? null : node ? uid : null;

    if (root == null) {
      this.pinnedRoot.set(null);
      this.hovered.set(null);
      return;
    }
    if (this.pinnedRoot() === root) {
      this.pinnedRoot.set(null);
      this.hovered.set(null);
      this.lastMapClick = null;
      return;
    }
    this.pinnedRoot.set(root);
    this.hovered.set(root);
  }

  onNodeDown(n: VNode, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    if (t.closest('input') || t.closest('button') || t.closest('.port') || t.closest('.pack-port')) return;
    const c = this.toContent(ev.clientX, ev.clientY);
    this.moving.set({ kind: 'node', uid: n.uid, offX: c.x - n.x, offY: c.y - n.y, sx: ev.clientX, sy: ev.clientY, origX: n.x, origY: n.y, moved: false });
    ev.preventDefault();
  }

  onOpDown(op: VOp, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    if (t.closest('input') || t.closest('button') || t.closest('.port') || t.closest('.pack-port')) return;
    const c = this.toContent(ev.clientX, ev.clientY);
    this.moving.set({ kind: 'op', uid: op.uid, offX: c.x - op.x, offY: c.y - op.y, sx: ev.clientX, sy: ev.clientY, origX: op.x, origY: op.y, moved: false });
    ev.preventDefault();
  }

  // ---------- раскладка ----------
  private layoutBody(): { nodes: unknown[]; ops: unknown[] } {
    return {
      nodes: this.nodes().map((n) => ({ uid: n.uid, kind: n.kind, refId: n.refId, name: n.name })),
      ops: this.ops().map((o) => ({
        uid: o.uid,
        outputUid: o.outputUid,
        inputs: o.inputs.map((i) => ({ nodeUid: i.nodeUid })),
      })),
    };
  }

  private applyLayout(plan: {
    nodes: { uid: number; x: number; y: number }[];
    ops: { uid: number; x: number; y: number }[];
    summary: string;
    ai: boolean;
  }, announce: boolean): void {
    const nodes = new Map(plan.nodes.map((p) => [p.uid, p] as const));
    const ops = new Map(plan.ops.map((p) => [p.uid, p] as const));
    this.nodes.update((list) =>
      list.map((n) => {
        const p = nodes.get(n.uid);
        return p ? { ...n, x: p.x, y: p.y } : n;
      })
    );
    this.ops.update((list) =>
      list.map((o) => {
        const p = ops.get(o.uid);
        return p ? { ...o, x: p.x, y: p.y } : o;
      })
    );
    this.cloudsVisible.set(true);
    try {
      localStorage.setItem('map.clouds', '1');
    } catch {
      /* приватный режим */
    }
    setTimeout(() => {
      this.relaxAgainstWires();
      this.fitView();
    }, 0);
    if (announce) {
      this.toast.show(
        `${plan.ai ? 'ИИ разложил' : 'Разложено компактно'}: ${plan.summary}. Нажмите «Сохранить», чтобы закрепить.`,
        'ok',
        4200
      );
    }
  }

  /** Компактная раскладка по умолчанию: сырьё кустами по категориям. */
  compactLayout(announce = false): void {
    if (this.layouting()) return;
    if (!this.nodes().length || !this.ops().length) return;
    this.layouting.set(true);
    this.api.aiLayoutMap$(this.layoutBody(), false).subscribe({
      next: (plan) => {
        this.layouting.set(false);
        this.applyLayout(plan, announce);
      },
      error: () => {
        this.layouting.set(false);
        this.autoLayout();
      },
    });
  }

  /** Кнопка «Разложить ИИ»: модель выбирает композицию облаков и этапов. */
  aiLayout(): void {
    if (this.layouting()) return;
    if (!this.nodes().length || !this.ops().length) {
      this.toast.show('Сначала добавьте сырьё и операции', 'warn', 2200);
      return;
    }
    this.layouting.set(true);
    this.api.aiLayoutMap$(this.layoutBody(), true).subscribe({
      next: (plan) => {
        this.layouting.set(false);
        this.applyLayout(plan, true);
      },
      error: (e) => {
        this.layouting.set(false);
        this.autoLayout();
        this.toast.show(
          `ИИ недоступен (${this.errText(e)}) — применена базовая раскладка`,
          'warn',
          4200
        );
      },
    });
  }

  // ---------- авто-раскладка ----------
  autoLayout(): void {
    const nodes = this.nodes();
    const ops = this.ops();
    if (!nodes.length || !ops.length) {
      this.toast.show('Сначала добавьте сырьё и операции', 'warn', 2200);
      return;
    }
    const byUid = new Map(nodes.map((n) => [n.uid, n] as const));
    const opByUid = new Map(ops.map((o) => [o.uid, o] as const));
    const producers = new Map<number, VOp>();
    for (const op of ops) producers.set(op.outputUid, op);

    const nodeDepth = new Map<number, number>();
    const opDepth = new Map<number, number>();
    const nodeBusy = new Set<number>();
    const opBusy = new Set<number>();

    function depthOfNode(uid: number): number {
      const cached = nodeDepth.get(uid);
      if (cached != null) return cached;
      if (nodeBusy.has(uid)) return 0;
      nodeBusy.add(uid);
      const n = byUid.get(uid);
      if (!n || n.kind === 'product') {
        nodeDepth.set(uid, 0);
        nodeBusy.delete(uid);
        return 0;
      }
      const op = producers.get(uid);
      // состояние/блюдо живёт в том же визуальном блоке, что и его операция
      const d = op ? depthOfOp(op) : 0;
      nodeBusy.delete(uid);
      nodeDepth.set(uid, d);
      return d;
    }

    function depthOfOp(op: VOp): number {
      const cached = opDepth.get(op.uid);
      if (cached != null) return cached;
      if (opBusy.has(op.uid)) return 1;
      opBusy.add(op.uid);
      const d = 1 + Math.max(0, ...op.inputs.map((i) => depthOfNode(i.nodeUid)));
      opBusy.delete(op.uid);
      opDepth.set(op.uid, d);
      return d;
    }

    for (const n of nodes) depthOfNode(n.uid);
    for (const op of ops) depthOfOp(op);

    interface Item {
      kind: 'node' | 'op';
      uid: number;
      desired: number;
    }
    const cols = new Map<number, Item[]>();
    const push = (d: number, item: Item): void => {
      const arr = cols.get(d);
      if (arr) arr.push(item);
      else cols.set(d, [item]);
    };
    // Сырьё ставим в колонку непосредственно перед первой операцией, которая его использует:
    // так провода от дальнего сырья не проходят сквозь блоки средних колонок.
    const consumerMinDepth = new Map<number, number>();
    for (const op of ops) {
      const d = opDepth.get(op.uid) ?? 1;
      for (const i of op.inputs) {
        const cur = consumerMinDepth.get(i.nodeUid);
        consumerMinDepth.set(i.nodeUid, cur == null ? d : Math.min(cur, d));
      }
    }
    const nodeCol = new Map<number, number>();
    // в колонках только свободные узлы (сырьё/незавершённые состояния) и операции-блоки
    for (const n of nodes) {
      if (producers.has(n.uid)) continue;
      const d = n.kind === 'product' ? consumerMinDepth.get(n.uid) : undefined;
      const col = d != null ? Math.max(0, d - 1) : 0;
      nodeCol.set(n.uid, col);
      push(col, { kind: 'node', uid: n.uid, desired: n.y || 120 });
    }
    for (const op of ops) push(opDepth.get(op.uid) ?? 1, { kind: 'op', uid: op.uid, desired: op.y || 120 });

    const nodeY = new Map<number, number>();
    const opY = new Map<number, number>();
    const colKeys = [...cols.keys()].sort((a, b) => a - b);
    for (const d of colKeys) {
      const items = cols.get(d)!;
      for (const it of items) {
        if (it.kind === 'op') {
          const op = opByUid.get(it.uid)!;
          const ys = op.inputs
            .map((i) => {
              const producer = producers.get(i.nodeUid);
              return producer ? opY.get(producer.uid) : nodeY.get(i.nodeUid);
            })
            .filter((v): v is number => v != null);
          if (ys.length) it.desired = ys.reduce((a, b) => a + b, 0) / ys.length;
        }
      }
      items.sort((a, b) => a.desired - b.desired || a.uid - b.uid);
      let cursor = 40;
      const gap = 190;
      for (const it of items) {
        const y = Math.max(cursor, Math.round(it.desired));
        if (it.kind === 'node') nodeY.set(it.uid, y);
        else opY.set(it.uid, y);
        cursor = y + gap;
      }
    }

    this.nodes.update((list) =>
      list.map((n) => {
        const producer = producers.get(n.uid);
        if (producer) {
          // скрытый узел результата держим при его блоке
          const x = 40 + (opDepth.get(producer.uid) ?? 1) * 300;
          const y = opY.get(producer.uid) ?? n.y;
          return { ...n, x, y };
        }
        const y = nodeY.get(n.uid);
        if (y == null) return n;
        return { ...n, x: 40 + (nodeCol.get(n.uid) ?? 0) * 300, y };
      })
    );
    this.ops.update((list) =>
      list.map((op) => {
        const y = opY.get(op.uid);
        if (y == null) return op;
        return { ...op, x: 40 + (opDepth.get(op.uid) ?? 1) * 300, y };
      })
    );
    this.relaxAgainstWires();
    setTimeout(() => this.fitView(), 0);
  }

  /** После раскладки сдвигаем блоки по вертикали, чтобы провода не проходили сквозь карточки. */
  private relaxAgainstWires(): void {
    const ops0 = this.ops();
    if (ops0.length < 2) return;
    const nodes0 = this.nodes();
    const producers = new Map<number, VOp>();
    for (const op of ops0) producers.set(op.outputUid, op);
    const byNode = new Map(nodes0.map((n) => [n.uid, n] as const));

    const pos = new Map<number, { x: number; y: number }>();
    for (const op of ops0) pos.set(op.uid, { x: op.x, y: op.y });

    for (let iter = 0; iter < 4; iter++) {
      const wires: { opUid: number; srcUid: number; pts: { x: number; y: number }[] }[] = [];
      for (const op of ops0) {
        const target = pos.get(op.uid)!;
        for (const inp of op.inputs) {
          const src = byNode.get(inp.nodeUid);
          if (!src) continue;
          const srcOp = producers.get(src.uid);
          const sp = srcOp ? pos.get(srcOp.uid) ?? null : null;
          const x1 = sp ? sp.x + BLOCK_W : src.x + NODE_W;
          const y1 = sp ? sp.y + PORT_DY : src.y + PORT_DY;
          wires.push({
            opUid: op.uid,
            srcUid: src.uid,
            pts: this.sampleCurve(x1, y1, target.x, target.y + BLOCK_H / 2),
          });
        }
      }

      let moved = false;
      for (const op of ops0) {
        const p = pos.get(op.uid)!;
        const others = [...pos.entries()].filter(([uid]) => uid !== op.uid).map(([, q]) => q);
        const blocked = (y: number): boolean => {
          const l = p.x - 12;
          const r = p.x + BLOCK_W + 12;
          const t = y - 12;
          const b = y + BLOCK_H + 12;
          for (const w of wires) {
            if (w.opUid === op.uid || w.srcUid === op.outputUid) continue;
            for (const pt of w.pts) {
              if (pt.x >= l && pt.x <= r && pt.y >= t && pt.y <= b) return true;
            }
          }
          for (const o of others) {
            if (Math.abs(o.x - p.x) >= BLOCK_W) continue;
            if (y < o.y + BLOCK_H + 16 && y + BLOCK_H + 16 > o.y) return true;
          }
          return false;
        };
        if (!blocked(p.y)) continue;
        let found: number | null = null;
        for (let d = 20; d <= 1800; d += 20) {
          const up = p.y - d;
          if (up >= 24 && !blocked(up)) {
            found = up;
            break;
          }
          const down = p.y + d;
          if (!blocked(down)) {
            found = down;
            break;
          }
        }
        if (found != null) {
          p.y = Math.round(found);
          moved = true;
        }
      }
      if (!moved) break;
    }

    this.ops.update((list) =>
      list.map((op) => {
        const q = pos.get(op.uid);
        return q && q.y !== op.y ? { ...op, y: q.y } : op;
      })
    );
    this.nodes.update((list) =>
      list.map((n) => {
        const prod = producers.get(n.uid);
        const q = prod ? pos.get(prod.uid) ?? null : null;
        return q && q.y !== n.y ? { ...n, y: q.y } : n;
      })
    );
  }

  /** Точки кривой провода — для проверки пересечений с карточками. */
  private sampleCurve(x1: number, y1: number, x2: number, y2: number): { x: number; y: number }[] {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const mt = 1 - t;
      const x = mt * mt * mt * x1 + 3 * mt * mt * t * (x1 + dx) + 3 * mt * t * t * (x2 - dx) + t * t * t * x2;
      const y = mt * mt * mt * y1 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y2;
      out.push({ x, y });
    }
    return out;
  }

  // ---------- пример ----------
  loadSample(): void {
    if (this.nodes().length && !confirm('Заменить текущую карту примером?')) return;
    const find = (name: string): Product | undefined =>
      this.products().find((p) => p.name.toLowerCase() === name.toLowerCase());
    const potato = find('картофель');
    const milk = find('молоко');
    const butter = find('масло сливочное');
    const asparagus = find('спаржа соевая');
    if (!potato || !milk || !butter) {
      this.toast.show('Для примера нужны картофель, молоко и масло сливочное в номенклатуре', 'warn', 4000);
      return;
    }
    const unit = this.baseUnits().find((u) => u.code === 'г') ?? this.baseUnits()[0];
    if (!unit) return;
    const categoryId = this.catalogs()[0]?.id ?? null;

    const nodes: VNode[] = [
      { uid: 1, kind: 'product', refId: potato.id, name: potato.name, nameEn: '', nameSr: '', catalogId: null, unitId: potato.unitId, unitCode: potato.unitCode, x: 40, y: 120, portionQty: '', price: '', note: '', packagings: [] },
      { uid: 2, kind: 'product', refId: milk.id, name: milk.name, nameEn: '', nameSr: '', catalogId: null, unitId: milk.unitId, unitCode: milk.unitCode, x: 40, y: 260, portionQty: '', price: '', note: '', packagings: [] },
      { uid: 3, kind: 'product', refId: butter.id, name: butter.name, nameEn: '', nameSr: '', catalogId: null, unitId: butter.unitId, unitCode: butter.unitCode, x: 40, y: 400, portionQty: '', price: '', note: '', packagings: [] },
      { uid: 4, kind: 'product', refId: asparagus?.id ?? 0, name: asparagus?.name ?? 'спаржа', nameEn: '', nameSr: '', catalogId: null, unitId: asparagus?.unitId ?? unit.id, unitCode: asparagus?.unitCode ?? unit.code, x: 40, y: 540, portionQty: '', price: '', note: '', packagings: [] },
      { uid: 10, kind: 'state', refId: null, name: 'Картофель очищенный', nameEn: '', nameSr: '', catalogId: null, unitId: unit.id, unitCode: unit.code, x: 300, y: 120, portionQty: '', price: '', note: '', packagings: [] },
      { uid: 11, kind: 'state', refId: null, name: 'Картофель варёный', nameEn: '', nameSr: '', catalogId: null, unitId: unit.id, unitCode: unit.code, x: 560, y: 120, portionQty: '', price: '', note: '', packagings: [] },
      {
        uid: 20, kind: 'output', refId: null, name: 'Пюре', nameEn: 'Mashed potatoes', nameSr: 'Pire krompir', catalogId: categoryId,
        unitId: unit.id, unitCode: unit.code, x: 820, y: 120, portionQty: '250', price: '', note: '',
        packagings: [
          { uid: 1, name: '250 г', qtyBase: '250', minOrder: '1', isDefault: true, price: '250', priceBasis: 'portion', cost: '', available: true },
          { uid: 2, name: '1 кг', qtyBase: '1000', minOrder: '1', isDefault: false, price: '900', priceBasis: 'portion', cost: '', available: true },
        ],
      },
      {
        uid: 21, kind: 'output', refId: null, name: 'Жареная картошка', nameEn: 'Fried potatoes', nameSr: 'Prženi krompir', catalogId: categoryId,
        unitId: unit.id, unitCode: unit.code, x: 820, y: 300, portionQty: '200', price: '', note: '',
        packagings: [
          { uid: 3, name: '200 г', qtyBase: '200', minOrder: '1', isDefault: true, price: '200', priceBasis: 'portion', cost: '', available: true },
        ],
      },
      {
        uid: 22, kind: 'output', refId: null, name: 'Салат с картофелем', nameEn: 'Potato salad', nameSr: 'Salata od krompira', catalogId: categoryId,
        unitId: unit.id, unitCode: unit.code, x: 1080, y: 220, portionQty: '180', price: '', note: '',
        packagings: [
          { uid: 4, name: '180 г', qtyBase: '180', minOrder: '1', isDefault: true, price: '180', priceBasis: 'portion', cost: '', available: true },
        ],
      },
    ];
    if (!asparagus) {
      // если спаржи нет, убираем её узел и вход из салата
    }
    const ops: VOp[] = [
      { uid: 100, name: 'чистка', yieldPct: '80', laborHours: '0.3', outputUid: 10, note: '', x: 300, y: 120, inputs: [{ nodeUid: 1, qty: '2000', inMass: true }] },
      { uid: 101, name: 'варка', yieldPct: '98', laborHours: '0.2', outputUid: 11, note: '', x: 560, y: 120, inputs: [{ nodeUid: 10, qty: '1000', inMass: true }] },
      { uid: 102, name: 'толчение', yieldPct: '100', laborHours: '0.4', outputUid: 20, note: '', x: 820, y: 120, inputs: [{ nodeUid: 11, qty: '784', inMass: true }, { nodeUid: 3, qty: '50', inMass: true }, { nodeUid: 2, qty: '200', inMass: true }] },
      { uid: 103, name: 'обжарка', yieldPct: '70', laborHours: '0.3', outputUid: 21, note: '', x: 820, y: 300, inputs: [{ nodeUid: 10, qty: '500', inMass: true }] },
      { uid: 104, name: 'сборка салата', yieldPct: '100', laborHours: '0.2', outputUid: 22, note: '', x: 1080, y: 220, inputs: [{ nodeUid: 11, qty: '150', inMass: true }] },
    ];
    if (asparagus) ops.find((o) => o.uid === 104)!.inputs.push({ nodeUid: 4, qty: '30', inMass: true });
    else nodes.splice(nodes.findIndex((n) => n.uid === 4), 1);

    this.nodes.set(nodes);
    this.ops.set(ops);
    this.nextNodeUid = 1000;
    this.nextOpUid = 1000;
    this.nextPackUid = 1000;
    this.selected.set({ kind: 'none' });
    this.hovered.set(null);
    setTimeout(() => this.autoLayout(), 20);
    setTimeout(() => this.save(), 120);
  }

  // ---------- панорамирование / масштаб ----------
  onWheel(ev: WheelEvent): void {
    const wrap = this.wrapEl()?.nativeElement;
    if (!wrap) return;
    ev.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.zoomAt(this.zoom() * factor, ev.clientX - rect.left, ev.clientY - rect.top);
  }

  zoomBy(k: number): void {
    const wrap = this.wrapEl()?.nativeElement;
    if (!wrap) {
      this.zoom.set(clamp(this.zoom() * k, this.zoomMin, this.zoomMax));
      return;
    }
    this.zoomAt(this.zoom() * k, wrap.clientWidth / 2, wrap.clientHeight / 2);
  }

  zoomAt(next: number, viewX: number, viewY: number): void {
    const zOld = this.zoom() || 1;
    const zNew = clamp(next, this.zoomMin, this.zoomMax);
    if (zNew === zOld) return;
    const p = this.pan();
    const cx = (viewX - p.x) / zOld;
    const cy = (viewY - p.y) / zOld;
    this.zoom.set(zNew);
    this.pan.set({ x: viewX - cx * zNew, y: viewY - cy * zNew });
  }

  zoomReset(): void {
    const wrap = this.wrapEl()?.nativeElement;
    if (!wrap) {
      this.zoom.set(1);
      return;
    }
    this.zoomAt(1, wrap.clientWidth / 2, wrap.clientHeight / 2);
  }

  fitView(): void {
    const wrap = this.wrapEl()?.nativeElement;
    if (!wrap) return;
    const box = this.contentBox();
    if (!box) {
      this.zoom.set(1);
      this.pan.set({ x: 0, y: 0 });
      return;
    }
    const w = Math.max(1, box.maxX - box.minX);
    const h = Math.max(1, box.maxY - box.minY);
    const pad = 24;
    const z = clamp(Math.min((wrap.clientWidth - pad * 2) / w, (wrap.clientHeight - pad * 2) / h), this.zoomMin, this.zoomMax);
    this.zoom.set(z);
    this.pan.set({
      x: (wrap.clientWidth - w * z) / 2 - box.minX * z,
      y: (wrap.clientHeight - h * z) / 2 - box.minY * z,
    });
  }

  private contentBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const ns = this.freeNodes();
    const os = this.ops();
    if (!ns.length && !os.length) return null;
    return {
      minX: Math.min(...ns.map((n) => n.x), ...os.map((o) => o.x)),
      minY: Math.min(...ns.map((n) => n.y), ...os.map((o) => o.y)),
      maxX: Math.max(...ns.map((n) => n.x + NODE_W), ...os.map((o) => o.x + BLOCK_W)),
      maxY: Math.max(...ns.map((n) => n.y + NODE_H), ...os.map((o) => o.y + BLOCK_H)),
    };
  }

  private visibleCenter(): { x: number; y: number } {
    const wrap = this.wrapEl()?.nativeElement;
    const z = this.zoom() || 1;
    const p = this.pan();
    if (!wrap) return { x: 240, y: 180 };
    return { x: (wrap.clientWidth * 0.4 - p.x) / z, y: (wrap.clientHeight * 0.5 - p.y) / z };
  }

  private toContent(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.wrapEl()?.nativeElement.getBoundingClientRect();
    const z = this.zoom() || 1;
    const p = this.pan();
    return { x: (clientX - (rect?.left ?? 0) - p.x) / z, y: (clientY - (rect?.top ?? 0) - p.y) / z };
  }

  private keepInView(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const wrap = this.wrapEl()?.nativeElement;
    if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return { x, y };
    const z = this.zoom() || 1;
    const p = this.pan();
    const keep = 72;
    const minX = (keep - p.x) / z - w;
    const maxX = (wrap.clientWidth - keep - p.x) / z;
    const minY = (keep - p.y) / z - h;
    const maxY = (wrap.clientHeight - keep - p.y) / z;
    return { x: clamp(x, Math.min(minX, maxX), Math.max(minX, maxX)), y: clamp(y, Math.min(minY, maxY), Math.max(minY, maxY)) };
  }

  wireD(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  canvasWidth(): number {
    const box = this.contentBox();
    return box ? Math.max(600, box.maxX + 80) : 600;
  }

  canvasH(): number {
    const box = this.contentBox();
    return box ? Math.max(480, box.maxY + 80) : 480;
  }

  readonly fmtMoney = fmtMoney;
  readonly fmtQty = fmtQty;
  readonly trimNum = (v: string): string => trim(num(v));
}
