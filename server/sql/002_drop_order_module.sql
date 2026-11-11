-- ============================================================
-- Одноразовая идемпотентная миграция для баз, созданных до удаления
-- модуля заказов. Новый 001_init.sql таких объектов уже не создаёт;
-- здесь они удаляются из уже работающих баз (локальная и боевая).
-- ============================================================

drop table if exists order_changes cascade;
drop table if exists orders cascade;
drop table if exists order_tabs cascade;
drop table if exists order_categories cascade;
drop table if exists writeoff_runs cascade;

drop function if exists orders_audit_fn() cascade;

alter table if exists tech_cards drop column if exists category_id;
alter table if exists tech_cards drop column if exists min_qty;
