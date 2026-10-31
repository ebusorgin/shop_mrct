import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { Unit } from '../core/models';
import { httpErr } from '../core/format';
import { ModalComponent } from './modal.component';

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
        <label class="f">Категория<input [(ngModel)]="edit.category" list="pe-cats" placeholder="овощи" /></label>
        <datalist id="pe-cats">@for (c of categories(); track c) { <option [value]="c"></option> }</datalist>
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
      <div class="row" style="margin-top:12px;align-items:flex-end">
        <div class="muted" style="flex-basis:100%;font-size:12px">
          Доп. единицы и пересчёт — задайте только нужные связи; пустое = связь не задавать.
          Пересчёт работает между шт↔г (грамм в 1 шт), шт↔мл (мл в 1 шт) и г↔мл (плотность).
        </div>
        <label class="f">грамм в 1 шт<input type="number" min="0" [(ngModel)]="edit.gPerPcs" placeholder="напр. 55" /></label>
        <label class="f">мл в 1 шт<input type="number" min="0" [(ngModel)]="edit.mlPerPcs" placeholder="напр. 50" /></label>
        <label class="f">грамм в 1 мл (плотность)<input type="number" min="0" step="any" [(ngModel)]="edit.gPerMl" placeholder="напр. 1.4" /></label>
      </div>
      <div modalFooter>
        <button class="btn" (click)="closed.emit()">Отмена</button>
        <button class="btn primary" [disabled]="saving() || (edit.id !== null && !loaded())" (click)="save()">{{ saving() ? 'Сохраняем…' : 'Сохранить' }}</button>
      </div>
    </app-modal>
  `,
})
export class ProductEditComponent implements OnInit {
  private api = inject(ApiService);

  /** null — новая позиция; иначе id редактируемой (карточка подтягивается с сервера). */
  @Input() productId: number | null = null;
  @Output() saved = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  err = signal('');
  saving = signal(false);
  loaded = signal(false);
  units = signal<Unit[]>([]);
  categories = signal<string[]>([]);

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
    this.api.categories$().subscribe((c) => this.categories.set(c));
    if (this.productId === null) {
      this.loaded.set(true);
      return;
    }
    this.api.product$(this.productId).subscribe({
      next: (p) => {
        this.edit = {
          id: p.id, name: p.name, category: p.category, unitId: p.unitId, minStock: p.minStock, active: p.active,
          shelfLifeDays: p.shelfLifeDays ?? null,
          gPerPcs: p.gPerPcs ?? null, mlPerPcs: p.mlPerPcs ?? null, gPerMl: p.gPerMl ?? null,
        };
        this.loaded.set(true);
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
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
