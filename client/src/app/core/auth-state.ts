import { Injectable, computed, signal } from '@angular/core';
import { AuthUser } from './models';

/**
 * Состояние входа без HttpClient — чтобы интерсептор и guard могли его читать,
 * не создавая циклическую зависимость (AuthService -> HttpClient -> интерсептор).
 */
@Injectable({ providedIn: 'root' })
export class AuthState {
  user = signal<AuthUser | null>(null);
  ready = signal(false);
  isAdmin = computed(() => this.user()?.isAdmin === true);
  /** Магазинный сотрудник: привязан к точке — видит только страницу своего магазина. */
  isStoreUser = computed(() => this.user()?.storeId != null);

  set(user: AuthUser | null): void {
    this.user.set(user);
  }

  clear(): void {
    this.user.set(null);
  }
}
