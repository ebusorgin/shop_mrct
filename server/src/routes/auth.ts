import { Router } from 'express';
import { ApiError, wrap } from '../http';
import { pool } from '../db';
import {
  AuthUser,
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  hashPassword,
  purgeExpiredSessions,
  readSession,
  requireAdmin,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from '../services/auth';
import { audit } from '../services/audit';

export const authRouter = Router();

const LOGIN_RE = /^[a-z0-9._-]{3,40}$/;
const MIN_PASSWORD = 6;

function normLogin(v: string): string {
  return v.trim().toLowerCase();
}

function reqPassword(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || !v) throw new ApiError(400, `Поле «${field}» обязательно`);
  if (v.length < MIN_PASSWORD) throw new ApiError(400, `Пароль должен быть не короче ${MIN_PASSWORD} символов`);
  if (v.length > 200) throw new ApiError(400, 'Пароль слишком длинный');
  return v;
}

const rowToUser = (r: Record<string, unknown>): AuthUser => ({
  id: Number(r.id),
  login: String(r.login),
  fullName: String(r.full_name || r.login),
  isAdmin: Boolean(r.is_admin),
  storeId: r.store_id === null || r.store_id === undefined ? null : Number(r.store_id),
  storeName: r.store_name === null || r.store_name === undefined ? null : String(r.store_name),
});

/** ФИО из формы: пусто -> null (в подписи будет логин). */
function nameOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > 50) throw new ApiError(400, 'ФИО: не длиннее 50 символов');
  return s;
}

/** Магазин из формы: пусто -> null (офисный пользователь). */
function storeIdOf(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'Магазин указан неверно');
  return n;
}

/** Проверяет, что точка существует, и отдаёт её название (для журнала). */
async function storeNameOf(storeId: number | null): Promise<string | null> {
  if (storeId === null) return null;
  const { rows } = await pool.query('select name from stores where id = $1', [storeId]);
  if (!rows.length) throw new ApiError(400, `Магазин №${storeId} не найден`);
  return String(rows[0].name);
}

// ---------- защита от перебора ----------

/** Простой счётчик неудачных входов: не больше N с одного IP за окно. */
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 10;
const fails = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function checkThrottle(ip: string): void {
  const rec = fails.get(ip);
  if (rec && rec.resetAt > Date.now() && rec.count >= FAIL_LIMIT) {
    throw new ApiError(429, 'Слишком много неудачных попыток входа. Подождите 10 минут');
  }
}

function noteFail(ip: string): void {
  const now = Date.now();
  const rec = fails.get(ip);
  if (!rec || rec.resetAt <= now) {
    fails.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    return;
  }
  rec.count += 1;
}

// ---------- вход / выход ----------

authRouter.post(
  '/login',
  wrap(async (req, res) => {
    const ip = clientIp(req);
    checkThrottle(ip);

    const login = normLogin(String(req.body?.login ?? ''));
    const password = String(req.body?.password ?? '');
    if (!login || !password) throw new ApiError(400, 'Введите логин и пароль');

    const { rows } = await pool.query(
      `select u.id, u.login, u.full_name, u.password_hash, u.is_admin, u.active, u.store_id,
              st.name as store_name
         from users u
         left join stores st on st.id = u.store_id
        where lower(u.login) = $1`,
      [login]
    );
    const row = rows[0];
    if (!row || !verifyPassword(password, String(row.password_hash)) || !row.active) {
      noteFail(ip);
      throw new ApiError(401, 'Неверный логин или пароль');
    }

    fails.delete(ip);
    const user = rowToUser(row);
    const { token } = await createSession(user.id, req.headers['user-agent'] ?? null);
    await pool.query('update users set last_login_at = now() where id = $1', [user.id]);
    await purgeExpiredSessions();

    setSessionCookie(res, token);
    await audit(user, {
      action: 'login',
      entity: 'user',
      entityId: user.id,
      title: `Вход · ${user.fullName}`,
      details: { login: user.login, ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 120) },
    });
    res.json({ user });
  })
);

authRouter.post(
  '/logout',
  wrap(async (req, res) => {
    const s = await readSession(req);
    if (s) {
      await deleteSession(s.token);
      await audit(s.user, { action: 'logout', entity: 'user', entityId: s.user.id, title: `Выход · ${s.user.fullName}` });
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

authRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ user: req.user });
  })
);

// ---------- свой пароль ----------

authRouter.post(
  '/password',
  requireAuth,
  wrap(async (req, res) => {
    const me = req.user as AuthUser;
    const current = String(req.body?.current ?? '');
    const next = reqPassword(req.body ?? {}, 'next');
    if (!current) throw new ApiError(400, 'Введите текущий пароль');

    const { rows } = await pool.query('select password_hash from users where id = $1', [me.id]);
    if (!rows.length) throw new ApiError(404, 'Пользователь не найден');
    if (!verifyPassword(current, String(rows[0].password_hash))) throw new ApiError(400, 'Текущий пароль указан неверно');

    await pool.query('update users set password_hash = $2, updated_at = now() where id = $1', [me.id, hashPassword(next)]);

    // все прочие сессии гасим, текущую перевыпускаем
    await deleteUserSessions(me.id);
    const { token } = await createSession(me.id, req.headers['user-agent'] ?? null);
    setSessionCookie(res, token);
    await audit(me, { action: 'password', entity: 'user', entityId: me.id, title: `Смена своего пароля · ${me.fullName}` });
    res.json({ ok: true });
  })
);

// ---------- пользователи (только админ) ----------

