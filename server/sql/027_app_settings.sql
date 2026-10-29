-- Настройки CRM, которые админ меняет из интерфейса (вместо правки server/.env).
-- Сейчас это транспорт запросов к OpenAI: напрямую или через SOCKS/HTTP-прокси (Tor),
-- потому что из ряда стран api.openai.com отвечает 403 unsupported_country_region_territory.
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
