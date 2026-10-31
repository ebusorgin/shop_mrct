-- ============================================================
-- 029: Словарь категорий сырья (номенклатура склада, products).
-- Категории редактируются в «Настройках» (дерево), там же привязка позиций.
-- products.category остаётся текстовым значением, которое читает склад/ИИ;
-- словарь задаёт допустимый набор имён. «прочее» — корзина нераспределённого,
-- в словарь НЕ заносится. Идемпотентно.
-- ============================================================

create table if not exists product_categories (
  id   serial primary key,
  name text not null unique
);

-- Заносим уже использующиеся категории (кроме «прочее»), регистр — строчными.
insert into product_categories (name)
  select distinct lower(btrim(category))
    from products
   where coalesce(btrim(category), '') <> ''
     and lower(btrim(category)) <> 'прочее'
on conflict (name) do nothing;
