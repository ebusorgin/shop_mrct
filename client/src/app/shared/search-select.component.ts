import {
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface SearchOption {
  id: number;
  label: string;
  /** Заголовок группы в списке (каталог/категория). */
  group?: string;
}

/**
 * Выпадающий список с поиском. Используется там, где вариантов много
 * (компоненты рецептуры), а обычный select становится неудобным.
 */
@Component({
  selector: 'app-search-select',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    :host { display: block; position: relative; width: 100%; }
    .ss-btn {
      width: 100%; display: flex; align-items: center; gap: 8px; text-align: left;
      padding: 7px 9px; font: inherit; font-size: 12.5px; color: var(--ink);
      border: 1px solid var(--border); border-radius: 8px; background: #fff; cursor: pointer;
    }
    .ss-btn:hover { border-color: #c3d5e6; }
    .ss-btn:disabled { opacity: .55; cursor: not-allowed; }
    .ss-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ss-value.placeholder { color: var(--muted); }
    .ss-arrow { flex: none; font-size: 10px; color: var(--muted); }
    .ss-pop {
      position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 40;
      background: #fff; border: 1px solid var(--border); border-radius: 10px;
      box-shadow: 0 12px 30px rgba(40, 35, 25, .16); padding: 6px;
    }
    .ss-search {
      width: 100%; padding: 7px 9px; font-size: 12.5px; border: 1px solid var(--border);
      border-radius: 7px; background: #fbfaf6;
    }
    .ss-search:focus { outline: none; border-color: var(--brand-blue); background: #fff; }
    .ss-list { max-height: 260px; overflow: auto; margin-top: 5px; display: flex; flex-direction: column; gap: 2px; }
    .ss-group {
      position: sticky; top: 0; z-index: 1;
      padding: 5px 8px 3px; background: #fff;
      font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
      color: var(--muted); border-bottom: 1px solid #f0ece2;
    }
    .ss-opt {
      width: 100%; text-align: left; border: 0; background: transparent; cursor: pointer;
      padding: 6px 8px; border-radius: 6px; font: inherit; font-size: 12.5px; color: var(--ink);
    }
    .ss-opt:hover { background: #f2f7fb; }
    .ss-opt.on { background: #e7f2fa; font-weight: 700; }
    .ss-empty { padding: 8px; font-size: 12px; color: var(--muted); text-align: center; }
  `],
  template: `
    <button type="button" class="ss-btn" [disabled]="disabled" (click)="toggle()">
      <span class="ss-value" [class.placeholder]="!selected">{{ selected?.label || placeholder }}</span>
      <span class="ss-arrow">▾</span>
    </button>

    @if (open) {
      <div class="ss-pop">
        <input
          class="ss-search"
          [ngModel]="query"
          (ngModelChange)="query = $event"
          (keydown.escape)="close()"
          placeholder="Поиск…"
          autocomplete="off"
        />
        <div class="ss-list">
          @for (g of grouped; track g.key) {
            @if (g.label) { <div class="ss-group">{{ g.label }}</div> }
            @for (o of g.options; track o.id) {
              <button type="button" class="ss-opt" [class.on]="o.id === value"
                      (mousedown)="$event.preventDefault(); pick(o.id)">
                {{ o.label }}
              </button>
            }
          } @empty {
            <div class="ss-empty">Ничего не найдено</div>
          }
        </div>
      </div>
    }
  `,
})
export class SearchSelectComponent {
  private host = inject(ElementRef<HTMLElement>);

  @Input() options: SearchOption[] = [];
  @Input() value: number | null = null;
  @Input() placeholder = '— выберите —';
  @Input() disabled = false;
  @Output() valueChange = new EventEmitter<number | null>();

  open = false;
  query = '';

  get selected(): SearchOption | null {
    return this.options.find((o) => o.id === this.value) ?? null;
  }

  get filtered(): SearchOption[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.options;
    return this.options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.group ?? '').toLowerCase().includes(q)
    );
  }

  /** Группы в порядке появления; элементы без группы идут без заголовка. */
  get grouped(): { key: string; label: string; options: SearchOption[] }[] {
    const by = new Map<string, SearchOption[]>();
    for (const option of this.filtered) {
      const key = option.group ?? '';
      const arr = by.get(key) ?? [];
      arr.push(option);
      by.set(key, arr);
    }
    return [...by.entries()].map(([key, options]) => ({ key, label: key, options }));
  }

  toggle(): void {
    if (this.disabled) return;
    this.open = !this.open;
    this.query = '';
    if (this.open) {
      setTimeout(() => {
        const input = this.host.nativeElement.querySelector('.ss-search') as HTMLInputElement | null;
        input?.focus();
      });
    }
  }

  close(): void {
    this.open = false;
  }

  pick(id: number): void {
    this.valueChange.emit(id);
    this.open = false;
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentDown(ev: PointerEvent): void {
    if (!this.open) return;
    if (!this.host.nativeElement.contains(ev.target as Node)) this.open = false;
  }
}
