-- ============================================================
-- 036: Жизненный цикл листа доставки + отчёт по автосписанию.
--   order_tabs.status — 'open' лист редактируется магазинами, 'locked' — после
--     списания закрыт (магазины правки не вносят), 'archived' — далёкое прошлое.
--   locked_at — когда закрыли. По дате листа (extract_date) сверяем, закрыта ли доставка.
-- Идемпотентно.
-- ============================================================

alter table order_tabs add column if not exists status text not null default 'open'
  check (status in ('open','locked','archived'));
alter table order_tabs add column if not exists locked_at timestamptz;
create index if not exists order_tabs_extract_idx on order_tabs (extract_date desc);
