-- ============================================================
-- 004: откат (сторно) входящих накладных
--   status: posted — приход на складе учтён
--           reversed — накладная отменена, движения отсторнированы
-- ============================================================

alter table waybills add column if not exists status text not null default 'posted'
  check (status in ('posted','reversed'));

create index if not exists waybills_status_idx on waybills(status);
