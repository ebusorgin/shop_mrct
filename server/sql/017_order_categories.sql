-- ============================================================
-- 017: Категории строк заказа (из листов Google Таблицы: «salati», «gorjacoe»…).
-- Нужны для фильтра «по категории» на страницах магазинов. Идемпотентно.
-- ============================================================

create table if not exists order_categories (
  id    serial primary key,
  name  text unique not null
);

alter table orders add column if not exists category_id int references order_categories(id);

-- Категории известны только из источника — заполняет синхронизатор.
-- Пустая таблица до первой синхронизации допустима: UI тогда фильтрует только по поиску.
