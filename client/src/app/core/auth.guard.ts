import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthState } from './auth-state';

/** Без входа — на страницу логина, запомнив, куда человек шёл. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthState);
  const router = inject(Router);
  if (auth.user()) return true;
  const next = state.url && state.url !== '/' ? { next: state.url } : {};
  return router.createUrlTree(['/login'], { queryParams: next });
};

/** Управление пользователями — только администратору. */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthState);
  const router = inject(Router);
  if (!auth.user()) return router.createUrlTree(['/login']);
  return auth.isAdmin() ? true : router.createUrlTree(['/']);
};
