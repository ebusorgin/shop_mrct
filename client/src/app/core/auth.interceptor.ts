import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthState } from './auth-state';

/** Вход и проверка сессии сами возвращают 401 — по ним не уводим на /login. */
const silent = (url: string): boolean => url.includes('/api/auth/login') || url.includes('/api/auth/me');

/**
 * Сессия живёт в httpOnly-cookie: просим браузер отправлять cookie с каждым запросом,
 * а на 401 от любого другого API сбрасываем состояние и уводим на страницу входа.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const state = inject(AuthState);
  const router = inject(Router);

  return next(req.clone({ withCredentials: true })).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !silent(req.url)) {
        state.clear();
        const from = router.url;
        if (!from.startsWith('/login')) {
          const queryParams = from && from !== '/' ? { next: from } : {};
          void router.navigate(['/login'], { queryParams });
        }
      }
      return throwError(() => err);
    })
  );
};
