import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of, tap } from 'rxjs';
import { AuthUser, AuthUserRow } from './models';
import { AuthState } from './auth-state';

/** Вход в CRM: сессия живёт в httpOnly-cookie, клиент лишь знает, кто вошёл. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private state = inject(AuthState);
  private base = '/api/auth';

  readonly user = this.state.user;
  readonly ready = this.state.ready;
  readonly isAdmin = this.state.isAdmin;
  readonly isStoreUser = this.state.isStoreUser;

  /** Проверка сессии на старте приложения (до первого срабатывания guard). */
  load(): Promise<void> {
    return new Promise((resolve) => {
      this.http.get<{ user: AuthUser }>(`${this.base}/me`).subscribe({
        next: (r) => {
          this.state.set(r.user);
          this.state.ready.set(true);
          resolve();
        },
        error: () => {
          this.state.clear();
          this.state.ready.set(true);
          resolve();
        },
      });
    });
  }

  login$(login: string, password: string): Observable<AuthUser> {
    return this.http.post<{ user: AuthUser }>(`${this.base}/login`, { login, password }).pipe(
      tap((r) => this.state.set(r.user)),
      map((r) => r.user)
    );
  }

  /** Выход: сервер гасит сессию, клиент чистит состояние даже если сеть недоступна. */
  logout$(): Observable<unknown> {
    return this.http.post(`${this.base}/logout`, {}).pipe(
      catchError(() => of(null)),
      tap(() => this.state.clear())
    );
  }

  changePassword$(current: string, next: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/password`, { current, next });
  }

  // ---- управление пользователями (админ) ----
  users$(): Observable<AuthUserRow[]> {
    return this.http.get<AuthUserRow[]>(`${this.base}/users`);
  }
  createUser$(body: { login: string; password: string; fullName?: string; isAdmin: boolean; storeId?: number | null }): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.base}/users`, body);
  }
  patchUser$(id: number, body: {
    password?: string;
    isAdmin?: boolean;
    active?: boolean;
    fullName?: string | null;
    storeId?: number | null;
  }): Observable<{ ok: boolean }> {
    return this.http.patch<{ ok: boolean }>(`${this.base}/users/${id}`, body);
  }
}
