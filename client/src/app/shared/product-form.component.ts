import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Unit } from '../core/models';
import { httpErr } from '../core/format';
import { HintDirective } from './hint.directive';

type ConvField = 'gPerPcs' | 'mlPerPcs' | 'gPerMl';

/** Строка подсказки под полями: что подставили (или почему не подставили). */
interface AiLine {
  field: ConvField;
  label: string;
  text: string;
}

const AI_LABELS: Record<ConvField, string> = {
  gPerPcs: 'грамм в 1 шт',
  mlPerPcs: 'мл в 1 шт',
  gPerMl: 'грамм в 1 мл',
};

const AI_CONFIDENCE: Record<string, string> = { high: 'высокая', medium: 'средняя', low: 'низкая' };

/**
 * Форма позиции номенклатуры без модального окна: поля, коэффициенты, «Спросить у ИИ» и кнопки.
 * Используется и в отдельном окне «Новая позиция», и во вкладке «Редактирование» карточки позиции.
 * productId = null — создание; иначе сначала подтягиваем полную карточку продукта.
 * Выходы: saved — позиция сохранена (родитель перезагружает списки), closed — отмена.
 */
@Component({
  selector: 'app-product-form',
  standalone: true,
  imports: [CommonModule, FormsModule, HintDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (edit.id !== null && !loaded()) { <p class="muted">Загружаем позицию…</p> }
        <div class="pform">
      <section class="pf-sec">
        <div class="pf-sec-head">
          <div>
            <div class="pf-eyebrow">Основное</div>
            <div class="pf-sec-note">Название и варианты, по которым позиция узнаётся в накладных и поиске.</div>
          </div>
        </div>
        <div class="pf-grid pf-grid-1">
          <label class="f">
            <span class="f-label">Название
              <button type="button" class="hint" aria-label="Что значит «Название»"
                      hintTitle="Название позиции"
                      [appHint]="'Так позиция называется в номенклатуре, поиске, накладных, заказах и на карте производства. По названию сопоставляются строки накладных и Google-таблицы, поэтому пишите его так же, как у поставщика. Произвольный текст.'">?</button>
            </span>
            <input [(ngModel)]="edit.name" placeholder="Картофель" />
          </label>
          <div class="f">
            <span class="f-label">Псевдонимы
              <button type="button" class="hint" aria-label="Что такое «Псевдонимы»"
                      hintTitle="Псевдонимы"
                      [appHint]="'Как поставщик или накладная называет эту позицию. По псевдонимам распознаются строки накладных и работает поиск на складе. Вводите через запятую или Enter; регистр и лишние пробелы не важны.'">?</button>
            </span>
            <div class="alias-editor">
              @for (a of aliases(); track a) {
                <span class="alias-chip">{{ a }}<button type="button" (click)="removeAlias(a)" aria-label="Удалить псевдоним">×</button></span>
              }
              <input [ngModel]="aliasDraft()" (ngModelChange)="aliasDraft.set($event)"
                     (keydown.enter)="addAlias($event)" (blur)="addAlias()"
                     placeholder="Например: Krompir, картофель отборный" />
            </div>
            <div class="pf-hintline">Через запятую или Enter. По псевдонимам распознаются накладные и ищется позиция на складе.</div>
          </div>
        </div>
      </section>

      <section class="pf-sec">
        <div class="pf-sec-head">
          <div>
            <div class="pf-eyebrow">Классификация и учёт</div>
            <div class="pf-sec-note">Где позиция используется, в чём хранится и когда о ней предупреждать.</div>
          </div>
        </div>
        <div class="pf-grid pf-grid-3">
          <label class="f">
            <span class="f-label">Категория
              <button type="button" class="hint" aria-label="Что значит «Категория»"
                      hintTitle="Складская категория"
                      [appHint]="'Группа для фильтров склада, выбора сырья в рецептуре и облаков на карте производства. На расчёты, списание и цены не влияет. «Без категории» означает «прочее».'">?</button>
            </span>
            <select [(ngModel)]="edit.category">
              <option value="">— без категории («прочее») —</option>
              @for (c of categoryOptions(); track c) { <option [value]="c">{{ c }}</option> }
            </select>
          </label>
          <label class="f">
            <span class="f-label">Ед. хранения (базовая)
              <button type="button" class="hint" aria-label="Что значит «Единица хранения»"
                      hintTitle="Базовая единица"
                      [appHint]="'Единица, в которой ведутся остатки и все движения: г, мл или шт. Количества в накладных, списаниях, составе рецептур и отчётах пересчитываются в неё по коэффициентам ниже. У позиции с историей движений единицу менять нельзя без пересчёта остатков.'">?</button>
            </span>
            <select [(ngModel)]="edit.unitId">
              @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }} — {{ u.name }}</option> }
            </select>
          </label>
          <label class="f">
            <span class="f-label">Мин. остаток, {{ editUnitCode() }}
              <button type="button" class="hint" aria-label="Что значит «Минимальный остаток»"
                      hintTitle="Минимальный остаток"
                      [appHint]="'Порог контроля остатка в базовой единице. Когда остаток опускается ниже, склад подсвечивает позицию; списание при этом не блокируется. 0 — не контролировать. Вводится число в текущей базовой единице.'">?</button>
            </span>
            <input type="number" [(ngModel)]="edit.minStock" />
          </label>
        </div>
        <div class="pf-grid pf-grid-2 pf-gap-top">
          <label class="f">
            <span class="f-label">Срок годности, дней
              <button type="button" class="hint" aria-label="Что значит «Срок годности»"
                      hintTitle="Срок годности"
                      [appHint]="'Сколько дней позиция годна с даты прихода. Используется для подсказок по годности партии; пусто — срок не задан. Целое число дней; на списание и цены не влияет.'">?</button>
            </span>
            <input type="number" min="0" step="1" [(ngModel)]="edit.shelfLifeDays" placeholder="напр. 90" />
          </label>
          @if (edit.id) {
            <label class="f">
              <span class="f-label">Статус
                <button type="button" class="hint" aria-label="Что значит «Статус»"
                        hintTitle="Статус позиции"
                        [appHint]="'Активная позиция доступна в накладных, рецептурах и поиске. Снятая с учёта остаётся в истории и старых документах, но не предлагается для новых операций.'">?</button>
              </span>
              <span class="pf-check"><input type="checkbox" [(ngModel)]="edit.active" /> активна</span>
            </label>
          }
        </div>
      </section>

      <section class="pf-sec">
        <div class="pf-sec-head">
          <div>
            <div class="pf-eyebrow">Пересчёт единиц</div>
            <div class="pf-sec-note">Задайте только нужные связи; пустое — связь не задана. Работает между шт↔г, шт↔мл и г↔мл.</div>
          </div>
          <button type="button" class="btn sm ai" (click)="askAi()"
                  [disabled]="asking() || saving() || !edit.name.trim()"
                  title="Спросить у ИИ типичные значения и подставить их в поля; сохраняет по-прежнему человек">
            {{ asking() ? '🤖 Спрашиваю…' : '🤖 Спросить у ИИ' }}
          </button>
        </div>
        <div class="pf-grid pf-grid-3">
          <label class="f">грамм в 1 шт<input type="number" min="0" [(ngModel)]="edit.gPerPcs" placeholder="напр. 55" /></label>
          <label class="f">мл в 1 шт<input type="number" min="0" [(ngModel)]="edit.mlPerPcs" placeholder="напр. 50" /></label>
          <label class="f">грамм в 1 мл (плотность)<input type="number" min="0" step="any" [(ngModel)]="edit.gPerMl" placeholder="напр. 1.4" /></label>
        </div>
        @if (aiLines().length) {
          <div class="ai-note">
            <div class="ai-note-head">🤖 {{ aiModel() || 'ИИ' }}: значения подставлены в поля — проверьте и поправьте перед сохранением</div>
            @for (l of aiLines(); track l.field) {
              <div><b>{{ l.label }}</b> — {{ l.text }}</div>
            }
          </div>
        }
        @if (aiErr()) { <div class="err pf-gap-top">{{ aiErr() }}</div> }
      </section>

      <div class="form-actions">
        <button type="button" class="btn" (click)="closed.emit()">Отмена</button>
        <button type="button" class="btn primary" [disabled]="saving() || (edit.id !== null && !loaded())" (click)="save()">{{ saving() ? 'Сохраняем…' : 'Сохранить' }}</button>
      </div>
    </div>`,
  styles: [
    `
    .pform { display: flex; flex-direction: column; gap: 14px; }
    .pf-sec { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
    .pf-sec-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .pf-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
    .pf-sec-note { margin-top: 3px; font-size: 12px; line-height: 1.4; color: var(--muted); }
    .pf-grid { display: grid; gap: 12px; }
    .pf-grid-1 { grid-template-columns: 1fr; }
    .pf-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pf-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .pf-gap-top { margin-top: 12px; }
    .pf-grid label.f { margin: 0; min-width: 0; }
    .pf-grid input, .pf-grid select { width: 100%; }
    .f-label { display: flex; align-items: center; gap: 2px; font-weight: 600; color: var(--text); }
    .hint {
      position: relative; display: inline-flex; align-items: center; justify-content: center;
      width: 15px; height: 15px; margin-left: 4px; border-radius: 50%;
      background: #e9e3d6; color: #6f6048; font-size: 9.5px; font-weight: 800;
      cursor: help; text-transform: none; vertical-align: middle; border: 0; padding: 0; font-family: inherit;
    }
    .hint:hover, .hint:focus { background: #dcd2bf; outline: none; }
    .alias-editor {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      min-height: 40px; padding: 6px 8px; border: 1px solid var(--border);
      border-radius: 8px; background: #fff;
    }
    .alias-editor:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .alias-editor input { width: auto; flex: 1 1 160px; min-width: 140px; border: 0; box-shadow: none; padding: 4px 2px; }
    .alias-chip {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px;
      border-radius: 999px; background: #eef3f8; color: #2c4a66; font-size: 12px; line-height: 1.2;
    }
    .alias-chip button {
      border: 0; background: transparent; color: #6b7d8f; cursor: pointer;
      font-size: 14px; line-height: 1; padding: 0 2px;
    }
    .alias-chip button:hover { color: #b4483e; }
    .pf-hintline { margin-top: 4px; font-size: 11px; line-height: 1.35; color: var(--muted); }
    .pf-check {
      display: inline-flex; align-items: center; gap: 8px; min-height: 38px;
      padding: 0 2px; font-size: 13px; color: var(--text);
    }
    .pf-check input { width: 16px; height: 16px; accent-color: var(--accent); }
    .btn.ai { border-color: #d9c9f5; background: #f8f4ff; color: #5b3fbf; flex: 0 0 auto; }
    .btn.ai:hover:not(:disabled) { background: #efe6ff; }
    .ai-note { margin-top: 10px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
    .ai-note b { color: var(--text); font-weight: 600; }
    .ai-note-head { color: var(--text); }
    .form-actions {
      display: flex; gap: 10px; justify-content: flex-end; align-items: center;
      margin-top: 2px; padding-top: 14px; border-top: 1px solid var(--border);
    }
    @media (max-width: 640px) {
      .pf-grid-2, .pf-grid-3 { grid-template-columns: 1fr; }
      .form-actions .btn { flex: 1 1 auto; justify-content: center; }
    }
    `,
  ],
})export class ProductFormComponent implements OnInit {
  private api = inject(ApiService);
  private cdr = inject(ChangeDetectorRef);

  /** null — новая позиция; иначе id редактируемой (карточка подтягивается с сервера). */
  @Input() productId: number | null = null;
  @Output() saved = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  err = signal('');
  saving = signal(false);
  loaded = signal(false);
  units = signal<Unit[]>([]);
  categories = signal<string[]>([]);
  /** Ждём GPT по трём коэффициентам — один запрос на поле, ответы могут идти десятки секунд. */
  asking = signal(false);
  aiLines = signal<AiLine[]>([]);
  aiModel = signal('');
  aiErr = signal('');
  /** Псевдонимы позиции: как поставщик/накладная называет товар. */
  aliases = signal<string[]>([]);
  aliasDraft = signal('');

  edit: {
    id: number | null; name: string; category: string; unitId: number | null; minStock: number; active: boolean;
    shelfLifeDays: number | null;
    gPerPcs: number | null; mlPerPcs: number | null; gPerMl: number | null;
  } = { id: null, name: '', category: '', unitId: null, minStock: 0, active: true,
      shelfLifeDays: null, gPerPcs: null, mlPerPcs: null, gPerMl: null };

  /** Только базовые единицы (г/мл/шт) — в них склад хранит остатки. */
  baseUnits = computed(() => this.units().filter((u) => u.baseFactor === 1));
  editUnitCode = computed(() => this.units().find((u) => u.id === this.edit.unitId)?.code ?? '…');

  ngOnInit(): void {
    this.api.units$().subscribe((u) => this.units.set(u));
    this.api.categoriesDictionary$().subscribe((list) => {
      this.categories.set(list.map((c) => c.name));
      this.canonicalizeCategory();
    });
    if (this.productId === null) {
      this.loaded.set(true);
      return;
    }
    this.api.product$(this.productId).subscribe({
      next: (p) => {
        this.edit = {
          id: p.id, name: p.name, category: (p.category ?? '').trim(), unitId: p.unitId, minStock: p.minStock, active: p.active,
          shelfLifeDays: p.shelfLifeDays ?? null,
          gPerPcs: p.gPerPcs ?? null, mlPerPcs: p.mlPerPcs ?? null, gPerMl: p.gPerMl ?? null,
        };
        this.aliases.set(Array.isArray(p.aliases) ? p.aliases : []);
        this.canonicalizeCategory();
        this.loaded.set(true);
        // edit — обычный объект, для OnPush-вьюхи это не триггер перерисовки
        this.cdr.markForCheck();
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  /** Варианты выбора: справочник + текущее значение, если его там нет (старые данные). */
  categoryOptions(): string[] {
    const list = this.categories();
    const cur = this.edit.category.trim();
    if (cur && !list.some((c) => c.toLowerCase() === cur.toLowerCase())) return [cur, ...list];
    return list;
  }

  /** «Прочее» показываем пустым пунктом; имя категории приводим к написанию из справочника. */
  private canonicalizeCategory(): void {
    const cur = this.edit.category.trim();
    if (!cur || cur.toLowerCase() === 'прочее') {
      this.edit.category = '';
      return;
    }
    const match = this.categories().find((c) => c.toLowerCase() === cur.toLowerCase());
    this.edit.category = match ?? cur;
  }

  /**
   * Спросить у GPT три величины пересчёта и подставить подходящие числа в поля.
   * Ничего не сохраняем: это те же подсказки, что и в полуфабрикатах, — решение за человеком.
   * Для сохранённой позиции сервер берёт её карточку из базы, для новой — описание из формы.
   */
  askAi(): void {
    const name = this.edit.name.trim();
    if (!name || this.asking()) return;
    this.asking.set(true);
    this.aiErr.set('');
    this.aiLines.set([]);
    this.aiModel.set('');
    const unitCode = this.units().find((u) => u.id === this.edit.unitId)?.code ?? null;
    const base = this.edit.id
      ? { sourceType: 'raw' as const, refId: this.edit.id }
      : { sourceType: 'raw' as const, name, unitCode, context: this.edit.category.trim() || null };
    this.api.askCoefficients$(base).subscribe({
      next: (res) => {
        const lines: AiLine[] = [];
        let model = '';
        for (const r of res.results) {
          if (r.model) model = r.model;
          if (r.value != null) {
            if (r.field === 'gPerPcs') this.edit.gPerPcs = r.value;
            else if (r.field === 'mlPerPcs') this.edit.mlPerPcs = r.value;
            else this.edit.gPerMl = r.value;
            lines.push({
              field: r.field,
              label: AI_LABELS[r.field],
              text: `${r.value} ${r.unit} · ${r.reason} · уверенность: ${AI_CONFIDENCE[r.confidence] ?? r.confidence}`,
            });
          } else {
            lines.push({ field: r.field, label: AI_LABELS[r.field], text: `не подставили — ${r.reason}` });
          }
        }
        this.aiModel.set(model);
        this.aiLines.set(lines);
        this.asking.set(false);
        this.cdr.markForCheck();
      },
      error: (e: unknown) => {
        this.asking.set(false);
        this.aiErr.set(`не удалось спросить: ${httpErr(e)}`);
        this.cdr.markForCheck();
      },
    });
  }

  addAlias(ev?: Event): void {
    ev?.preventDefault();
    const parts = this.aliasDraft().split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
    this.aliasDraft.set('');
    if (!parts.length) return;
    const key = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').trim();
    const current = this.aliases();
    const seen = new Set(current.map(key));
    const next = current.slice();
    for (const part of parts) {
      const k = key(part);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      next.push(part);
    }
    if (next.length !== current.length) this.aliases.set(next);
  }

  removeAlias(alias: string): void {
    this.aliases.update((list) => list.filter((x) => x !== alias));
  }

  save(): void {
    this.err.set('');
    const conv = (v: number | string | null): number | null =>
      v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    const body: Record<string, unknown> = {
      name: this.edit.name,
      category: this.edit.category || 'прочее',
      unitId: this.edit.unitId,
      minStock: this.edit.minStock,
      shelfLifeDays: conv(this.edit.shelfLifeDays as number | string | null),
      gPerPcs: conv(this.edit.gPerPcs as number | string | null),
      mlPerPcs: conv(this.edit.mlPerPcs as number | string | null),
      gPerMl: conv(this.edit.gPerMl as number | string | null),
      aliases: this.aliases(),
    };
    this.saving.set(true);
    const sub = {
      next: () => { this.saving.set(false); this.saved.emit(); },
      error: (e: unknown) => { this.saving.set(false); this.err.set(httpErr(e)); },
    };
    if (this.edit.id) {
      body['active'] = this.edit.active;
      this.api.patchProduct(this.edit.id, body).subscribe(sub);
    } else {
      this.api.createProduct(body).subscribe(sub);
    }
  }
}
