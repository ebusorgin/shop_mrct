import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService } from '../core/api.service';
import { PointCard } from '../core/models';
import { httpErr } from '../core/format';
import { ModalComponent } from './modal.component';

interface Draft {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  contactPerson: string;
  openingHours: string;
  position: string;
  active: boolean;
  note: string;
}

const blankDraft = (): Draft => ({
  id: '', code: '', name: '', address: '', phone: '', email: '',
  contactPerson: '', openingHours: '', position: '', active: true, note: '',
});

/**
 * Модальная форма точки продаж. `point = null` — создание, иначе редактирование.
 * Сама сохраняет через API и сообщает родителю через (saved), затем закрывается (closed).
 */
@Component({
  selector: 'app-point-form',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [title]="point ? 'Изменить точку' : 'Новая точка продаж'" (closed)="closed.emit()">
      <form class="form" (ngSubmit)="save()">
        <div class="cols">
          <label class="f">Номер точки
            <input name="id" [(ngModel)]="draft().id" [disabled]="!!point" placeholder="напр. 111 (пусто — авто)" />
          </label>
          <label class="f">Код <small class="muted">(Mix 38…)</small>
            <input name="code" [(ngModel)]="draft().code" placeholder="авто, если пусто" />
          </label>
        </div>
        <label class="f">Название *
          <input name="name" [(ngModel)]="draft().name" placeholder="Магазин 111" />
        </label>
        <label class="f">Адрес
          <input name="address" [(ngModel)]="draft().address" />
        </label>
        <div class="cols">
          <label class="f">Телефон <input name="phone" [(ngModel)]="draft().phone" /></label>
          <label class="f">Контактное лицо <input name="contactPerson" [(ngModel)]="draft().contactPerson" /></label>
        </div>
        <div class="cols">
          <label class="f">Email <input name="email" [(ngModel)]="draft().email" /></label>
          <label class="f">Режим работы <input name="openingHours" [(ngModel)]="draft().openingHours" placeholder="Пн–Сб 07–21" /></label>
        </div>
        <div class="cols">
          <label class="f">Порядок <small class="muted">(сортировка)</small>
            <input name="position" [(ngModel)]="draft().position" placeholder="авто" />
          </label>
          <label class="f check">
            <input type="checkbox" name="active" [(ngModel)]="draft().active" /> <span>Активна</span>
          </label>
        </div>
        <label class="f">Заметка
          <textarea name="note" rows="2" [(ngModel)]="draft().note"></textarea>
        </label>
        @if (formErr()) { <div class="err">{{ formErr() }}</div> }

        <div modalFooter>
          <button type="button" class="btn" (click)="closed.emit()">Отмена</button>
          <button type="submit" class="btn primary" [disabled]="busy()">{{ point ? 'Сохранить' : 'Создать' }}</button>
        </div>
      </form>
    </app-modal>
  `,
  styles: [
    `
    .form { display: flex; flex-direction: column; gap: 12px; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .form .f { display: flex; flex-direction: column; gap: 4px; }
    .form .f input, .form .f textarea { width: 100%; }
    .form .f.check { flex-direction: row; align-items: center; gap: 8px; }
    .form .f.check input { width: auto; }
    @media (max-width: 520px) { .cols { grid-template-columns: 1fr; } }
    `,
  ],
})
export class PointFormComponent implements OnInit {
  private api = inject(ApiService);

  @Input() point: PointCard | null = null;
  @Output() saved = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  draft = signal<Draft>(blankDraft());
  formErr = signal('');
  busy = signal(false);

  ngOnInit(): void {
    const p = this.point;
    if (p) {
      this.draft.set({
        id: String(p.id),
        code: p.code,
        name: p.name,
        address: p.address,
        phone: p.phone,
        email: p.email,
        contactPerson: p.contactPerson,
        openingHours: p.openingHours,
        position: p.position != null ? String(p.position) : '',
        active: p.active,
        note: p.note,
      });
    }
  }

  private body(): Record<string, unknown> {
    const d = this.draft();
    const body: Record<string, unknown> = {
      name: d.name.trim(),
      code: d.code.trim(),
      address: d.address.trim(),
      phone: d.phone.trim(),
      email: d.email.trim(),
      contactPerson: d.contactPerson.trim(),
      openingHours: d.openingHours.trim(),
      note: d.note.trim(),
      active: d.active,
    };
    if (!this.point && d.id.trim()) body['id'] = Number(d.id.trim());
    if (d.position.trim()) body['position'] = Number(d.position.trim());
    return body;
  }

  save(): void {
    if (!this.draft().name.trim()) {
      this.formErr.set('Укажите название точки');
      return;
    }
    this.busy.set(true);
    this.formErr.set('');
    const body = this.body();
    const req$: Observable<unknown> = this.point
      ? this.api.patchPoint(this.point.id, body)
      : this.api.createPoint(body);
    req$.subscribe({
      next: () => {
        this.busy.set(false);
        this.saved.emit();
        this.closed.emit();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formErr.set(httpErr(e));
      },
    });
  }
}
