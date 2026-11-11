-- ============================================================
-- MIX markt CRM — единственный файл инициализации БД.
-- Выполняется при каждом старте сервера (src/init-db.ts) и идемпотентен:
-- повторный запуск не меняет существующую схему и данные.
-- Новые изменения схемы добавляйте сюда же с IF NOT EXISTS.
--
-- Единицы измерения: всё хранится в БАЗОВЫХ единицах —
--   mass -> граммы (г), volume -> миллилитры (мл), count -> штуки (шт).
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------- Очистка от удалённых модулей ----------

drop table if exists schema_migrations;
drop table if exists order_changes cascade;
drop table if exists orders cascade;
drop table if exists order_tabs cascade;
drop table if exists order_categories cascade;
drop table if exists writeoff_runs cascade;
drop function if exists orders_audit_fn() cascade;

-- ---------- Справочники и склад ----------

create table if not exists units (
  id          serial primary key,
  code        text unique not null,
  name        text not null,
  dimension   text not null check (dimension in ('mass','volume','count')),
  base_factor numeric not null default 1,
  constraint units_only_base check (base_factor = 1)
);

create table if not exists products (
  id              serial primary key,
  name            text unique not null,
  category        text not null default 'прочее',
  unit_id         int not null,
  min_stock       numeric not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  g_per_pcs       numeric check (g_per_pcs is null or g_per_pcs >= 0),
  ml_per_pcs      numeric check (ml_per_pcs is null or ml_per_pcs >= 0),
  g_per_ml        numeric check (g_per_ml is null or g_per_ml >= 0),
  shelf_life_days int check (shelf_life_days is null or shelf_life_days >= 0),
  created_by      int,
  updated_by      int
);

create table if not exists product_categories (
  id   serial primary key,
  name text unique not null
);

-- оформление категории сырья: иконка (эмодзи) и фоновый цвет
alter table product_categories add column if not exists icon text not null default '';
alter table product_categories add column if not exists color text not null default '';

create unique index if not exists product_categories_icon_uniq
  on product_categories (icon) where icon <> '';

-- Каталог готовой продукции (разделы меню/витрины): техкарты ссылаются на него.
create table if not exists product_catalogs (
  id       serial primary key,
  name     text unique not null,
  position int not null default 0
);

-- витрина каталога: иконка (эмодзи) и фоновый цвет
alter table product_catalogs add column if not exists icon text not null default '';
alter table product_catalogs add column if not exists color text not null default '';

-- иконка уникальна среди каталогов; пустая («без иконки») может повторяться
create unique index if not exists product_catalogs_icon_uniq
  on product_catalogs (icon) where icon <> '';

create table if not exists product_aliases (
  id         serial primary key,
  product_id int not null,
  alias      text unique not null,
  alias_raw  text not null,
  source     text not null default 'waybill',
  created_at timestamptz not null default now()
);

