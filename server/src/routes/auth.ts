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
  isAdmin: Boolean(r.is_admin),
});

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
      'select id, login, password_hash, is_admin, active from users where lower(login) = $1',
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
    res.json({ user });
  })
);

authRouter.post(
  '/logout',
  wrap(async (req, res) => {
    const s = await readSession(req);
    if (s) await deleteSession(s.token);
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
      `select id, login, is_admin, active, created_at, last_login_at
         from users
        order by is_admin desc, lower(login)`
    );
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        login: r.login,
        isAdmin: Boolean(r.is_admin),
        active: Boolean(r.active),
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
    const isAdmin = Boolean(req.body?.isAdmin);

    const { rows: dup } = await pool.query('select 1 from users where lower(login) = $1', [login]);
    if (dup.length) throw new ApiError(409, `Пользователь «${login}» уже существует`);

    const { rows } = await pool.query(
      'insert into users (login, password_hash, is_admin) values ($1, $2, $3) returning id',
      [login, hashPassword(password), isAdmin]
    );
    res.status(201).json({ id: Number(rows[0].id) });
  })
);

authRouter.patch(
  '/users/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const me = req.user as AuthUser;
    const { rows } = await pool.query('select id, login, is_admin, active from users where id = $1', [id]);
    const cur = rows[0];
    if (!cur) throw new ApiError(404, 'Пользователь не найден');

    const nextAdmin = req.body?.isAdmin === undefined ? Boolean(cur.is_admin) : Boolean(req.body.isAdmin);
    const nextActive = req.body?.active === undefined ? Boolean(cur.active) : Boolean(req.body.active);

    // не даём остаться без активного администратора
    if (Boolean(cur.is_admin) && (!nextAdmin || !nextActive)) {
      const { rows: admins } = await pool.query(
        'select count(*)::int as c from users where is_admin and active and id <> $1',
        [id]
      );
      if (Number(admins[0].c) === 0) throw new ApiError(400, 'Это последний активный администратор — его нельзя отключить или лишить прав');
    }
    if (id === me.id && !nextActive) throw new ApiError(400, 'Нельзя отключить самого себя');

    await pool.query('update users set is_admin = $2, active = $3, updated_at = now() where id = $1', [
      id,
      nextAdmin,
      nextActive,
    ]);

    if (req.body?.password !== undefined && req.body?.password !== null && req.body?.password !== '') {
      const password = reqPassword(req.body, 'password');
      await pool.query('update users set password_hash = $2, updated_at = now() where id = $1', [id, hashPassword(password)]);
      await deleteUserSessions(id);
    } else if (!nextActive) {
      await deleteUserSessions(id);
    }

    res.json({ ok: true });
  })
);
