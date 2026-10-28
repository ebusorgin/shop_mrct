-- Пользователи CRM и сессии входа.
-- Пароль хранится только как scrypt-хэш (см. server/src/services/auth.ts),
-- от сессионного токена в БД лежит sha256 — сырой токен есть только в cookie клиента.

create table if not exists users (
  id serial primary key,
  login text not null,
  password_hash text not null,
  is_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- логин уникален без учёта регистра: Admin и admin — один и тот же пользователь
create unique index if not exists users_login_lower_uidx on users (lower(login));

create table if not exists sessions (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);