-- Остаток материализован и пересчитывается из movements внутри транзакции.
create table if not exists stock (
  product_id int primary key,
  qty        numeric not null default 0,
  avg_cost   numeric not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists movements (
  id         bigserial primary key,
  product_id int not null,
  type       text not null check (type in ('receipt','writeoff','adjustment')),
  qty        numeric not null,
  unit_cost  numeric not null default 0,
  doc_type   text,
  doc_id     int,
  comment    text,
  created_at timestamptz not null default now(),
  user_id    int,
  user_login text
);

-- ---------- Производство: полуфабрикаты и техкарты ----------

create table if not exists semi_products (
  id              serial primary key,
  name            text unique not null,
  unit_id         int not null,
  note            text default '',
  created_at      timestamptz not null default now(),
  g_per_pcs       numeric check (g_per_pcs is null or g_per_pcs >= 0),
  ml_per_pcs      numeric check (ml_per_pcs is null or ml_per_pcs >= 0),
  g_per_ml        numeric check (g_per_ml is null or g_per_ml >= 0),
  shelf_life_days int check (shelf_life_days is null or shelf_life_days >= 0),
  created_by      int,
  updated_by      int,
  out_qty         numeric not null default 1,
  board           jsonb
);

create table if not exists semi_inputs (
  id             serial primary key,
  semi_id        int not null,
  yield_pct      numeric check (yield_pct > 0 and yield_pct <= 100),
  qty_per_output numeric check (qty_per_output > 0),
  source_type    text not null default 'raw' check (source_type in ('raw','semi')),
  ref_id         int not null
);

comment on column semi_inputs.yield_pct is 'base: выход после уварки/очистки, %; additive (опц.): выход своей уварки, % — сырой вход делится на него';
comment on column semi_inputs.qty_per_output is 'количество входа на партию, в базовых единицах входа; yield_pct (если задан) — потери при обработке этого входа';
comment on column semi_inputs.source_type is 'raw = складское сырьё (products.id), semi = другой полуфабрикат (semi_products.id)';

create table if not exists tech_cards (
  id              serial primary key,
  name            text not null,
  portion_qty     numeric not null check (portion_qty > 0),
  portion_unit_id int not null,
  note            text default '',
  created_at      timestamptz not null default now(),
  plu             text,
  created_by      int,
  updated_by      int,
  catalog_id      int
);

-- каталог продукции появился позже — добавляем колонку в уже работающие базы
alter table tech_cards add column if not exists catalog_id int;

-- остатки старого модуля заказов
alter table tech_cards drop column if exists category_id;
alter table tech_cards drop column if exists min_qty;

create table if not exists tech_card_items (
  id          serial primary key,
  card_id     int not null,
  source_type text not null check (source_type in ('raw','semi','product')),
  ref_id      int not null,
  qty         numeric not null check (qty > 0),
  unit_id     int not null,
  position    int not null default 0
);

-- продукт может входить в состав другого продукта: raw = products, semi = semi_products, product = tech_cards
alter table tech_card_items drop constraint if exists tech_card_items_source_type_check;
alter table tech_card_items add constraint tech_card_items_source_type_check
  check (source_type in ('raw','semi','product'));
comment on column tech_card_items.source_type is 'raw = products.id, semi = semi_products.id, product = другой продукт tech_cards.id';

create table if not exists production_batches (
  id            serial primary key,
  card_id       int not null,
  portions      int not null check (portions > 0),
  batch_date    date not null default current_date,
  cost_total    numeric not null default 0,
  note          text default '',
  status        text not null default 'posted' check (status in ('posted','reversed')),
  created_at    timestamptz not null default now(),
  created_by    int,
  created_login text
);

create table if not exists production_batch_items (
  id         serial primary key,
  batch_id   int not null,
  product_id int not null,
  qty        numeric not null,
  unit_cost  numeric not null default 0
);

-- ---------- Приходные накладные ----------

create table if not exists waybills (
  id              serial primary key,
  number          text not null,
  supplier        text not null default '',
  doc_date        date not null default current_date,
  created_at      timestamptz not null default now(),
  file_name       text,
  stored_file     text,
  status          text not null default 'posted' check (status in ('posted','reversed')),
  supplier_pib    text,
  currency        text not null default 'RSD',
  total_net       numeric(14,2),
  total_vat       numeric(14,2),
  total_gross     numeric(14,2),
  doc_total_net   numeric(14,2),
  doc_total_vat   numeric(14,2),
  doc_total_gross numeric(14,2),
  file_data       bytea,
  file_mime       text,
  extra_files     jsonb,
  accepted_by     int,
  accepted_login  text,
  accepted_at     timestamptz,
  reversed_by     int,
  reversed_login  text,
  reversed_at     timestamptz
);

create table if not exists waybill_items (
  id         serial primary key,
  waybill_id int not null,
  product_id int not null,
  qty        numeric not null check (qty > 0),
  unit_id    int not null,
  price      numeric not null default 0,
  vat_rate   numeric(6,3),
  vat_amount numeric(14,2)
);

comment on column waybill_items.vat_rate is 'Ставка PDV в процентах; null = нет данных / без PDV';

-- ---------- Точки продаж, пользователи и сессии ----------

create table if not exists stores (
  id             int primary key,                   -- 103…110
  code           text unique not null,              -- 'Mix 38103'
  name           text not null,
  active         boolean not null default true,
  position       int not null default 0,
  address        text not null default '',
  phone          text not null default '',
  email          text not null default '',
  contact_person text not null default '',
  opening_hours  text not null default '',
  note           text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     int,
  updated_by     int,
  pib            text not null default '',
  mbr            text not null default '',
  account_no     text not null default ''
);

create table if not exists users (
  id            serial primary key,
  login         text not null,
  password_hash text not null,
  is_admin      boolean not null default false,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_login_at timestamptz,
  full_name     varchar(50),
  store_id      int
);

create table if not exists sessions (
  token_hash text primary key,
  user_id    int not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

-- ---------- Журнал действий, настройки ----------

create table if not exists audit_log (
  id         bigserial primary key,
  user_id    int,
  user_login text not null default 'system',
  action     text not null,
  entity     text not null,
  entity_id  text,
  title      text not null default '',
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  user_name  text
);

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- ---------- Внешние ключи ----------
-- Отдельным блоком: users и stores ссылаются друг на друга.
-- Повторный запуск пропускает уже созданные ограничения.

do $$
declare
  fk record;
begin
  for fk in
    select *
      from (values
        ('audit_log',              'audit_log_user_id_fkey',                 'foreign key (user_id) references users(id) on delete set null'),
        ('movements',              'movements_product_id_fkey',              'foreign key (product_id) references products(id)'),
        ('movements',              'movements_user_id_fkey',                 'foreign key (user_id) references users(id) on delete set null'),
        ('product_aliases',        'product_aliases_product_id_fkey',        'foreign key (product_id) references products(id) on delete cascade'),
        ('production_batch_items', 'production_batch_items_batch_id_fkey',   'foreign key (batch_id) references production_batches(id) on delete cascade'),
        ('production_batch_items', 'production_batch_items_product_id_fkey', 'foreign key (product_id) references products(id)'),
        ('production_batches',     'production_batches_card_id_fkey',        'foreign key (card_id) references tech_cards(id)'),
        ('production_batches',     'production_batches_created_by_fkey',     'foreign key (created_by) references users(id) on delete set null'),
        ('products',               'products_created_by_fkey',               'foreign key (created_by) references users(id) on delete set null'),
        ('products',               'products_unit_id_fkey',                  'foreign key (unit_id) references units(id)'),
        ('products',               'products_updated_by_fkey',               'foreign key (updated_by) references users(id) on delete set null'),
        ('semi_inputs',            'semi_inputs_semi_id_fkey',               'foreign key (semi_id) references semi_products(id) on delete cascade'),
        ('semi_products',          'semi_products_created_by_fkey',          'foreign key (created_by) references users(id) on delete set null'),
        ('semi_products',          'semi_products_unit_id_fkey',             'foreign key (unit_id) references units(id)'),
        ('semi_products',          'semi_products_updated_by_fkey',          'foreign key (updated_by) references users(id) on delete set null'),
        ('sessions',               'sessions_user_id_fkey',                  'foreign key (user_id) references users(id) on delete cascade'),
        ('stock',                  'stock_product_id_fkey',                  'foreign key (product_id) references products(id) on delete cascade'),
        ('stores',                 'stores_created_by_fkey',                 'foreign key (created_by) references users(id) on delete set null'),
        ('stores',                 'stores_updated_by_fkey',                 'foreign key (updated_by) references users(id) on delete set null'),
        ('tech_card_items',        'tech_card_items_card_id_fkey',           'foreign key (card_id) references tech_cards(id) on delete cascade'),
        ('tech_card_items',        'tech_card_items_unit_id_fkey',           'foreign key (unit_id) references units(id)'),
        ('tech_cards',             'tech_cards_catalog_id_fkey',             'foreign key (catalog_id) references product_catalogs(id) on delete set null'),
        ('tech_cards',             'tech_cards_created_by_fkey',             'foreign key (created_by) references users(id) on delete set null'),
        ('tech_cards',             'tech_cards_portion_unit_id_fkey',        'foreign key (portion_unit_id) references units(id)'),
        ('tech_cards',             'tech_cards_updated_by_fkey',             'foreign key (updated_by) references users(id) on delete set null'),
        ('users',                  'users_store_id_fkey',                    'foreign key (store_id) references stores(id) on delete set null'),
        ('waybill_items',          'waybill_items_product_id_fkey',          'foreign key (product_id) references products(id)'),
        ('waybill_items',          'waybill_items_unit_id_fkey',             'foreign key (unit_id) references units(id)'),
        ('waybill_items',          'waybill_items_waybill_id_fkey',          'foreign key (waybill_id) references waybills(id) on delete cascade'),
        ('waybills',               'waybills_accepted_by_fkey',              'foreign key (accepted_by) references users(id) on delete set null'),
        ('waybills',               'waybills_reversed_by_fkey',              'foreign key (reversed_by) references users(id) on delete set null')
      ) as v(tbl, con, def)
  loop
    if not exists (
      select 1
        from pg_constraint
       where conrelid = fk.tbl::regclass
         and conname = fk.con
    ) then
      execute format('alter table %I add constraint %I %s', fk.tbl, fk.con, fk.def);
    end if;
  end loop;
end $$;

-- ---------- Индексы ----------

create index if not exists audit_log_created_idx         on audit_log (created_at desc);
create index if not exists audit_log_entity_id_idx       on audit_log (entity, entity_id);
create index if not exists audit_log_entity_idx          on audit_log (entity, created_at desc);
create index if not exists audit_log_user_idx            on audit_log (user_id, created_at desc);
create index if not exists movements_doc_idx             on movements (doc_type, doc_id);
create index if not exists movements_product_idx         on movements (product_id, created_at desc);
create index if not exists product_aliases_prod_idx      on product_aliases (product_id);
create index if not exists product_aliases_trgm          on product_aliases using gin (alias gin_trgm_ops);
create index if not exists products_name_trgm            on products using gin (name gin_trgm_ops);
create index if not exists sessions_expires_idx          on sessions (expires_at);
create index if not exists sessions_user_idx             on sessions (user_id);
create unique index if not exists tech_cards_plu_uniq    on tech_cards (plu) where plu is not null and plu <> '';
create unique index if not exists users_login_lower_uidx on users (lower(login));
create index if not exists users_store_idx               on users (store_id);
create unique index if not exists waybills_number_active_uniq on waybills (btrim(number)) where status <> 'reversed';
create index if not exists waybills_status_idx           on waybills (status);

-- ---------- Справочные данные ----------

insert into units (code, name, dimension, base_factor) values
  ('г',  'грамм',     'mass',   1),
  ('мл', 'миллилитр', 'volume', 1),
  ('шт', 'штука',     'count',  1)
on conflict do nothing;

insert into stores (id, code, name, position) values
  (103, 'Mix 38103', 'Магазин 103', 1),
  (104, 'Mix 38104', 'Магазин 104', 2),
  (105, 'Mix 38105', 'Магазин 105', 3),
  (106, 'Mix 38106', 'Магазин 106', 4),
  (107, 'Mix 38107', 'Магазин 107', 5),
  (108, 'Mix 38108', 'Магазин 108', 6),
  (109, 'Mix 38109', 'Магазин 109', 7),
  (110, 'Mix 38110', 'Магазин 110', 8)
on conflict do nothing;

insert into product_catalogs (name, position) values
  ('салаты', 1),
  ('заморозка', 2),
  ('горячие блюда', 3),
  ('соленья', 4),
  ('супы', 5)
on conflict (name) do nothing;
