import { ChangeDetectionStrategy, Component, EventEmitter, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { RawCategory, RawProductRef } from '../core/models';
import { httpErr } from '../core/format';
import { ProductEditComponent } from './product-edit.component';

/**
 * Дерево категорий сырья (номенклатура склада): узел = категория, потомки = позиции.
 * Плашка «прочее» — нераспределённые; ✎ открывает общую модалку позиции, × отвязывает.
 * Данные — эндпоинты /api/settings/raw-* (только администратор).
 * changed — любое изменение данных (родитель может обновить свои списки категорий).
 */
@Component({
  selector: 'app-raw-categories',
  standalone: true,
  imports: [CommonModule, FormsModule, ProductEditComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .tree { display: flex; flex-direction: column; gap: 2px; }
    .node-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; cursor: pointer; user-select: none; }
    .node-row:hover { background: #f4f7fb; }
    .twist { font-size: 10px; color: var(--muted); width: 12px; flex: none; transition: transform .12s; }
    .twist.open { transform: rotate(90deg); }
    .cat-name { font-weight: 600; text-transform: capitalize; }
    .cat-input { max-width: 220px; }
    .cnt { font-size: 12px; color: var(--muted); background: #eef1f5; border-radius: 10px; padding: 1px 8px; }
    .actions { display: flex; gap: 4px; align-items: center; margin-left: auto; flex: none; }
    .children { margin: 2px 0 8px 20px; padding-left: 16px; border-left: 2px solid var(--border); }
    .child { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 4px; }
    .child:hover { background: #f4f7fb; }
    .child .dot { color: var(--muted); flex: none; }
    .child-name { font-size: 13px; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* крестик — сразу за названием, всегда виден: до него тянуться не нужно */
    .child .x { flex: none; background: none; border: none; cursor: pointer; font-size: 15px; line-height: 1;
      color: #b6bec9; padding: 2px 5px; border-radius: 4px; }
    .child .x:hover { color: var(--red); background: #fdeaec; }
    /* карандаш «редактировать позицию» — тот же приём, но синяя подсветка */
    .pen { flex: none; background: none; border: none; cursor: pointer; font-size: 13px; line-height: 1;
      color: #b6bec9; padding: 2px 5px; border-radius: 4px; }
    .pen:hover { color: var(--accent); background: #eaf1fb; }
    .add-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
    .leaf-add { color: var(--muted); font-size: 13px; padding: 2px 0 0 3px; }
    /* плашка нераспределённых позиций */
    .unass { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; background: #fcfcfd; }
    .unass-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .unass-head b { font-size: 13px; }
    .unass-warn { color: #b06a00; font-size: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 12px;
      background: #eef1f5; font-size: 12px; color: #3c4450; }
    .chip-none { font-size: 13px; color: var(--green); }
  `],
  template: `
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="unass">
      <div class="unass-head">
        <b>Ни в одной категории («прочее»)</b>
        <span class="cnt">{{ unassigned().length }}</span>
        @if (unassigned().length) {
          <span class="unass-warn">— распределите позиции по категориям</span>
        }
      </div>
      <div class="chips">
        @for (p of unassigned(); track p.id) {
          <span class="chip">{{ p.name }}<button class="pen" (click)="editProduct(p.id)" title="Редактировать позицию">✎</button></span>
        } @empty {
          <span class="chip-none">Отлично — всё сырьё распределено</span>
        }
      </div>
    </div>

    <div class="tree">
      @for (cat of cats(); track cat.id) {
        <div class="node">
          <div class="node-row" (click)="toggleExpand(cat.id)">
            <span class="twist" [class.open]="expandedIds().has(cat.id)">▶</span>
            @if (editingCat() === cat.id) {
              <input class="cat-input" [ngModel]="editCatName()" (ngModelChange)="editCatName.set($event)"
                (click)="$event.stopPropagation()" (keyup.enter)="saveRename()" (keyup.escape)="editingCat.set(null)" />
              <span class="actions">
                <button class="btn sm primary" (click)="$event.stopPropagation(); saveRename()">✓</button>
                <button class="btn sm" (click)="$event.stopPropagation(); editingCat.set(null)">✕</button>
              </span>
            } @else {
              <span class="cat-name">{{ cat.name }}</span>
              <span class="cnt">{{ cat.productCount }}</span>
              <span class="actions">
                <button class="btn sm" (click)="$event.stopPropagation(); startRename(cat)" title="Переименовать">✎</button>
                <button class="btn sm danger" (click)="$event.stopPropagation(); deleteCat(cat.id)" title="Удалить">🗑</button>
              </span>
            }
          </div>
          @if (expandedIds().has(cat.id)) {
            <div class="children">
              @for (p of productsOf(cat.id); track p.id) {
                <div class="child">
                  <span class="dot">└</span>
                  <span class="child-name" [title]="p.name">{{ p.name }}</span>
                  <button class="pen" (click)="editProduct(p.id)" title="Редактировать позицию">✎</button>
                  <button class="x" (click)="removeProduct(cat.id, p.id)" title="Убрать в «прочее»">×</button>
                </div>
              }
              <div class="leaf-add">@if (!productsOf(cat.id).length) { В категории пока нет позиций }</div>
              <div class="add-row">
                <select class="minw0" [ngModel]="pickOf(cat.id)" (ngModelChange)="setPick(cat.id, $event)">
                  <option [ngValue]="null">+ выбрать из нераспределённых</option>
                  @for (p of unassigned(); track p.id) {
                    <option [ngValue]="p.id">{{ p.name }}</option>
                  }
                </select>
                <button class="btn sm" [disabled]="!pickOf(cat.id)" (click)="addProduct(cat.id)">Добавить</button>
              </div>
            </div>
          }
        </div>
      } @empty {
        <div class="muted" style="padding:8px">Категории не созданы</div>
      }
    </div>

    <div class="row mt">
      <input class="cat-input" placeholder="Новая категория сырья" [ngModel]="newCatName()" (ngModelChange)="newCatName.set($event)" (keyup.enter)="createCat()" />
      <button class="btn sm primary" [disabled]="!newCatName().trim()" (click)="createCat()">+ Добавить</button>
    </div>

    @if (editOpen()) {
      <app-product-edit [productId]="editId()" (saved)="onProductSaved()" (closed)="editOpen.set(false)" />
    }
  `,
})
export class RawCategoriesComponent implements OnInit {
  private api = inject(ApiService);

  /** Данные дерева изменились (позиция/категория) — родитель обновляет свои списки. */
  @Output() changed = new EventEmitter<void>();

  err = signal('');
  msg = signal('');
  cats = signal<RawCategory[]>([]);
  all = signal<RawProductRef[]>([]);
  /** Множество id раскрытых категорий (несколько веток открыты независимо). */
  expandedIds = signal<Set<number>>(new Set());
  /** Кэш позиций раскрытых категорий: catId → products. */
  productsByCat = signal<Map<number, RawProductRef[]>>(new Map());
  /** Черновик выбранной позиции для добавления: catId → productId. */
  pickByCat = signal<Map<number, number | null>>(new Map());
  newCatName = signal('');
  editingCat = signal<number | null>(null);
  editCatName = signal('');
  /** Окно позиции — общая модалка «Новая позиция» (app-product-edit). */
  editOpen = signal(false);
  editId = signal<number | null>(null);

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.rawCategories$().subscribe((r) => this.cats.set(r));
    this.api.allRawProducts$().subscribe((r) => this.all.set(r));
  }

  /** Позиции без категории («прочее»/вне словаря) — плашка сверху и источник для пикера. */
  unassigned = computed(() => this.all().filter((p) => p.categoryId === null || p.categoryId === undefined));

  createCat(): void {
    const name = this.newCatName().trim();
    if (!name) return;
    this.api.createRawCategory$(name).subscribe({
      next: () => { this.newCatName.set(''); this.load(); this.changed.emit(); },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  startRename(cat: RawCategory): void {
    this.editingCat.set(cat.id);
    this.editCatName.set(cat.name);
  }

  saveRename(): void {
    const id = this.editingCat();
    const name = this.editCatName().trim();
    if (!id || !name) { this.editingCat.set(null); return; }
    this.api.renameRawCategory$(id, name).subscribe({
      next: () => { this.editingCat.set(null); this.load(); this.refreshOpenBranches(); this.changed.emit(); },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  deleteCat(id: number): void {
    if (!confirm('Удалить категорию? Позиции уйдут в «прочее».')) return;
    this.api.deleteRawCategory$(id).subscribe({
      next: () => {
        const next = new Set(this.expandedIds());
        next.delete(id);
        this.expandedIds.set(next);
        const cache = new Map(this.productsByCat());
        cache.delete(id);
        this.productsByCat.set(cache);
        this.load();
        this.changed.emit();
      },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  toggleExpand(id: number): void {
    const next = new Set(this.expandedIds());
    if (next.has(id)) {
      next.delete(id);
      this.expandedIds.set(next);
      return;
    }
    next.add(id);
    this.expandedIds.set(next);
    if (!this.productsByCat().has(id)) {
      this.api.rawCategoryProducts$(id).subscribe((prods) => {
        this.productsByCat.set(new Map(this.productsByCat()).set(id, prods));
      });
    }
  }

  productsOf(catId: number): RawProductRef[] {
    return this.productsByCat().get(catId) ?? [];
  }

  pickOf(catId: number): number | null {
    return this.pickByCat().get(catId) ?? null;
  }

  setPick(catId: number, productId: number | null): void {
    this.pickByCat.set(new Map(this.pickByCat()).set(catId, productId));
  }

  addProduct(catId: number): void {
    const productId = this.pickOf(catId);
    if (!productId) return;
    const prod = this.all().find((p) => p.id === productId);
    if (!prod) return;
    const updated = [...this.productsOf(catId), prod];
    this.productsByCat.set(new Map(this.productsByCat()).set(catId, updated));
    this.setPick(catId, null);
    this.persistAssign(catId, updated);
  }

  removeProduct(catId: number, productId: number): void {
    const updated = this.productsOf(catId).filter((p) => p.id !== productId);
    this.productsByCat.set(new Map(this.productsByCat()).set(catId, updated));
    this.persistAssign(catId, updated);
  }

  private persistAssign(catId: number, prods: RawProductRef[]): void {
    this.api.assignRawProducts$(catId, prods.map((p) => p.id)).subscribe({
      next: () => { this.load(); this.changed.emit(); },
      error: (e: unknown) => this.err.set(httpErr(e)),
    });
  }

  /** Открыть модалку редактирования позиции (как «Новая позиция»). */
  editProduct(id: number): void {
    this.editId.set(id);
    this.editOpen.set(true);
  }

  onProductSaved(): void {
    this.editOpen.set(false);
    this.msg.set('Позиция сохранена ✓');
    this.load();
    // название/категория могли измениться — перечитываем раскрытые ветки
    this.refreshOpenBranches();
    this.changed.emit();
  }

  private refreshOpenBranches(): void {
    for (const id of this.expandedIds()) {
      this.api.rawCategoryProducts$(id).subscribe((prods) => {
        this.productsByCat.set(new Map(this.productsByCat()).set(id, prods));
      });
    }
  }
}
