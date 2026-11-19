import { CanDeactivateFn } from '@angular/router';

/**
 * Не даёт уйти со страницы, если компонент сообщает о несохранённых изменениях.
 * Компонент сам решает, что считать «грязным», и показывает подтверждение.
 */
export const unsavedChangesGuard: CanDeactivateFn<unknown> = (component) => {
  const view = component as { canDeactivate?: () => boolean } | null;
  return view?.canDeactivate ? view.canDeactivate() : true;
};
