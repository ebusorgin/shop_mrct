import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, forkJoin, of } from 'rxjs';
import { ApiService } from '../core/api.service';
import { AiCoefficient, Unit } from '../core/models';
import { httpErr } from '../core/format';
import { ModalComponent } from './modal.component';

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
 * Модальное окно позиции номенклатуры склада — то же, что «Новая позиция» на странице «Склад».
 * Родитель показывает его через @if: компонент существует в DOM только когда открыт.
 * productId = null — создание; иначе сначала подтягиваем полную карточку продукта.
 * Выходы: saved — позиция сохранена (родитель перезагружает свои списки), closed — закрыто без сохранения.
 */
@Component({
  selector: 'app-product-edit',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [title]="edit.id ? 'Редактировать позицию' : 'Новая позиция'" (closed)="closed.emit()">
      @if (err()) { <div class="err">{{ err() }}</div> }
      @if (edit.id !== null && !loaded()) { <p class="muted">Загружаем позицию…</p> }
      <div class="row">
        <label class="f" style="flex:2">Название<input [(ngModel)]="edit.name" placeholder="Картофель" /></label>
        <label class="f">Категория
          <select [(ngModel)]="edit.category">
            <option value="">— без категории («прочее») —</option>
            @for (c of categoryOptions(); track c) { <option [value]="c">{{ c }}</option> }
          </select>
        </label>
        <label class="f">Ед. хранения (базовая)
          <select [(ngModel)]="edit.unitId">
            @for (u of baseUnits(); track u.id) { <option [ngValue]="u.id">{{ u.code }} — {{ u.name }}</option> }
          </select>
        </label>
        <label class="f">Мин. остаток, {{ editUnitCode() }}<input type="number" [(ngModel)]="edit.minStock" /></label>
        <label class="f">Срок годности, дней<input type="number" min="0" step="1" [(ngModel)]="edit.shelfLifeDays" placeholder="напр. 90" /></label>
        @if (edit.id) {
          <label class="f" style="flex-direction:row;align-items:center;gap:6px">
            <input type="checkbox" [(ngModel)]="edit.active" /> активен
          </label>
        }
      </div>
      <div class="ai-head">
        <div class="muted">
          Доп. единицы и пересчёт — задайте только нужные связи; пустое = связь не задавать.
          Пересчёт работает между шт↔г (грамм в 1 шт), шт↔мл (мл в 1 шт) и г↔мл (плотность).
        </div>
        <button type="button" class="btn sm ai" (click)="askAi()"
                [disabled]="asking() || saving() || !edit.name.trim()"
                title="Спросить у GPT типичные значения и подставить их в поля; сохраняет по-прежнему человек">
          {{ asking() ? '🤖 Спрашиваю…' : '🤖 Спросить у ИИ' }}
        </button>
      </div>
      <div class="row" style="align-items:flex-end">
        <label class="f">грамм в 1 шт<input type="number" min="0" [(ngModel)]="edit.gPerPcs" placeholder="напр. 55" /></label>
        <label class="f">мл в 1 шт<input type="number" min="0" [(ngModel)]="edit.mlPerPcs" placeholder="напр. 50" /></label>
        <label class="f">грамм в 1 мл (плотность)<input type="number" min="0" step="any" [(ngModel)]="edit.gPerMl" placeholder="напр. 1.4" /></label>
      </div>
      @if (aiLines().length) {
        <div class="ai-note">
          <div class="ai-note-head">🤖 {{ aiModel() || 'GPT' }}: значения подставлены в поля — проверьте и поправьте перед сохранением</div>
          @for (l of aiLines(); track l.field) {
            <div><b>{{ l.label }}</b> — {{ l.text }}</div>
          }
        </div>
      }
      @if (aiErr()) { <div class="err" style="margin-top:8px">{{ aiErr() }}</div> }
      <div modalFooter>
        <button class="btn" (click)="closed.emit()">Отмена</button>
        <button class="btn primary" [disabled]="saving() || (edit.id !== null && !loaded())" (click)="save()">{{ saving() ? 'Сохраняем…' : 'Сохранить' }}</button>
      </div>
    </app-modal>
  `,
  styles: [
    `
    .ai-head { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .ai-head .muted { flex: 1 1 420px; font-size: 12px; }
    .btn.ai { border-color: #d9c9f5; background: #f8f4ff; color: #5b3fbf; flex: 0 0 auto; }
    .btn.ai:hover:not(:disabled) { background: #efe6ff; }
    .ai-note { margin-top: 8px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
    .ai-note b { color: var(--text); font-weight: 600; }
    .ai-note-head { color: var(--text); }
    `,
  ],
})
export class ProductEditComponent implements OnInit {
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
    const fields: ConvField[] = ['gPerPcs', 'mlPerPcs', 'gPerMl'];
    forkJoin(
      fields.map((field) =>
        this.api.askCoefficient$({ ...base, field }).pipe(
          // одно поле может не ответить — остальные подсказки всё равно нужны
          catchError((e: unknown) =>
            of({
              field,
              unit: '',
              value: null,
              confidence: 'low',
              reason: `не удалось спросить: ${httpErr(e)}`,
              model: '',
            } as AiCoefficient)
          )
        )
      )
    ).subscribe((results) => {
      const lines: AiLine[] = [];
      let model = '';
      for (const r of results) {
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
    });
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
