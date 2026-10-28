-- ============================================================
-- 020: «Точки продаж» — расширенный профиль магазина (торговая точка).
--   Добавляем в stores поля адреса/контактов/режима работы и служебные
--   created_at/updated_at. Существующие seed-точки 103..110 остаются валидными
--   (новые текстовые поля = ''). Идемпотентно.
-- ============================================================

alter table stores add column if not exists address        text not null default '';
alter table stores add column if not exists phone          text not null default '';
alter table stores add column if not exists email          text not null default '';
alter table stores add column if not exists contact_person text not null default '';
alter table stores add column if not exists opening_hours  text not null default '';
alter table stores add column if not exists note           text not null default '';
alter table stores add column if not exists created_at     timestamptz not null default now();
alter table stores add column if not exists updated_at     timestamptz not null default now();
