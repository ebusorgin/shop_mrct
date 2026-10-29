import { ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Product, Semi, TechCard, Unit } from '../core/models';
import { Conv } from '../core/units';
import {
  CONV_FIELD_HINT,
  CONV_FIELD_LABEL,
  ConvField,
  ExpWarn,
  Issue,
  RawLine,
  SemiCtx,
  SemiDraft,
  SourceKind,
  SortMode,
  SORT_LABELS,
  batchPresets,
  convValueOf,
  dedupeWarnings,
  edgesOfDraft,
  expandComposition,
  Expansion,
  fixableWarn,
  fmtBase,
  incompleteOf,
  outDenom,
  pickableAsInput,
  productConvBody,
  refInfo,
  semiAdditives,
  semiBase,
  semiBodyOf,
  semiMatches,
  sortSemis,
  toInputQty,
  trimNum,
  unitCodeOf,
  usedBySemis,
  validateDraft,
  warnKey,
  warnText,
  ExpNode,
} from '../core/semi-calc';
import { PickOption, PickerComponent } from '../shared/picker.component';
import { httpErr, trim } from '../core/format';

/** Строка дерева потребности (узел + открыты ли его дети). */
interface CalcRow {
  node: ExpNode;
  hasKids: boolean;
  open: boolean;
}

/**
 * Быстрая правка коэффициента прямо из предупреждения расчёта: кликнул «Молоко:
 * нельзя перевести «г» в «мл»» → здесь же поле «грамм в 1 мл (плотность)», значение
 * уходит в запись номенклатуры (PATCH), состав заготовки не трогается.
 */
interface ConvFix {
  key: string;
  sourceType: SourceKind;
  refId: number;
  name: string;
  field: ConvField;
  /** Вводимое число как текст: пустое поле должно означать «не задано», а не 0. */
  value: string;
  current: number | null;
  saving: boolean;
  err: string;
  /** Ждём ответ GPT (кнопка «Спросить у ИИ») — запрос может идти десятки секунд через Tor. */
  asking: boolean;
  /** Что ответил ИИ — показываем под полем, включая случай «вразумительного ответа нет». */
  ai: string;
  /** Число, которое подставил ИИ, и модель: нужны, чтобы отличить подсказку от ручной правки. */
  aiValue: number | null;
  aiModel: string | null;
}

/** Самооценка модели — по-человечески, в подписи под полем. */
const AI_CONFIDENCE: Record<string, string> = { high: 'высокая', medium: 'средняя', low: 'низкая' };

