import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { norm } from '../core/semi-calc';

/** Вариант в поисковом выборе компонента состава. */
export interface PickOption {
  id: number;
  label: string;
  /** Единица измерения входа — показываем рядом с названием. */
  unit?: string;
  /** Категория/пояснение второй строкой. */
  group?: string;
  /** Причина, по которой выбрать нельзя (например, цикл). */
  blocked?: string;
}

/**
 * Searchable combobox для выбора сырья или полуфабриката: кнопка-значение +
 * выпадающий поиск по названию (регистр/ё/диакритика не учитываются).
 * Длинный справочник не прокручивается «обычным select» — показываем только совпадения.
 */
@Component({
  selector: 'app-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk">
      @if (!open()) {
        <button type="button" class="pk-val" [class.empty]="!chosen()" [disabled]="disabled" (click)="show()">
          <span class="pk-txt">{{ chosen()?.label ?? placeholder }}</span>
          @if (chosen()?.unit) { <span class="pk-unit">{{ chosen()!.unit }}</span> }
          <span class="pk-caret">▾</span>
        </button>
      } @else {
        <div class="pk-drop">
          <input
            class="pk-q"
            autofocus
            [ngModel]="query()"
            (ngModelChange)="query.set($event)"
            (keydown.escape)="close()"
            (keydown.enter)="pickFirst(); $event.preventDefault()"
            placeholder="поиск по названию…"
          />
          <div class="pk-list">
            @for (o of visible(); track o.id) {
              <button type="button" class="pk-row" [class.on]="o.id === selId()" [disabled]="!!o.blocked" (click)="choose(o)">
                <span class="pk-txt">{{ o.label }}</span>
                <span class="pk-side">
                  @if (o.group) { <span class="pk-grp">{{ o.group }}</span> }
                  @if (o.unit) { <span class="pk-unit">{{ o.unit }}</span> }
                </span>
                @if (o.blocked) { <span class="pk-block">🚫 {{ o.blocked }}</span> }
              </button>
            } @empty {
              <p class="pk-none">Ничего не найдено</p>
            }
          </div>
          <div class="pk-foot">{{ visible().length }} совпадений</div>
        </div>
        <div class="pk-scrim" (click)="close()"></div>
      }
    </div>
  `,
  styles: [
    `
    :host { display: block; min-width: 0; }
    .pk { position: relative; min-width: 0; }
    .pk-val, .pk-row {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; cursor: pointer;
      font: inherit; color: var(--text); background: #fff; border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 10px;
    }
    .pk-val.empty .pk-txt { color: var(--muted); }
    .pk-val:hover { border-color: var(--accent); }
    .pk-val:disabled { opacity: .5; cursor: not-allowed; }
    .pk-caret { margin-left: auto; color: var(--muted); font-size: 11px; }
    .pk-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .pk-side { margin-left: auto; display: flex; align-items: baseline; gap: 8px; flex: none; }
    .pk-grp { font-size: 11px; color: var(--muted); }
    .pk-unit {
      font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft);
      border-radius: 999px; padding: 1px 7px; flex: none;
    }
    .pk-scrim { position: fixed; inset: 0; z-index: 70; }
    .pk-drop {
      position: absolute; z-index: 71; left: 0; right: 0; top: calc(100% + 4px);
      background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 10px 26px rgba(10, 18, 32, .18); padding: 6px; min-width: 220px;
    }
    .pk-q { width: 100%; margin-bottom: 6px; }
    .pk-list { max-height: 260px; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
    .pk-row { border: 0; background: transparent; padding: 7px 9px; border-radius: 6px; flex-wrap: wrap; }
    .pk-row:hover { background: #f2f5fa; }
    .pk-row.on { background: var(--accent-soft); font-weight: 600; }
    .pk-row:disabled { cursor: not-allowed; opacity: .65; }
    .pk-block { flex-basis: 100%; font-size: 11px; color: var(--red); }
    .pk-none { margin: 6px; font-size: 12px; color: var(--muted); }
    .pk-foot { font-size: 11px; color: var(--muted); padding: 4px 8px 2px; border-top: 1px solid var(--border); }
    `,
  ],
})
export class PickerComponent {
  @Output() picked = new EventEmitter<PickOption>();
  @Input() placeholder = '— выбрать —';
  @Input() disabled = false;

  private optionsSig = signal<PickOption[]>([]);
  private selectedSig = signal<number | null>(null);
  /** Для шаблона: текущий выбор (подсветка строки). */
  selId = computed(() => this.selectedSig());

  @Input() set options(v: PickOption[]) {
    this.optionsSig.set(v ?? []);
  }
  @Input() set selectedId(v: number | null) {
    this.selectedSig.set(v ?? null);
  }

  open = signal(false);
  query = signal('');

  chosen = computed(() => {
    const id = this.selectedSig();
    return id == null ? undefined : this.optionsSig().find((o) => o.id === id);
  });

  /** Сначала совпадения в начале названия, затем вхождение; заблокированные — в конце. */
  visible = computed(() => {
    const q = norm(this.query());
    const all = this.optionsSig();
    if (!q) return all;
    const hit = all.filter((o) => norm(o.label).includes(q));
    const starts = hit.filter((o) => norm(o.label).startsWith(q));
    return [...starts, ...hit.filter((o) => !starts.includes(o))];
  });

  show(): void {
    if (this.disabled) return;
    this.query.set('');
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
    this.query.set('');
  }

  choose(o: PickOption): void {
    if (o.blocked) return;
    this.picked.emit(o);
    this.close();
  }

  pickFirst(): void {
    const first = this.visible().find((o) => !o.blocked);
    if (first) this.choose(first);
  }
}
