-- ============================================================
-- 022: события Google Таблицы заказов.
--   sheet_events — журнал уведомлений: вебхук Apps Script (source='apps_script'),
--   серверный вотчер листа (source='watch') и ручные прогоны (source='manual').
-- Нужен для отладки «почему пришла/не пришла плашка» и чтобы видеть, кто правил.
-- Идемпотентно.
-- ============================================================

create table if not exists sheet_events (
  id          bigserial primary key,
  source      text not null check (source in ('apps_script', 'watch', 'manual')),
  sheet_name  text,                                  -- вкладка («28.10»), если известна
  change_type text,                                  -- EDIT / INSERT_ROW / TEST / hash_changed
  actor       text,                                  -- e-mail из Apps Script, если Google его отдал
  payload     jsonb not null default '{}',           -- сырое тело вебхука — как пришло
  created_at  timestamptz not null default now()
);

create index if not exists sheet_events_created_idx on sheet_events (created_at desc);
