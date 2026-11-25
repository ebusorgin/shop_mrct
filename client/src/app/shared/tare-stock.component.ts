import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';
import { PackageMovementRow, PackageStockRow } from '../core/models';
import { fmtMoney, fmtQty, httpErr } from '../core/format';
import { currencySymbol } from '../core/currency';

type MoveMode = 'receipt' | 'writeoff' | 'adjustment';

interface TareEdit {
  row: PackageStockRow;
  mode: MoveMode;
  qty: number;
  unitCost: number;
  comment: string;
}

const KIND_LABEL: Record<string, string> = {
  jar: 'банка',
  lid: 'крышка',
  bag: 'пакет',
  container: 'контейнер',
  other: 'прочее',
};

const MODE_LABEL: Record<MoveMode, string> = {
  receipt: 'Приход тары',
  writeoff: 'Списание тары',
  adjustment: 'Корректировка тары',
};

/** Учёт тары: остатки, приход/списание/корректировка и журнал движений. */
@Component({
  selector: 'app-tare-stock',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .tare-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .tare-head p { flex: 1; margin: 0; font-size: 12px; color: var(--muted); line-height: 1.45; }
    .edit-card { margin-bottom: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: #fbfcfd; }
    .edit-card b { display: block; font-size: 13.5px; margin-bottom: 8px; }
    .fields { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; }
    .fields .f { min-width: 120px; }
    .fields .grow { flex: 1; min-width: 180px; }
    .fields input { width: 100%; }
    .acts { display: flex; gap: 6px; }
    .tare-table { margin: 0; }
    .tare-table .acts-cell { white-space: nowrap; text-align: right; }
    .tare-table .acts-cell .btn { margin-left: 4px; }
    .icon-btn { border: 1px solid var(--border); background: #fff; color: var(--muted); width: 26px; height: 26px;
                border-radius: 7px; cursor: pointer; font-size: 11px; line-height: 1; padding: 0; }
    .icon-btn.danger { color: #c0392b; border-color: #e5b4b4; }
    .icon-btn.danger:hover { background: #fdf4f4; }
    .tare-table .num { text-align: right; font-variant-numeric: tabular-nums; }
    .moves-head { display: flex; align-items: center; gap: 10px; margin: 18px 0 8px; }
    .moves-head h3 { margin: 0; font-size: 15px; }
    .filter-chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 9px; border-radius: 999px;
                   background: var(--accent-soft); color: var(--accent); font-size: 11.5px; font-weight: 600; }
    .filter-chip button { border: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 11px; padding: 1px 4px; }
    .moves-table .num { text-align: right; font-variant-numeric: tabular-nums; }
    .move-in { color: #236b4c; }
    .move-out { color: #a8551b; }
    .muted-sm { margin: 0; padding: 14px; text-align: center; color: var(--muted); font-size: 12.5px; }
  `],
  template: `
    <div class="tare-head">
      <p>Тара ведётся отдельно от складской номенклатуры: банки, крышки, пакеты и контейнеры.
         Приход увеличивает остаток по цене за штуку, списание уменьшает, корректировка задаёт изменение вручную.</p>
      <button type="button" class="btn primary" (click)="openCreate()">＋ Новая тара</button>
      <button type="button" class="btn sm" [disabled]="loading()" (click)="load()">⟳ Обновить</button>
    </div>

    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    @if (addOpen()) {
      <div class="edit-card">
        <b>Новая тара</b>
        <div class="fields">
          <label class="f grow">Название
            <input [ngModel]="newName()" (ngModelChange)="newName.set($event)" placeholder="например, банка 700 г" />
          </label>
          <label class="f">Вид
            <select [ngModel]="newKind()" (ngModelChange)="newKind.set($event)">
              <option value="jar">банка</option>
              <option value="lid">крышка</option>
              <option value="bag">пакет</option>
              <option value="container">контейнер</option>
              <option value="other">прочее</option>
            </select>
          </label>
          <div class="acts">
            <button type="button" class="btn primary" [disabled]="creating()" (click)="create()">
              {{ creating() ? 'Создаём…' : 'Создать' }}
            </button>
            <button type="button" class="btn" [disabled]="creating()" (click)="closeCreate()">Отмена</button>
          </div>
        </div>
      </div>
    }

    @if (edit(); as e) {
      <div class="edit-card">
        <b>{{ modeLabel(e.mode) }} · {{ e.row.name }}</b>
        <div class="fields">
          <label class="f">Количество, шт
            <input type="number" step="any" [ngModel]="e.qty" (ngModelChange)="setQty($event)" />
          </label>
          @if (e.mode === 'receipt') {
            <label class="f">Цена за шт
              <input type="number" min="0" step="any" [ngModel]="e.unitCost" (ngModelChange)="setCost($event)" />
            </label>
          }
          <label class="f grow">Комментарий
            <input [ngModel]="e.comment" (ngModelChange)="setComment($event)" placeholder="необязательно" />
          </label>
          <div class="acts">
            <button type="button" class="btn primary" [disabled]="saving()" (click)="save()">
              {{ saving() ? 'Сохраняем…' : 'Сохранить' }}
            </button>
            <button type="button" class="btn" [disabled]="saving()" (click)="cancel()">Отмена</button>
          </div>
        </div>
        @if (e.mode === 'adjustment') {
          <p class="muted" style="margin:8px 0 0;font-size:11.5px">Отрицательное число уменьшает остаток, положительное — увеличивает.</p>
        }
      </div>
    }

    <table class="tbl tare-table">
      <tr>
        <th>Тара</th>
        <th>Вид</th>
        <th class="num">Остаток</th>
        <th class="num">Себест., {{ currency() }}</th>
        <th class="num">Сумма</th>
        <th></th>
      </tr>
      @for (r of rows(); track r.id) {
        <tr>
          <td><b>{{ r.name }}</b></td>
          <td class="muted">{{ kindLabel(r.kind) }}</td>
          <td class="num">{{ fmtQty(r.qty, 'шт') }}</td>
          <td class="num">{{ money(r.avgCost) }}</td>
          <td class="num">{{ money(r.value) }}</td>
          <td class="acts-cell">
            <button type="button" class="btn sm" (click)="start(r, 'receipt')">+ приход</button>
            <button type="button" class="btn sm" (click)="start(r, 'writeoff')">− списать</button>
            <button type="button" class="btn sm" (click)="start(r, 'adjustment')">± корректировка</button>
            <button type="button" class="btn sm" (click)="history(r)">история</button>
            <button type="button" class="icon-btn danger" title="Удалить тару" (click)="remove(r)">✕</button>
          </td>
        </tr>
      } @empty {
        <tr class="empty"><td colspan="6">Тара не заведена</td></tr>
      }
    </table>

    <div class="moves-head">
      <h3>Движения тары</h3>
      @if (filter(); as f) {
        <span class="filter-chip">только «{{ f.name }}»
          <button type="button" title="Показать все" (click)="clearFilter()">✕</button>
        </span>
      }
    </div>
    <table class="tbl moves-table">
      <tr>
        <th>Дата</th><th>Тара</th><th>Операция</th><th class="num">Количество</th>
        <th class="num">Себест.</th><th>Кто</th><th>Комментарий</th>
      </tr>
      @for (m of moves(); track m.id) {
        <tr>
          <td class="nw muted">{{ m.createdAt }}</td>
          <td>{{ m.packageName }}</td>
          <td>{{ modeLabel(m.type) }}</td>
          <td class="num" [class.move-in]="m.qty > 0" [class.move-out]="m.qty < 0">{{ fmtQty(m.qty, 'шт', true) }}</td>
          <td class="num">{{ money(m.unitCost) }}</td>
          <td class="nw">{{ m.userName || m.userLogin || '—' }}</td>
          <td>{{ m.comment || '—' }}</td>
        </tr>
      } @empty {
        <tr class="empty"><td colspan="7">Движений тары ещё нет</td></tr>
      }
    </table>
  `,
})
export class TareStockComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly rows = signal<PackageStockRow[]>([]);
  readonly moves = signal<PackageMovementRow[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly err = signal('');
  readonly msg = signal('');
  readonly edit = signal<TareEdit | null>(null);
  readonly filter = signal<PackageStockRow | null>(null);
  readonly addOpen = signal(false);
  readonly creating = signal(false);
  readonly newName = signal('');
  readonly newKind = signal('jar');

  readonly fmtQty = fmtQty;
  readonly money = fmtMoney;
  readonly currency = currencySymbol;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.packages$().subscribe({
      next: (rows) => { this.rows.set(rows); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.err.set(httpErr(e)); },
    });
    this.loadMoves();
  }

  private loadMoves(): void {
    const f = this.filter();
    this.api.packageMovements$({ packageId: f?.id, limit: 100 }).subscribe({
      next: (rows) => this.moves.set(rows),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  kindLabel(kind: string): string {
    return KIND_LABEL[kind] ?? kind;
  }

  modeLabel(mode: MoveMode): string {
    return MODE_LABEL[mode];
  }

  openCreate(): void {
    this.edit.set(null);
    this.addOpen.set(true);
    this.newName.set('');
    this.newKind.set('jar');
    this.err.set('');
    this.msg.set('');
  }

  closeCreate(): void {
    this.addOpen.set(false);
    this.err.set('');
  }

  create(): void {
    if (this.creating()) return;
    const name = this.newName().trim();
    if (!name) {
      this.err.set('Введите название тары');
      return;
    }
    this.creating.set(true);
    this.err.set('');
    this.msg.set('');
    this.api.createPackage$({ name, kind: this.newKind() }).subscribe({
      next: () => {
        this.creating.set(false);
        this.addOpen.set(false);
        this.msg.set('Тара добавлена');
        this.load();
      },
      error: (e) => {
        this.creating.set(false);
        this.err.set(httpErr(e));
      },
    });
  }

  remove(row: PackageStockRow): void {
    if (!confirm(`Удалить тару «${row.name}»? Позиции с движениями или привязкой к фасовкам удалить нельзя.`)) {
      return;
    }
    this.err.set('');
    this.msg.set('');
    this.api.deletePackage$(row.id).subscribe({
      next: () => {
        if (this.filter()?.id === row.id) this.filter.set(null);
        this.msg.set('Тара удалена');
        this.load();
      },
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  start(row: PackageStockRow, mode: MoveMode): void {
    this.err.set('');
    this.msg.set('');
    this.edit.set({
      row,
      mode,
      qty: mode === 'adjustment' ? 0 : 1,
      unitCost: row.avgCost,
      comment: '',
    });
  }

  cancel(): void {
    this.edit.set(null);
    this.err.set('');
  }

  setQty(value: unknown): void {
    this.edit.update((e) => (e ? { ...e, qty: Number(value) || 0 } : e));
  }

  setCost(value: unknown): void {
    this.edit.update((e) => (e ? { ...e, unitCost: Math.max(0, Number(value) || 0) } : e));
  }

  setComment(value: string): void {
    this.edit.update((e) => (e ? { ...e, comment: value } : e));
  }

  save(): void {
    const e = this.edit();
    if (!e || this.saving()) return;
    if (e.mode === 'adjustment' ? e.qty === 0 : !(e.qty > 0)) {
      this.err.set(e.mode === 'adjustment' ? 'Корректировка не может быть 0' : 'Количество должно быть больше 0');
      return;
    }
    this.saving.set(true);
    this.err.set('');
    this.msg.set('');
    this.api.addPackageMovement$({
      packageId: e.row.id,
      type: e.mode,
      qty: e.qty,
      unitCost: e.mode === 'receipt' ? e.unitCost : undefined,
      comment: e.comment.trim() || undefined,
    }).subscribe({
      next: () => {
        this.saving.set(false);
        this.edit.set(null);
        this.msg.set('Движение тары сохранено');
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        this.err.set(httpErr(err));
      },
    });
  }

  history(row: PackageStockRow): void {
    this.filter.set(row);
    this.loadMoves();
  }

  clearFilter(): void {
    this.filter.set(null);
    this.loadMoves();
  }
}
