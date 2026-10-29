import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../core/auth.service';
import { ApiService } from '../core/api.service';
import { AuthUserRow } from '../core/models';
import { httpErr } from '../core/format';
import { ModalComponent } from '../shared/modal.component';

/** Строка выбора магазина в формах пользователя. */
interface StoreOption {
  id: number;
  name: string;
  code: string;
  active: boolean;
}

/**
 * Раздел «Пользователи» (только админ): список аккаунтов CRM, создание,
 * сброс пароля, выдача прав администратора и отключение входа.
 * Пароли живут на сервере (scrypt), здесь их никто не видит — можно только задать новый.
 *
 * Тип пользователя: офис (вся CRM, может быть админом) или магазин —
 * привязан к одной точке продаж; к одной точке можно привязать несколько человек.
 */
@Component({
  selector: 'app-users',
  standalone: true,
  imports: [FormsModule, ModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <h1 class="page-title" style="margin:0">👤 Пользователи</h1>
      <span class="spacer"></span>
      <button class="btn sm" (click)="load()">⟳</button>
      <button class="btn sm primary" (click)="openCreate()">+ Пользователь</button>
    </div>
    @if (err()) { <div class="err">{{ err() }}</div> }
    @if (msg()) { <div class="ok-msg">{{ msg() }}</div> }

    <div class="panel">
      <table class="tbl stack">
        <thead>
          <tr>
            <th>Сотрудник</th>
            <th>Доступ</th>
            <th>Статус</th>
            <th>Последний вход</th>
            <th style="text-align:right">Действия</th>
          </tr>
        </thead>
        <tbody>
          @for (r of rows(); track r.id) {
            <tr [class.off]="!r.active">
              <td>
                <strong>{{ r.fullName }}</strong>
                @if (r.id === meId()) { <span class="badge gray" style="margin-left:6px">вы</span> }
                <div class="muted small">{{ r.login }}</div>
              </td>
              <td data-l="Доступ">
                @if (r.storeId) {
                  <span class="badge amber" title="Доступ только к своему магазину">магазин</span>
                  <div class="muted small">{{ r.storeName }}</div>
                } @else if (r.isAdmin) {
                  <span class="badge blue">админ</span>
                } @else {
                  <span class="badge gray">офис</span>
                }
              </td>
              <td data-l="Статус">
                <span class="badge" [class.green]="r.active" [class.red]="!r.active">
                  {{ r.active ? 'вход разрешён' : 'отключён' }}
                </span>
              </td>
              <td data-l="Вход" class="nw">{{ fmtDate(r.lastLoginAt) }}</td>
              <td data-l="Действия" class="acts">
                <button type="button" class="btn sm" (click)="openProfile(r)" [disabled]="busyId() === r.id">
                  Профиль
                </button>
                <button type="button" class="btn sm" (click)="openPwd(r)" [disabled]="busyId() === r.id">
                  Пароль
                </button>
                @if (!r.storeId) {
                  <button type="button" class="btn sm" (click)="toggleAdmin(r)" [disabled]="busyId() === r.id">
                    {{ r.isAdmin ? 'Снять админа' : 'Сделать админом' }}
                  </button>
                }
                <button
                  type="button"
                  class="btn sm"
                  [class.danger]="r.active"
                  (click)="toggleActive(r)"
                  [disabled]="busyId() === r.id || (r.id === meId() && r.active)"
                  [title]="r.id === meId() && r.active ? 'Себя отключить нельзя' : ''"
                >
                  {{ r.active ? 'Отключить' : 'Включить' }}
                </button>
              </td>
            </tr>
          } @empty {
            <tr class="empty"><td colspan="5">Пользователей нет</td></tr>
          }
        </tbody>
      </table>
    </div>

    @if (createOpen()) {
      <app-modal title="Новый пользователь" (closed)="createOpen.set(false)">
        @if (formErr()) { <div class="err">{{ formErr() }}</div> }
        <div class="col">
          <label class="f">
            Логин
            <input [(ngModel)]="newLogin" autocomplete="off" [disabled]="busy()" placeholder="ivan" />
          </label>
          <label class="f">
            ФИО
            <input [(ngModel)]="newName" maxlength="50" autocomplete="off" [disabled]="busy()" placeholder="Иванов Иван" />
          </label>
          <label class="f">
            Магазин
            <select [(ngModel)]="newStoreId" [disabled]="busy()">
              <option [ngValue]="null">— офис, доступ ко всей CRM —</option>
              @for (s of stores(); track s.id) {
                <option [ngValue]="s.id">{{ s.name }} · {{ s.code }}{{ s.active ? '' : ' (закрыт)' }}</option>
              }
            </select>
          </label>
          <label class="f">
            Пароль
            <input type="text" [(ngModel)]="newPassword" autocomplete="new-password" [disabled]="busy()" />
          </label>
          <label class="chk" [class.off]="newStoreId !== null">
            <input type="checkbox" [(ngModel)]="newAdmin" [disabled]="busy() || newStoreId !== null" />
            <span>Администратор — может управлять пользователями</span>
          </label>
          <div class="muted small">
            Логин: 3–40 символов, латиница, цифры, точка, дефис, подчёркивание. Пароль не короче 6 символов.
            ФИО — до 50 символов, можно одним словом.
          </div>
          <div class="muted small">
            Если выбрать магазин — это сотрудник точки: он привязан только к этому магазину
            (к одной точке можно привязать нескольких человек) и не может быть администратором.
          </div>
        </div>
        <div modalFooter>
          <button type="button" class="btn" (click)="createOpen.set(false)" [disabled]="busy()">Отмена</button>
          <button type="button" class="btn primary" (click)="create()" [disabled]="busy()">
            {{ busy() ? 'Создаём…' : 'Создать' }}
          </button>
        </div>
      </app-modal>
    }

    @if (editUser(); as u) {
      <app-modal [title]="'Профиль: ' + u.login" (closed)="editUser.set(null)">
        @if (formErr()) { <div class="err">{{ formErr() }}</div> }
        <div class="col">
          <label class="f">
            ФИО сотрудника
            <input [(ngModel)]="editName" maxlength="50" autocomplete="off" [disabled]="busy()" placeholder="Иванов Иван" />
          </label>
          <label class="f">
            Магазин
            <select [(ngModel)]="editStoreId" [disabled]="busy()">
              <option [ngValue]="null">— офис, доступ ко всей CRM —</option>
              @for (s of stores(); track s.id) {
                <option [ngValue]="s.id">{{ s.name }} · {{ s.code }}{{ s.active ? '' : ' (закрыт)' }}</option>
              }
            </select>
          </label>
          @if (editStoreId !== null) {
            <div class="muted small">
              Сотрудник магазина привязан к одной точке. Права администратора снимаются автоматически.
            </div>
          }
       
        </div>
        <div modalFooter>
          <button type="button" class="btn" (click)="editUser.set(null)" [disabled]="busy()">Отмена</button>
          <button type="button" class="btn primary" (click)="saveProfile(u)" [disabled]="busy()">
            {{ busy() ? 'Сохраняем…' : 'Сохранить' }}
          </button>
        </div>
      </app-modal>
    }

    @if (pwdUser(); as u) {
      <app-modal [title]="'Новый пароль: ' + u.login" (closed)="pwdUser.set(null)">
        @if (formErr()) { <div class="err">{{ formErr() }}</div> }
        <div class="col">
          <label class="f">
            Пароль
            <input type="text" [(ngModel)]="newPassword" autocomplete="new-password" [disabled]="busy()" />
          </label>
          <div class="muted small">
            Сохраните пароль и передайте его пользователю: посмотреть старый нельзя. Все сессии {{ u.login }} будут завершены.
          </div>
        </div>
        <div modalFooter>
          <button type="button" class="btn" (click)="pwdUser.set(null)" [disabled]="busy()">Отмена</button>
          <button type="button" class="btn primary" (click)="resetPwd(u)" [disabled]="busy()">
            {{ busy() ? 'Сохраняем…' : 'Сменить пароль' }}
          </button>
        </div>
      </app-modal>
    }
  `,
  styles: [
    `
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .spacer { flex: 1 1 auto; }
    .small { font-size: 12px; }
    .col { display: flex; flex-direction: column; gap: 10px; }
    .chk { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
    .chk input { width: auto; }
    .chk.off { opacity: .5; cursor: default; }
    .acts { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
    tr.off td { opacity: .6; }
    @media (max-width: 900px) {
      .acts { justify-content: flex-start; }
    }
    `,
  ],
})
export class UsersComponent implements OnInit {
  private auth = inject(AuthService);
  private api = inject(ApiService);

  rows = signal<AuthUserRow[]>([]);
  stores = signal<StoreOption[]>([]);
  busyId = signal<number | null>(null);
  err = signal('');
  msg = signal('');

  createOpen = signal(false);
  pwdUser = signal<AuthUserRow | null>(null);
  editUser = signal<AuthUserRow | null>(null);
  busy = signal(false);
  formErr = signal('');

  newLogin = '';
  newName = '';
  newPassword = '';
  newAdmin = false;
  newStoreId: number | null = null;

  editName = '';
  editStoreId: number | null = null;

  meId = (): number => this.auth.user()?.id ?? 0;

  ngOnInit(): void {
    this.load();
    this.loadStores();
  }

  load(): void {
    this.err.set('');
    this.auth.users$().subscribe({
      next: (v) => this.rows.set(v),
      error: (e) => this.err.set(httpErr(e)),
    });
  }

  /** Список точек для привязки; ошибка не должна ломать раздел пользователей. */
  private loadStores(): void {
    this.api.points$().subscribe({
      next: (v) =>
        this.stores.set(
          v
            .map((p) => ({ id: p.id, name: p.name, code: p.code, active: Boolean(p.active) }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        ),
      error: () => undefined,
    });
  }

  openCreate(): void {
    this.newLogin = '';
    this.newName = '';
    this.newPassword = '';
    this.newAdmin = false;
    this.newStoreId = null;
    this.formErr.set('');
    this.createOpen.set(true);
  }

  openProfile(r: AuthUserRow): void {
    // берём именно сохранённое значение: однословное ФИО может совпасть с логином
    this.editName = r.fullNameRaw ?? '';
    this.editStoreId = r.storeId;
    this.formErr.set('');
    this.editUser.set(r);
  }

  saveProfile(r: AuthUserRow): void {
    if (this.busy()) return;
    const fullName = this.editName.trim().replace(/\s+/g, ' ').slice(0, 50);
    const storeChanged = r.storeId !== this.editStoreId;
    this.busy.set(true);
    this.formErr.set('');
    this.auth.patchUser$(r.id, { fullName: fullName || null, ...(storeChanged ? { storeId: this.editStoreId } : {}) }).subscribe({
      next: () => {
        this.busy.set(false);
        this.editUser.set(null);
        this.flash(`Профиль «${r.login}» сохранён`);
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.formErr.set(httpErr(e));
      },
    });
  }

  openPwd(r: AuthUserRow): void {
    this.newPassword = '';
    this.formErr.set('');
    this.pwdUser.set(r);
  }

  create(): void {
    if (this.busy()) return;
    const login = this.newLogin.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(login)) {
      this.formErr.set('Логин: 3–40 символов, латиница, цифры, точка, дефис, подчёркивание');
      return;
    }
    if (this.newPassword.length < 6) {
      this.formErr.set('Пароль должен быть не короче 6 символов');
      return;
    }
    this.busy.set(true);
    this.formErr.set('');
    this.auth
      .createUser$({ login, fullName: this.newName.trim().replace(/\s+/g, ' ').slice(0, 50), password: this.newPassword, isAdmin: this.newAdmin, storeId: this.newStoreId })
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          this.createOpen.set(false);
          this.flash(`Пользователь «${login}» создан (id ${r.id})`);
          this.load();
        },
        error: (e) => {
          this.busy.set(false);
          this.formErr.set(httpErr(e));
        },
      });
  }

  resetPwd(r: AuthUserRow): void {
    if (this.busy()) return;
    if (this.newPassword.length < 6) {
      this.formErr.set('Пароль должен быть не короче 6 символов');
      return;
    }
    this.busy.set(true);
    this.formErr.set('');
    this.auth.patchUser$(r.id, { password: this.newPassword }).subscribe({
      next: () => {
        this.busy.set(false);
        this.pwdUser.set(null);
        this.flash(`Пароль «${r.login}» изменён, его сессии завершены`);
        this.load();
      },
      error: (e) => {
        this.busy.set(false);
        this.formErr.set(httpErr(e));
      },
    });
  }

  toggleAdmin(r: AuthUserRow): void {
    if (r.storeId) return; // магазинному пользователю права админа не выдаются
    this.patch(r, { isAdmin: !r.isAdmin }, r.isAdmin ? `«${r.login}» больше не администратор` : `«${r.login}» теперь администратор`);
  }

  toggleActive(r: AuthUserRow): void {
    this.patch(r, { active: !r.active }, r.active ? `Вход для «${r.login}» закрыт` : `Вход для «${r.login}» открыт`);
  }

  private patch(r: AuthUserRow, body: { isAdmin?: boolean; active?: boolean; fullName?: string | null; storeId?: number | null }, ok: string): void {
    if (this.busyId() !== null) return;
    this.err.set('');
    this.busyId.set(r.id);
    this.auth.patchUser$(r.id, body).subscribe({
      next: () => {
        this.busyId.set(null);
        this.flash(ok);
        this.load();
      },
      error: (e) => {
        this.busyId.set(null);
        this.err.set(httpErr(e));
      },
    });
  }

  private flash(text: string): void {
    this.msg.set(text);
    setTimeout(() => this.msg.set(''), 4000);
  }

  fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const p = (x: number) => String(x).padStart(2, '0');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}