authRouter.get(
  '/users',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select u.id, u.login, coalesce(nullif(btrim(u.full_name), ''), u.login) as full_name,
              u.full_name as full_name_raw,
              u.is_admin, u.active, u.store_id, st.name as store_name,
              u.created_at, u.last_login_at
         from users u
         left join stores st on st.id = u.store_id
        order by u.is_admin desc, lower(u.login)`
    );
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        login: r.login,
        fullName: String(r.full_name),
        // как сохранено на самом деле (null — ФИО не задано, в списке показывается логин)
        fullNameRaw: r.full_name_raw === null || r.full_name_raw === undefined ? null : String(r.full_name_raw),
        isAdmin: Boolean(r.is_admin),
        active: Boolean(r.active),
        storeId: r.store_id === null ? null : Number(r.store_id),
        storeName: r.store_name === null ? null : String(r.store_name),
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      }))
    );
  })
);

authRouter.post(
  '/users',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const login = normLogin(String(req.body?.login ?? ''));
    if (!LOGIN_RE.test(login)) {
      throw new ApiError(400, 'Логин: 3–40 символов, латиница, цифры, точка, дефис, подчёркивание');
    }
    const password = reqPassword(req.body ?? {}, 'password');
    const fullName = nameOf(req.body?.fullName);
    const storeId = storeIdOf(req.body?.storeId);
    const storeName = await storeNameOf(storeId);
    // магазинный пользователь — не администратор: его зона — только своя точка
    const isAdmin = storeId === null ? Boolean(req.body?.isAdmin) : false;

    const { rows: dup } = await pool.query('select 1 from users where lower(login) = $1', [login]);
    if (dup.length) throw new ApiError(409, `Пользователь «${login}» уже существует`);

    const { rows } = await pool.query(
      'insert into users (login, full_name, password_hash, is_admin, store_id) values ($1, $2, $3, $4, $5) returning id',
      [login, fullName, hashPassword(password), isAdmin, storeId]
    );
    const id = Number(rows[0].id);
    await audit(req.user, {
      action: 'create',
      entity: 'user',
      entityId: id,
      title: `Пользователь «${fullName ?? login}»${storeName ? ' · магазин «' + storeName + '»' : ''}`,
      details: { login, isAdmin, storeId, storeName },
    });
    res.status(201).json({ id });
  })
);

authRouter.patch(
  '/users/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const me = req.user as AuthUser;
    const { rows } = await pool.query('select id, login, full_name, is_admin, active, store_id from users where id = $1', [id]);
    const cur = rows[0];
    if (!cur) throw new ApiError(404, 'Пользователь не найден');

    const nextActive = req.body?.active === undefined ? Boolean(cur.active) : Boolean(req.body.active);
    const nextName = req.body?.fullName === undefined ? (cur.full_name as string | null) : nameOf(req.body.fullName);
    const curStoreId = cur.store_id === null ? null : Number(cur.store_id);
    const nextStoreId = req.body?.storeId === undefined ? curStoreId : storeIdOf(req.body.storeId);
    const nextStoreName = await storeNameOf(nextStoreId);
    // магазинному пользователю права администратора не выдаём
    let nextAdmin = req.body?.isAdmin === undefined ? Boolean(cur.is_admin) : Boolean(req.body.isAdmin);
    if (nextStoreId !== null) nextAdmin = false;

    // не даём остаться без активного администратора
    if (Boolean(cur.is_admin) && (!nextAdmin || !nextActive)) {
      const { rows: admins } = await pool.query(
        'select count(*)::int as c from users where is_admin and active and id <> $1',
        [id]
      );
      if (Number(admins[0].c) === 0) throw new ApiError(400, 'Это последний активный администратор — его нельзя отключить или лишить прав');
    }
    if (id === me.id && !nextActive) throw new ApiError(400, 'Нельзя отключить самого себя');

    await pool.query(
      'update users set is_admin = $2, active = $3, full_name = $4, store_id = $5, updated_at = now() where id = $1',
      [id, nextAdmin, nextActive, nextName, nextStoreId]
    );

    let passwordChanged = false;
    if (req.body?.password !== undefined && req.body?.password !== null && req.body?.password !== '') {
      const password = reqPassword(req.body, 'password');
      await pool.query('update users set password_hash = $2, updated_at = now() where id = $1', [id, hashPassword(password)]);
      await deleteUserSessions(id);
      passwordChanged = true;
    } else if (!nextActive) {
      await deleteUserSessions(id);
    }

    const rightsChanged = Boolean(cur.is_admin) !== nextAdmin || Boolean(cur.active) !== nextActive;
    const nameChanged = (cur.full_name ?? null) !== nextName;
    const storeChanged = curStoreId !== nextStoreId;
    await audit(req.user, {
      action: passwordChanged ? 'password' : rightsChanged ? 'role' : 'update',
      entity: 'user',
      entityId: id,
      title: `Пользователь «${nextName ?? cur.login}»${nextStoreName ? ' · магазин «' + nextStoreName + '»' : ''}`,
      details: {
        login: cur.login,
        ...(rightsChanged ? { isAdmin: { from: Boolean(cur.is_admin), to: nextAdmin }, active: { from: Boolean(cur.active), to: nextActive } } : {}),
        ...(nameChanged ? { fullName: { from: cur.full_name ?? null, to: nextName } } : {}),
        ...(storeChanged ? { storeId: { from: curStoreId, to: nextStoreId }, storeName: nextStoreName } : {}),
        ...(passwordChanged ? { passwordReset: true } : {}),
      },
    });
    res.json({ ok: true });
  })
);
