import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PointDayOrder } from '../core/models';

const RZ_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
export type ResizeDir = (typeof RZ_DIRS)[number];

/**
 * Карточка заказа за день-лист.
 * Позицию и размер задаёт хост-элемент (left/top/width/height),
 * перемещение и ресайз — снаружи, через события хост-элемента.
 */
@Component({
  selector: 'app-point-day-card',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tip-h">
      <span>Заказ на {{ fmtDate(date) }}</span>
      <span class="tip-right">
        <span class="muted">{{ data?.positions ?? 0 }} поз.</span>
        @if (pinned) {
          <button type="button" class="tip-x" (click)="closed.emit()" aria-label="Закрыть">×</button>
        }
      </span>
    </div>
    @if (loading) {
      <div class="small">Загрузка…</div>
    } @else {
      @if (data; as d) {
        @if (d.lines.length) {
          <div class="tip-scroll">
            <table class="tip-t">
              <thead><tr><th>Позиция</th><th>Кол-во</th><th>Сумма</th></tr></thead>
              <tbody>
                @for (l of d.lines; track $index) {
                  <tr [class.sel]="isSel(l.id)" (click)="pick(l.id)">
                    <td class="n">{{ l.name }}</td>
                    <td>{{ fmtQty(l.qty) }} {{ l.unit }}</td>
                    <td>{{ l.sum === null ? '—' : money(l.sum) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="tip-f"><span>Итого</span><b>{{ d.totalCost === null ? '—' : money(d.totalCost) }}</b></div>
        } @else {
          <div class="small">Позиций нет</div>
        }
      } @else {
        <div class="small">Нет данных</div>
      }
    }
    @if (pinned) {
      @for (d of dirs; track d) {
        <span [class]="'rz rz-' + d" (pointerdown)="resizeStart.emit({ dir: d, ev: $event })"></span>
      }
    }
  `,
  styles: [
    `
    :host {
      position: fixed;
      z-index: 60;
      width: 340px;
      max-width: calc(100vw - 16px);
      max-height: 80vh;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      padding: 10px 12px;
      font-size: 12px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
      pointer-events: none;
    }
    :host(.pin) { pointer-events: auto; }
    :host(.dragging) { user-select: none; }
    .tip-h { flex: 0 0 auto; display: flex; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 6px; cursor: move; touch-action: none; }
    .tip-right { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    .tip-x { border: 0; background: transparent; color: var(--muted); font-size: 16px; line-height: 1; padding: 0 2px; cursor: pointer; }
    .tip-x:hover { color: inherit; }
    .small { font-size: 11px; color: var(--muted); }
    .tip-scroll { flex: 0 1 auto; max-height: 220px; overflow: auto; overscroll-behavior: contain; cursor: auto; }
    :host(.sized) .tip-scroll { flex: 1 1 auto; min-height: 0; max-height: none; }
    .tip-t { width: 100%; border-collapse: collapse; }
    .tip-t th { text-align: left; font-weight: 500; color: var(--muted); font-size: 11px; padding: 2px 0; position: sticky; top: 0; background: #fff; }
    .tip-t td { padding: 3px 0; border-top: 1px solid #f1f5f9; vertical-align: top; }
    .tip-t td.n { overflow-wrap: anywhere; }
    /* выбранная позиция: подсвечивается во всех открытых карточках */
    :host(.pin) .tip-t tbody tr { cursor: pointer; }
    :host(.pin) .tip-t tbody tr:hover td { background: #f6f9ff; }
    .tip-t tbody tr.sel td { background: #e3edff; }
    .tip-t tbody tr.sel td.n { font-weight: 600; }
    .tip-t th:nth-child(2), .tip-t td:nth-child(2),
    .tip-t th:nth-child(3), .tip-t td:nth-child(3) { text-align: right; padding-left: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .tip-f { flex: 0 0 auto; display: flex; justify-content: space-between; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-weight: 600; }
    @media (max-width: 520px) { :host { width: 300px; } }
    .rz { position: absolute; touch-action: none; z-index: 2; }
    .rz-n { top: -4px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
    .rz-s { bottom: -4px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
    .rz-w { left: -4px; top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
    .rz-e { right: -4px; top: 10px; bottom: 10px; width: 8px; cursor: ew-resize; }
    .rz-nw { top: -4px; left: -4px; width: 14px; height: 14px; cursor: nwse-resize; }
    .rz-ne { top: -4px; right: -4px; width: 14px; height: 14px; cursor: nesw-resize; }
    .rz-sw { bottom: -4px; left: -4px; width: 14px; height: 14px; cursor: nesw-resize; }
    .rz-se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: nwse-resize; }
    .rz-se::before {
      content: '';
      position: absolute; right: 3px; bottom: 3px;
      width: 7px; height: 7px;
      border-right: 1.5px solid #b9c4d2; border-bottom: 1.5px solid #b9c4d2;
      border-radius: 0 0 2px 0;
    }
    `,
  ],
})
export class PointDayCardComponent {
  @Input({ required: true }) date!: string;
  @Input() data: PointDayOrder | null = null;
  @Input() loading = false;
  @Input() pinned = false;
  /** id выделенных позиций — общие для всех открытых карточек */
  @Input() selected: ReadonlySet<number> | null = null;
  @Output() closed = new EventEmitter<void>();
  @Output() resizeStart = new EventEmitter<{ dir: ResizeDir; ev: PointerEvent }>();
  @Output() picked = new EventEmitter<number>();

  readonly dirs = RZ_DIRS;

  isSel(id: number): boolean {
    return this.selected?.has(id) ?? false;
  }

  /** Выделение — только у закреплённой карточки (превью при наведении не кликается). */
  pick(id: number): void {
    if (this.pinned) this.picked.emit(id);
  }

  fmtDate(iso: string): string {
    const p = (x: number) => String(x).padStart(2, '0');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  fmtQty(n: number): string {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(n);
  }

  money(n: number): string {
    return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
  }
}
