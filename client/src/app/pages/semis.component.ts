import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Product, Semi, Unit } from '../core/models';
import { Conv, toBaseClient } from '../core/units';
import { fmtQty, httpErr, trim } from '../core/format';

type SourceKind = 'raw' | 'semi';

/** Ребро состава: вход (сырьё или другой полуфабрикат) с нормой расхода. */
interface Edge {
  sourceType: SourceKind;
  refId: number | null;
  role: 'base' | 'additive';
  yieldPct?: number | null;
  qtyPerOutput?: number | null;
}

interface SemiDraft {
  id: number | null;
  name: string;
  note: string;
  unitId: number | null;
  shelfLifeDays: number | null;
  gPerPcs: number | null;
  mlPerPcs: number | null;
  gPerMl: number | null;
  base: { sourceType: SourceKind; refId: number | null; yieldPct: number };
  additives: { sourceType: SourceKind; refId: number | null; qtyPerOutput: number | null; yieldPct: number | null }[];
}

@Component({
  selector: 'app-semis',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🔪 Полуфабрикаты — конструктор заготовок</h1>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="grid2" style="grid-template-columns: .8fr 1.2fr;">
      <!-- ===== список ===== -->
      <div class="panel">
        <h3>Заготовки</h3>
        <div class="list-pick">
          @for (s of list(); track s.id) {
            <button [class.on]="draft()?.id === s.id" (click)="editSemi(s)">
              <b>{{ s.name }}</b>
              <div class="muted" style="font-size:12px">{{ describe(s) }}</div>
            </button>
          } @empty { <p class="muted">Пока нет ни одной заготовки</p> }
        </div>
        <hr class="hr" />
        <button class="btn" (click)="newSemi()">+ Новая заготовка</button>
      </div>

      <!-- ===== редактор ===== -->
      @if (draft(); as d) {
        <div class="panel">
          <h3>{{ d.id ? 'Редактирование' : 'Создание' }} заготовки</h3>
          <div class="row">
            <label class="f" style="flex:2">Название<input [(ngModel)]="d.name" placeholder="Картофель варёный" /></label>
            <label class="f">Ед. выхода
              <select [(ngModel)]="d.unitId">
                @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }}</option> }
              </select>
            </label>
            <label class="f" style="flex:1">Описание<input [(ngModel)]="d.note" placeholder="почистили и сварили" /></label>
          </div>
          <details class="adv">
            <summary>Доп. параметры</summary>
            <div class="adv-body">
              <div class="row">
                <label class="f">Срок годности, дней<input type="number" min="0" step="1" [(ngModel)]="d.shelfLifeDays" placeholder="напр. 3" /></label>
              </div>
          <div class="row" style="margin-top:8px;align-items:flex-end">
            <div class="muted" style="flex-basis:100%;font-size:12px">
              Пересчёт размерностей выхода — задайте только нужные связи; пусто = связь не задавать.
              Позволяет техкарте ссылаться на заготовку в г/мл, даже если её выход — в шт.
            </div>
            <label class="f">грамм в 1 шт<input type="number" min="0" [(ngModel)]="d.gPerPcs" placeholder="напр. 53" /></label>
            <label class="f">мл в 1 шт<input type="number" min="0" [(ngModel)]="d.mlPerPcs" placeholder="—" /></label>
            <label class="f">грамм в 1 мл (плотность)<input type="number" min="0" step="any" [(ngModel)]="d.gPerMl" placeholder="—" /></label>
          </div>
            </div>
          </details>
          <hr class="hr" />

          <h3>Состав заготовки</h3>
          <div class="rec">
            <div class="rec-head">
              <div>Тип</div>
              <div>Вход · сырьё или полуфабрикат</div>
              <div class="num">Расход на {{ outDenom() }} выхода</div>
              <div class="num">Выход после&nbsp;уварки, %</div>
              <div>Как расходуется</div>
              <div class="del"></div>
            </div>

            <!-- ЯДРО -->
            <div class="rec-group core">
              <div class="rec-glabel"><span class="tick"></span>Ядро · основной продукт<span class="rec-gnote">ровно одно, задаёт выход</span></div>
              <div class="rec-row is-base">
                <label class="rec-field">
                  <select [(ngModel)]="d.base.sourceType" (ngModelChange)="d.base.refId = null">
                    <option value="raw">🟦 Сырьё</option>
                    <option value="semi">🟨 Полуфабрикат</option>
                  </select>
                </label>
                <label class="rec-field">
                  <select [(ngModel)]="d.base.refId">
                    <option [ngValue]="null">— выбрать —</option>
                    @if (d.base.sourceType === 'raw') {
                      @for (p of products(); track p.id) { <option [ngValue]="p.id">{{ p.category }} · {{ p.name }}</option> }
                    } @else {
                      @for (s of availableSemis(); track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }
                    }
                  </select>
                </label>
                <div class="rec-num"><span class="rec-core">весь выход</span></div>
                <div class="rec-num"><input type="number" [(ngModel)]="d.base.yieldPct" min="1" max="100" /></div>
                <div class="rec-hint">{{ yieldHint() }}</div>
                <div class="rec-del"></div>
              </div>
            </div>

            <!-- ДОБАВКИ -->
            <div class="rec-group adds">
              <div class="rec-glabel"><span class="tick"></span>Добавки · расход на {{ outDenom() }} выхода<span class="rec-gnote">сколько угодно, необязательны</span></div>
              @for (a of d.additives; track $index) {
                <div class="rec-row">
                  <label class="rec-field">
                    <select [(ngModel)]="a.sourceType" (ngModelChange)="a.refId = null">
                      <option value="raw">🟦 Сырьё</option>
                      <option value="semi">🟨 Полуфабрикат</option>
                    </select>
                  </label>
                  <label class="rec-field">
                    <select [(ngModel)]="a.refId">
                      <option [ngValue]="null">— выбрать —</option>
                      @if (a.sourceType === 'raw') {
                        @for (p of products(); track p.id) { <option [ngValue]="p.id">{{ p.category }} · {{ p.name }}</option> }
                      } @else {
                        @for (s of availableSemis(); track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }
                      }
                    </select>
                  </label>
                  <div class="rec-num"><input type="number" [(ngModel)]="a.qtyPerOutput" placeholder="кол-во" /></div>
                  <div class="rec-num">
                    <input type="number" min="1" max="100" [(ngModel)]="a.yieldPct" placeholder="100" title="Своя уварка/выход добавки, %. Пусто = без потерь (100%)" />
                  </div>
                  <div class="rec-hint">{{ addHint(a) }}</div>
                  <div class="rec-del"><button class="btn sm danger" (click)="d.additives.splice($index, 1)">✕</button></div>
                </div>
              } @empty {
                <div class="rec-empty">Добавок нет — заготовка состоит только из ядра.</div>
              }
              <div class="rec-addrow">
                <button class="btn sm" (click)="d.additives.push({ sourceType: 'raw', refId: null, qtyPerOutput: null, yieldPct: null })">+ добавка</button>
              </div>
            </div>
          </div>

          <hr class="hr" />
          <h3>Проверка расхода (полное раскрытие до сырья)</h3>
          <div class="row" style="align-items:center">
            <label class="f">Хотим получить заготовку<input style="width:120px" type="number" [(ngModel)]="wantQty" /></label>
            <span class="muted">{{ unitCode(d.unitId) }}</span>
            <div class="spacer"></div>
          </div>
          @if (d.base.refId && wantQty > 0) {
            <table class="tbl">
              <tr><th>Понадобится сырья (сквозь все уровни)</th><th class="num">Количество</th></tr>
              @for (r of previewRows(); track r.name) {
                <tr><td>{{ r.name }}</td><td class="num">{{ r.text }}</td></tr>
              }
            </table>
          } @else {
            <p class="muted">Выберите базовый вход, чтобы увидеть расход.</p>
          }

          <hr class="hr" />
          <div class="row">
            <button class="btn primary" (click)="save()">💾 Сохранить заготовку</button>
            @if (d.id) { <button class="btn danger" (click)="remove()">Удалить</button> }
            <div class="spacer"></div>
            <button class="btn" (click)="draft.set(null)">Закрыть</button>
          </div>
        </div>
      } @else {
        <div class="panel"><p class="muted">Выберите заготовку слева или создайте новую. Заготовка может делаться как из
          складского сырья, так и из других полуфабрикатов — расход полностью раскладывается до сырья.</p></div>
      }
    </div>
  `,
  styles: [
    `
    /* доп. параметры — сворачиваемый аккордеон (details/summary) */
    .adv { margin-top: 10px; border: 1px solid var(--border); border-radius: 8px; background: #fbfcfe; }
    .adv > summary {
      cursor: pointer; padding: 9px 12px; font-weight: 600; font-size: 13px;
      color: var(--muted); list-style: none; user-select: none;
    }
    .adv > summary::-webkit-details-marker { display: none; }
    .adv > summary::before {
      content: '▸'; display: inline-block; margin-right: 8px;
      transition: transform .15s ease; color: var(--accent);
    }
    .adv[open] > summary { color: var(--text); }
    .adv[open] > summary::before { transform: rotate(90deg); }
    .adv-body { padding: 2px 12px 12px; border-top: 1px solid var(--border); }

    .rec { display: flex; flex-direction: column; }
    .rec-head, .rec-row {
      display: grid; gap: 10px; align-items: center;
      grid-template-columns: 128px minmax(170px, 1.6fr) 132px 120px minmax(160px, 1.3fr) 34px;
    }
    .rec-head {
      font-size: 11px; text-transform: uppercase; letter-spacing: .4px;
      color: var(--muted); padding: 2px 10px 8px;
    }
    .rec-head .num { text-align: right; }
    .rec-head .del { text-align: center; }
    .rec-row { padding: 6px 0; border-top: 1px solid var(--border); }

    /* группы: ядро vs добавки */
    .rec-group { margin-top: 14px; }
    .rec-group.core {
      background: var(--accent-soft); border: 1px solid #cfe0fb; border-radius: 10px;
      padding: 4px 10px 8px;
    }
    .rec-group.adds { padding: 0 10px; }
    .rec-group.core .rec-row { border-top: none; }
    .rec-glabel {
      display: flex; align-items: center; gap: 8px; padding: 8px 0 6px;
      font-size: 12px; font-weight: 700; color: var(--text);
    }
    .rec-glabel .tick { width: 9px; height: 9px; border-radius: 50%; background: var(--amber); flex: none; }
    .rec-group.core .rec-glabel { color: var(--accent); }
    .rec-group.core .rec-glabel .tick { background: var(--accent); }
    .rec-gnote { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--muted); }

    .rec-field { display: flex; min-width: 0; }
    .rec-field select { width: 100%; }
    .rec-num { display: flex; justify-content: flex-end; min-width: 0; }
    .rec-num input { width: 100%; text-align: right; font-variant-numeric: tabular-nums; }
    .rec-core {
      font-size: 11px; font-weight: 600; color: var(--accent);
      background: #fff; border: 1px solid #cfe0fb; border-radius: 999px; padding: 4px 10px; white-space: nowrap;
    }
    .rec-hint {
      font-size: 12px; color: var(--muted); line-height: 1.35; min-height: 16px;
      overflow-wrap: anywhere;
    }
    .rec-del { display: flex; justify-content: center; }
    .rec-empty {
      padding: 10px; font-size: 12px; text-align: center; color: var(--muted);
      border: 1px dashed var(--border); border-radius: 8px; margin-top: 2px;
    }
    .rec-addrow { margin-top: 8px; }
    @media (max-width: 1180px) {
      .rec-head, .rec-row {
        grid-template-columns: 116px minmax(140px, 1.4fr) 116px 104px minmax(140px, 1.2fr) 30px; gap: 8px;
      }
    }
    @media (max-width: 900px) {
      .rec-head { display: none; }
      .rec-row { grid-template-columns: 1fr 1fr; }
      .rec-hint { grid-column: 1 / -1; }
      .rec-num { justify-content: flex-start; }
      .rec-gnote { display: none; }
    }
    @media (max-width: 640px) {
      .rec-row { grid-template-columns: 1fr 1fr; gap: 8px; }
      .rec-group.core, .rec-group.adds { padding-left: 8px; padding-right: 8px; }
      .rec-num input { min-width: 0; }
    }
    `,
  ],
})
export class SemisComponent implements OnInit {
  private api = inject(ApiService);

  list = signal<Semi[]>([]);
  products = signal<Product[]>([]);
  units = signal<Unit[]>([]);
  draft = signal<SemiDraft | null>(null);
  wantQty = 1000; // в единицах выхода
  err = signal('');
  msg = signal('');

  trim = trim;

  baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));

  ngOnInit(): void {
    this.reload();
    this.api.products$({ active: 'true' }).subscribe((p) => this.products.set(p));
    this.api.units$().subscribe((u) => this.units.set(u));
  }

  reload(): void {
    this.api.semis$().subscribe({
      next: (v) => this.list.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  /** Другие полуфабрикаты, доступные как вход (исключаем редактируемый — против самоцикла). */
  availableSemis(): Semi[] {
    const id = this.draft()?.id ?? null;
    return this.list().filter((s) => s.id !== id);
  }

  describe(s: Semi): string {
    const b = s.inputs.find((i) => i.role === 'base');
    const adds = s.inputs.filter((i) => i.role === 'additive');
    let t = b ? `${b.sourceType === 'semi' ? '🟨' : '🟦'} ${b.name} → выход ${trim(Number(b.yieldPct))}%` : '';
    if (adds.length) t += ' · ' + adds.map((a) => `+${a.name}${a.yieldPct != null ? ` вых.${trim(Number(a.yieldPct))}%` : ''}`).join(' ');
    return t;
  }

  /**
   * Подсказка по добавке: в каком количестве и с учётом какого собственного уварка она расходуется.
   * В черновике qtyPerOutput хранится в удобной шкале — на 1 кг/л (1000 баз. ед.) выхода.
   */
  addHint(a: { sourceType: SourceKind; refId: number | null; qtyPerOutput: number | null; yieldPct: number | null }): string {
    if (a.refId == null) return '— выберите вход';
    const u = this.refUnit(a.sourceType, a.refId);
    const q = a.qtyPerOutput != null ? trim(Number(a.qtyPerOutput)) : '?';
    const base = `${q} ${u} на ${this.outDenom()}`;
    if (a.yieldPct == null || !(a.yieldPct > 0) || a.yieldPct >= 100) return base;
    const factor = Math.round((100 / a.yieldPct) * 100) / 100;
    return `${base} · уварок −${trim(100 - a.yieldPct)}% → вход ×${trim(factor)}`;
  }

  /** Знаменатель удобной шкалы добавок: 1 кг / 1 л / 1000 шт — по размерности единицы выхода. */
  outDenom(): string {
    const u = this.units().find((x) => x.id === this.draft()?.unitId);
    if (!u) return '1000 ед.';
    if (u.dimension === 'mass') return '1 кг';
    if (u.dimension === 'volume') return '1 л';
    return '1000 шт';
  }

  unitCode(unitId: number | null): string {
    return this.units().find((u) => u.id === unitId)?.code ?? '';
  }

  refUnit(sourceType: SourceKind, refId: number | null): string {
    if (refId == null) return '?';
    if (sourceType === 'raw') return this.products().find((p) => p.id === refId)?.unitCode ?? '?';
    return this.list().find((s) => s.id === refId)?.unitCode ?? '?';
  }

  refName(sourceType: SourceKind, refId: number | null): string {
    if (refId == null) return '';
    if (sourceType === 'raw') return this.products().find((p) => p.id === refId)?.name ?? '';
    return this.list().find((s) => s.id === refId)?.name ?? '';
  }

  newSemi(): void {
    this.msg.set('');
    this.draft.set({
      id: null, name: '', note: '',
      unitId: this.baseUnits().find((u) => u.code === 'г')?.id ?? null,
      shelfLifeDays: null,
      gPerPcs: null, mlPerPcs: null, gPerMl: null,
      base: { sourceType: 'raw', refId: null, yieldPct: 90 },
      additives: [],
    });
    this.wantQty = 1000;
  }

  editSemi(s: Semi): void {
    this.msg.set('');
    const base = s.inputs.find((i) => i.role === 'base');
    this.draft.set({
      id: s.id, name: s.name, note: s.note, unitId: s.unitId,
      shelfLifeDays: s.shelfLifeDays ?? null,
      gPerPcs: s.gPerPcs ?? null, mlPerPcs: s.mlPerPcs ?? null, gPerMl: s.gPerMl ?? null,
      base: {
        sourceType: base?.sourceType ?? 'raw',
        refId: base?.refId ?? null,
        yieldPct: base ? Number(base.yieldPct) : 90,
      },
      additives: s.inputs
        .filter((i) => i.role === 'additive')
        // БД хранит долю на 1 базовую единицу выхода; в UI показываем удобную шкалу — на 1000 (кг/л).
        .map((i) => ({ sourceType: i.sourceType, refId: i.refId, qtyPerOutput: Number(i.qtyPerOutput) * 1000, yieldPct: i.yieldPct != null ? Number(i.yieldPct) : null })),
    });
  }

  yieldHint(): string {
    const d = this.draft();
    if (!d || d.base.refId == null) return 'выберите вход';
    const u = this.refUnit(d.base.sourceType, d.base.refId);
    return `из 10 ${u} входа получится ${trim((10 * d.base.yieldPct) / 100)} ${u}`;
  }

  /** Полное рекурсивное раскрытие состава заготовки до листового сырья. */
  previewRows(): { name: string; text: string }[] {
    const d = this.draft();
    if (!d || d.base.refId == null) return [];
    const need = new Map<number, number>();
    const addRaw = (pid: number, q: number) => need.set(pid, (need.get(pid) ?? 0) + q);
    const path = new Set<number>();
    if (d.id) path.add(d.id);
    this.expandEdges(this.draftEdges(d), this.wantQty, d.unitId, addRaw, path);
    return [...need.entries()].map(([pid, q]) => {
      const p = this.products().find((x) => x.id === pid);
      return { name: p?.name ?? `#${pid}`, text: fmtQty(q, p?.unitCode ?? '') };
    });
  }

  private draftEdges(d: SemiDraft): Edge[] {
    const edges: Edge[] = [{ ...d.base, role: 'base' }];
    for (const a of d.additives) {
      if (a.refId != null && (a.qtyPerOutput ?? 0) > 0) edges.push({ ...a, role: 'additive' });
    }
    return edges;
  }

  /** Каноничная единица входа (товар/вложенный полуфабрикат) по ref. */
  private inUnitId(sourceType: SourceKind, refId: number): number | null {
    return sourceType === 'raw'
      ? this.products().find((p) => p.id === refId)?.unitId ?? null
      : this.list().find((s) => s.id === refId)?.unitId ?? null;
  }

  /** Коэффициенты пересчёта входа: conv товара (сырьё) или conv дочернего полуфабриката. */
  private inConv(sourceType: SourceKind, refId: number): Conv | null {
    const o =
      sourceType === 'raw'
        ? this.products().find((p) => p.id === refId)
        : this.list().find((s) => s.id === refId);
    return o ? { gPerPcs: o.gPerPcs, mlPerPcs: o.mlPerPcs, gPerMl: o.gPerMl } : null;
  }

  /**
   * Раскрытие рёбер состава на `outQty` баз. ед. ВЫХОДА полуфабриката (`semiUnitId`).
   * Рубеж 2: доля входа из размерности выхода переводится в каноничную единицу входа (как серверный resolveSemi).
   */
  private expandEdges(
    edges: Edge[],
    outQty: number,
    semiUnitId: number | null,
    addRaw: (pid: number, q: number) => void,
    path: Set<number>
  ): void {
    const base = edges.find((e) => e.role === 'base' && e.refId != null);
    if (!base) return;
    this.feed(base, outQty / (Number(base.yieldPct) / 100), semiUnitId, addRaw, path);
    for (const e of edges.filter((x) => x.role === 'additive' && x.refId != null)) {
      // qtyPerOutput в черновике — на 1000 ед. выхода, поэтому /1000
      let q = (outQty * Number(e.qtyPerOutput)) / 1000;
      if (e.yieldPct != null && Number(e.yieldPct) > 0) q = q / (Number(e.yieldPct) / 100);
      this.feed(e, q, semiUnitId, addRaw, path);
    }
  }

  private feed(
    e: Edge,
    qty: number,
    semiUnitId: number | null,
    addRaw: (pid: number, q: number) => void,
    path: Set<number>
  ): void {
    if (e.refId == null) return;
    const targetUnit = this.inUnitId(e.sourceType, e.refId);
    const converted = toBaseClient(this.units(), qty, semiUnitId, targetUnit, this.inConv(e.sourceType, e.refId));
    // Путь пересчёта не задан — оставляем прежний расчёт «в размерности выхода» (как сервер вернул бы ошибку, но UI не роняем).
    const qTarget = converted ?? qty;
    if (e.sourceType === 'raw') {
      addRaw(e.refId, qTarget);
      return;
    }
    if (path.has(e.refId)) return; // защита от цикла
    const sub = this.list().find((s) => s.id === e.refId);
    if (!sub) return;
    const subEdges: Edge[] = sub.inputs.map((i) => ({
      sourceType: i.sourceType, refId: i.refId, role: i.role,
      yieldPct: i.yieldPct != null ? Number(i.yieldPct) : null,
      qtyPerOutput: i.qtyPerOutput != null ? Number(i.qtyPerOutput) : null,
    }));
    this.expandEdges(subEdges, qTarget, sub.unitId, addRaw, new Set([...path, e.refId]));
  }

  save(): void {
    const d = this.draft();
    if (!d) return;
    this.err.set('');
    if (!d.name.trim() || !d.unitId || d.base.refId == null) {
      this.err.set('Заполните название, единицу выхода и базовый вход');
      return;
    }
    const inputs: Record<string, unknown>[] = [
      { sourceType: d.base.sourceType, refId: d.base.refId, role: 'base', yieldPct: d.base.yieldPct },
      ...d.additives
        .filter((a) => a.refId != null && (a.qtyPerOutput ?? 0) > 0)
        .map((a) => ({ sourceType: a.sourceType, refId: a.refId, role: 'additive', qtyPerOutput: (a.qtyPerOutput ?? 0) / 1000, yieldPct: (a.yieldPct ?? 0) > 0 && (a.yieldPct ?? 0) < 100 ? a.yieldPct : null })),
    ];
    const body = {
      name: d.name.trim(), note: d.note, unitId: d.unitId,
      shelfLifeDays: d.shelfLifeDays === null || (d.shelfLifeDays as unknown) === '' || !Number.isFinite(Number(d.shelfLifeDays))
        ? null : Math.trunc(Number(d.shelfLifeDays)),
      gPerPcs: d.gPerPcs, mlPerPcs: d.mlPerPcs, gPerMl: d.gPerMl,
      inputs,
    };
    const sub = {
      next: () => {
        this.msg.set(`Заготовка «${d.name}» сохранена ✓`);
        this.reload();
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    };
    if (d.id) this.api.patchSemi(d.id, body).subscribe(sub);
    else this.api.createSemi(body).subscribe(sub);
  }

  remove(): void {
    const d = this.draft();
    if (!d?.id || !confirm(`Удалить заготовку «${d.name}»?`)) return;
    this.api.deleteSemi(d.id).subscribe({
      next: () => {
        this.draft.set(null);
        this.msg.set('Заготовка удалена');
        this.reload();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }
}
