-- ============================================================
-- 037: Поля для выставления счетов/отпремниц (PIB, MBR, Broj računa) для магазинов.
-- Идемпотентно.
-- ============================================================

alter table stores add column if not exists pib text not null default '';
alter table stores add column if not exists mbr text not null default '';
alter table stores add column if not exists account_no text not null default '';
