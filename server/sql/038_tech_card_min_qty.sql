-- 038: Минимальный заказ (min_qty) на технологическую карту (настраивается производством).
alter table tech_cards add column if not exists min_qty numeric;
