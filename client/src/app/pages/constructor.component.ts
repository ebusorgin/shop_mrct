import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { ToastService } from '../core/toast.service';
import { Product, Semi, Unit } from '../core/models';
import { fmtCost, fmtMoney, fmtQty } from '../core/format';
import { Assembly, BlockCost, buildSemiBody, resolveConstructor } from '../core/constructor-calc';

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

/** Ограничить значение диапазоном [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* Ширина карточек и вертикаль коннекторов — те же числа, что в CSS (.pi / .pi.note).
   Якоря связи считаются аналитически, без замера DOM: коннектор живёт на строке заголовка. */
const W_ING = 232;
const W_NOTE = 200;
const PORT_DY = 20;
/* коннектор выступает за край блока на 6px, а стол режет всё снаружи — блоки не подводим вплотную */
const PORT_M = 8;
/* размер карточки правки связи — для прижатия к краям стола (чтобы не обрезалась о край) */
const LE_W = 236;
const LE_H = 190;

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
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <h1 class="page-title">🍲 Конструктор блюд</h1>
      <span class="badge blue">{{ rawCount() }} сырья</span>
      <span class="badge amber">{{ semiCount() }} полуфабрикатов</span>
      <div class="spacer"></div>
      <span class="hint muted">Перетащите ингредиент на стол · связь — тянуть от правого коннектора к левому · клик по связи — выход после обработки (%)</span>
    </div>

    @if (listErr()) { <div class="err">{{ listErr() }} <button class="btn sm" (click)="reload()">Повторить</button></div> }

    <div class="cols">
      <!-- ============ ЛЕВО: каталог сырья и полуфабрикатов ============ -->
      <div class="panel cat">
        <div class="search">
          <input
            [ngModel]="query()"
            (ngModelChange)="query.set($event)"
            placeholder="Поиск: название продукта или заготовки…"
            aria-label="Поиск по ингредиентам"
          />
          @if (query()) { <button type="button" class="clr" title="Очистить" (click)="query.set('')">✕</button> }
        </div>

        <div class="chips">
          <button type="button" class="chip" [class.on]="fType() === 'all'" (click)="fType.set('all')">Все</button>
          <button type="button" class="chip" [class.on]="fType() === 'raw'" (click)="fType.set('raw')">🟦 Сырьё</button>
          <button type="button" class="chip" [class.on]="fType() === 'semi'" (click)="fType.set('semi')">🟨 Полуфабр.</button>
          <span class="spacer"></span>
          <span class="found">Найдено: <b>{{ filtered().length }}</b></span>
        </div>

        @if (loading()) {
          <div class="sk">@for (i of [1, 2, 3, 4, 5, 6]; track i) { <div class="sk-row">Загрузка…</div> }</div>
        } @else {
          <div class="list">
            @for (it of filtered(); track it.key) {
              <div
                class="ci"
                draggable="true"
                [class.dragging]="dragKey() === it.key"
                (dragstart)="onDragStart(it, $event)"
                (dragend)="onDragEnd()"
                title="Перетащите на стол"
              >
                <span class="grip" aria-hidden="true">⠿</span>
                <span class="ci-mark" [title]="it.sourceType === 'raw' ? 'сырьё' : 'полуфабрикат'">
                  {{ it.sourceType === 'raw' ? '🟦' : '🟨' }}
                </span>
                <span class="ci-name">{{ it.name }}</span>
                <span class="ci-unit">{{ it.unitCode }}</span>
              </div>
            } @empty {
              <p class="muted">Ничего не найдено — измените поиск или фильтр типа.</p>
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
          @if (plate().length) { <button type="button" class="btn sm danger" (click)="clearPlate()">Очистить</button> }
        </div>

        <div
          class="plate-area"
          #area
          [class.over]="overTable()"
          [class.linking]="!!linking()"
          (dragenter)="onDragEnter($event)"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave()"
          (drop)="onDrop($event)"
          (contextmenu)="onAreaContextMenu($event)"
        >
          @if (plate().length === 0) {
            <div class="empty-drop">
              <div class="ed-icon">🍽</div>
              <div>Перетащите сюда сырьё или полуфабрикат из левой колонки.</div>
              <div class="muted small">Правой кнопкой на пустом месте стола можно создать полуфабрикат.</div>
            </div>
          }

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

    .chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
    .chip {
      border: 1px solid var(--border); background: #fff; color: var(--text); border-radius: 999px;
      font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; cursor: pointer;
    }
    .chip:hover { background: #f2f5fa; }
    .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .found { font-size: 12px; color: var(--muted); }

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
    }
    .plate-area.over { border-color: var(--accent); background: var(--accent-soft); }

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
      position: absolute; pointer-events: auto; width: 232px; max-width: calc(100% - 16px);
      display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 10px;
      border: 1px solid var(--border); border-radius: 10px; background: #fff; box-shadow: var(--shadow);
      cursor: grab; user-select: none; touch-action: none;
    }
    .pi:active { cursor: grabbing; }
    .pi.moving { cursor: grabbing; border-color: var(--accent); box-shadow: 0 8px 22px rgba(20, 30, 55, .22); z-index: 30; }
    .pi input { cursor: text; touch-action: auto; user-select: text; }
    .pi-top { display: flex; align-items: center; gap: 6px; }
    .pi-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
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
    .pi.note { width: 200px; }
    .note-in {
      flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; font: inherit;
      font-size: 13px; font-weight: 600; box-shadow: none;
    }
    .note-in:focus { outline: none; box-shadow: none; }

    /* себестоимость блока-ингредиента — прямо под количеством */
    .pi-cost { font-size: 12px; font-weight: 700; color: var(--green); font-variant-numeric: tabular-nums; }

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
  fType = signal<'all' | SourceKind>('all');

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

  /** глубина dragenter/dragleave — чтобы подсветка стола не мигала при проходе над дочерними элементами */
  private depth = 0;
  private nextUid = 1;
  private nextLinkId = 1;

  ngOnInit(): void {
    this.reload();
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
      next: (s) => { this.semis.set(s); finish(); },
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

  filtered = computed<CItem[]>(() => {
    const t = this.fType();
    const q = this.query().trim().toLowerCase();
    return this.all().filter((it) => {
      if (t !== 'all' && it.sourceType !== t) return false;
      if (q && !it.name.toLowerCase().includes(q)) return false;
      return true;
    });
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
      // карточка ещё не отрисована — центрируем по курсору на номинальный размер 232×84
      const rect = this.areaRef()?.nativeElement.getBoundingClientRect();
      const x = rect ? ev.clientX - rect.left - 116 : undefined;
      const y = rect ? ev.clientY - rect.top - 42 : undefined;
      this.placeOnTable(it, x, y);
    }
    this.dragging.set(null);
    this.dragKey.set('');
  }

  /** сброс позиции на стол — новым блоком (одну и ту же позицию можно положить несколько раз) */
  private placeOnTable(it: CItem, x?: number, y?: number): void {
    const n = this.plate().length % 8;
    const pos = this.spot(x ?? 16 + n * 30, y ?? 16 + n * 28, 232, 84);
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
  }

  // ---------- контекстное меню стола ----------
  /** правая кнопка на пустом месте стола — своё меню */
  onAreaContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    const el = this.areaRef()?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // координаты курсора внутри стола — туда и поставим новый блок
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const pos = this.menuPos(ev, 1);
    this.ctxMenu.set({
      x: pos.x,
      y: pos.y,
      items: [{ label: '➕ Создать полуфабрикат', run: () => this.createNoteAt(px, py) }],
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
      items.push(
        { label: '✏️ Редактировать', run: () => this.editBlock(el) },
        // сборка со стола становится реальной заготовкой в разделе «Полуфабрикаты»
        { label: '💾 Сохранить в полуфабрикаты', run: () => this.saveAssembly(p) },
      );
    } else {
      // у полуфабриката «Редактировать» — переименование прямо в блоке (сохраняется в каталог)
      items.push({ label: isSemi ? '✏️ Переименовать' : '✏️ Редактировать', run: () => (isSemi ? this.startSemiEdit(p) : this.editBlock(el)) });
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
   * Абсолютные количества со стола пересчитываются в нормы относительно выхода (buildSemiBody).
   * Неудачу (нет имени/связей, вложенная сборка, неконвертируемая единица) показываем, не сохраняя.
   */
  saveAssembly(p: PlateItem): void {
    if (this.savingSemi()) return;
    const res = buildSemiBody(this.plate(), this.links(), this.ctx(), p.uid);
    if (!res.ok) {
      this.toast.show(res.error, 'warn', 3600);
      return;
    }
    const body = res.body;
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
  }

  /** свободный текстовый блок на столе в точке правого клика */
  private createNoteAt(x: number, y: number): void {
    const pos = this.spot(x - 100, y - 20, 200, 44);
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
    const areaW = el?.clientWidth ?? 600;
    const areaH = el?.clientHeight ?? 360;
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
    const aRect = area.getBoundingClientRect();
    this.moving.set({
      uid: p.uid,
      offX: ev.clientX - (aRect.left + p.x),
      offY: ev.clientY - (aRect.top + p.y),
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
    const aRect = area.getBoundingClientRect();
    // не подводим блок вплотную к краю стола: иначе коннекторы вылезут за обрезку
    const x = clamp(ev.clientX - aRect.left - mv.offX, PORT_M, Math.max(PORT_M, mv.areaW - mv.blockW - PORT_M));
    const y = clamp(ev.clientY - aRect.top - mv.offY, 4, Math.max(4, mv.areaH - mv.blockH - 4));
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
    const aRect = area.getBoundingClientRect();
    const target = this.inPortOwner(ev.clientX, ev.clientY);
    this.linkTarget.set(target);
    // над подходящим блоком конец нити «прилипает» к его входу — сразу видно, куда замкнётся
    const to = target == null ? null : this.plate().find((p) => p.uid === target);
    const snap = to ? this.inPort(to) : null;
    this.linking.set({
      ...lk,
      x2: snap ? snap.x : clamp(ev.clientX - aRect.left, 0, area.clientWidth),
      y2: snap ? snap.y : clamp(ev.clientY - aRect.top, 0, area.clientHeight),
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

  /** прижать карточку правки к внутренности стола, чтобы не обрезалась о край */
  editorX(w: Wire): number {
    const aW = this.areaRef()?.nativeElement.clientWidth ?? 600;
    return clamp(w.mx - LE_W / 2, 8, Math.max(8, aW - LE_W - 8));
  }

  editorY(w: Wire): number {
    const aH = this.areaRef()?.nativeElement.clientHeight ?? 360;
    return clamp(w.my + 14, 8, Math.max(8, aH - LE_H - 8));
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
