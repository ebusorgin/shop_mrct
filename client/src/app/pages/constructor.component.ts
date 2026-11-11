import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { Product, Semi, Unit } from '../core/models';
import type { DiagramBlock, DiagramData } from '../core/models';
import { fmtCost, fmtMoney, fmtQty } from '../core/format';
import { Assembly, BlockCost, buildSemiBody, resolveConstructor } from '../core/constructor-calc';
import { ModalComponent } from '../shared/modal.component';

/** Тип компонента на «столе»: сырьё (продукт номенклатуры) или полуфабрикат (заготовка). */
type SourceKind = 'raw' | 'semi';

/** Позиция левого меню — то, что можно перетащить на стол. */
interface CItem {
  /** ключ позиции: sourceType:refId */
  key: string;
  sourceType: SourceKind;
  refId: number;
  name: string;
  /** Ед. хранения (базовая) позиции — начальная единица количества на столе */
  unitCode: string;
}

/** Блок на столе: экземпляр позиции (одну и ту же можно положить несколько раз) + количество и место. */
interface PlateItem {
  /** id конкретного блока на столе (не позиции каталога) */
  uid: number;
  /** ingredient — сброшен с левого меню; note — пустой текстовый блок с контекстного меню */
  kind: 'ingredient' | 'note';
  sourceType: SourceKind;
  refId: number;
  name: string;
  /** заголовок свободного блока (редактируется прямо на столе) */
  title: string;
  /** координата левого-верхнего угла блока внутри области стола, px */
  x: number;
  y: number;
  /** количество — текст поля ввода (пусто = не задано, а не 0) */
  qty: string;
  /** единица количества — «Ед. хранения (базовая)» позиции, на столе не редактируется */
  unitCode: string;
}

/** Пункт контекстного меню стола. */
interface CtxMenuItem {
  label: string;
  /** опасное действие (удаление) — красная подсветка */
  danger?: boolean;
  /** разделитель перед пунктом — отделяет опасное действие от основных */
  sep?: boolean;
  run: () => void;
}

/** Открытое контекстное меню (правая кнопка на пустом месте стола). */
interface ContextMenu {
  x: number;
  y: number;
  items: CtxMenuItem[];
}

/** Активное перетаскивание блока по столу (pointer-events). */
interface Moving {
  uid: number;
  /** смещение курсора внутри блока, чтобы блок не «прыгал» при хвате */
  offX: number;
  offY: number;
  /** размеры области стола и самого блока на момент хвата — для ограничения границ */
  areaW: number;
  areaH: number;
  blockW: number;
  blockH: number;
}

/** Связь между блоками: выход источника → вход приёмника.
    yieldPct — «выход после обработки», доля продукта, которая войдёт в заготовку. */
interface Link {
  id: number;
  from: number;
  to: number;
  /** текст поля: пусто = не задано (считаем без потерь, 100 %), иначе число 0..100 */
  yieldPct: string;
}

/** Нить связи в координатах области стола. */
interface Wire {
  id: number;
  d: string;
  mx: number;
  my: number;
  /** подпись выхода на нити, напр. «85 %» — всегда видна, чтобы схема читалась без открытия */
  yieldText: string;
}

