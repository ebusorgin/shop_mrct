-- ============================================================
-- 028: Категории товаров (техкарт). Связь tech_cards → order_categories.
-- Категории редактируются в «Настройках»; там же привязка товаров.
-- Идемпотентно.
-- ============================================================

alter table tech_cards add column if not exists category_id int references order_categories(id) on delete set null;

-- Убираем жёсткий FK на orders (при удалении категории строки не должны блокировать)
alter table orders drop constraint if exists orders_category_id_fkey;
alter table orders add constraint orders_category_id_fkey
  foreign key (category_id) references order_categories(id) on delete set null;

create index if not exists tech_cards_category_idx on tech_cards (category_id) where category_id is not null;
