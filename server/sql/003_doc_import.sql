-- ============================================================
-- 003: импорт накладных из файлов (GPT)
--   * product_aliases — запомненные псевдонимы: название из документа -> позиция склада.
--     alias хранится нормализованным (lower, ё->е, без пунктуации), уникален:
--     одно имя может вести только на одну позицию.
--   * pg_trgm — нечёткий поиск похожих названий для подсказок.
--   * waybills — прикреплённый файл накладной.
-- ============================================================

create extension if not exists pg_trgm;

create table if not exists product_aliases (
  id          serial primary key,
  product_id  int not null references products(id) on delete cascade,
  alias       text not null unique,               -- нормализованный псевдоним
  alias_raw   text not null,                      -- как написано в документе
  source      text not null default 'waybill',
  created_at  timestamptz not null default now()
);
create index if not exists product_aliases_prod_idx on product_aliases(product_id);

-- нечёткий поиск по названиям и псевдонимам
create index if not exists products_name_trgm    on products        using gin (name gin_trgm_ops);
create index if not exists product_aliases_trgm  on product_aliases using gin (alias gin_trgm_ops);

alter table waybills add column if not exists file_name   text;  -- исходное имя файла
alter table waybills add column if not exists stored_file text;  -- имя файла на диске (uploads/waybills)