/** Рисование новой связи: тащим от правого коннектора к левому. */
interface Linking {
  from: number;
  /** стартовая точка (правый коннектор) и курсор — в координатах стола */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Узел мини-блок-схемы состава заготовки (внутри карточки на столе). */
interface MiniNode {
  key: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** raw | semi | note — цвет чипа */
  cls: 'raw' | 'semi' | 'note';
}

/** Нить мини-схемы от узла к узлу (в координатах мини-полотна). */
interface MiniEdge {
  id: number;
  d: string;
}

/** Готовая мини-схема состава заготовки для вложенного отображения в блоке. */
interface MiniView {
  w: number;
  h: number;
  nodes: MiniNode[];
  edges: MiniEdge[];
  /** сколько блоков в составе (для подписи) */
  count: number;
}

/**
 * Свойства заготовки уровня «блока A» редактора «Редактирование заготовки» — то, что
 * стол сам не выводит: единица выхода, размер партии, описание, срок годности и парные
 * коэффициенты пересчёта размерностей. Пустые (null) значения при сохранении замещаются
 * выведенным из стола (unitId/outQty) — поэтому стол без этих полей ничего не теряет.
 */
interface SemiProps {
  unitId: number | null;
  outQty: number | null;
  note: string;
  shelfLifeDays: number | null;
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
}

const DEFAULT_PROPS: SemiProps = {
  unitId: null, outQty: null, note: '', shelfLifeDays: null, gPerPcs: null, mlPerPcs: null, gPerMl: null,
};

/** Ограничить значение диапазоном [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* Ширина карточек и вертикаль коннекторов — те же числа, что в CSS (.pi / .pi.note).
   Якоря связи считаются аналитически, без замера DOM: коннектор живёт на строке заголовка. */
const W_ING = 260;
const W_NOTE = 220;
const PORT_DY = 20;
/* коннектор выступает за край блока на 6px, а стол режет всё снаружи — блоки не подводим вплотную */
const PORT_M = 8;
/* размер карточки правки связи — для прижатия к краям стола (чтобы не обрезалась о край) */
const LE_W = 236;
const LE_H = 190;

/* размеры мини-полотна состава внутри карточки (внутренняя ширина блока ~232px) */
const MINI_W = 232;
const MINI_CHIP_H = 15;
const MINI_ROW_GAP = 5;
const MINI_COL_GAP = 14;
const MINI_PAD = 4;

/**
 * Раскладывает стол заготовки в компактную слоистую мини-блок-схему: ярусы
 * (слева направо) по longest-path рангу, внутри яруса — по исходной высоте.
 * Сырые позиции пользователя могут быть «клубком» — для превью берём упорядоченную
 * сетку, а не x/y: читается как настоящая схема, а не как уменьшенный стол.
 */
function buildMini(data: DiagramData): MiniView | null {
  const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
  const links = Array.isArray(data?.links) ? data.links : [];
  const byUid = new Map<number, DiagramBlock>();
  for (const b of blocks) byUid.set(Number(b.uid), b);
  if (!byUid.size) return null;

  const inc: Record<number, number[]> = {};
  for (const l of links) {
    const from = Number(l.from);
    const to = Number(l.to);
    if (!byUid.has(from) || !byUid.has(to)) continue;
    (inc[to] ||= []).push(from);
  }

  // longest-path ранг = номер яруса; корень (без входов) — ярус 0
  const rank: Record<number, number> = {};
  const busy = new Set<number>();
  const getRank = (uid: number): number => {
    if (uid in rank) return rank[uid];
    if (busy.has(uid)) return 0; // защита от цикла
    busy.add(uid);
    const parents = inc[uid] || [];
    const r = parents.length ? Math.max(...parents.map(getRank)) + 1 : 0;
    busy.delete(uid);
    rank[uid] = r;
    return r;
  };
  for (const b of blocks) getRank(Number(b.uid));

  const buckets: number[][] = [];
  for (const b of blocks) {
    const r = rank[Number(b.uid)] || 0;
    (buckets[r] ||= []).push(Number(b.uid));
  }
  const filled = buckets.filter((l) => l && l.length);
  // порядок внутри яруса — по высоте исходного стола (верх→низ)
  for (const layer of filled) {
    layer.sort((a, bb) => {
      const na = byUid.get(a)!;
      const nb = byUid.get(bb)!;
      return (Number(na.y) - Number(nb.y)) || (Number(na.x) - Number(nb.x));
    });
  }

  const layerCount = filled.length || 1;
  const maxRows = Math.max(1, ...filled.map((l) => l.length));
  const colW = layerCount <= 1
    ? Math.min(150, MINI_W - 2 * MINI_PAD)
    : clamp(Math.floor((MINI_W - 2 * MINI_PAD - MINI_COL_GAP * (layerCount - 1)) / layerCount), 30, 110);
  const rowStep = MINI_CHIP_H + MINI_ROW_GAP;
  const h = 2 * MINI_PAD + maxRows * MINI_CHIP_H + (maxRows - 1) * MINI_ROW_GAP;

  const nodes: MiniNode[] = [];
  filled.forEach((layer, r) => {
    const x = MINI_PAD + r * (colW + MINI_COL_GAP);
    const colH = layer.length * MINI_CHIP_H + (layer.length - 1) * MINI_ROW_GAP;
    const startY = MINI_PAD + (h - 2 * MINI_PAD - colH) / 2;
    layer.forEach((uid, i) => {
      const b = byUid.get(uid)!;
      const isNote = b.kind === 'note';
      const cls: MiniNode['cls'] = isNote ? 'note' : b.sourceType === 'semi' ? 'semi' : 'raw';
      const label = (isNote ? b.title || 'Полуфабрикат' : b.name) || '—';
      nodes.push({ key: uid, x, y: Math.round(startY + i * rowStep), w: colW, h: MINI_CHIP_H, label, cls });
    });
  });

  const pos = new Map(nodes.map((n) => [n.key, n]));
  const edges: MiniEdge[] = [];
  let eid = 1;
  for (const l of links) {
    const a = pos.get(Number(l.from));
    const b = pos.get(Number(l.to));
    if (!a || !b) continue;
    const fx = a.x + a.w;
    const fy = a.y + a.h / 2;
    const tx = b.x;
    const ty = b.y + b.h / 2;
    const dx = Math.max(6, (tx - fx) / 2);
    edges.push({ id: eid++, d: `M${fx},${fy} C${fx + dx},${fy} ${tx - dx},${ty} ${tx},${ty}` });
  }

  const w = Math.min(MINI_PAD * 2 + layerCount * colW + (layerCount - 1) * MINI_COL_GAP, MINI_W);
  return { w, h, nodes, edges, count: nodes.length };
}

/**
 * «Конструктор блюд»: левое меню со списком сырья и полуфабрикатов перетаскивается
 * мышкой (нативный HTML5 DnD) на правую панель — «стол». Сброшенный блок превращается
 * в карточку с полем количества: единица количества — нередактируемая «Ед. хранения
 * (базовая)» позиции (г/мл/шт). Блоки соединяются связями: правый коннектор (выход) есть
 * у всех, левый (вход) — у свободных блоков, созданных из контекстного меню.
 * Полуфабрикат можно переименовать прямо в блоке (двойной клик или «Редактировать»):
 * имя сохраняется в общий каталог заготовок — правка видна и на странице «Полуфабрикаты».
 * Количество течёт сквозь связи вперёд: сборка показывает итоговый выход (с учётом %
 * обработки) и себестоимость; заготовки сводятся к сырью тем же ядром, что и страница
 * «Полуфабрикаты». КБЖУ — следующим шагом.
 */
@Component({
  selector: 'app-constructor',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <h1 class="page-title">🍲 Конструктор блюд</h1>
      <span class="badge blue">{{ rawCount() }} сырья</span>
      <span class="badge amber">{{ semiCount() }} полуфабрикатов</span>
      <div class="spacer"></div>
      <span class="hint muted">Перетащите ингредиент на стол · связь — тянуть от правого коннектора к левому · клик по связи — выход после обработки (%)</span>
    </div>

    <!-- панель текущей заготовки: название, сохранение/обновление стола (список — во вкладке «Полуфабрикаты» слева) -->
    <div class="scheme-bar">
      <button type="button" class="btn sm" title="Очистить стол и начать новую заготовку" (click)="newDiagram()">🆕 Новая</button>
      <input
        class="scheme-name"
        type="text"
        placeholder="Название заготовки"
        [ngModel]="diagramName()"
        (ngModelChange)="diagramName.set($event)"
        (keydown.enter)="saveDiagram()"
      />
      <span class="badge" [class.gray]="currentId() === null" [class.blue]="currentId() !== null">
        {{ currentId() === null ? 'не сохранена' : 'сохранена' }}
      </span>
      <button
        type="button"
        class="btn primary sm"
        [disabled]="savingDiagram() || plate().length === 0"
        (click)="saveDiagram()"
      >{{ savingDiagram() ? '…' : currentId() === null ? '💾 Сохранить' : '💾 Обновить' }}</button>
      <div class="spacer"></div>
      <span class="muted small">Сохранённые заготовки — во вкладке «🟨 Полуфабрикаты» слева</span>
    </div>

    <!-- свойства заготовки: попап с полями редактора «Редактирование заготовки» -->
    @if (showProps()) {
      <app-modal [title]="propsTitle()" (closed)="closeProps()">
        <div class="props-form">
          <label class="pf">
            Ед. выхода
            <select [ngModel]="propsDraft().unitId" (ngModelChange)="patchProp('unitId', $event)">
              <option [ngValue]="null">авто · {{ derivedUnit() || '—' }}</option>
              @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
            </select>
          </label>
          <label class="pf">
            Размер партии ({{ propsDraft().unitId != null ? unitCodeOf(propsDraft().unitId) : (derivedUnit() || 'ед') }})
            <input class="pf-in" type="number" min="0" step="any" inputmode="decimal"
                   [ngModel]="propsDraft().outQty" (ngModelChange)="patchProp('outQty', numOrNull($event))"
                   [placeholder]="outHint()" />
          </label>
          <label class="pf grow">
            Описание
            <input class="pf-in" type="text" [ngModel]="propsDraft().note" (ngModelChange)="patchProp('note', $event)" placeholder="почистили и сварили" />
          </label>
          <label class="pf">
            Срок годности, дней
            <input class="pf-in" type="number" min="0" step="1" [ngModel]="propsDraft().shelfLifeDays" (ngModelChange)="patchProp('shelfLifeDays', numOrNull($event))" placeholder="напр. 3" />
          </label>
          <div class="pf-note muted">Пересчёт размерностей выхода — задайте только нужные связи; пусто = связь не задавать. Позволяет продукту ссылаться на заготовку в г/мл, даже если её выход — в шт.</div>
          <label class="pf">
            грамм в 1 шт
            <input class="pf-in" type="number" min="0" step="any" [ngModel]="propsDraft().gPerPcs" (ngModelChange)="patchProp('gPerPcs', numOrNull($event))" placeholder="напр. 53" />
          </label>
          <label class="pf">
            мл в 1 шт
            <input class="pf-in" type="number" min="0" step="any" [ngModel]="propsDraft().mlPerPcs" (ngModelChange)="patchProp('mlPerPcs', numOrNull($event))" placeholder="—" />
          </label>
          <label class="pf">
            грамм в 1 мл (плотность)
            <input class="pf-in" type="number" min="0" step="any" [ngModel]="propsDraft().gPerMl" (ngModelChange)="patchProp('gPerMl', numOrNull($event))" placeholder="—" />
          </label>
        </div>
        <div modalFooter>
          <button type="button" class="btn" (click)="closeProps()">Отмена</button>
          <button type="button" class="btn primary" [disabled]="propsSaving()" (click)="saveProps()">{{ propsTarget()?.mode === 'semi' ? (propsSaving() ? 'Сохраняю…' : '💾 Сохранить') : 'Готово' }}</button>
        </div>
      </app-modal>
    }

    @if (listErr()) { <div class="err">{{ listErr() }} <button class="btn sm" (click)="reload()">Повторить</button></div> }

    <div class="cols">
      <!-- ============ ЛЕВО: каталог сырья и полуфабрикатов ============ -->
      <div class="panel cat">
        <div class="search">
          <input
            [ngModel]="query()"
            (ngModelChange)="query.set($event)"
            [placeholder]="catTab() === 'raw' ? 'Поиск сырья…' : 'Поиск полуфабрикатов…'"
            aria-label="Поиск по ингредиентам"
          />
          @if (query()) { <button type="button" class="clr" title="Очистить" (click)="query.set('')">✕</button> }
        </div>

        <div class="tabs">
          <button type="button" class="tab" [class.on]="catTab() === 'raw'" (click)="catTab.set('raw')">
            🟦 Сырьё <span class="tab-n">{{ rawFiltered().length }}</span>
          </button>
          <button type="button" class="tab" [class.on]="catTab() === 'semi'" (click)="catTab.set('semi')">
            🟨 Полуфабрикаты <span class="tab-n">{{ semiFiltered().length }}</span>
          </button>
          @if (catTab() === 'semi') {
            <button type="button" class="tab-refresh" title="Обновить список заготовок" (click)="loadDiagrams()">↻</button>
          }
        </div>

        @if (loading()) {
          <div class="sk">@for (i of [1, 2, 3, 4, 5, 6]; track i) { <div class="sk-row">Загрузка…</div> }</div>
        } @else if (catTab() === 'raw') {
          <div class="list">
            @for (it of rawFiltered(); track it.key) {
              <div
                class="ci"
                draggable="true"
                [class.dragging]="dragKey() === it.key"
                (dragstart)="onDragStart(it, $event)"
                (dragend)="onDragEnd()"
                title="Перетащите на стол"
              >
                <span class="grip" aria-hidden="true">⠿</span>
                <span class="ci-mark">🟦</span>
                <span class="ci-name">{{ it.name }}</span>
                <span class="ci-unit">{{ it.unitCode }}</span>
              </div>
            } @empty {
              <p class="muted">Сырьё не найдено — измените поиск.</p>
            }
          </div>
        } @else {
          <div class="list">
            @for (d of semiFiltered(); track d.id) {
              <div
                class="scheme-row"
                [class.cur]="d.id === currentId()"
                [class.dragging]="dragKey() === 'semi:' + d.id"
                draggable="true"
                (dragstart)="onDragStartSemi(d, $event)"
                (dragend)="onDragEnd()"
                title="Перетащите на стол как компонент"
              >
                <span class="grip" aria-hidden="true">⠿</span>
                <button type="button" class="sr-open" (click)="openDiagram(d.id)" [title]="'Открыть стол: ' + d.name">
                  <b>{{ d.name }}</b>
                  <span class="sr-meta">{{ d.inputs.length }} составл. · {{ d.outQty }} {{ d.unitCode }} · {{ d.hasBoard ? 'на столе' : 'без стола' }}</span>
                </button>
                <button type="button" class="sr-del" title="Удалить заготовку" (click)="deleteDiagram(d)">🗑</button>
              </div>
            } @empty {
              <p class="muted">Полуфабрикатов пока нет — соберите блюдо на столе и нажмите «Сохранить».</p>
            }
          </div>
        }
      </div>

      <!-- ============ ПРАВО: стол (зона сброса + свободное расположение блоков) ============ -->
      <div class="panel table">
        <div class="tb-head">
          <h3>🧑‍🍳 Стол</h3>
          @if (plate().length) {
            <span class="badge blue">блоков: {{ plate().length }}</span>
          }
          @if (links().length) {
            <span class="badge gray" title="Связей между блоками">связей: {{ links().length }}</span>
          }
          <div class="spacer"></div>
          <div class="zoombar" title="Масштаб стола: кнопки или Ctrl+колёсико; тянуть мышью на пустом месте — сдвиг">
            <button type="button" (click)="zoomOut()" title="Уменьшить (Ctrl+колёсико)">−</button>
            <button type="button" class="z-val" (click)="zoomReset()" title="Сбросить масштаб">{{ zoomPct() }}%</button>
            <button type="button" (click)="zoomIn()" title="Увеличить (Ctrl+колёсико)">+</button>
          </div>
          @if (plate().length) { <button type="button" class="btn sm danger" (click)="clearPlate()">Очистить</button> }
        </div>

        <div
          class="plate-area"
          #area
          [class.over]="overTable()"
          [class.linking]="!!linking()"
          [class.panning]="panning()"
          (dragenter)="onDragEnter($event)"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave()"
          (drop)="onDrop($event)"
          (contextmenu)="onAreaContextMenu($event)"
          (wheel)="onAreaWheel($event)"
          (pointerdown)="onAreaPointerDown($event)"
          (pointermove)="onAreaPointerMove($event)"
          (pointerup)="onAreaPointerUp($event)"
          (pointercancel)="onAreaPointerUp($event)"
        >
          @if (plate().length === 0) {
            <div class="empty-drop">
              <div class="ed-icon">🍽</div>
              <div>Перетащите сюда сырьё или полуфабрикат из левой колонки.</div>
              <div class="muted small">Правой кнопкой на пустом месте стола можно создать полуфабрикат.</div>
            </div>
          }

          <!-- сцена стола: масштабируется и сдвигается; координаты блоков/нитей — в пространстве содержимого -->
          <div class="scene" [style.transform]="sceneTransform()">
          <!-- связи между блоками: слой под карточками; клик по нити — выход после обработки -->
          <svg class="wires">
            @for (w of wires(); track w.id) {
              <g class="wire-row" [class.sel]="editingLink() === w.id">
                <path class="wire-hit" [attr.d]="w.d" (click)="openLinkEditor(w.id)" />
                <path class="wire" [attr.d]="w.d" />
                <text class="wire-pct" [attr.x]="w.mx" [attr.y]="w.my - 14" text-anchor="middle" [class.set]="w.yieldText !== '100 %'">{{ w.yieldText }}</text>
                <g class="wire-x" (click)="removeLink(w.id, $event)">
                  <title>Удалить связь</title>
                  <circle [attr.cx]="w.mx" [attr.cy]="w.my" r="9" />
                  <text [attr.x]="w.mx" [attr.y]="w.my + 3.5" text-anchor="middle">✕</text>
                </g>
              </g>
            }
            @if (linking(); as lk) {
              <path class="wire temp" [attr.d]="wireD(lk.x1, lk.y1, lk.x2, lk.y2)" />
            }
          </svg>

          <div class="plate">
            @for (p of plate(); track p.uid) {
              <div
                class="pi"
                [attr.data-uid]="p.uid"
                [class.note]="p.kind === 'note'"
                [class.ing-raw]="p.kind === 'ingredient' && p.sourceType === 'raw'"
                [class.ing-semi]="p.kind === 'ingredient' && p.sourceType === 'semi'"
                [class.moving]="moving()?.uid === p.uid"
                [style.left.px]="p.x"
                [style.top.px]="p.y"
                (pointerdown)="onBlockDown(p, $event)"
                (pointermove)="onBlockMove($event)"
                (pointerup)="onBlockUp($event)"
                (pointercancel)="onBlockUp($event)"
                (contextmenu)="onBlockContextMenu(p, $event)"
              >
                <div class="pi-top">
                  <span class="grip" aria-hidden="true">⠿</span>
                  @if (p.kind === 'ingredient') {
                    <span class="badge" [class.blue]="p.sourceType === 'raw'" [class.amber]="p.sourceType === 'semi'">
                      {{ p.sourceType === 'raw' ? 'сырьё' : 'полуфабр.' }}
                    </span>
                  }
                  @if (p.kind === 'ingredient') {
                    @if (editing()?.uid === p.uid) {
                      <!-- переименование полуфабриката прямо в блоке: Enter — сохранить, Esc — отменить -->
                      <input
                        class="name-in"
                        type="text"
                        [ngModel]="editing()!.value"
                        (ngModelChange)="editingName($event)"
                        (keydown.enter)="saveSemiName(p)"
                        (keydown.escape)="cancelSemiEdit($event)"
                        (blur)="saveSemiName(p)"
                      />
                    } @else {
                      <b
                        class="pi-name"
                        [class.semi-name]="p.sourceType === 'semi'"
                        [title]="p.sourceType === 'semi' ? 'Двойной клик — переименовать заготовку (сохранится в общий каталог)' : p.name"
                        (dblclick)="startSemiEdit(p)"
                      >{{ p.name }}</b>
                    }
                  } @else {
                    <input
                      class="note-in"
                      type="text" placeholder="Название полуфабриката"
                      [ngModel]="p.title"
                      (ngModelChange)="p.title = $event; plate.set(plate().slice())"
                    />
                  }
                  <button type="button" class="pi-x" title="Убрать со стола" (click)="remove(p.uid)">✕</button>
                </div>
                @if (p.kind === 'ingredient') {
                  <div class="pi-qty">
                    <input
                      class="qty-in"
                      type="number" min="0" step="any" inputmode="decimal" placeholder="кол-во"
                      [ngModel]="p.qty"
                      (ngModelChange)="p.qty = $event; plate.set(plate().slice())"
                    />
                    <span class="u-txt" title="Ед. хранения (базовая) позиции">{{ p.unitCode }}</span>
                  </div>
                  @if (blockCost(p.uid); as bc) {
                    @if (bc.ready && bc.cost > 0) {
                      <div class="pi-cost" title="Себестоимость этого количества на столе">≈ {{ fmtMoney(bc.cost) }}</div>
                    }
                  }
                  <!-- мини-блок-схема состава: как устроена эта заготовка внутри -->
                  @if (p.sourceType === 'semi') {
                    @if (miniFor(p.refId); as mini) {
                      <div class="mini" [title]="'Состав заготовки: ' + mini.count + ' блок(ов)'">
                        <div class="mini-cap">🧩 состав · {{ mini.count }}</div>
                        <div class="mini-canvas" [style.width.px]="mini.w" [style.height.px]="mini.h">
                          <svg class="mini-svg" [attr.viewBox]="'0 0 ' + mini.w + ' ' + mini.h" [style.width.px]="mini.w" [style.height.px]="mini.h">
                            @for (e of mini.edges; track e.id) {
                              <path class="mini-wire" [attr.d]="e.d" />
                            }
                          </svg>
                          @for (n of mini.nodes; track n.key) {
                            <span
                              class="mini-chip"
                              [class.raw]="n.cls === 'raw'"
                              [class.semi]="n.cls === 'semi'"
                              [class.note]="n.cls === 'note'"
                              [style.left.px]="n.x"
                              [style.top.px]="n.y"
                              [style.width.px]="n.w"
                              [style.height.px]="n.h"
                              [title]="n.label"
                            >{{ n.label }}</span>
                          }
                        </div>
                      </div>
                    }
                  }
                }

                @if (p.kind === 'note') {
                  @if (asm(p.uid); as a) {
                    <div class="asm">
                      @if (!a.streams.length) {
                        <div class="asm-empty">Свяжите сырьё с этим блоком — посчитаем выход и ₽</div>
                      } @else {
                        <div class="asm-row total"><span>Себестоимость</span><b>{{ fmtMoney(a.totalCost) }}</b></div>
                        @if (a.outQty !== null && a.primaryUnit !== null) {
                          <div class="asm-row"><span>Выход</span><b>{{ fmtQty(a.outQty, a.primaryUnit) }}</b></div>
                        }
                        @if (a.costPerUnit !== null && a.primaryUnit !== null) {
                          <div class="asm-row"><span>На 1 ед.</span><b>{{ fmtCost(a.costPerUnit, a.primaryUnit) }}</b></div>
                        }
                        <div class="asm-streams">
                          @for (s of a.streams; track $index) {
                            <div class="asm-s" [title]="s.warn || ''">
                              <span class="as-n">{{ s.name }}</span>
                              @if (s.inQty > 0) {
                                <span class="as-q">
                                  {{ fmtQty(s.inQty, s.unitCode) }}@if (s.yieldPct < 100) { <span class="as-y">↓{{ s.yieldPct }}%</span> }
                                </span>
                              } @else {
                                <span class="as-q as-warn">—</span>
                              }
                              <span class="as-c">{{ fmtMoney(s.cost) }}</span>
                            </div>
                          }
                        </div>
                        @if (a.outByUnit.length > 1) {
                          <div class="asm-multi">выход в разных единицах — ₽ на единицу не считаем</div>
                        }
                      }
                    </div>
                  }
                }

                <!-- коннекторы: выход справа есть у всех, вход слева — только у свободного блока -->
                @if (p.kind === 'note') {
                  <span class="port in" [class.hot]="linkTarget() === p.uid" title="Вход связи"></span>
                }
                <span
                  class="port out"
                  title="Потяните, чтобы связать с другим блоком"
                  (pointerdown)="onPortDown(p, $event)"
                  (pointermove)="onPortMove($event)"
                  (pointerup)="onPortUp($event)"
                  (pointercancel)="cancelLink($event)"
                ></span>
              </div>
            }
          </div>
          </div>

          <!-- карточка правки связи: выход после обработки (%) — открывается кликом по нити -->
          @if (linkEditor(); as e) {
            <div
              class="link-editor"
              [style.left.px]="editorX(e.w)"
              [style.top.px]="editorY(e.w)"
              (pointerdown)="$event.stopPropagation()"
              (contextmenu)="$event.stopPropagation()"
            >
              <div class="le-head">
                🔥 Обработка
                <button type="button" class="le-x" title="Закрыть" (click)="closeLinkEditor()">✕</button>
              </div>
              <div class="le-route">{{ blockName(e.l.from) }} <span class="le-ar">→</span> {{ blockName(e.l.to) }}</div>
              <label class="f">Выход после обработки, %
                <input
                  type="number" min="0" max="100" step="any" inputmode="decimal" placeholder="100"
                  [ngModel]="linkYield(e.l.id)" (ngModelChange)="patchLinkYield(e.l.id, $event)"
                  (keydown.enter)="closeLinkEditor()" (keydown.escape)="closeLinkEditor()"
                />
              </label>
              <div class="muted le-tip">Сколько продукта войдёт в заготовку: 100 % — без потерь, 85 % — 15 % уходит при чистке и варке.</div>
              <div class="le-acts">
                <button type="button" class="btn primary sm" (click)="closeLinkEditor()">Готово</button>
                <button type="button" class="btn danger sm" (click)="removeLink(e.l.id, $event)">Удалить связь</button>
              </div>
            </div>
          }
        </div>
      </div>
    </div>

    <!-- контекстное меню стола -->
    @if (ctxMenu(); as m) {
      <div class="ctx-backdrop" (click)="closeCtxMenu()" (contextmenu)="closeCtxMenu()"></div>
      <div class="ctx-menu" [style.left.px]="m.x" [style.top.px]="m.y">
        @for (it of m.items; track it.label) {
          @if (it.sep) { <hr class="ctx-sep" /> }
          <button type="button" class="ctx-item" [class.danger]="it.danger" (click)="it.run(); closeCtxMenu()">{{ it.label }}</button>
        }
      </div>
    }
  `,
  styles: [
    `
    .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .head .page-title { margin: 0; }
    .hint { font-size: 12.5px; }

    /* панель блок-схем */
    .scheme-bar {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;
      padding: 8px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    }
    .scheme-name { width: 240px; max-width: 60vw; }

    /* свойства заготовки — содержимое всплывающего окна (проецируется в app-modal) */
    .props-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .props-form .pf { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
    .props-form .pf.grow { grid-column: 1 / -1; }
    .props-form .pf-in { width: 100%; font-size: 13px; padding: 6px 8px; }
    .props-form select { font-size: 13px; padding: 6px 8px; }
    .props-form .pf-note { grid-column: 1 / -1; font-size: 11.5px; }
    @media (max-width: 520px) { .props-form { grid-template-columns: 1fr; } }

    /* вкладки левого каталога: сырьё / полуфабрикаты */
    .tabs { display: flex; align-items: center; gap: 6px; margin: 10px 0; }
    .tab {
      display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: #fff;
      color: var(--text); border-radius: 8px; font: inherit; font-size: 12.5px; font-weight: 600;
      padding: 6px 10px; cursor: pointer;
    }
    .tab:hover { background: #f2f5fa; }
    .tab.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .tab-n {
      font-size: 11px; font-weight: 700; padding: 0 6px; border-radius: 999px;
      background: rgba(0, 0, 0, .08); font-variant-numeric: tabular-nums;
    }
    .tab.on .tab-n { background: rgba(255, 255, 255, .28); }
    .tab-refresh { margin-left: auto; border: 0; background: transparent; cursor: pointer; color: var(--muted); font-size: 15px; padding: 2px 8px; border-radius: 6px; }
    .tab-refresh:hover { background: #f2f5fa; color: var(--text); }

    /* строка заготовки во вкладке «Полуфабрикаты»: тянется на стол + открыть стол + удалить */
    .scheme-row {
      display: flex; align-items: stretch; gap: 4px; padding-left: 6px;
      border: 1px solid var(--border); border-radius: 8px; background: #fff;
      cursor: grab; user-select: none; transition: border-color .1s, background .1s;
    }
    .scheme-row:hover { background: #f2f5fa; border-color: #cdd8ea; }
    .scheme-row.cur { border-color: var(--accent); background: var(--accent-soft); }
    .scheme-row.dragging { opacity: .5; border-style: dashed; border-color: var(--accent); }
    .scheme-row .grip { align-self: center; }
    .sr-open { flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; font: inherit; cursor: pointer; padding: 8px 4px; display: flex; flex-direction: column; gap: 2px; }
    .sr-open b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .sr-meta { font-size: 11px; color: var(--muted); }
    .sr-del { flex: none; border: 0; background: transparent; cursor: pointer; color: var(--muted); font-size: 14px; padding: 0 8px; border-radius: 8px; }
    .sr-del:hover { background: var(--red-soft); color: var(--red); }

    /* узкое меню слева, стол на всю оставшуюся ширину и высоту экрана */
    .cols {
      display: grid;
      grid-template-columns: 250px minmax(0, 1fr);
      gap: 16px;
      align-items: stretch;
      height: calc(100vh - 96px);
      min-height: 420px;
    }
    /* grid-элемент по умолчанию min-height:auto — панель растягивалась содержимым и ряд вылезал за экран */
    .cols > * { min-height: 0; }

    /* левый каталог */
    .cat { overflow: auto; margin-bottom: 0; }
    .search { position: relative; display: flex; }
    .search input { width: 100%; padding-right: 30px; }
    .clr {
      position: absolute; right: 4px; top: 5px; border: 0; background: transparent; color: var(--muted);
      cursor: pointer; font-size: 14px; padding: 4px 7px; border-radius: 6px;
    }
    .clr:hover { background: #f2f5fa; color: var(--text); }

    .sk { display: flex; flex-direction: column; gap: 6px; }
    .sk-row { border: 1px solid var(--border); border-radius: 8px; padding: 12px; color: var(--muted); font-size: 12px; background: #fbfcfe; }

    .list { display: flex; flex-direction: column; gap: 6px; }
    .ci {
      display: flex; align-items: center; gap: 6px; padding: 9px 10px;
      border: 1px solid var(--border); border-radius: 8px; background: #fff;
      cursor: grab; user-select: none; transition: box-shadow .1s, border-color .1s;
    }
    .ci:hover { background: #f2f5fa; border-color: #cdd8ea; }
    .ci:active { cursor: grabbing; }
    .ci.dragging { opacity: .5; border-style: dashed; border-color: var(--accent); }
    .grip { color: var(--muted); font-size: 14px; flex: none; line-height: 1; }
    /* в узкой колонке тип — цветным маркером, подпись в tooltip */
    .ci-mark { flex: none; font-size: 11px; line-height: 1; }
    .ci-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ci-unit { margin-left: auto; font-size: 11.5px; color: var(--muted); flex: none; }

    /* правый «стол» — тянется на всю высоту ряда */
    .table { display: flex; flex-direction: column; margin-bottom: 0; }
    .tb-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .tb-head h3 { margin: 0; }

    /* область стола: позиционирующий контейнер и зона сброса */
    .plate-area {
      position: relative; flex: 1; min-height: 0; overflow: hidden;
      border: 2px dashed var(--border); border-radius: var(--radius);
      background: #fbfcfe; transition: border-color .1s, background .1s;
      cursor: grab; touch-action: none;
    }
    .plate-area.over { border-color: var(--accent); background: var(--accent-soft); }
    .plate-area.panning { cursor: grabbing; }

    /* сцена стола: масштабируется (transform) от левого-верхнего угла; блоки/нити внутри — в координатах содержимого */
    .scene { position: absolute; inset: 0; transform-origin: 0 0; }

    /* панель масштаба в шапке стола */
    .zoombar { display: inline-flex; align-items: center; gap: 2px; }
    .zoombar button {
      border: 1px solid var(--border); background: #fff; color: var(--text);
      border-radius: 6px; cursor: pointer; padding: 2px 9px; font: inherit; font-size: 14px; line-height: 1.5;
    }
    .zoombar button:hover { background: #f2f5fa; }
    .zoombar .z-val { min-width: 50px; text-align: center; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

    .empty-drop {
      position: absolute; inset: 0; z-index: 1; pointer-events: none;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 6px; text-align: center; color: var(--muted); padding: 24px;
    }
    .plate-area.over .empty-drop { color: var(--accent); }
    .ed-icon { font-size: 40px; opacity: .6; }
    .small { font-size: 12px; }

    /* блоки-карточки: абсолютно позиционируются, двигаются мышкой по столу */
    .plate { position: absolute; inset: 0; pointer-events: none; }
    .pi {
      position: absolute; pointer-events: auto; width: 260px; max-width: calc(100% - 16px);
      display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 10px;
      border: 1px solid var(--border); border-left: 4px solid var(--border);
      border-radius: 12px; background: #fff; box-shadow: var(--shadow);
      cursor: grab; user-select: none; touch-action: none;
    }
    /* цветовая принадлежность блока: сырьё — голубой, заготовка — янтарный, сборка — зелёный */
    .pi.ing-raw { border-left-color: var(--accent); background: linear-gradient(180deg, #f2f7ff, #fff 62%); }
    .pi.ing-semi { border-left-color: var(--amber); background: linear-gradient(180deg, #fdf7e6, #fff 62%); }
    .pi.note { border-left-color: var(--green); background: linear-gradient(180deg, #eefaf2, #fff 62%); }
    .pi:active { cursor: grabbing; }
    .pi.moving { cursor: grabbing; border-color: var(--accent); box-shadow: 0 8px 22px rgba(20, 30, 55, .22); z-index: 30; }
    .pi input { cursor: text; touch-action: auto; user-select: text; }
    .pi-top { display: flex; align-items: center; gap: 6px; }
    .pi-name {
      flex: 1; min-width: 0; font-size: 13px; line-height: 1.28; font-weight: 600;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
      overflow: hidden; overflow-wrap: anywhere;
    }
    .pi-name.semi-name { cursor: text; } .pi-name.semi-name:hover { text-decoration: underline dashed; text-underline-offset: 3px; }
    /* инлайн-редактор имени полуфабриката в блоке */
    .name-in {
      flex: 1; min-width: 0; font: inherit; font-size: 13px; font-weight: 600; padding: 2px 6px;
      border: 1px solid var(--accent); border-radius: 6px; background: #fff; box-shadow: none;
    }
    .name-in:focus { outline: none; }
    .pi-x {
      flex: none; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px;
      cursor: pointer; padding: 2px 6px; border-radius: 6px;
    }
    .pi-x:hover { background: var(--red-soft); color: var(--red); }
    .pi-qty { display: flex; gap: 6px; }
    .qty-in { flex: 1; min-width: 0; padding: 6px 8px; font-size: 13px; text-align: right; font-variant-numeric: tabular-nums; }
    /* базовая единица — просто текст, не поле */
    .u-txt { flex: none; align-self: center; font-size: 12.5px; font-weight: 600; color: var(--muted); }

    /* свободный блок (из контекстного меню) */
    .pi.note { width: 220px; }
    .note-in {
      flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; font: inherit;
      font-size: 13px; font-weight: 600; box-shadow: none;
    }
    .note-in:focus { outline: none; box-shadow: none; }

    /* себестоимость блока-ингредиента — прямо под количеством */
    .pi-cost { font-size: 12px; font-weight: 700; color: var(--green); font-variant-numeric: tabular-nums; }

    /* мини-блок-схема состава заготовки внутри карточки */
    .mini { margin-top: 2px; border-top: 1px dashed var(--border); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .mini-cap { font-size: 9.5px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: var(--muted); }
    .mini-canvas { position: relative; }
    .mini-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    .mini-wire { fill: none; stroke: #b6c2d6; stroke-width: 1.2; }
    .mini-chip {
      position: absolute; box-sizing: border-box; display: flex; align-items: center; padding: 0 4px;
      font-size: 9px; font-weight: 600; line-height: 1; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; border-radius: 4px; border: 1px solid var(--border); background: #fff; color: var(--text);
    }
    .mini-chip.raw { border-color: #bcd4f6; background: #eef4ff; color: #2a5fa8; }
    .mini-chip.semi { border-color: #f0d79a; background: #fdf5e2; color: #8a5a00; }
    .mini-chip.note { border-color: #b6e2c6; background: #eafaef; color: #1d7a41; }

    /* живой расчёт сборки прямо в свободном блоке */
    .asm { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border); padding-top: 7px; }
    .asm-empty { font-size: 11.5px; color: var(--muted); line-height: 1.35; }
    .asm-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
    .asm-row span { color: var(--muted); }
    .asm-row b { font-variant-numeric: tabular-nums; }
    .asm-row.total b { color: var(--green); font-size: 13px; }
    .asm-streams { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
    .asm-s { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; align-items: baseline; font-size: 11px; }
    .as-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .as-q { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .as-q.as-warn { color: var(--red); }
    .as-y { color: var(--accent); font-weight: 600; margin-left: 3px; }
    .as-c { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .asm-multi { font-size: 10.5px; color: #b26a00; line-height: 1.3; }

    /* ---------- связи между блоками ---------- */
    /* слой нитей под карточками (z-index:0 — блоки идут позже в DOM и рисуются поверх);
       сам слой кликов не ловит, только широкая «полоса попадания» нити и кнопка удаления */
    .wires {
      position: absolute; inset: 0; z-index: 0; pointer-events: none;
      width: 100%; height: 100%; overflow: visible;
    }
    .wire { fill: none; stroke: #93a3bc; stroke-width: 2; }
    .wire.temp { stroke: var(--accent); stroke-dasharray: 6 4; }
    /* невидимая широкая полоса поверх нити — по ней видно, что связь наведена, и жмётся ✕ */
    .wire-hit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; cursor: pointer; }
    .wire-row:hover .wire { stroke: var(--red); }
    /* клик по нити открывает выход после обработки: выбранная нить подсвечена, ✕ виден */
    .wire-row.sel .wire { stroke: var(--accent); stroke-width: 2.5; }
    .wire-row.sel .wire-x { pointer-events: auto; opacity: 1; }
    /* подпись выхода на нити — чтобы схема читалась без открытия карточки */
    .wire-pct { font-size: 11px; font-weight: 600; fill: var(--muted); pointer-events: none; }
    .wire-pct.set { fill: var(--accent); }
    .wire-row:hover .wire-pct, .wire-row.sel .wire-pct { opacity: 0; }
    .wire-x { pointer-events: none; opacity: 0; transition: opacity .1s; }
    .wire-row:hover .wire-x { pointer-events: auto; opacity: 1; }
    .wire-x circle { fill: #fff; stroke: var(--border); stroke-width: 1.5; }
    .wire-x text { font-size: 10px; fill: var(--muted); }
    .wire-x:hover circle { fill: var(--red-soft); stroke: var(--red); }
    .wire-x:hover text { fill: var(--red); }

    /* карточка правки связи: прижата к нити на столе, следует за ней при перетаскивании блоков */
    .link-editor {
      position: absolute; z-index: 40; width: 236px; pointer-events: auto;
      display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px;
      background: var(--panel); border: 1px solid var(--accent); border-radius: 10px;
      box-shadow: 0 10px 26px rgba(20, 30, 55, .2);
    }
    .le-head { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px; }
    .le-x { margin-left: auto; border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: 6px; }
    .le-x:hover { background: var(--red-soft); color: var(--red); }
    .le-route { font-size: 12px; color: var(--muted); background: #fbfcfe; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
    .le-route .le-ar { color: var(--accent); font-weight: 700; }
    .link-editor input { text-align: right; font-variant-numeric: tabular-nums; }
    .le-tip { font-size: 11.5px; line-height: 1.4; }
    .le-acts { display: flex; gap: 8px; }

    /* коннекторы: выход справа у всех блоков, вход слева — у свободного блока */
    .port {
      position: absolute; top: 14px; width: 12px; height: 12px; box-sizing: border-box;
      border-radius: 50%; background: #fff; border: 2px solid var(--accent);
      z-index: 2; touch-action: none;
    }
    .port.out { right: -6px; cursor: crosshair; }
    .port.out:hover { background: var(--accent); }
    /* вход только у свободных блоков: сырьё связей не принимает */
    .port.in { left: -6px; background: var(--accent-soft); }
    .plate-area.linking .port.in { border-color: var(--green); }
    .port.in.hot { background: var(--green); border-color: var(--green); transform: scale(1.3); box-shadow: 0 0 0 3px var(--accent-soft); }
    /* ✕ в шапке не наступают на правый коннектор */
    .pi-top > :last-child { margin-right: 10px; }

    /* контекстное меню стола */
    .ctx-backdrop { position: fixed; inset: 0; z-index: 90; }
    .ctx-menu {
      position: fixed; z-index: 91; min-width: 180px; padding: 5px;
      background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
      box-shadow: 0 8px 24px rgba(20, 30, 55, .18); display: flex; flex-direction: column; gap: 2px;
    }
    .ctx-item {
      text-align: left; border: 0; background: transparent; color: var(--text);
      font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 7px; cursor: pointer;
    }
    .ctx-item:hover { background: var(--accent-soft); }
    .ctx-item.danger { color: var(--red); }
    .ctx-item.danger:hover { background: var(--red-soft); }
    .ctx-sep { border: none; border-top: 1px solid var(--border); margin: 4px 2px; }

    /* планшет/телефон: колонки складываются, высота возвращается на потоковую */
    @media (max-width: 900px) {
      .cols { grid-template-columns: 1fr; height: auto; min-height: 0; }
      .cat { max-height: 45vh; }
      .table { min-height: 70vh; }
    }
    `,
  ],
})
export class ConstructorComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  products = signal<Product[]>([]);
  semis = signal<Semi[]>([]);
  /** справочник единиц — нужен, чтобы свести заготовку к сырью и посчитать её ₽ */
  units = signal<Unit[]>([]);

  loading = signal(true);
  listErr = signal('');

  query = signal('');
  /** активная вкладка левого каталога: сырьё или полуфабрикаты (заготовки) */
  catTab = signal<SourceKind>('raw');

  /** позиция, которую сейчас тащат из каталога (читать dataTransfer можно только на drop) */
  dragKey = signal('');
  dragging = signal<CItem | null>(null);
  overTable = signal(false);

  plate = signal<PlateItem[]>([]);

  /** инлайн-редактирование имени полуфабриката в блоке: null — никто не правится */
  editing = signal<{ uid: number; value: string } | null>(null);
  /** имя в процессе сохранения (PATCH целиком, сервер только так умеет) — кнопка/blur не кусаются */
  savingName = signal(false);

  /** сборка в процессе сохранения в каталог (POST /api/semis) — не давать нажать дважды */
  savingSemi = signal(false);

  /** связь, открытая для правки выхода после обработки (клик по нити): id связи */
  editingLink = signal<number | null>(null);

  // ---------- заготовки каталога (вкладка «Полуфабрикаты») ----------
  /** список заготовок (= бывшие «мои схемы») */
  diagrams = signal<Semi[]>([]);
  /** id открытой заготовки (null — новая/несохранённая) */
  currentId = signal<number | null>(null);
  /** название текущей заготовки — правится в поле и уходит на сервер */
  diagramName = signal('');
  /** идёт сохранение заготовки (POST/PATCH) */
  savingDiagram = signal(false);

  /** свойства заготовки (перенос полей редактора «Редактирование заготовки») — текущий стол */
  props = signal<SemiProps>(DEFAULT_PROPS);
  /** открыто ли всплывающее окно свойств заготовки */
  showProps = signal(false);
  /** черновик свойств внутри попапа — коммитим только по «Готово»/сохранении */
  propsDraft = signal<SemiProps>(DEFAULT_PROPS);
  /** цель попапа: текущий стол (board) или конкретная заготовка каталога (semi) */
  propsTarget = signal<{ mode: 'board' } | { mode: 'semi'; semi: Semi } | null>(null);
  /** идёт сохранение свойств заготовки из попапа (PATCH) */
  propsSaving = signal(false);

  /** контекстное меню стола (правая кнопка на пустом месте) */
  ctxMenu = signal<ContextMenu | null>(null);

  /** активное перетаскивание блока по столу (null — никто не двигается) */
  moving = signal<Moving | null>(null);

  /** связи между блоками */
  links = signal<Link[]>([]);
  /** сейчас тянут новую связь (null — не тянут) */
  linking = signal<Linking | null>(null);
  /** блок, над которым держат конец нити и куда связь встанет при отпускании */
  linkTarget = signal<number | null>(null);
  /** область стола — координатная база для сброса из каталога и для движения блоков */
  private areaRef = viewChild<ElementRef<HTMLDivElement>>('area');

  /** кэш столов (составов) заготовок по refId — для мини-блок-схем внутри карточек */
  semiBoards = signal<Record<number, DiagramData | null>>({});
  /** refId, чей стол уже грузим (не дёргать сервер дважды) */
  private boardLoading = new Set<number>();

  /** глубина dragenter/dragleave — чтобы подсветка стола не мигала при проходе над дочерними элементами */
  private depth = 0;
  private nextUid = 1;
  private nextLinkId = 1;

  // ---------- зум и панорамирование стола ----------
  readonly zoomMin = 0.3;
  readonly zoomMax = 2.5;
  /** масштаб содержимого стола (1 = 100 %) */
  zoom = signal(1);
  /** сдвиг сцены в экранных px */
  pan = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  /** тянем пустое место стола (панорамирование) */
  panning = signal(false);
  private panStart: { sx: number; sy: number; px: number; py: number } | null = null;

  zoomPct = computed(() => Math.round(this.zoom() * 100));

  /** transform сцены: сначала сдвиг, затем масштаб от левого-верхнего угла */
  sceneTransform(): string {
    const p = this.pan();
    return `translate(${p.x}px, ${p.y}px) scale(${this.zoom()})`;
  }

  /** экранные координаты курсора → координаты содержимого стола (с учётом зума и сдвига) */
  private toContent(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.areaRef()?.nativeElement.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const p = this.pan();
    const z = this.zoom() || 1;
    return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
  }

  /** сменить масштаб, удерживая точку под якорем (по умолчанию — центр стола) на месте */
  setZoom(next: number, anchorClientX?: number, anchorClientY?: number): void {
    const el = this.areaRef()?.nativeElement;
    const zNew = clamp(next, this.zoomMin, this.zoomMax);
    if (!el) { this.zoom.set(zNew); return; }
    const rect = el.getBoundingClientRect();
    const ax = anchorClientX ?? rect.left + el.clientWidth / 2;
    const ay = anchorClientY ?? rect.top + el.clientHeight / 2;
    const zOld = this.zoom();
    if (zNew === zOld) return;
    const p = this.pan();
    const cx = (ax - rect.left - p.x) / zOld;
    const cy = (ay - rect.top - p.y) / zOld;
    this.pan.set({ x: ax - rect.left - cx * zNew, y: ay - rect.top - cy * zNew });
    this.zoom.set(zNew);
  }

  zoomIn(): void { this.setZoom(this.zoom() * 1.2); }
  zoomOut(): void { this.setZoom(this.zoom() / 1.2); }
  zoomReset(): void { this.zoom.set(1); this.pan.set({ x: 0, y: 0 }); }

  /** Ctrl + колесо над столом — зум к курсору */
  onAreaWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    this.setZoom(this.zoom() * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), ev.clientX, ev.clientY);
  }

  onAreaPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    // хват не с блока/коннектора/карточки связи — там своё поведение (движение блока, тяга связи)
    if (t.closest('.pi') || t.closest('.port') || t.closest('.link-editor')) return;
    this.panning.set(true);
    this.panStart = { sx: ev.clientX, sy: ev.clientY, px: this.pan().x, py: this.pan().y };
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  }

  onAreaPointerMove(ev: PointerEvent): void {
    if (!this.panStart) return;
    this.pan.set({ x: this.panStart.px + (ev.clientX - this.panStart.sx), y: this.panStart.py + (ev.clientY - this.panStart.sy) });
  }

  onAreaPointerUp(ev: PointerEvent): void {
    if (!this.panStart) return;
    (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
    this.panStart = null;
    this.panning.set(false);
  }

  ngOnInit(): void {
    this.reload();
    this.loadDiagrams();
  }

  reload(): void {
    this.loading.set(true);
    this.listErr.set('');
    let done = 0;
    const finish = (err?: string) => {
      if (err) this.listErr.set(err);
      if (++done === 3) this.loading.set(false);
    };
    this.api.products$({ active: 'true' }).subscribe({
      next: (p) => { this.products.set(p); finish(); },
      error: (e) => finish(this.errText(e)),
    });
    this.api.semis$().subscribe({
      next: (s) => { this.semis.set(s); this.diagrams.set(s); finish(); },
      error: (e) => finish(this.errText(e)),
    });
    this.api.units$().subscribe({
      next: (u) => { this.units.set(u); finish(); },
      error: () => finish(), // единицы не загрузились — расчёт заготовок просто беднее, список не роняем
    });
  }

  private errText(e: unknown): string {
    const any = e as { error?: { error?: string }; message?: string };
    return any?.error?.error ?? any?.message ?? 'Не удалось загрузить список';
  }

  // ---------- менеджер заготовок каталога ----------
  /** перечитать список заготовок (полный каталог = список столов + составов) */
  loadDiagrams(): void {
    this.api.semis$().subscribe({
      next: (s) => { this.semis.set(s); this.diagrams.set(s); },
      error: () => {},
    });
  }

  /** чистый стол + новая (несохранённая) заготовка */
  newDiagram(): void {
    this.clearPlate();
    this.currentId.set(null);
    this.diagramName.set('');
    this.props.set(DEFAULT_PROPS);
    this.showProps.set(false);
    this.propsTarget.set(null);
  }

  /**
   * Создать (id нет) или перезаписать (id есть) заготовку каталога из текущего стола.
   * Рецепт считается из главной сборки (свободного блока с входящими связями), стол
   * сохраняется как её board — «мои схемы» и есть полуфабрикаты.
   */
  saveDiagram(): void {
    if (this.savingDiagram()) return;
    const name = this.diagramName().trim();
    if (!name) {
      this.toast.show('Укажите название заготовки', 'warn', 2200);
      return;
    }
    if (!this.plate().length) {
      this.toast.show('На столе пусто — нечего сохранять', 'warn', 2200);
      return;
    }
    const main = this.mainNote();
    if (!main) {
      this.toast.show('Создайте блок-полуфабрикат (правая кнопка на столе) и подведите к нему сырьё', 'warn', 3200);
      return;
    }
    const inbound = (uid: number) => this.links().filter((l) => l.to === uid).length;
    if (inbound(main.uid) === 0) {
      this.toast.show('Нет входящих связей — соедините сырьё с блоком заготовки', 'warn', 3200);
      return;
    }
    const res = buildSemiBody(this.plate(), this.links(), this.ctx(), main.uid);
    if (!res.ok) {
      this.toast.show(res.error, 'warn', 3600);
      return;
    }
    const p = this.props();
    const shelf =
      p.shelfLifeDays != null && Number.isFinite(Number(p.shelfLifeDays)) ? Math.trunc(Number(p.shelfLifeDays)) : null;
    // свойства уровня заготовки (перенос из редактора): пустое = значение, выведенное из стола
    const body = {
      ...res.body,
      name,
      unitId: p.unitId ?? res.body.unitId,
      outQty: p.outQty != null && p.outQty > 0 ? p.outQty : res.body.outQty,
      note: p.note?.trim() ?? '',
      shelfLifeDays: shelf,
      gPerPcs: p.gPerPcs,
      mlPerPcs: p.mlPerPcs,
      gPerMl: p.gPerMl,
      board: { blocks: this.plate(), links: this.links() },
    };
    const id = this.currentId();
    this.savingDiagram.set(true);
    const done = () => {
      this.savingDiagram.set(false);
      // состав этой заготовки мог измениться — сбросим её мини-кэш и перечитаем, если блок стоит на столе
      const sid = this.currentId();
      if (sid != null) {
        this.semiBoards.update((m) => { const n = { ...m }; delete n[sid]; return n; });
        if (this.plate().some((b) => b.kind === 'ingredient' && b.sourceType === 'semi' && b.refId === sid)) {
          this.loadSemiBoard(sid);
        }
      }
      this.toast.show(id == null ? `Заготовка «${name}» сохранена` : `Заготовка «${name}» обновлена`, 'ok', 2000);
      this.loadDiagrams();
    };
    if (id == null) {
      this.api.createSemi(body).subscribe({
        next: (r) => {
          this.currentId.set(r.id); // дальнейшие правки — «Обновить» этой же заготовки
          done();
        },
        error: (e: unknown) => {
          this.savingDiagram.set(false);
          this.toast.show(this.errText(e), 'err', 3000);
        },
      });
    } else {
      this.api.patchSemi(id, body).subscribe({
        next: done,
        error: (e: unknown) => {
          this.savingDiagram.set(false);
          this.toast.show(this.errText(e), 'err', 3000);
        },
      });
    }
  }

  /** загрузить стол заготовки на стол (после проверки — не потеряли бы несохранённое) */
  openDiagram(id: number): void {
    if (this.plate().length && id !== this.currentId() && !confirm('Открыть другую заготовку? Несохранённые изменения текущего стола пропадут.')) {
      return;
    }
    this.api.semi$(id).subscribe({
      next: (s) => {
        const blocks = (s.board?.blocks ?? []).map((b) => this.reviveBlock(b));
        const uids = new Set(blocks.map((b) => b.uid));
        const links = (s.board?.links ?? [])
          .filter((l) => uids.has(Number(l.from)) && uids.has(Number(l.to)))
          .map((l) => ({ id: Number(l.id), from: Number(l.from), to: Number(l.to), yieldPct: String(l.yieldPct ?? '') }));
        this.plate.set(blocks);
        this.links.set(links);
        this.currentId.set(s.id);
        this.diagramName.set(s.name);
        this.props.set({
          unitId: s.unitId ?? null,
          outQty: Number(s.outQty) || null,
          note: s.note ?? '',
          shelfLifeDays: s.shelfLifeDays ?? null,
          gPerPcs: s.gPerPcs ?? null,
          mlPerPcs: s.mlPerPcs ?? null,
          gPerMl: s.gPerMl ?? null,
        });
        this.editing.set(null);
        this.editingLink.set(null);
        // счётчики выше максимума загруженных id — новые блоки/связи не столкнутся с прежними
        this.nextUid = blocks.reduce((m, b) => Math.max(m, b.uid), 0) + 1;
        this.nextLinkId = links.reduce((m, l) => Math.max(m, l.id), 0) + 1;
        this.toast.show(
          blocks.length ? `Заготовка «${s.name}» открыта` : `Заготовка «${s.name}» — стола нет, соберите его из компонентов`,
          'ok',
          2200,
        );
      },
      error: (e: unknown) => this.toast.show(this.errText(e), 'err', 3000),
    });
  }

  /** блок из хранилища → живой блок; имя/единицу ингредиента обновляем по текущему каталогу */
  private reviveBlock(b: DiagramBlock): PlateItem {
    const kind: PlateItem['kind'] = b.kind === 'note' ? 'note' : 'ingredient';
    const sourceType: SourceKind = b.sourceType === 'semi' ? 'semi' : 'raw';
    const refId = Number(b.refId) || 0;
    const item: PlateItem = {
      uid: Number(b.uid),
      kind,
      sourceType,
      refId,
      name: String(b.name ?? ''),
      title: String(b.title ?? ''),
      x: Number(b.x) || 0,
      y: Number(b.y) || 0,
      qty: String(b.qty ?? ''),
      unitCode: String(b.unitCode ?? ''),
    };
    if (kind === 'ingredient') {
      if (sourceType === 'semi') {
        const s = this.semis().find((x) => x.id === refId);
        if (s) { item.name = s.name; item.unitCode = s.unitCode; }
        this.loadSemiBoard(refId);
      } else {
        const p = this.products().find((x) => x.id === refId);
        if (p) { item.name = p.name; item.unitCode = p.unitCode; }
      }
    }
    return item;
  }

  deleteDiagram(d: Semi): void {
    if (!confirm(`Удалить заготовку «${d.name}»?`)) return;
    this.api.deleteSemi(d.id).subscribe({
      next: () => {
        // удалили открытую — стол оставляем, но он становится «новой» заготовкой
        if (this.currentId() === d.id) this.currentId.set(null);
        this.diagrams.update((list) => list.filter((x) => x.id !== d.id));
        this.semis.update((list) => list.filter((x) => x.id !== d.id));
        this.toast.show('Заготовка удалена', 'ok', 1800);
      },
      error: (e: unknown) => this.toast.show(this.errText(e), 'err', 3000),
    });
  }

  // ---------- производные списки ----------
  rawCount = computed(() => this.products().length);
  semiCount = computed(() => this.semis().length);

  /** единый каталог: сырьё + полуфабрикаты */
  private all = computed<CItem[]>(() => {
    const raw: CItem[] = this.products().map((p) => ({
      key: `raw:${p.id}`, sourceType: 'raw', refId: p.id, name: p.name, unitCode: p.unitCode,
    }));
    const semi: CItem[] = this.semis().map((s) => ({
      key: `semi:${s.id}`, sourceType: 'semi', refId: s.id, name: s.name, unitCode: s.unitCode,
    }));
    return [...raw, ...semi].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  /** вкладка «Сырьё»: позиции номенклатуры, отфильтрованные поиском */
  rawFiltered = computed<CItem[]>(() => {
    const q = this.query().trim().toLowerCase();
    return this.all().filter((it) => it.sourceType === 'raw' && (!q || it.name.toLowerCase().includes(q)));
  });

  /** вкладка «Полуфабрикаты»: сохранённые заготовки (= бывшие «мои схемы»), отфильтрованные поиском */
  semiFiltered = computed<Semi[]>(() => {
    const q = this.query().trim().toLowerCase();
    return this.diagrams().filter((d) => !q || d.name.toLowerCase().includes(q));
  });

  // ---------- расчёт по столу: выход и себестоимость сборок ----------
  /** справочники, нужные, чтобы развернуть заготовку до сырья */
  ctx = computed(() => ({ units: this.units(), products: this.products(), semis: this.semis() }));
  /** прямой прогон количества сквозь связи: сборки (выход/₽) и собственные ₽ ингредиентов */
  calc = computed(() => resolveConstructor(this.plate(), this.links(), this.ctx()));

  /** расчёт сборки (свободного блока): потоки, выход с учётом обработки, себестоимость */
  asm(uid: number): Assembly | null {
    return this.calc().assemblies.get(uid) ?? null;
  }

  /** собственная себестоимость блока-ингредиента на столе */
  blockCost(uid: number): BlockCost | null {
    return this.calc().blocks.get(uid) ?? null;
  }

  // ---------- мини-блок-схема состава заготовки (внутри карточки на столе) ----------
  /** подтянуть стол (состав) заготовки, если его ещё нет в кэше и у неё есть сохранённый стол */
  private loadSemiBoard(refId: number): void {
    if (!refId || this.semiBoards()[refId] !== undefined || this.boardLoading.has(refId)) return;
    const meta = this.semis().find((s) => s.id === refId);
    // список отдаёт только признак hasBoard — без стола нечего и тянуть
    if (meta && meta.hasBoard === false) {
      this.semiBoards.update((m) => ({ ...m, [refId]: null }));
      return;
    }
    this.boardLoading.add(refId);
    this.api.semi$(refId).subscribe({
      next: (s) => {
        this.boardLoading.delete(refId);
        this.semiBoards.update((m) => ({ ...m, [refId]: s.board ?? null }));
      },
      error: () => {
        this.boardLoading.delete(refId);
        this.semiBoards.update((m) => ({ ...m, [refId]: null }));
      },
    });
  }

  /** мини-полотна составов по refId — пересчитываем только когда поменялся кэш столов */
  private miniMap = computed<Record<number, MiniView | null>>(() => {
    const map: Record<number, MiniView | null> = {};
    for (const [id, board] of Object.entries(this.semiBoards())) {
      map[Number(id)] = board ? buildMini(board) : null;
    }
    return map;
  });

  /** мини-схема состава заготовки в карточке (null, пока стол не долетел или его нет) */
  miniFor(refId: number): MiniView | null {
    return this.miniMap()[refId] ?? null;
  }

  // ---------- свойства заготовки (перенос полей редактора) ----------
  /** базовые единицы — список для выбора «Ед. выхода» (как в редакторе заготовки) */
  baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));

  /** код единицы по id — для подписей рядом с полем */
  unitCodeOf(id: number | null): string {
    if (id == null) return '';
    return this.units().find((u) => u.id === id)?.code ?? '';
  }

  /** главная сборка стола — блок-нота с наибольшим числом входящих связей (тот же выбор, что при сохранении) */
  mainNote(): PlateItem | null {
    const notes = this.plate().filter((b) => b.kind === 'note');
    if (!notes.length) return null;
    const inbound = (uid: number) => this.links().filter((l) => l.to === uid).length;
    return notes.reduce((m, b) => (inbound(b.uid) > inbound(m.uid) ? b : m), notes[0]);
  }

  /** выход, который стол выводит сам — подсказка (placeholder) и значение по умолчанию для размера партии */
  derivedOut(): number | null {
    const main = this.mainNote();
    return main ? this.asm(main.uid)?.outQty ?? null : null;
  }

  /** единица этого вывода (код) — '' если единиц несколько или выход не собран */
  derivedUnit(): string {
    const main = this.mainNote();
    return main ? this.asm(main.uid)?.primaryUnit ?? '' : '';
  }

  /** подсказка размера партии: выведенный из стола выход либо общий пример */
  outHint(): string {
    if (this.propsTarget()?.mode === 'semi') return 'напр. 1000';
    const v = this.derivedOut();
    return v == null ? 'напр. 1000' : String(v);
  }

  /** правка одного свойства в черновике попапа */
  patchProp<K extends keyof SemiProps>(key: K, value: SemiProps[K]): void {
    this.propsDraft.update((p) => ({ ...p, [key]: value }));
  }

  /** строка/число поля ввода → число или null (пусто = не задано) */
  numOrNull(v: string | number | null | undefined): number | null {
    const s = (v ?? '').toString().trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- попап свойств заготовки (открывается из контекстного меню блока) ----------
  /** открыть попап свойств текущего стола — правки уйдут в saveDiagram при сохранении заготовки */
  openPropsForBoard(): void {
    this.propsDraft.set(this.props());
    this.propsTarget.set({ mode: 'board' });
    this.showProps.set(true);
  }

  /** открыть попап свойств заготовки из каталога — сохранение патчит её сразу */
  openPropsForSemi(refId: number): void {
    const semi = this.semis().find((s) => s.id === refId);
    if (!semi) {
      this.toast.show('Заготовка не найдена в каталоге — обновите список', 'warn', 2500);
      return;
    }
    this.propsDraft.set({
      unitId: semi.unitId ?? null,
      outQty: Number(semi.outQty) || null,
      note: semi.note ?? '',
      shelfLifeDays: semi.shelfLifeDays ?? null,
      gPerPcs: semi.gPerPcs ?? null,
      mlPerPcs: semi.mlPerPcs ?? null,
      gPerMl: semi.gPerMl ?? null,
    });
    this.propsTarget.set({ mode: 'semi', semi });
    this.showProps.set(true);
  }

  /** закрыть попап без сохранения */
  closeProps(): void {
    this.showProps.set(false);
    this.propsTarget.set(null);
  }

  /** заголовок попапа по цели */
  propsTitle(): string {
    const t = this.propsTarget();
    return t?.mode === 'semi' ? `Свойства: «${t.semi.name}»` : 'Свойства заготовки';
  }

  /** сохранить: стол — коммитим в props (войдут в saveDiagram); заготовка каталога — PATCH */
  saveProps(): void {
    if (this.propsSaving()) return;
    const t = this.propsTarget();
    if (!t) return;
    const d = this.propsDraft();
    const shelf =
      d.shelfLifeDays != null && Number.isFinite(Number(d.shelfLifeDays)) ? Math.trunc(Number(d.shelfLifeDays)) : null;
    if (t.mode === 'board') {
      this.props.set(d);
      this.closeProps();
      return;
    }
    const semi = t.semi;
    const unitId = d.unitId ?? semi.unitId;
    const body = {
      name: semi.name,
      unitId,
      outQty: d.outQty != null && d.outQty > 0 ? d.outQty : semi.outQty,
      note: d.note?.trim() ?? '',
      shelfLifeDays: shelf,
      gPerPcs: d.gPerPcs,
      mlPerPcs: d.mlPerPcs,
      gPerMl: d.gPerMl,
      inputs: semi.inputs,
    };
    this.propsSaving.set(true);
    this.api.patchSemi(semi.id, body).subscribe({
      next: () => {
        this.propsSaving.set(false);
        const unitCode = this.unitCodeOf(unitId);
        const updated = { ...semi, ...body, unitCode };
        this.semis.update((list) => list.map((s) => (s.id === semi.id ? updated : s)));
        this.diagrams.update((list) => list.map((s) => (s.id === semi.id ? updated : s)));
        // блоки этой заготовки на столе — подтянуть свежую единицу выхода
        this.plate.update((list) =>
          list.map((x) => (x.kind === 'ingredient' && x.sourceType === 'semi' && x.refId === semi.id ? { ...x, unitCode } : x)),
        );
        this.toast.show(`Свойства «${semi.name}» сохранены`, 'ok', 2000);
        this.closeProps();
      },
      error: (e: unknown) => {
        this.propsSaving.set(false);
        this.toast.show(this.errText(e), 'err', 3000);
      },
    });
  }

  readonly fmtMoney = fmtMoney;
  readonly fmtQty = fmtQty;
  readonly fmtCost = fmtCost;

  // ---------- перетаскивание из каталога (нативный HTML5 DnD) ----------
  onDragStart(it: CItem, ev: DragEvent): void {
    this.dragging.set(it);
    this.dragKey.set(it.key);
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('text/plain', it.key);
    }
  }

  /** перетащить заготовку из вкладки «Полуфабрикаты» на стол как компонент */
  onDragStartSemi(d: Semi, ev: DragEvent): void {
    this.onDragStart({ key: `semi:${d.id}`, sourceType: 'semi', refId: d.id, name: d.name, unitCode: d.unitCode }, ev);
  }

  onDragEnd(): void {
    this.dragging.set(null);
    this.dragKey.set('');
    this.overTable.set(false);
    this.depth = 0;
  }

  onDragEnter(ev: DragEvent): void {
    ev.preventDefault();
    this.depth++;
    this.overTable.set(true);
  }

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }

  onDragLeave(): void {
    if (--this.depth <= 0) {
      this.depth = 0;
      this.overTable.set(false);
    }
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.depth = 0;
    this.overTable.set(false);
    const key = ev.dataTransfer?.getData('text/plain') ?? '';
    const it = this.dragging() ?? this.all().find((x) => x.key === key) ?? null;
    if (it) {
      // карточка ещё не отрисована — центрируем по курсору на номинальный размер 260×84 в координатах содержимого
      const rect = this.areaRef()?.nativeElement.getBoundingClientRect();
      const c = this.toContent(ev.clientX, ev.clientY);
      const x = rect ? c.x - 130 : undefined;
      const y = rect ? c.y - 42 : undefined;
      this.placeOnTable(it, x, y);
    }
    this.dragging.set(null);
    this.dragKey.set('');
  }

  /** сброс позиции на стол — новым блоком (одну и ту же позицию можно положить несколько раз) */
  private placeOnTable(it: CItem, x?: number, y?: number): void {
    const n = this.plate().length % 8;
    const pos = this.spot(x ?? 16 + n * 30, y ?? 16 + n * 28, 260, 84);
    this.plate.update((list) => [
      ...list,
      {
        uid: this.nextUid++,
        kind: 'ingredient',
        sourceType: it.sourceType,
        refId: it.refId,
        name: it.name,
        title: '',
        x: pos.x,
        y: pos.y,
        qty: '',
        // начальная единица — «Ед. хранения (базовая)» позиции
        unitCode: it.unitCode,
      },
    ]);
    // полуфабрикат на столе показывает мини-схему своего состава — подтянем его стол
    if (it.sourceType === 'semi') this.loadSemiBoard(it.refId);
  }

  // ---------- контекстное меню стола ----------
  /** правая кнопка на пустом месте стола — своё меню */
  onAreaContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const el = this.areaRef()?.nativeElement;
    if (!el) return;
    // координаты курсора в пространстве содержимого — туда и поставим новый блок
    const c = this.toContent(ev.clientX, ev.clientY);
    const pos = this.menuPos(ev, 1);
    this.ctxMenu.set({
      x: pos.x,
      y: pos.y,
      items: [{ label: '➕ Создать полуфабрикат', run: () => this.createNoteAt(c.x, c.y) }],
    });
  }

  closeCtxMenu(): void {
    this.ctxMenu.set(null);
  }

  /** правая кнопка на блоке — меню действий с этим блоком */
  onBlockContextMenu(p: PlateItem, ev: MouseEvent): void {
    ev.preventDefault();
    // не даём обработчику стола подменить меню на «Создать блок»
    ev.stopPropagation();
    const el = ev.currentTarget as HTMLElement;
    const isSemi = p.kind === 'ingredient' && p.sourceType === 'semi';
    const isNote = p.kind === 'note';
    const items: CtxMenuItem[] = [
      // обработка (выход после обработки) теперь живёт на связи: открываем первую входящую нить блока
      { label: '🔥 Выход обработки', run: () => this.processBlock(p) },
    ];
    if (isNote) {
      // «Редактировать» — попап свойств текущей заготовки (сборки)
      items.push(
        { label: '✏️ Редактировать', run: () => this.openPropsForBoard() },
        // сборка со стола становится реальной заготовкой в разделе «Полуфабрикаты»
        { label: '💾 Сохранить в полуфабрикаты', run: () => this.saveAssembly(p) },
      );
    } else if (isSemi) {
      // «Редактировать» — попап свойств этой заготовки из каталога (имя — двойным кликом по нему)
      items.push({ label: '✏️ Редактировать', run: () => this.openPropsForSemi(p.refId) });
    } else {
      items.push({ label: '✏️ Редактировать', run: () => this.editBlock(el) });
    }
    items.push({ label: '🗑 Удалить', danger: true, sep: true, run: () => this.remove(p.uid) });
    const pos = this.menuPos(ev, items.length);
    this.ctxMenu.set({ x: pos.x, y: pos.y, items });
  }

  /** меню у курсора, но не за краем экрана (стол прижат к правому краю — иначе пункты обрезались) */
  private menuPos(ev: MouseEvent, items: number): { x: number; y: number } {
    const W = 220;
    const H = items * 36 + 20;
    return {
      x: clamp(ev.clientX, 6, Math.max(6, window.innerWidth - W - 6)),
      y: clamp(ev.clientY, 6, Math.max(6, window.innerHeight - H - 6)),
    };
  }

  /** обработка — выход после обработки задаётся на связи: открыть первую нить, примыкающую к блоку */
  private processBlock(p: PlateItem): void {
    const ln = this.links().find((l) => l.to === p.uid) ?? this.links().find((l) => l.from === p.uid);
    if (!ln) {
      this.toast.show('Нет связи. Свяжите сырьё с заготовкой, затем кликните по нити — там задаётся выход обработки', 'info', 3200);
      return;
    }
    this.editingLink.set(ln.id);
  }

  /** фокус в первое редактируемое поле блока (количество у ингредиента, название у блока) */
  private editBlock(el: HTMLElement): void {
    const inp = el.querySelector<HTMLInputElement>('input');
    if (!inp) return;
    inp.focus();
    inp.select?.();
  }

  // ---------- редактирование полуфабриката прямо в блоке ----------
  /** двойной клик по имени / пункт меню — открываем редактор имени внутри блока */
  startSemiEdit(p: PlateItem): void {
    if (p.kind !== 'ingredient' || p.sourceType !== 'semi') return;
    this.editing.set({ uid: p.uid, value: p.name });
  }

  editingName(v: string): void {
    const ed = this.editing();
    if (ed) this.editing.set({ ...ed, value: v });
  }

  cancelSemiEdit(ev?: Event): void {
    // Esc внутри input всплывёт к обработчику стола — не надо, закрываемся сами
    ev?.stopPropagation?.();
    this.editing.set(null);
  }

  /**
   * Сохранить новое имя заготовки. Серверный PATCH принимает только запись целиком,
   * поэтому тело собирается из уже загруженного каталога, а меняется лишь name.
   * Имя уходит в общий каталог — блок переименовывается на столе, в левой колонке
   * и на странице «Полуфабрикаты».
   */
  saveSemiName(p: PlateItem): void {
    const ed = this.editing();
    // blur после Enter/Escape: редактор уже закрыт — второй раз не сохраняем
    if (!ed || ed.uid !== p.uid || this.savingName()) return;
    const name = ed.value.trim();
    this.editing.set(null);
    if (!name || name === p.name) return;
    const semi = this.semis().find((s) => s.id === p.refId);
    if (!semi) {
      this.toast.show('Заготовка не найдена в каталоге — обновите страницу', 'warn', 2500);
      return;
    }
    this.savingName.set(true);
    this.api
      .patchSemi(semi.id, {
        name,
        unitId: semi.unitId,
        outQty: semi.outQty,
        note: semi.note,
        shelfLifeDays: semi.shelfLifeDays,
        gPerPcs: semi.gPerPcs,
        mlPerPcs: semi.mlPerPcs,
        gPerMl: semi.gPerMl,
        inputs: semi.inputs,
      })
      .subscribe({
        next: () => {
          this.savingName.set(false);
          // каталог слева и счётчик — за тем же именем
          this.semis.update((list) => list.map((s) => (s.id === semi.id ? { ...s, name } : s)));
          // все блоки этой заготовки на столе (её можно сбросить несколько раз)
          this.plate.update((list) =>
            list.map((x) => (x.kind === 'ingredient' && x.sourceType === 'semi' && x.refId === semi.id ? { ...x, name } : x))
          );
          this.toast.show(`Полуфабрикат переименован в «${name}»`, 'ok', 2000);
        },
        error: (e: unknown) => {
          this.savingName.set(false);
          // возвращаем открытый редактор с введённым именем — можно поправить и повторить
          this.editing.set({ uid: p.uid, value: name });
          this.toast.show(this.errText(e), 'err', 3000);
        },
      });
  }

  /**
   * Сохранить сборку (свободный блок) как настоящую заготовку в каталог «Полуфабрикаты».
   * Абсолютные количества со стола сводятся к входам на партию (buildSemiBody), стол — в board.
   * Неудачу (нет имени/связей, вложенная сборка, неконвертируемая единица) показываем, не сохраняя.
   */
  saveAssembly(p: PlateItem): void {
    if (this.savingSemi()) return;
    const res = buildSemiBody(this.plate(), this.links(), this.ctx(), p.uid);
    if (!res.ok) {
      this.toast.show(res.error, 'warn', 3600);
      return;
    }
    const body = { ...res.body, board: { blocks: this.plate(), links: this.links() } };
    this.savingSemi.set(true);
    this.api.createSemi(body).subscribe({
      next: () => {
        this.savingSemi.set(false);
        this.toast.show(`Полуфабрикат «${body.name}» сохранён — доступен в каталоге слева`, 'ok', 3000);
        // перечитать каталог заготовок: блок появится в списке и сможет входить в другие сборки
        this.api.semis$().subscribe({ next: (s) => this.semis.set(s), error: () => {} });
      },
      error: (e: unknown) => {
        this.savingSemi.set(false);
        this.toast.show(this.errText(e), 'err', 3600);
      },
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.ctxMenu.set(null);
    this.linking.set(null);
    this.linkTarget.set(null);
    this.editingLink.set(null);
    if (this.showProps()) this.closeProps();
  }

  /** свободный текстовый блок на столе в точке правого клика */
  private createNoteAt(x: number, y: number): void {
    const pos = this.spot(x - 110, y - 20, 220, 44);
    this.plate.update((list) => [
      ...list,
      {
        uid: this.nextUid++,
        kind: 'note',
        sourceType: 'raw',
        refId: 0,
        name: '',
        title: '',
        x: pos.x,
        y: pos.y,
        qty: '',
        unitCode: '',
      },
    ]);
  }

  /** прижать точку размещения к внутренности стола */
  private spot(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const el = this.areaRef()?.nativeElement;
    const z = this.zoom() || 1;
    // границы в координатах содержимого: видимая область стола делится на масштаб
    const areaW = (el?.clientWidth ?? 600) / z;
    const areaH = (el?.clientHeight ?? 360) / z;
    return {
      x: clamp(x, PORT_M, Math.max(PORT_M, areaW - w - PORT_M)),
      y: clamp(y, 4, Math.max(4, areaH - h - 4)),
    };
  }

  // ---------- движение блоков мышкой по столу (pointer-events) ----------
  onBlockDown(p: PlateItem, ev: PointerEvent): void {
    // только левая кнопка: правая — контекстное меню, средняя — не трогаем
    if (ev.button !== 0) return;
    // хват не с кнопок и поля ввода, иначе нельзя нажать ✕ и печатать количество
    const t = ev.target as HTMLElement;
    if (t.closest('button') || t.closest('input')) return;
    // двойной клик по имени полуфабриката открывает редактор — блок не должен «прыгнуть»
    if (t.closest('b.semi-name') || this.editing()?.uid === p.uid) return;
    const el = ev.currentTarget as HTMLElement;
    const area = this.areaRef()?.nativeElement;
    if (!area) return;
    const c = this.toContent(ev.clientX, ev.clientY);
    this.moving.set({
      uid: p.uid,
      // смещение захвата в координатах содержимого (учитывает зум/сдвиг)
      offX: c.x - p.x,
      offY: c.y - p.y,
      areaW: area.clientWidth,
      areaH: area.clientHeight,
      blockW: el.offsetWidth,
      blockH: el.offsetHeight,
    });
    el.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  onBlockMove(ev: PointerEvent): void {
    const mv = this.moving();
    if (!mv) return;
    const area = this.areaRef()?.nativeElement;
    if (!area) return;
    const c = this.toContent(ev.clientX, ev.clientY);
    // границы в координатах содержимого: видимая область стола делится на масштаб
    const cw = mv.areaW / (this.zoom() || 1);
    const ch = mv.areaH / (this.zoom() || 1);
    const x = clamp(c.x - mv.offX, PORT_M, Math.max(PORT_M, cw - mv.blockW - PORT_M));
    const y = clamp(c.y - mv.offY, 4, Math.max(4, ch - mv.blockH - 4));
    this.plate.update((list) => list.map((p) => (p.uid === mv.uid ? { ...p, x, y } : p)));
  }

  onBlockUp(ev: PointerEvent): void {
    if (!this.moving()) return;
    (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
    this.moving.set(null);
  }

  // ---------- связи между блоками ----------
  /** ширина блока для расчёта коннекторов (та же, что в CSS) */
  private blockW(p: PlateItem): number {
    return p.kind === 'note' ? W_NOTE : W_ING;
  }

  /** правый коннектор — выход связи: упирается в правый край строки заголовка */
  private outPort(p: PlateItem): { x: number; y: number } {
    return { x: p.x + this.blockW(p), y: p.y + PORT_DY };
  }

  /** левый коннектор — вход связи (есть только у свободных блоков) */
  private inPort(p: PlateItem): { x: number; y: number } {
    return { x: p.x, y: p.y + PORT_DY };
  }

  /** кривая между коннекторами: горизонтальные ручки, растущие с длиной, — нить не «палка» */
  wireD(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  /** нити существующих связей; середина кубической Безье с такими ручками = среднее концов */
  wires = computed<Wire[]>(() => {
    const byUid = new Map(this.plate().map((p) => [p.uid, p]));
    const out: Wire[] = [];
    for (const l of this.links()) {
      const a = byUid.get(l.from);
      const b = byUid.get(l.to);
      if (!a || !b) continue;
      const p1 = this.outPort(a);
      const p2 = this.inPort(b);
      out.push({
        id: l.id,
        d: this.wireD(p1.x, p1.y, p2.x, p2.y),
        mx: (p1.x + p2.x) / 2,
        my: (p1.y + p2.y) / 2,
        yieldText: this.yieldText(l),
      });
    }
    return out;
  });

  /** старт от правого коннектора: нить тянется от него к левому коннектору другого блока */
  onPortDown(p: PlateItem, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    // хват с коннектора не должен начинать перетаскивание самого блока
    ev.stopPropagation();
    const a = this.outPort(p);
    this.linking.set({ from: p.uid, x1: a.x, y1: a.y, x2: a.x, y2: a.y });
    this.linkTarget.set(null);
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  onPortMove(ev: PointerEvent): void {
    const lk = this.linking();
    if (!lk) return;
    const area = this.areaRef()?.nativeElement;
    if (!area) return;
    const c = this.toContent(ev.clientX, ev.clientY);
    const target = this.inPortOwner(ev.clientX, ev.clientY);
    this.linkTarget.set(target);
    // над подходящим блоком конец нити «прилипает» к его входу — сразу видно, куда замкнётся
    const to = target == null ? null : this.plate().find((p) => p.uid === target);
    const snap = to ? this.inPort(to) : null;
    this.linking.set({
      ...lk,
      x2: snap ? snap.x : c.x,
      y2: snap ? snap.y : c.y,
    });
  }

  onPortUp(ev: PointerEvent): void {
    const lk = this.linking();
    if (!lk) return;
    const to = this.linkTarget();
    this.cancelLink(ev);
    if (to != null) this.addLink(lk.from, to);
  }

  cancelLink(ev: PointerEvent): void {
    (ev.currentTarget as HTMLElement)?.releasePointerCapture?.(ev.pointerId);
    this.linking.set(null);
    this.linkTarget.set(null);
  }

  /** блок под курсором, который может принять связь: только свободный блок, не источник */
  private inPortOwner(clientX: number, clientY: number): number | null {
    const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const el = hit?.closest<HTMLElement>('[data-uid]');
    if (!el) return null;
    const uid = Number(el.dataset.uid);
    const p = this.plate().find((x) => x.uid === uid);
    return p && p.kind === 'note' && p.uid !== this.linking()?.from ? p.uid : null;
  }

  /**
   * Привязать выход одного блока к входу другого.
   * Нитей в один блок заводят сколько угодно — это и есть смысл: сырьё сходится в блок блюда.
   */
  addLink(from: number, to: number): void {
    if (from === to) return;
    if (this.links().some((l) => l.from === from && l.to === to)) return;
    // цикл получится, если «to» уже ведёт по существующим связям обратно в «from»
    if (this.reaches(to, from)) {
      this.toast.show('Такая связь замкнёт цепочку в кольцо', 'warn', 2200);
      return;
    }
    const id = this.nextLinkId++;
    this.links.update((list) => [...list, { id, from, to, yieldPct: '' }]);
    // только что связали — сразу просим задать выход после обработки
    this.editingLink.set(id);
  }

  /** есть ли путь по связям из a в b (поиск в глубину по выходам) */
  private reaches(a: number, b: number): boolean {
    const stack = [a];
    const seen = new Set<number>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === b) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const l of this.links()) if (l.from === cur) stack.push(l.to);
    }
    return false;
  }

  removeLink(id: number, ev?: Event): void {
    ev?.stopPropagation?.();
    this.links.update((list) => list.filter((l) => l.id !== id));
    if (this.editingLink() === id) this.editingLink.set(null);
  }

  // ---------- правка связи: выход после обработки ----------
  /** кликнули по нити — открыть карточку с процентом обработки */
  openLinkEditor(id: number): void {
    this.editingLink.set(id);
  }

  closeLinkEditor(): void {
    this.editingLink.set(null);
  }

  patchLinkYield(id: number, v: string | number): void {
    const s = (v ?? '').toString().trim();
    this.links.update((list) => list.map((l) => (l.id === id ? { ...l, yieldPct: s } : l)));
  }

  /** карточка правки: связь + её нить (позиция); null, если связь уже удалена */
  linkEditor = computed<{ l: Link; w: Wire } | null>(() => {
    const id = this.editingLink();
    if (id == null) return null;
    const l = this.links().find((x) => x.id === id);
    const w = this.wires().find((x) => x.id === id);
    return l && w ? { l, w } : null;
  });

  linkYield(id: number): string {
    return this.links().find((l) => l.id === id)?.yieldPct ?? '';
  }

  /** человекочитаемое имя блока для заголовка «откуда → куда» */
  blockName(uid: number): string {
    const p = this.plate().find((x) => x.uid === uid);
    if (!p) return '—';
    return p.kind === 'note' ? p.title.trim() || 'Полуфабрикат' : p.name;
  }

  /** подпись выхода на нити: пусто = без потерь (100 %) */
  private yieldText(l: Link): string {
    const n = Number(l.yieldPct?.trim());
    return Number.isFinite(n) && n > 0 ? `${n} %` : '100 %';
  }

  /** прижать карточку правки к внутренности стола (экранные координаты), чтобы не обрезалась о край */
  editorX(w: Wire): number {
    const el = this.areaRef()?.nativeElement;
    const aW = el?.clientWidth ?? 600;
    const p = this.pan();
    const z = this.zoom() || 1;
    return clamp(w.mx * z + p.x - LE_W / 2, 8, Math.max(8, aW - LE_W - 8));
  }

  editorY(w: Wire): number {
    const el = this.areaRef()?.nativeElement;
    const aH = el?.clientHeight ?? 360;
    const p = this.pan();
    const z = this.zoom() || 1;
    return clamp(w.my * z + p.y + 14, 8, Math.max(8, aH - LE_H - 8));
  }

  // ---------- редактирование блока ----------
  remove(uid: number): void {
    this.plate.update((list) => list.filter((p) => p.uid !== uid));
    // связи удалённого блока повисли бы в пустоту — убираем их вместе с блоком
    this.links.update((list) => list.filter((l) => l.from !== uid && l.to !== uid));
  }

  clearPlate(): void {
    this.plate.set([]);
    this.links.set([]);
    this.linking.set(null);
    this.linkTarget.set(null);
    this.editingLink.set(null);
  }
}
