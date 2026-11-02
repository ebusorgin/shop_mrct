-- ============================================================
-- 035: Расписание автосписания заказов со склада.
--   orders.written_off_at — флаг, что строка доски уже списана (защита от
--     повторного списания при следующем прогоне/ручном запуске);
--   writeoff_runs  — один прогон на слот (дата доставки + время): идемпотентность
--     по unique(delivery_date, fired_slot) — второй запуск того же слота скипается.
-- Идемпотентно.
-- ============================================================

alter table orders add column if not exists written_off_at timestamptz;
create index if not exists orders_written_off_idx on orders (date_tab) where written_off_at is null;

create table if not exists writeoff_runs (
  id             serial primary key,
  delivery_date  date not null,
  fired_slot     text not null,                              -- 'HH:MM' по MSK либо 'manual-...' для ручного запуска
  status         text not null default 'running'
                 check (status in ('running','ok','error')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  lines_written  int  not null default 0,
  batches        int  not null default 0,
  raw            jsonb not null default '{}',               -- карточки/порции/пропуски/ошибки по карточкам
  error          text,
  created_by     text not null default 'system',
  unique (delivery_date, fired_slot)
);
