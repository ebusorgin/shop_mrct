import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ModalComponent } from './modal.component';
import { ProductFormComponent } from './product-form.component';

/**
 * Модальное окно позиции номенклатуры склада — «Новая позиция» / правка со страницы «Склад».
 * Сама форма живёт в app-product-form: её же показывает вкладка «Редактирование» карточки позиции.
 * productId = null — создание; иначе подтягивается карточка продукта.
 * Выходы: saved — позиция сохранена (родитель перезагружает свои списки), closed — закрыто без сохранения.
 */
@Component({
  selector: 'app-product-edit',
  standalone: true,
  imports: [ModalComponent, ProductFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal [title]="productId ? 'Редактировать позицию' : 'Новая позиция'" (closed)="closed.emit()">
      <app-product-form [productId]="productId" (saved)="saved.emit()" (closed)="closed.emit()" />
    </app-modal>
  `,
})
export class ProductEditComponent {
  /** null — новая позиция; иначе id редактируемой. */
  @Input() productId: number | null = null;
  @Output() saved = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();
}
