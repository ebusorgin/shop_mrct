import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * «Конструктор блюд» — раздел в разработке. Планируется как инструмент сборки блюда
 * из продуктов и полуфабрикатов с расчётом себестоимости, выхода и КБЖУ.
 * Пока — страница-заглушка, наполнение добавим следующим шагом.
 */
@Component({
  selector: 'app-constructor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="page-title">🍲 Конструктор блюд</h1>
    <div class="panel">
      <p class="muted">
        Раздел в разработке. Здесь можно будет собирать блюдо из продуктов и полуфабрикатов,
        считать себестоимость, выход и КБЖУ.
      </p>
    </div>
  `,
})
export class ConstructorComponent {}