@Component({
  selector: 'app-semis',
  standalone: true,
  imports: [CommonModule, FormsModule, PickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <h1 class="page-title">🔪 Полуфабрикаты</h1>
      <span class="badge blue">{{ semis().length }} заготовок</span>
      <div class="spacer"></div>
      <button class="btn" (click)="duplicate()" [disabled]="!draft()">⧉ Дублировать</button>
      <button class="btn primary" (click)="newSemi()">+ Новая заготовка</button>
    </div>

    @if (listErr()) { <div class="err">{{ listErr() }} <button class="btn sm" (click)="reload()">Повторить</button></div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid2 cols">
      <!-- ================= КАТАЛОГ ================= -->
      <div class="panel cat" #listEl>
        <div class="search">
          <input
            [ngModel]="query()"
            (ngModelChange)="onQuery($event)"
            placeholder="Поиск: название заготовки или входящий продукт…"
            aria-label="Поиск по полуфабрикатам"
          />
          @if (query()) { <button type="button" class="clr" title="Очистить" (click)="onQuery('')">✕</button> }
        </div>

        <div class="filters">
          <div class="chipset">
            <span class="clbl">Тип</span>
            <button type="button" class="chip" [class.on]="fType() === 'all'" (click)="fType.set('all'); page.set(1)">Все</button>
            <button type="button" class="chip" [class.on]="fType() === 'raw'" (click)="fType.set('raw'); page.set(1)">Из сырья</button>
            <button type="button" class="chip" [class.on]="fType() === 'semi'" (click)="fType.set('semi'); page.set(1)">Из полуфабриката</button>
          </div>
          <div class="chipset">
            <span class="clbl">Состав</span>
            <button type="button" class="chip" [class.on]="fAdds() === 'with'" (click)="fAdds.set('with'); page.set(1)">С добавками</button>
            <button type="button" class="chip" [class.on]="fAdds() === 'none'" (click)="fAdds.set('none'); page.set(1)">Только ядро</button>
            <button type="button" class="chip warn" [class.on]="fBad()" (click)="toggleBad()">⚠ Неполные</button>
          </div>
          <div class="chipset">
            <span class="clbl">Сортировка</span>
            <select class="sort" [ngModel]="sortMode()" (ngModelChange)="onSort($event)">
              @for (m of sortModes(); track m) { <option [ngValue]="m">{{ sortLabel(m) }}</option> }
            </select>
            @if (hasFilters()) { <button type="button" class="chip reset" (click)="resetFilters()">Сбросить</button> }
          </div>
        </div>

        <div class="found">
          Найдено: <b>{{ filtered().length }}</b>
          @if (filtered().length !== semis().length) { <span class="muted"> из {{ semis().length }}</span> }
        </div>

        @if (loading()) {
          <div class="sk">@for (i of skRows(); track i) { <div class="sk-row">Загрузка…</div> }</div>
        } @else {
          <div class="list-pick">
            @for (s of pageItems(); track s.id) {
              <button type="button" class="rc" [class.on]="draft()?.id === s.id" (click)="editSemi(s)">
                <div class="rc-1">
                  <b>{{ s.name }}</b>
                  <span class="badge" [class.blue]="semiBase(s)?.sourceType === 'raw'" [class.amber]="semiBase(s)?.sourceType === 'semi'">
                    {{ semiBase(s)?.sourceType === 'semi' ? '🟨 из полуфабриката' : '🟦 из сырья' }}
                  </span>
                </div>
                <div class="rc-2">
                  <span>ядро: {{ semiBase(s)?.name ?? '— не выбрано —' }}</span>
                  <span>· выход {{ yieldText(s) }}</span>
                  <span>· добавок: {{ semiAdditives(s).length }}</span>
                  <span>· ед. выхода: {{ s.unitCode }}</span>
                </div>
                @if (rowWarn(s)) { <div class="rc-w">⚠ {{ rowWarn(s) }}</div> }
              </button>
            } @empty {
              @if (semis().length === 0) {
                <p class="muted">Пока нет ни одной заготовки. Нажмите «+ Новая заготовка».</p>
              } @else {
                <p class="muted">Ничего не найдено. Измените поиск или <button type="button" class="lnk" (click)="resetFilters()">сбросьте фильтры</button>.</p>
              }
            }
          </div>

          @if (filtered().length > perPage()) {
            <div class="pager">
              <label class="ps">На странице
                <select [ngModel]="perPage()" (ngModelChange)="setPerPage($event)">
                  @for (n of perPageOptions(); track n) { <option [ngValue]="n">{{ n }}</option> }
                </select>
              </label>
              <span class="range">{{ range() }}</span>
              <div class="spacer"></div>
              <button type="button" class="btn sm" [disabled]="page() === 1" (click)="goPage(1)">«</button>
              @for (p of pageWindow(); track $index) {
                @if (p === -1) { <span class="gap">…</span> } @else {
                  <button type="button" class="btn sm pg" [class.on]="p === page()" (click)="goPage(p)">{{ p }}</button>
                }
              }
              <button type="button" class="btn sm" [disabled]="page() >= pageCount()" (click)="goPage(pageCount())">»</button>
            </div>
          }
        }
      </div>

      <!-- ================= РЕДАКТОР ================= -->
      @if (draft(); as d) {
        <div class="panel ed" #editorEl>
          <div class="ed-head">
            <h3>{{ d.id ? 'Редактирование' : 'Новая' }} заготовки</h3>
            @if (dirty()) { <span class="badge amber">● несохранено</span> }
            <div class="spacer"></div>
            @if (issues().length) { <span class="badge red">ошибок: {{ issues().length }}</span> }
          </div>
          @if (err()) { <div class="err">{{ err() }}</div> }

          <!-- БЛОК A. Основная информация -->
          <div class="blk">
            <div class="blk-t">A · Основная информация</div>
            <div class="row">
              <label class="f" style="flex:2">Название
                <input [ngModel]="d.name" (ngModelChange)="patchDraft('name', $event)" placeholder="Картофель варёный" />
                @if (issue('name')) { <span class="f-err">{{ issue('name') }}</span> }
              </label>
              <label class="f">Ед. выхода
                <select [ngModel]="d.unitId" (ngModelChange)="patchDraft('unitId', $event)">
                  @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
                </select>
                @if (issue('unitId')) { <span class="f-err">{{ issue('unitId') }}</span> }
              </label>
              <label class="f" style="flex:1">Описание
                <input [ngModel]="d.note" (ngModelChange)="patchDraft('note', $event)" placeholder="почистили и сварили" />
              </label>
            </div>
            <details class="adv">
              <summary>Доп. параметры (срок годности, пересчёт размерностей)</summary>
              <div class="adv-body">
                <div class="row">
                  <label class="f">Срок годности, дней
                    <input type="number" min="0" step="1" [ngModel]="d.shelfLifeDays" (ngModelChange)="patchDraft('shelfLifeDays', num($event))" placeholder="напр. 3" />
                  </label>
                </div>
                <div class="row" style="margin-top:8px;align-items:flex-end">
                  <div class="muted" style="flex-basis:100%;font-size:12px">
                    Пересчёт размерностей выхода — задайте только нужные связи; пусто = связь не задавать.
                    Позволяет техкарте ссылаться на заготовку в г/мл, даже если её выход — в шт.
                  </div>
                  <label class="f">грамм в 1 шт
                    <input type="number" min="0" [ngModel]="d.gPerPcs" (ngModelChange)="patchDraft('gPerPcs', num($event))" placeholder="напр. 53" /></label>
                  <label class="f">мл в 1 шт
                    <input type="number" min="0" [ngModel]="d.mlPerPcs" (ngModelChange)="patchDraft('mlPerPcs', num($event))" placeholder="—" /></label>
                  <label class="f">грамм в 1 мл (плотность)
                    <input type="number" min="0" step="any" [ngModel]="d.gPerMl" (ngModelChange)="patchDraft('gPerMl', num($event))" placeholder="—" /></label>
                </div>
              </div>
            </details>
          </div>

          <!-- БЛОК B. Основной продукт и обработка -->
          <div class="blk core">
            <div class="blk-t">B · Основной продукт и обработка
              <span class="blk-note">ровно один вход, он задаёт выход заготовки</span></div>
            <div class="core-grid">
              <label class="f">Тип входа
                <select [ngModel]="d.base.sourceType" (ngModelChange)="setBaseType($event)">
                  <option value="raw">🟦 Сырьё</option>
                  <option value="semi">🟨 Полуфабрикат</option>
                </select>
              </label>
              <label class="f">Продукт
                <app-picker
                  [options]="baseSource() === 'raw' ? productOptions() : semiOptions()"
                  [selectedId]="d.base.refId"
                  (picked)="pickBase($event)"
                />
                @if (issue('base')) { <span class="f-err">{{ issue('base') }}</span> }
              </label>
              <label class="f">Ед. входа
                <span class="ro">{{ baseUnit() || '—' }}</span>
              </label>
              <label class="f">Выход после обработки, %
                <input type="number" min="1" max="100" step="any" [ngModel]="d.base.yieldPct" (ngModelChange)="patchBase({ yieldPct: num($event) })" />
                @if (issue('baseYield')) { <span class="f-err">{{ issue('baseYield') }}</span> }
              </label>
            </div>
            <div class="chain">
              <span class="ci">вход (весь)</span>
              <b>{{ chainIn() }}</b>
              <span class="ar">→</span>
              <span class="ci">выход после обработки</span>
              <b>{{ trim(num(d.base.yieldPct) ?? 0) }}%</b>
              <span class="ar">→</span>
              <span class="ci">выход на партию</span>
              <b>{{ chainOut() }}</b>
            </div>
            <div class="muted tip">
              Количество входа считается автоматически: нужно {{ wantHint() }}. Выход — технологический коэффициент,
              а не сумма входящих: при варке и жарке масса меняется.
            </div>
            @if (outIsPcs() && yieldIsLoss()) {
              <div class="mini" [class.warn]="!selfGPerPcs()">
                Выход — в штуках, поэтому {{ trim(num(d.base.yieldPct) ?? 0) }} % это потери <b>массы</b>, а не штук:
                штуки выхода переводятся в граммы по «грамм в 1 шт» самой заготовки (блок A → «Доп. параметры»),
                там делятся на выход после обработки и возвращаются в штуки входа.
                @if (!selfGPerPcs()) { <b>Сейчас «грамм в 1 шт» не задан — расход считается по-старому: делятся штуки, число неверно.</b> }
              </div>
            }
          </div>

          <!-- БЛОК C. Дополнительные ингредиенты -->
          <div class="blk">
            <div class="blk-t">C · Дополнительные ингредиенты
              <span class="blk-note">сколько угодно, необязательны · норма на {{ outDenom() }} выхода</span></div>

            <div class="tb-head">
              <div>Тип</div>
              <div>Компонент</div>
              <div class="num">Норма на {{ outDenom() }}</div>
              <div class="num">Свой выход, %</div>
              <div class="num">Расход на партию</div>
              <div class="del"></div>
            </div>
            @for (a of d.additives; track $index) {
              <div class="tb-row">
                <select class="t-sel" [ngModel]="a.sourceType" (ngModelChange)="patchAdditive($index, { sourceType: $event, refId: null })">
                  <option value="raw">🟦 Сырьё</option>
                  <option value="semi">🟨 Полуфабр.</option>
                </select>
                <div class="t-pick">
                  <app-picker
                    [options]="a.sourceType === 'raw' ? productOptions() : semiOptions()"
                    [selectedId]="a.refId"
                    (picked)="pickAdditive($index, $event)"
                  />
                  @if (issue('add' + $index + ':ref') || issue('add' + $index + ':dup')) {
                    <span class="f-err">{{ issue('add' + $index + ':ref') || issue('add' + $index + ':dup') }}</span>
                  }
                </div>
                <input class="t-num" type="number" min="0" step="any" [ngModel]="a.qtyPerOutput"
                       (ngModelChange)="patchAdditive($index, { qtyPerOutput: num($event) })" placeholder="кол-во" />
                <input class="t-num" type="number" min="1" max="100" step="any" [ngModel]="a.yieldPct"
                       (ngModelChange)="patchAdditive($index, { yieldPct: num($event) })" placeholder="100"
                       title="Свой выход добавки после обработки, %. Пусто = без потерь (100%)" />
                <div class="t-part">{{ addPerBatch(a) }}</div>
                <div class="t-del"><button type="button" class="btn sm danger" (click)="removeAdditive($index)">✕</button></div>
              </div>
              @if (issue('add' + $index + ':qty') || issue('add' + $index + ':yield')) {
                <div class="tb-err">{{ issue('add' + $index + ':qty') || issue('add' + $index + ':yield') }}</div>
              }
            } @empty {
              <div class="tb-empty">Добавок нет — заготовка состоит только из основного продукта.</div>
            }
            <div class="tb-add"><button type="button" class="btn sm" (click)="addAdditive()">+ Добавить ингредиент</button></div>
          </div>

          <!-- БЛОК D. База расчёта норм -->
          <div class="blk basis">
            <div class="blk-t">D · База расчёта норм <span class="blk-note">как переводятся числа в полях в расход</span></div>
            <div class="basis-grid">
              <div class="bi">
                <span class="bt">Основной продукт</span>
                <span>норма задаётся <b>на весь выход</b> партии: вход = выход ÷ выход после обработки. Складского количества входа
                  здесь нет — весь выход заготовки идёт из него.</span>
              </div>
              <div class="bi">
                <span class="bt">Добавки</span>
                <span>норма задаётся <b>на {{ outDenom() }} готовой заготовки</b> (по размерности единицы выхода),
                  расход = выход × норма ÷ 1000 ÷ свой выход.</span>
              </div>
              <div class="bi">
                <span class="bt">Размерности</span>
                <span>г / мл / шт переводятся только по коэффициентам заготовки и продукта
                  (г в 1 шт, мл в 1 шт, г в 1 мл). 1 мл ≠ 1 г автоматически — без коэффициента будет предупреждение.</span>
              </div>
              <div class="bi">
                <span class="bt">Выход после обработки и штуки</span>
                <span>выход после обработки — отношение <b>масс</b>: при варке и чистке уходит грамм, а не «штуки». Поэтому если выход
                  заготовки в шт, потери считаются через «грамм в 1 шт» самой заготовки: без него деление выходом
                  превращает 1 яйцо в 1.111 яйца — расчёт помечается предупреждением.</span>
              </div>
            </div>
          </div>

          <!-- БЛОК E. Расчёт производства -->
          <div class="blk calc">
            <div class="blk-t">E · Расчёт производства
              <span class="blk-note">предварительный: склад и себестоимость не трогаем</span></div>
            <div class="row calc-in">
              <label class="f">Хотим получить
                <input style="width:140px" type="number" min="0" step="any" [ngModel]="want()" (ngModelChange)="want.set(num($event) ?? 0)" />
              </label>
              <span class="ro">{{ unitCodeOf(d.unitId) }}</span>
              <div class="spacer"></div>
              @for (p of presets(); track p.label) {
                <button type="button" class="btn sm" [class.on]="want() === p.qty" (click)="want.set(p.qty)">{{ p.label }}</button>
              }
            </div>
            @if (d.base.refId == null || !(want() > 0)) {
              <p class="muted small">Выберите основной продукт и укажите объём партии, чтобы увидеть расход.</p>
            } @else {
              <div class="calc-sum">
                <div><span class="l">Выход заготовки</span><b>{{ fmt(want(), unitCodeOf(d.unitId)) }}</b></div>
                <div><span class="l">Нужно основного продукта</span><b>{{ fmt(baseNeed(), baseUnit()) }}</b></div>
                <div><span class="l">Позиций сырья</span><b>{{ calc().raw.length }}</b></div>
              </div>

              <div class="sub-t">Дерево состава{{ expanded().size ? ' (с раскрытием)' : '' }}</div>
              <div class="tree">
                @for (r of calcRows(); track r.node.key) {
                  <div class="tr" [style.paddingLeft.px]="4 + r.node.depth * 18">
                    @if (r.hasKids) {
                    <button type="button" class="tw" (click)="toggleNode(r.node.key)">{{ r.open ? '▾' : '▸' }} {{ r.node.children.length }}</button>
                    } @else { <span class="tw-sp"></span> }
                    <span class="k" [class.base]="r.node.role === 'base'" [class.semi]="r.node.sourceType === 'semi'">
                      {{ r.node.role === 'base' ? 'ядро' : 'добавка' }}{{ r.node.sourceType === 'semi' ? ' · полуфабрикат' : '' }}
                    </span>
                    <span class="n">{{ r.node.name }}</span>
                    <span class="b">{{ r.node.basis }}</span>
                    <span class="q">{{ fmt(r.node.qty, r.node.unitCode) }}</span>
                    @if (nodeFix(r.node); as fx) {
                      <button type="button" class="w fixw" [class.open]="!!cfOf(fx)" (click)="openFix(fx)"
                              title="Не хватает коэффициента — кликните, чтобы задать его у этой записи">
                        ⚠ {{ r.node.warns[0] }} · 🛠 исправить
                      </button>
                    } @else if (r.node.warns.length) {
                      <span class="w">⚠ {{ r.node.warns[0] }}</span>
                    }
                  </div>
                }
              </div>

              <div class="sub-t">Итоговая потребность в сырье (сквозь все уровни)</div>
              <table class="tbl stack">
                <tr class="th-row"><th>Сырьё</th><th>Откуда расход</th><th class="num">Количество</th></tr>
                @for (r of calc().raw; track r.productId) {
                  <tr>
                    <td data-l="Сырьё">{{ r.name }}</td>
                    <td data-l="Откуда" class="muted">{{ r.via.length ? 'через ' + r.via.join(', ') : 'напрямую' }}</td>
                    <td class="num" data-l="Нужно">{{ fmt(r.qty, r.unitCode) }}</td>
                  </tr>
                } @empty {
                  <tr><td class="empty" colspan="3">Сырьё не собирается — проверьте состав</td></tr>
                }
              </table>

              @if (sumHint(); as h) { <div class="mini" [class.warn]="h.warn">{{ h.text }}</div> }
              @if (calcWarnings().length) {
                <div class="warns">
                  @for (w of calcWarnings(); track warnKey(w)) {
                    <div class="warn-cell">
                      @if (fixableWarn(w)) {
                        <button type="button" class="warn-row fix" [class.open]="!!cfOf(w)" (click)="openFix(w)"
                                title="Кликните, чтобы задать коэффициент прямо здесь">
                          <span class="fi">🛠</span>
                          <span class="ft">{{ warnText(w) }}</span>
                          <span class="fg">{{ cfOf(w) ? 'скрыть правку' : 'исправить: ' + convLabel(w.field) }}</span>
                        </button>
                      } @else {
                        <div class="warn-row">⚠ {{ warnText(w) }}</div>
                      }
                      @if (cfOf(w); as cf) {
                        <div class="cf">
                          <div class="cf-head">
                            <b>{{ cf.name }}</b>
                            <span class="cf-ent">{{ cf.sourceType === 'raw' ? 'продукт номенклатуры' : 'вложенная заготовка' }}</span>
                            <span class="cf-cur">сейчас: {{ cf.current == null ? '— не задан —' : cf.current }}</span>
                          </div>
                          <div class="cf-row">
                            <label class="f cf-field">
                              {{ convLabel(cf.field) }}
                              <input #convInput class="hot" type="number" min="0" step="any" autocomplete="off"
                                     [ngModel]="cf.value" (ngModelChange)="patchConvFix($event)"
                                     (keyup.enter)="saveConvFix()" (keyup.escape)="cancelConvFix()"
                                     [placeholder]="convExample(cf.field)" />
                            </label>
                            <div class="cf-acts">
                              <button type="button" class="btn sm ai" [disabled]="cf.asking || cf.saving" (click)="askAiFix()"
                                      title="Спросить у GPT типичное значение и подставить в поле; сохраняет по-прежнему человек">
                                {{ cf.asking ? '🤖 Спрашиваю…' : '🤖 Спросить у ИИ' }}
                              </button>
                              <button type="button" class="btn primary sm" [disabled]="cf.saving" (click)="saveConvFix()">
                                {{ cf.saving ? 'Сохраняю…' : '💾 Сохранить и пересчитать' }}
                              </button>
                              <button type="button" class="btn sm" [disabled]="cf.saving" (click)="cancelConvFix()">Отмена</button>
                            </div>
                          </div>
                          @if (cf.err) { <div class="cf-err">{{ cf.err }}</div> }
                          @if (cf.ai) {
                            <div class="cf-ai" [class.na]="cf.aiValue == null">{{ cf.ai }}</div>
                          }
                          <div class="cf-note">
                            {{ convHint(cf.field) }}. Значение пишется в запись «{{ cf.name }}» (в журнале видно, что меняли),
                            рецептура заготовки остаётся прежней — пересчитается только расход.
                          </div>
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            }
          </div>

          <!-- ДЕЙСТВИЯ -->
          <div class="acts">
            <button class="btn primary" [disabled]="saving() || issues().length > 0" (click)="save()">
              {{ saving() ? 'Сохранение…' : '💾 Сохранить заготовку' }}
            </button>
            @if (dirty()) { <button class="btn" [disabled]="saving()" (click)="revert()">↩ Отменить изменения</button> }
            @if (d.id) { <button class="btn danger" [disabled]="saving()" (click)="remove()">Удалить</button> }
            <div class="spacer"></div>
            <button class="btn" (click)="closeEditor()">Закрыть</button>
          </div>
          @if (issues().length) {
            <div class="blk-err">Сохранение заблокировано: посмотрите подсказки у полей ({{ issues().length }}).</div>
          }
          @if (calcWarnCount() && !issues().length) {
            <div class="mini warn">Расчёт содержит нерешённые пересчёты размерностей — кликните предупреждение в блоке E, чтобы задать коэффициент.</div>
          }
        </div>
      } @else {
        <div class="panel">
          <p class="muted">Выберите заготовку слева или создайте новую. Заготовка делается как из складского сырья,
            так и из других полуфабрикатов — расход полностью раскладывается до сырья с учётом выхода после обработки на каждом уровне.</p>
          <p class="muted small">База расчёта норм: количество добавки задаётся <b>на 1 кг / 1 л / 1000 шт готовой заготовки</b>
            (по размерности единицы выхода), количество основного продукта — <b>на весь выход</b> партии.</p>
        </div>
      }
    </div>
  `,
  styles: [
    `
    .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .head .page-title { margin: 0; }
    .cols { grid-template-columns: minmax(300px, .82fr) minmax(0, 1.18fr); align-items: start; }
    .cat { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow: auto; }
    /* каталог скроллится сам — внутреннему списку двойной скролл не нужен */
    .cat .list-pick { max-height: none; overflow: visible; }

    .search { position: relative; display: flex; }
    .search input { width: 100%; padding-right: 30px; }
    .clr {
      position: absolute; right: 4px; top: 5px; border: 0; background: transparent; color: var(--muted);
      cursor: pointer; font-size: 14px; padding: 4px 7px; border-radius: 6px;
    }
    .clr:hover { background: #f2f5fa; color: var(--text); }

    .filters { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
    .chipset { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .clbl { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); min-width: 54px; }
    .chip {
      border: 1px solid var(--border); background: #fff; color: var(--text); border-radius: 999px;
      font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; cursor: pointer;
    }
    .chip:hover { background: #f2f5fa; }
    .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .chip.warn.on { background: var(--amber); border-color: var(--amber); }
    .chip.reset { color: var(--red); border-color: #efb6b6; }
    .sort { font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: #fff; }
    .found { margin: 10px 0 6px; font-size: 12px; color: var(--muted); }

    .sk { display: flex; flex-direction: column; gap: 6px; }
    .sk-row { border: 1px solid var(--border); border-radius: 8px; padding: 14px 12px; color: var(--muted); font-size: 12px; background: #fbfcfe; }

    .rc {
      display: block; width: 100%; text-align: left; border: 1px solid var(--border); background: #fff;
      border-radius: 8px; padding: 9px 12px; cursor: pointer; font: inherit;
    }
    .rc:hover { background: #f2f5fa; }
    .rc.on { border-color: var(--accent); background: var(--accent-soft); }
    .rc-1 { display: flex; align-items: center; gap: 8px; }
    .rc-1 b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rc-1 .badge { margin-left: auto; flex: none; }
    .rc-2 { margin-top: 3px; font-size: 11.5px; color: var(--muted); display: flex; gap: 4px; flex-wrap: wrap; }
    .rc-w { margin-top: 4px; font-size: 11.5px; color: var(--amber); }
    .lnk { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; padding: 0; }

    .pager { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .ps { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
    .ps select { font-size: 12px; padding: 4px 6px; }
    .range { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .pg { min-width: 32px; justify-content: center; }
    .pg.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .gap { color: var(--muted); }

    /* редактор */
    .ed-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .ed-head h3 { margin: 0; }
    .blk { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px 12px; margin-top: 12px; }
    .blk-t { font-size: 11.5px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
    .blk-note { margin-left: 8px; font-weight: 400; text-transform: none; letter-spacing: 0; }
    .blk.core { background: var(--accent-soft); border-color: #cfe0fb; }
    .blk.core .blk-t { color: var(--accent); }
    .blk.calc { background: #fbfcfe; }
    .basis-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
    .bi { display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--border); border-radius: 8px; background: #fff; padding: 8px 10px; font-size: 12px; color: var(--muted); line-height: 1.45; }
    .bi b { color: var(--text); }
    .bi .bt { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--accent); }
    .blk-err { margin-top: 10px; font-size: 12px; color: var(--red); }

    .core-grid { display: grid; grid-template-columns: 150px minmax(200px, 1.6fr) 96px 150px; gap: 10px; align-items: start; }
    .ro {
      border: 1px solid var(--border); border-radius: 8px; background: #f7f9fc; padding: 8px 10px;
      font-size: 13px; font-weight: 600; color: var(--text); min-height: 38px; display: flex; align-items: center;
    }
    .chain {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; padding: 8px 10px;
      background: #fff; border: 1px solid #cfe0fb; border-radius: 8px; font-size: 13px;
    }
    .chain .ci { font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
    .chain .ar { color: var(--accent); font-weight: 700; }
    .tip { margin-top: 6px; font-size: 11.5px; line-height: 1.4; }
    .f-err { display: block; font-size: 11.5px; color: var(--red); text-transform: none; letter-spacing: 0; }

    /* таблица добавок */
    .tb-head, .tb-row { display: grid; gap: 10px; align-items: start; }
    .tb-head {
      grid-template-columns: 128px minmax(180px, 1.7fr) 120px 116px minmax(120px, 1fr) 34px;
      font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); padding: 2px 0 6px;
    }
    .tb-head .num { text-align: right; }
    .tb-head .del { text-align: center; }
    .tb-row { grid-template-columns: 128px minmax(180px, 1.7fr) 120px 116px minmax(120px, 1fr) 34px; padding: 6px 0; border-top: 1px solid var(--border); }
    .t-sel, .t-num { width: 100%; }
    .t-num { text-align: right; font-variant-numeric: tabular-nums; }
    .t-pick { min-width: 0; }
    .t-part { text-align: right; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 9px; }
    .t-del { display: flex; justify-content: center; padding-top: 4px; }
    .tb-err { font-size: 11.5px; color: var(--red); margin-top: -4px; }
    .tb-empty { padding: 10px; font-size: 12px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; }
    .tb-add { margin-top: 8px; }

    /* расчёт */
    .calc-in { align-items: flex-end; }
    .btn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .calc-sum { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 4px; }
    .calc-sum > div {
      display: flex; flex-direction: column; gap: 2px; background: #fff; border: 1px solid var(--border);
      border-radius: 8px; padding: 8px 12px; min-width: 150px;
    }
    .calc-sum .l { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
    .calc-sum b { font-size: 15px; font-variant-numeric: tabular-nums; }
    .sub-t { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); }
    .tree { border: 1px solid var(--border); border-radius: 8px; background: #fff; padding: 4px 6px; }
    .tr { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; font-size: 12.5px; border-bottom: 1px solid #f0f3f8; flex-wrap: wrap; }
    .tr:last-child { border-bottom: 0; }
    .tw { border: 0; background: transparent; cursor: pointer; color: var(--accent); font: inherit; font-size: 11px; padding: 0 2px; flex: none; }
    .tw-sp { width: 22px; flex: none; }
    .tr .k { font-size: 10.5px; color: var(--muted); flex: none; }
    .tr .k.base { color: var(--accent); font-weight: 700; }
    .tr .k.semi { color: var(--amber); }
    .tr .n { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
    .tr .b { color: var(--muted); font-size: 11.5px; }
    .tr .q { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .tr .w { flex-basis: 100%; color: var(--amber); font-size: 11.5px; }
    .w.fixw {
      border: 0; background: none; padding: 0; font: inherit; font-size: 11.5px; color: var(--amber);
      cursor: pointer; text-decoration: underline; text-underline-offset: 2px; text-align: left;
    }
    .w.fixw:hover, .w.fixw.open { color: #8f5f00; text-decoration: none; font-weight: 600; }
    .warns { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .warn-row { font-size: 12px; color: var(--amber); background: var(--amber-soft); border-radius: 6px; padding: 6px 9px; }
    .warn-cell { display: flex; flex-direction: column; gap: 6px; }
    /* кликабельное предупреждение = ссылка на поле, которое лечит проблему */
    .warn-row.fix {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; font: inherit; font-size: 12px;
      border: 1px solid #e8d3ad; cursor: pointer;
    }
    .warn-row.fix:hover { background: #fbeed2; }
    .warn-row.fix.open { border-color: var(--amber); background: #fdf3df; }
    .warn-row.fix .fi { flex: none; }
    .warn-row.fix .ft { min-width: 0; overflow-wrap: anywhere; }
    .warn-row.fix .fg { flex: none; margin-left: auto; font-size: 10.5px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: .3px; white-space: nowrap; }

    /* панель быстрой правки коэффициента */
    .cf { border: 1px solid var(--accent); border-radius: 8px; background: #fff; padding: 10px 12px; box-shadow: 0 2px 10px rgba(20, 40, 80, .07); }
    .cf-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; margin-bottom: 8px; }
    .cf-ent, .cf-cur { font-size: 11.5px; color: var(--muted); }
    .cf-cur { margin-left: auto; font-variant-numeric: tabular-nums; }
    .cf-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
    .cf-field { flex: 1 1 230px; max-width: 330px; }
    .cf-acts { display: flex; gap: 8px; flex-wrap: wrap; }
    .cf-note { margin-top: 8px; font-size: 11.5px; color: var(--muted); line-height: 1.45; }
    /* ответ модели: видно, ЧЬЁ это число и насколько ему верить */
    .btn.ai { border-color: #d9c9f5; background: #f8f4ff; color: #5b3fbf; }
    .btn.ai:hover:not(:disabled) { background: #efe6ff; }
    .cf-ai {
      margin-top: 8px; font-size: 12px; line-height: 1.45; color: #4a3a86;
      background: #f8f4ff; border: 1px solid #e2d6fb; border-radius: 8px; padding: 6px 9px;
    }
    .cf-ai.na { color: #8a5a00; background: #fff8e8; border-color: #f0d9a8; }
    .cf-err { margin-top: 6px; font-size: 12px; color: var(--red); }
    /* подсвечиваем именно то поле, которого не хватало */
    input.hot { border-color: var(--amber); background: #fffaf0; box-shadow: 0 0 0 3px var(--amber-soft); }
    .mini { margin-top: 8px; font-size: 12px; color: var(--muted); }
    .mini.warn { color: var(--amber); background: var(--amber-soft); border-radius: 6px; padding: 6px 9px; }
    .small { font-size: 12px; }
    .adv { margin-top: 10px; border: 1px solid var(--border); border-radius: 8px; background: #fbfcfe; }
    .adv > summary { cursor: pointer; padding: 9px 12px; font-weight: 600; font-size: 13px; color: var(--muted); list-style: none; user-select: none; }
    .adv > summary::-webkit-details-marker { display: none; }
    .adv > summary::before { content: '▸'; display: inline-block; margin-right: 8px; transition: transform .15s ease; color: var(--accent); }
    .adv[open] > summary { color: var(--text); }
    .adv[open] > summary::before { transform: rotate(90deg); }
    .adv-body { padding: 2px 12px 12px; border-top: 1px solid var(--border); }
    .acts { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }

    @media (max-width: 1180px) {
      .tb-head, .tb-row { grid-template-columns: 116px minmax(150px, 1.4fr) 104px 100px minmax(100px, 1fr) 30px; gap: 8px; }
      .core-grid { grid-template-columns: 132px minmax(170px, 1.4fr) 84px 132px; }
    }
    @media (max-width: 900px) {
      /* узкий экран: каталог и редактор идут друг под другом (глобальная .grid2 без нашего правила не переопределяется) */
      .cols { grid-template-columns: 1fr; }
      .cat { position: static; max-height: none; }
      .tb-head { display: none; }
      .tb-row { grid-template-columns: 1fr 1fr; }
      .t-part, .t-del { padding-top: 0; }
      .t-part { text-align: left; }
      .core-grid { grid-template-columns: 1fr 1fr; }
      .warn-row.fix { align-items: flex-start; }
      .warn-row.fix .fg { margin-left: 0; flex-basis: 100%; }
    }
    @media (max-width: 640px) {
      .tb-row { grid-template-columns: 1fr 1fr; gap: 8px; }
      .t-num { text-align: left; }
    }
    `,
  ],
})
export class SemisComponent implements OnInit {
  private api = inject(ApiService);
  private listEl = viewChild<ElementRef<HTMLElement>>('listEl');
  private editorEl = viewChild<ElementRef<HTMLElement>>('editorEl');

  // ---------- справочники ----------
  semis = signal<Semi[]>([]);
  products = signal<Product[]>([]);
  units = signal<Unit[]>([]);
  loading = signal(true);
  listErr = signal('');
  ctx = computed<SemiCtx>(() => ({ units: this.units(), products: this.products(), semis: this.semis() }));

  // ---------- каталог ----------
  query = signal('');
  fType = signal<'all' | 'raw' | 'semi'>('all');
  fAdds = signal<'all' | 'with' | 'none'>('all');
  fBad = signal(false);
  sortMode = signal<SortMode>('name');
  page = signal(1);
  perPage = signal(20);
  perPageOptions = () => [20, 50, 100];
  sortModes = () => Object.keys(SORT_LABELS) as SortMode[];
  sortLabel = (m: SortMode) => SORT_LABELS[m];

  filtered = computed(() => {
    const q = this.query().trim();
    const list = this.semis().filter((s) => {
      if (q && !semiMatches(s, q)) return false;
      if (this.fType() !== 'all' && (semiBase(s)?.sourceType ?? 'none') !== this.fType()) return false;
      const adds = semiAdditives(s).length;
      if (this.fAdds() === 'with' && adds === 0) return false;
      if (this.fAdds() === 'none' && adds > 0) return false;
      if (this.fBad() && !incompleteOf(s)) return false;
      return true;
    });
    return sortSemis(list, this.sortMode());
  });

  pageCount = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.perPage())));
  pageItems = computed(() => {
    const p = Math.min(this.page(), this.pageCount());
    const from = (p - 1) * this.perPage();
    return this.filtered().slice(from, from + this.perPage());
  });
  range = computed(() => {
    const total = this.filtered().length;
    if (!total) return '0 записей';
    const from = (Math.min(this.page(), this.pageCount()) - 1) * this.perPage() + 1;
    const to = Math.min(total, from + this.perPage() - 1);
    return `${from}–${to} из ${total}`;
  });
  pageWindow = computed(() => {
    const n = this.pageCount();
    const cur = Math.min(this.page(), n);
    if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
    const out: number[] = [1];
    const lo = Math.max(2, cur - 1);
    const hi = Math.min(n - 1, cur + 1);
    if (lo > 2) out.push(-1);
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < n - 1) out.push(-1);
    out.push(n);
    return out;
  });
  skRows = () => [1, 2, 3];
  trim = trim;

  hasFilters = computed(() => this.query() !== '' || this.fType() !== 'all' || this.fAdds() !== 'all' || this.fBad());

  onQuery(v: string): void {
    this.query.set(v ?? '');
    this.page.set(1);
  }
  onSort(m: SortMode): void {
    this.sortMode.set(m);
    this.page.set(1);
  }
  toggleBad(): void {
    this.fBad.update((v) => !v);
    this.page.set(1);
  }
  resetFilters(): void {
    this.query.set('');
    this.fType.set('all');
    this.fAdds.set('all');
    this.fBad.set(false);
    this.sortMode.set('name');
    this.page.set(1);
  }
  setPerPage(n: number): void {
    this.perPage.set(Number(n) || 20);
    this.page.set(1);
  }
  goPage(p: number): void {
    this.page.set(Math.min(Math.max(1, p), this.pageCount()));
  }

  semiBase = semiBase;
  semiAdditives = semiAdditives;
  /** Выход базового входа для строки каталога. */
  yieldText(s: Semi): string {
    const y = semiBase(s)?.yieldPct;
    return y != null ? `${trim(Number(y))}%` : '—';
  }
  num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  fmt = (qty: number, unitCode: string) => fmtBase(qty, unitCode ?? '');
  unitCodeOf = (unitId: number | null) => unitCodeOf(this.ctx(), unitId);
  outDenom = () => outDenom(this.ctx(), this.draft()?.unitId ?? null);

  /** Чем «неполна» заготовка для бейджа в каталоге. */
  rowWarn(s: Semi): string | null {
    const bad = incompleteOf(s);
    if (bad) return bad;
    const b = semiBase(s);
    if (!b || !b.unitId || !s.unitId) return null;
    const outU = this.units().find((u) => u.id === s.unitId);
    const inU = this.units().find((u) => u.id === b.unitId);
    if (outU && inU && outU.dimension !== inU.dimension && !(s.gPerPcs || s.mlPerPcs || s.gPerMl)) {
      return 'нет коэффициента пересчёта размерностей';
    }
    return null;
  }

  // ---------- редактор ----------
  draft = signal<SemiDraft | null>(null);
  private baseline = signal('');
  dirty = computed(() => (this.draft() ? JSON.stringify(this.draft()) !== this.baseline() : false));
  saving = signal(false);
  err = signal('');
  msg = signal('');
  want = signal(1000);

  baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));
  baseSource = computed<SourceKind>(() => this.draft()?.base.sourceType ?? 'raw');

  issues = computed<Issue[]>(() => {
    const d = this.draft();
    return d ? validateDraft(this.ctx(), d) : [];
  });
  private issueByField = computed(() => {
    const m: Record<string, string> = {};
    for (const i of this.issues()) if (!m[i.field]) m[i.field] = i.message;
    return m;
  });
  issue = (field: string): string => this.issueByField()[field] ?? '';

  productOptions = computed<PickOption[]>(() =>
    this.products()
      .map((p) => ({ id: p.id, label: p.name, unit: p.unitCode, group: p.category }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  );

  /** Полуфабрикаты для выбора входа: исключаем те, что создадут цикл. */
  semiOptions = computed<PickOption[]>(() => {
    const ctx = this.ctx();
    const d = this.draft();
    return this.semis()
      .map((s) => {
        const blocked = d?.id != null && s.id === d.id ? 'сама заготовка' : !pickableAsInput(ctx, d?.id ?? null, s.id) ? 'создаст цикл' : undefined;
        return { id: s.id, label: s.name, unit: s.unitCode, group: 'полуфабрикат', blocked };
      })
      .sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || a.label.localeCompare(b.label, 'ru'));
  });

  baseUnit(): string {
    const d = this.draft();
    if (!d) return '';
    const refId = d.base.refId;
    if (refId == null) return '';
    const u = this.units().find((x) => x.id === this.refUnitId(d.base.sourceType, refId));
    return u?.code ?? '';
  }

  private refUnitId(sourceType: SourceKind, refId: number): number | null {
    const r = sourceType === 'raw' ? this.products().find((p) => p.id === refId) : this.semis().find((s) => s.id === refId);
    return r?.unitId ?? null;
  }

  presets = computed(() => batchPresets(this.ctx(), this.draft()?.unitId ?? null));

  chainIn(): string {
    const e = this.calc();
    const b = e.nodes.find((n) => n.role === 'base');
    return b ? `${this.fmt(b.qty, b.unitCode)} (${b.name})` : '— выберите продукт —';
  }
  chainOut(): string {
    const d = this.draft();
    if (!d) return '—';
    return `${this.fmt(this.want(), this.unitCodeOf(d.unitId))} заготовки`;
  }
  wantHint(): string {
    const d = this.draft();
    if (!d) return '—';
    return `${this.fmt(this.want(), this.unitCodeOf(d.unitId))} готовой заготовки`;
  }
  baseNeed(): number {
    return this.calc().nodes.find((n) => n.role === 'base')?.qty ?? 0;
  }

  /** Норма добавки → расход на текущую партию (только отображение, рецептуру не меняет). */
  addPerBatch(a: SemiDraft['additives'][number]): string {
    const d = this.draft();
    if (!d || a.refId == null || !(Number(a.qtyPerOutput) > 0) || !(this.want() > 0)) return '—';
    const ctx = this.ctx();
    const ref = refInfo(ctx, a.sourceType, a.refId);
    if (!ref) return '—';
    let q = (this.want() * Number(a.qtyPerOutput)) / 1000;
    const own = Number(a.yieldPct ?? 0);
    // свой выход добавки — как в блоке E: при выходе в штуках делим МАССУ, а не штуки.
    // inGrams=true → число в граммах, переводим из размерности mass (обратного /gPerPcs нет).
    let byMass = false;
    const g = this.selfGPerPcs();
    if (own > 0 && own < 100) {
      if (this.outIsPcs() && g && g > 0) {
        q = (q * g) / (own / 100);
        byMass = true;
      } else {
        q = q / (own / 100);
      }
    }
    const conv = toInputQty(ctx, q, d.unitId, ref, byMass);
    return `${this.fmt(conv.qty, ref.unitCode)}${conv.warn ? ' ⚠' : ''}`;
  }

  /** Состав черновика + коэффициенты самой заготовки: без них выход в штуках не посчитать. */
  private draftConv(): Conv {
    const d = this.draft();
    return { gPerPcs: d?.gPerPcs ?? null, mlPerPcs: d?.mlPerPcs ?? null, gPerMl: d?.gPerMl ?? null };
  }

  /** Выход редактируемой заготовки — в штуках. */
  outIsPcs(): boolean {
    const u = this.ctx().units.find((x) => x.id === this.draft()?.unitId);
    return u?.dimension === 'count';
  }

  /** Задан выход после обработки меньше 100 % — то есть потери есть. */
  yieldIsLoss(): boolean {
    const y = Number(this.draft()?.base.yieldPct ?? 0);
    return y > 0 && y < 100;
  }

  selfGPerPcs(): number | null {
    return this.draft()?.gPerPcs ?? null;
  }

  // ---------- расчёт (блок E) ----------
  calc = computed<Expansion>(() => {
    const d = this.draft();
    if (!d || d.base.refId == null || !(this.want() > 0)) {
      return { nodes: [], raw: [] as RawLine[], warnings: [], ready: false };
    }
    return expandComposition(
      this.ctx(),
      edgesOfDraft(d),
      this.want(),
      d.unitId,
      d.id != null ? new Set<number>([d.id]) : new Set<number>(),
      [],
      0,
      this.draftConv(),
      d.id != null ? { sourceType: 'semi', refId: d.id, name: d.name } : null
    );
  });

  expanded = signal<Set<string>>(new Set());
  calcRows = computed<CalcRow[]>(() => {
    const out: CalcRow[] = [];
    const open = this.expanded();
    const walk = (nodes: ExpNode[]) => {
      for (const n of nodes) {
        const hasKids = n.children.length > 0;
        const isOpen = hasKids && open.has(n.key);
        out.push({ node: n, hasKids, open: isOpen });
        if (isOpen) walk(n.children);
      }
    };
    walk(this.calc().nodes);
    return out;
  });
  toggleNode(key: string): void {
    this.expanded.update((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }
  calcWarnCount = computed(() => this.calcWarnings().length);

  /** Предупреждения раскрытия без повторов: один и тот же продукт может входить в несколько веток. */
  calcWarnings = computed<ExpWarn[]>(() => dedupeWarnings(this.calc().warnings));

  warnKey = warnKey;
  warnText = warnText;
  fixableWarn = fixableWarn;
  /** Кликабельное предупреждение строки дерева: не хватает коэффициента у записи. */
  nodeFix(n: ExpNode): ExpWarn | null {
    return n.fixes.find(fixableWarn) ?? null;
  }
  convLabel = (f: ConvField | null): string => (f ? CONV_FIELD_LABEL[f] : 'коэффициент пересчёта');
  convExample = (f: ConvField | null): string => (f ? CONV_FIELD_HINT[f].example : 'число');
  convHint = (f: ConvField | null): string => (f ? CONV_FIELD_HINT[f].eq : 'какой коэффициент нужен');

  // ---------- быстрая правка коэффициента из предупреждения ----------
  convFix = signal<ConvFix | null>(null);
  private convInput = viewChild<ElementRef<HTMLInputElement>>('convInput');

  /** Открыта ли правка именно для этого предупреждения (иначе null). */
  cfOf(w: ExpWarn): ConvFix | null {
    const cf = this.convFix();
    return cf && cf.key === warnKey(w) ? cf : null;
  }

  openFix(w: ExpWarn): void {
    if (!fixableWarn(w)) return;
    const key = warnKey(w);
    if (this.convFix()?.key === key) {
      this.convFix.set(null);
      return;
    }
    const refId = w.refId;
    const field = w.field;
    const current = convValueOf(this.ctx(), w.sourceType, refId, field);
    this.convFix.set({
      key,
      sourceType: w.sourceType,
      refId,
      name: w.where,
      field,
      value: current == null ? '' : String(current),
      current,
      saving: false,
      err: '',
      asking: false,
      ai: '',
      aiValue: null,
      aiModel: null,
    });
    setTimeout(() => {
      const el = this.convInput()?.nativeElement;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
    });
  }

  /**
   * Ручной ввод снимает статус «подсказал ИИ»: в журнал должно попасть то, что человек
   * сохранил сам, а не модель, чьё число он только подправил.
   */
  patchConvFix(v: unknown): void {
    this.convFix.update((cf) =>
      cf ? { ...cf, value: v == null || v === '' ? '' : String(v), err: '', ai: '', aiValue: null, aiModel: null } : cf
    );
  }

  /**
   * Спросить у GPT физическую величину этой записи (плотность, массу или объём штуки)
   * и подставить в поле. Ничего не сохраняем: решение и запись в базу — за человеком.
   * Число к нам приходит уже проверенным по физическим пределам (сервер), поэтому
   * здесь оно либо есть, либо его нет с объяснением, почему спрашивать бессмысленно.
   */
  askAiFix(): void {
    const cf = this.convFix();
    if (!cf || cf.asking) return;
    this.convFix.update((x) => (x ? { ...x, asking: true, ai: 'Спрашиваю у GPT…', aiValue: null, aiModel: null, err: '' } : x));
    this.api
      .askCoefficient$({ sourceType: cf.sourceType, refId: cf.refId, field: cf.field })
      .subscribe({
        next: (r) => {
          const conf = AI_CONFIDENCE[r.confidence] ?? r.confidence;
          this.convFix.update((x) => {
            if (!x) return x;
            if (r.value == null) {
              return { ...x, asking: false, ai: `🤖 ${r.model}: ${r.reason || 'вразумительного ответа нет'} — поле не заполнен` };
            }
            return {
              ...x,
              asking: false,
              value: String(r.value),
              ai: `🤖 ${r.model}: ${r.reason || 'без объяснения'} · уверенность: ${conf} · значение в поле можно поправить перед сохранением`,
              aiValue: r.value,
              aiModel: r.model,
            };
          });
        },
        error: (e) => this.convFix.update((x) => (x ? { ...x, asking: false, ai: '', err: httpErr(e) } : x)),
      });
  }

  cancelConvFix(): void {
    this.convFix.set(null);
  }

  /**
   * Записать коэффициент в саму запись (продукт номенклатуры / вложенная заготовка) и
   * пересчитать расход. Состав редактируемой заготовки не меняется — правится только
   * размерностная связь, поэтому и предупреждение перестаёт быть актуальным сразу.
   */
  saveConvFix(): void {
    const cf = this.convFix();
    if (!cf || cf.saving) return;
    const raw = cf.value.trim().replace(',', '.');
    if (!raw) {
      this.convFix.update((x) => (x ? { ...x, err: 'Введите число: пустое значение коэффициент не задаёт' } : x));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      this.convFix.update((x) => (x ? { ...x, err: 'Коэффициент — число больше 0' } : x));
      return;
    }
    this.convFix.update((x) => (x ? { ...x, saving: true, err: '' } : x));
    // «подсказал ИИ» пишем только если в поле осталось то самое число; после ручной
    // правки коэффициента источник у значения — человек
    const aiModel =
      cf.aiModel && cf.aiValue != null && Math.abs(n - cf.aiValue) < 1e-9 ? cf.aiModel : null;
    const what = `${CONV_FIELD_LABEL[cf.field]} = ${trimNum(n)}${aiModel ? ' (подсказал ИИ)' : ''}`;
    const done = () => {
      this.convFix.set(null);
      if (cf.sourceType === 'raw') {
        this.api.products$({ active: 'true' }).subscribe((p) => {
          this.products.set(p);
          this.msg.set(`«${cf.name}»: ${what} — расход пересчитан ✓`);
        });
      } else {
        // список заготовок обновляем БЕЗ перезаписи черновика: несохраненные правки редактора дороже
        this.api.semis$().subscribe((list) => {
          this.semis.set(list);
          this.msg.set(`«${cf.name}»: ${what} — расход пересчитан ✓`);
        });
      }
    };
    const fail = (e: unknown) => {
      this.convFix.update((x) => (x ? { ...x, saving: false, err: httpErr(e) } : x));
    };
    if (cf.sourceType === 'raw') {
      this.api.patchProduct(cf.refId, productConvBody(cf.field, n, aiModel)).subscribe({ next: done, error: fail });
      return;
    }
    const src = this.semis().find((s) => s.id === cf.refId);
    if (!src) {
      this.convFix.update((x) => (x ? { ...x, saving: false, err: 'Вложенная заготовка не найдена — обновите список' } : x));
      return;
    }
    const patch: Partial<Record<ConvField, number | null>> = {};
    patch[cf.field] = n;
    this.api.patchSemi(cf.refId, semiBodyOf(src, patch, aiModel)).subscribe({ next: done, error: fail });
  }

  /** Σ входа по размерности выхода vs выход — намёк на правдоподобность выхода (как в техкартах). */
  sumHint = computed<{ text: string; warn: boolean } | null>(() => {
    const exp = this.calc();
    const d = this.draft();
    if (!exp.ready || !d) return null;
    const outU = this.units().find((u) => u.id === d.unitId);
    if (!outU || outU.dimension === 'count') return null;
    let inSum = 0;
    for (const n of exp.nodes) {
      if (n.depth !== 0) continue;
      const ref = refInfo(this.ctx(), n.sourceType, n.refId);
      if (!ref) continue;
      const iu = this.units().find((u) => u.id === ref.unitId);
      if (!iu || iu.dimension !== outU.dimension) continue;
      inSum += n.qty * iu.baseFactor;
    }
    if (!inSum) return null;
    const ratio = inSum / this.want();
    const parts = `Σ входа ${fmtBase(inSum, outU.code)} vs выход ${fmtBase(this.want(), outU.code)}`;
    if (ratio <= 1.02) return { text: `${parts} — потер при обработке не задано (выход ≈ входу)`, warn: false };
    if (ratio > 4) return { text: `${parts} — вход в ×${trimNum(Math.round(ratio * 10) / 10)} больше выхода: проверьте выход после обработки и нормы`, warn: true };
    return { text: `${parts} — технологический расход ×${trimNum(Math.round(ratio * 100) / 100)}`, warn: false };
  });

  // ---------- мутации черновика (только через сигналы — OnPush + computed) ----------
  patchDraft<K extends keyof SemiDraft>(k: K, v: SemiDraft[K]): void {
    this.draft.update((d) => (d ? { ...d, [k]: v } : d));
  }
  patchBase(patch: Partial<SemiDraft['base']>): void {
    this.draft.update((d) => (d ? { ...d, base: { ...d.base, ...patch } } : d));
  }
  setBaseType(t: SourceKind): void {
    this.patchBase({ sourceType: t, refId: null });
  }
  pickBase(o: PickOption): void {
    this.patchBase({ refId: o.id });
  }
  patchAdditive(i: number, patch: Partial<SemiDraft['additives'][number]>): void {
    this.draft.update((d) => (d ? { ...d, additives: d.additives.map((a, idx) => (idx === i ? { ...a, ...patch } : a)) } : d));
  }
  pickAdditive(i: number, o: PickOption): void {
    this.patchAdditive(i, { refId: o.id });
  }
  addAdditive(): void {
    this.draft.update((d) => (d ? { ...d, additives: [...d.additives, { sourceType: 'raw' as SourceKind, refId: null, qtyPerOutput: null, yieldPct: null }] } : d));
  }
  removeAdditive(i: number): void {
    this.draft.update((d) => (d ? { ...d, additives: d.additives.filter((_, idx) => idx !== i) } : d));
  }

  // ---------- загрузка / каталог ----------
  ngOnInit(): void {
    this.reload();
    this.api.products$({ active: 'true' }).subscribe((p) => this.products.set(p));
    this.api.units$().subscribe((u) => this.units.set(u));
  }

  reload(keepId: number | null = null): void {
    this.loading.set(true);
    this.listErr.set('');
    this.api.semis$().subscribe({
      next: (list) => {
        this.semis.set(list);
        this.loading.set(false);
        if (keepId != null) {
          const fresh = list.find((s) => s.id === keepId);
          if (fresh) this.applyDraft(this.toDraft(fresh));
        }
      },
      error: (e) => {
        this.loading.set(false);
        this.listErr.set(httpErr(e));
      },
    });
  }

  /** Черновик из сохранённой заготовки (additive qtyPerOutput → удобная шкала ×1000). */
  private toDraft(s: Semi): SemiDraft {
    const base = semiBase(s);
    const adds = semiAdditives(s);
    return {
      id: s.id,
      name: s.name,
      note: s.note,
      unitId: s.unitId,
      shelfLifeDays: s.shelfLifeDays ?? null,
      gPerPcs: s.gPerPcs ?? null,
      mlPerPcs: s.mlPerPcs ?? null,
      gPerMl: s.gPerMl ?? null,
      base: {
        sourceType: (base?.sourceType ?? 'raw') as SourceKind,
        refId: base?.refId ?? null,
        yieldPct: base ? Number(base.yieldPct) : 90,
      },
      additives: adds.map((a) => ({
        sourceType: a.sourceType,
        refId: a.refId,
        qtyPerOutput: Number(a.qtyPerOutput) * 1000,
        yieldPct: a.yieldPct != null ? Number(a.yieldPct) : null,
      })),
    };
  }

  private applyDraft(d: SemiDraft): void {
    this.draft.set(d);
    this.baseline.set(JSON.stringify(d));
    this.err.set('');
    this.expanded.set(new Set());
    this.convFix.set(null);
  }

  private confirmLoss(): boolean {
    if (!this.dirty()) return true;
    return confirm('В редакторе есть несохранённые изменения — при переходе они будут потеряны. Продолжить?');
  }

  newSemi(): void {
    if (!this.confirmLoss()) return;
    this.msg.set('');
    this.applyDraft({
      id: null,
      name: '',
      note: '',
      unitId: this.baseUnits().find((u) => u.code === 'г')?.id ?? this.baseUnits()[0]?.id ?? null,
      shelfLifeDays: null,
      gPerPcs: null,
      mlPerPcs: null,
      gPerMl: null,
      base: { sourceType: 'raw', refId: null, yieldPct: 90 },
      additives: [],
    });
    this.want.set(1000);
    this.revealEditor();
  }

  editSemi(s: Semi): void {
    if (this.draft()?.id === s.id) return;
    if (!this.confirmLoss()) return;
    this.msg.set('');
    this.applyDraft(this.toDraft(s));
    this.revealEditor();
  }

  /** Копия выбранной заготовки как новая независимая запись (исходник не трогаем). */
  duplicate(): void {
    const d = this.draft();
    if (!d) return;
    if (!this.confirmLoss()) return;
    const copy: SemiDraft = {
      ...d,
      id: null,
      name: `${d.name.trim() || 'заготовка'} (копия)`,
      base: { ...d.base },
      additives: d.additives.map((a) => ({ ...a })),
    };
    this.msg.set('');
    this.applyDraft(copy);
    this.revealEditor();
  }

  revert(): void {
    const d = this.draft();
    if (!d?.id) return;
    const src = this.semis().find((s) => s.id === d.id);
    if (!src) return;
    this.applyDraft(this.toDraft(src));
    this.msg.set('Изменения отменены — заготовка в сохранённом виде');
  }

  closeEditor(): void {
    if (!this.confirmLoss()) return;
    this.draft.set(null);
    this.err.set('');
    setTimeout(() => {
      const el = this.listEl()?.nativeElement;
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  save(): void {
    const d = this.draft();
    if (!d) return;
    this.err.set('');
    const problems = this.issues();
    if (problems.length) {
      this.err.set(problems.map((p) => p.message).join(' · '));
      return;
    }
    // payload — ровно как раньше: additive qtyPerOutput в БД = доля на 1 базовую ед. выхода (÷1000 от UI)
    const inputs: Record<string, unknown>[] = [
      { sourceType: d.base.sourceType, refId: d.base.refId, role: 'base', yieldPct: d.base.yieldPct },
      ...d.additives
        .filter((a) => a.refId != null && (a.qtyPerOutput ?? 0) > 0)
        .map((a) => ({
          sourceType: a.sourceType,
          refId: a.refId,
          role: 'additive',
          qtyPerOutput: (a.qtyPerOutput ?? 0) / 1000,
          yieldPct: (a.yieldPct ?? 0) > 0 && (a.yieldPct ?? 0) < 100 ? a.yieldPct : null,
        })),
    ];
    const body = {
      name: d.name.trim(),
      note: d.note,
      unitId: d.unitId,
      shelfLifeDays:
        d.shelfLifeDays === null || (d.shelfLifeDays as unknown) === '' || !Number.isFinite(Number(d.shelfLifeDays))
          ? null
          : Math.trunc(Number(d.shelfLifeDays)),
      gPerPcs: d.gPerPcs,
      mlPerPcs: d.mlPerPcs,
      gPerMl: d.gPerMl,
      inputs,
    };
    this.saving.set(true);
    const done = (id: number) => {
      this.saving.set(false);
      this.msg.set(`Заготовка «${d.name.trim()}» сохранена ✓`);
      this.reload(id);
    };
    if (d.id) {
      this.api.patchSemi(d.id, body).subscribe({
        next: () => done(d.id!),
        error: (e) => {
          this.saving.set(false);
          this.err.set(httpErr(e));
        },
      });
    } else {
      this.api.createSemi(body).subscribe({
        next: (res) => {
          this.draft.update((x) => (x ? { ...x, id: res.id } : x));
          this.baseline.set(JSON.stringify({ ...this.draft()!, id: res.id }));
          done(res.id);
        },
        error: (e) => {
          this.saving.set(false);
          this.err.set(httpErr(e));
        },
      });
    }
  }

  /**
   * Удаление с объяснением последствий. Список использующих техкарт тянем лениво
   * (GET /api/cards) только по клику, а не при каждом открытии редактора.
   */
  remove(): void {
    const d = this.draft();
    if (!d?.id) return;
    const id = d.id;
    const name = d.name.trim();
    this.saving.set(true);
    const run = (cards: TechCard[]) => {
      this.saving.set(false);
      const parents = usedBySemis(this.ctx(), id);
      const usedCards = cards.filter((c) => c.items.some((i) => i.sourceType === 'semi' && i.refId === id));
      if (parents.length || usedCards.length) {
        const lines = [
          parents.length ? `состав других заготовок: ${parents.map((s) => `«${s.name}»`).join(', ')}` : '',
          usedCards.length ? `техкарты: ${usedCards.map((c) => `«${c.name}»`).join(', ')}` : '',
        ].filter(Boolean);
        this.err.set(
          `«${name}» используется — ${lines.join('; ')}. ` +
            'Сначала уберите его из состава этих заготовок/карточек: иначе удаление нарушит рецептуры, и сервер его не примет.'
        );
        return;
      }
      if (!confirm(`Удалить заготовку «${name}»? Действие необратимо (снимок изменений останется в журнале).`)) return;
      // следующая запись после удаления — из текущего отфильтрованного каталога
      const rest = this.filtered().filter((s) => s.id !== id);
      const idx = this.filtered().findIndex((s) => s.id === id);
      this.saving.set(true);
      this.api.deleteSemi(id).subscribe({
        next: () => {
          this.draft.set(null);
          this.baseline.set('');
          this.msg.set('Заготовка удалена');
          this.api.semis$().subscribe({
            next: (list) => {
              this.semis.set(list);
              this.saving.set(false);
              const next = rest[Math.min(Math.max(idx, 0), rest.length - 1)];
              if (next) this.applyDraft(this.toDraft(next));
            },
            error: (e) => {
              this.saving.set(false);
              this.listErr.set(httpErr(e));
            },
          });
        },
        error: (e) => {
          this.saving.set(false);
          this.err.set(httpErr(e));
        },
      });
    };
    if (this.cards() !== null) {
      run(this.cards()!);
    } else {
      this.api.cards$().subscribe({
        next: (v) => {
          this.cards.set(v);
          run(v);
        },
        // без списка техкарт не блокируем: сервер сам ответит 409, если заготовка используется
        error: () => run([]),
      });
    }
  }

  /** Техкарты — только для проверки удаления; тянутся один раз по требованию. */
  private cards = signal<TechCard[] | null>(null);

  private revealEditor(): void {
    setTimeout(() => {
      const el = this.editorEl()?.nativeElement;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight - 120) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}
