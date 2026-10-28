import { NextFunction, Request, RequestHandler, Response } from 'express';
import * as crypto from 'crypto';
// config первым: dotenv должен прочитать .env до создания пула
import { config } from '../config';
import { pool } from '../db';

/** Пользователь, под которым выполняется запрос. */
export interface AuthUser {
  id: number;
  login: string;
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const SESSION_COOKIE = 'mix_session';

// ---------- пароли ----------

const SCRYPT_KEYLEN = 64;

/** `scrypt$<saltHex>$<hashHex>` — формат хранения пароля в users.password_hash. */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
    actual = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------- cookie ----------

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return part.slice(i + 1).trim();
      }
    }
  }
  return null;
}

const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionDays * 24 * 60 * 60}`;

export function setSessionCookie(res: Response, token: string): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs}`);
}

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---------- сессии ----------

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(userId: number, userAgent: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    `insert into sessions (token_hash, user_id, expires_at, user_agent)
     values ($1, $2, now() + ($3::text || ' days')::interval, $4)
     returning expires_at`,
    [sha256(token), userId, String(config.sessionDays), userAgent?.slice(0, 300) ?? null]
  );
  return { token, expiresAt: rows[0].expires_at as Date };
}

/** Текущая сессия запроса: пользователь + сырой токен (нужен для logout/смены пароля). */
export async function readSession(req: Request): Promise<{ token: string; user: AuthUser } | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const { rows } = await pool.query(
    `select u.id, u.login, u.is_admin
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.active
      limit 1`,
    [sha256(token)]
  );
  if (!rows.length) return null;
  return { token, user: { id: Number(rows[0].id), login: String(rows[0].login), isAdmin: Boolean(rows[0].is_admin) } };
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query('delete from sessions where token_hash = $1', [sha256(token)]);
}

/** Удаляет сессии пользователя; `keepToken` — оставить текущую (ротация при смене пароля). */
export async function deleteUserSessions(userId: number, keepToken?: string): Promise<void> {
  if (keepToken) {
    await pool.query('delete from sessions where user_id = $1 and token_hash <> $2', [userId, sha256(keepToken)]);
  } else {
    await pool.query('delete from sessions where user_id = $1', [userId]);
  }
}

export async function purgeExpiredSessions(): Promise<void> {
  await pool.query('delete from sessions where expires_at < now()');
}

// ---------- middleware ----------

export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  readSession(req)
    .then((s) => {
      if (!s) {
        res.status(401).json({ error: 'Требуется вход в систему' });
        return;
      }
      req.user = s.user;
      next();
    })
    .catch(next);
};

export const requireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'Доступно только администратору' });
    return;
  }
  next();
};

// ---------- первый администратор ----------

/**
 * Создаёт админа, если пользователей ещё нет.
 * Пароль берём из AUTH_ADMIN_PASSWORD; если он не задан — генерируем и печатаем один раз в лог,
 * чтобы CRM нельзя было поднять с пустым паролем.
 */
export async function ensureAdminUser(): Promise<void> {
  const { rows } = await pool.query('select count(*)::int as c from users');
  if (Number(rows[0].c) > 0) return;

  const login = (config.authAdminLogin || 'admin').trim().toLowerCase();
  const generated = !config.authAdminPassword;
  const password = config.authAdminPassword || crypto.randomBytes(9).toString('base64url');

  await pool.query(
    'insert into users (login, password_hash, is_admin) values ($1, $2, true)',
    [login, hashPassword(password)]
  );

  if (generated) {
    console.log(
      `[auth] создан администратор "${login}"\n` +
        `[auth] ПАРОЛЬ (показан один раз, смените в CRM -> пользователи): ${password}\n` +
        '[auth] чтобы задать свой, укажите AUTH_ADMIN_PASSWORD в server/.env до первого старта'
    );
  } else {
    console.log(`[auth] создан администратор "${login}" (пароль из AUTH_ADMIN_PASSWORD)`);
  }
}
