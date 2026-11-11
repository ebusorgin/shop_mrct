-- ============================================================
-- MIX markt CRM — единый файл инициализации БД.
-- Заменяет всю прежнюю цепочку миграций 001…039: схема собрана из их
-- итогового состояния и очищена от модуля заказов (orders, order_tabs,
-- order_changes, order_categories, writeoff_runs) и объектов умершей
-- синхронизации с Google Таблицами (sheet_events, order_sync_run).
--
-- Рассчитан на ПУСТУЮ базу: применяется один раз, повторный запуск
-- отслеживает schema_migrations (см. src/migrate.ts).
--
-- Единицы измерения: всё хранится в БАЗОВЫХ единицах —
--   mass -> граммы (г), volume -> миллилитры (мл), count -> штуки (шт).
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------- Справочники и склад ----------

create table units (
  id          serial primary key,
  code        text unique not null,
  name        text not null,
  dimension   text not null check (dimension in ('mass','volume','count')),
  base_factor numeric not null default 1,
  constraint units_only_base check (base_factor = 1)
);

create table products (
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

create table product_categories (
  id   serial primary key,
  name text unique not null
);

create table product_aliases (
  id         serial primary key,
  product_id int not null,
  alias      text unique not null,
  alias_raw  text not null,
  source     text not null default 'waybill',
  created_at timestamptz not null default now()
);

-- Остаток материализован и пересчитывается из movements внутри транзакции.
create table stock (
  product_id int primary key,
  qty        numeric not null default 0,
  avg_cost   numeric not null default 0,
  updated_at timestamptz not null default now()
);

create table movements (
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

create table semi_products (
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

create table semi_inputs (
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

create table tech_cards (
  id              serial primary key,
  name            text not null,
  portion_qty     numeric not null check (portion_qty > 0),
  portion_unit_id int not null,
  note            text default '',
  created_at      timestamptz not null default now(),
  plu             text,
  created_by      int,
  updated_by      int
);

create table tech_card_items (
  id          serial primary key,
  card_id     int not null,
  source_type text not null check (source_type in ('raw','semi')),
  ref_id      int not null,
  qty         numeric not null check (qty > 0),
  unit_id     int not null,
  position    int not null default 0
);

create table production_batches (
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

create table production_batch_items (
  id         serial primary key,
  batch_id   int not null,
  product_id int not null,
  qty        numeric not null,
  unit_cost  numeric not null default 0
);

-- ---------- Приходные накладные ----------

create table waybills (
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

create table waybill_items (
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

create table stores (
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

create table users (
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

create table sessions (
  token_hash text primary key,
  user_id    int not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

-- ---------- Журнал действий, настройки ----------

create table audit_log (
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

create table app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);


-- ---------- Внешние ключи ----------
-- Отдельным блоком: users и stores ссылаются друг на друга.

alter table audit_log              add constraint audit_log_user_id_fkey                 foreign key (user_id)         references users(id)              on delete set null;
alter table movements              add constraint movements_product_id_fkey              foreign key (product_id)      references products(id);
alter table movements              add constraint movements_user_id_fkey                 foreign key (user_id)         references users(id)              on delete set null;
alter table product_aliases        add constraint product_aliases_product_id_fkey        foreign key (product_id)      references products(id)           on delete cascade;
alter table production_batch_items add constraint production_batch_items_batch_id_fkey   foreign key (batch_id)        references production_batches(id) on delete cascade;
alter table production_batch_items add constraint production_batch_items_product_id_fkey foreign key (product_id)      references products(id);
alter table production_batches     add constraint production_batches_card_id_fkey        foreign key (card_id)         references tech_cards(id);
alter table production_batches     add constraint production_batches_created_by_fkey     foreign key (created_by)      references users(id)              on delete set null;
alter table products               add constraint products_created_by_fkey               foreign key (created_by)      references users(id)              on delete set null;
alter table products               add constraint products_unit_id_fkey                  foreign key (unit_id)         references units(id);
alter table products               add constraint products_updated_by_fkey               foreign key (updated_by)      references users(id)              on delete set null;
alter table semi_inputs            add constraint semi_inputs_semi_id_fkey               foreign key (semi_id)         references semi_products(id)      on delete cascade;
alter table semi_products          add constraint semi_products_created_by_fkey          foreign key (created_by)      references users(id)              on delete set null;
alter table semi_products          add constraint semi_products_unit_id_fkey             foreign key (unit_id)         references units(id);
alter table semi_products          add constraint semi_products_updated_by_fkey          foreign key (updated_by)      references users(id)              on delete set null;
alter table sessions               add constraint sessions_user_id_fkey                  foreign key (user_id)         references users(id)              on delete cascade;
alter table stock                  add constraint stock_product_id_fkey                  foreign key (product_id)      references products(id)           on delete cascade;
alter table stores                 add constraint stores_created_by_fkey                 foreign key (created_by)      references users(id)              on delete set null;
alter table stores                 add constraint stores_updated_by_fkey                 foreign key (updated_by)      references users(id)              on delete set null;
alter table tech_card_items        add constraint tech_card_items_card_id_fkey           foreign key (card_id)         references tech_cards(id)         on delete cascade;
alter table tech_card_items        add constraint tech_card_items_unit_id_fkey           foreign key (unit_id)         references units(id);
alter table tech_cards             add constraint tech_cards_created_by_fkey             foreign key (created_by)      references users(id)              on delete set null;
alter table tech_cards             add constraint tech_cards_portion_unit_id_fkey        foreign key (portion_unit_id) references units(id);
alter table tech_cards             add constraint tech_cards_updated_by_fkey             foreign key (updated_by)      references users(id)              on delete set null;
alter table users                  add constraint users_store_id_fkey                    foreign key (store_id)        references stores(id)             on delete set null;
alter table waybill_items          add constraint waybill_items_product_id_fkey          foreign key (product_id)      references products(id);
alter table waybill_items          add constraint waybill_items_unit_id_fkey             foreign key (unit_id)         references units(id);
alter table waybill_items          add constraint waybill_items_waybill_id_fkey          foreign key (waybill_id)      references waybills(id)           on delete cascade;
alter table waybills               add constraint waybills_accepted_by_fkey              foreign key (accepted_by)     references users(id)              on delete set null;
alter table waybills               add constraint waybills_reversed_by_fkey              foreign key (reversed_by)     references users(id)              on delete set null;

-- ---------- Индексы ----------

create index audit_log_created_idx         on audit_log (created_at desc);
create index audit_log_entity_id_idx       on audit_log (entity, entity_id);
create index audit_log_entity_idx          on audit_log (entity, created_at desc);
create index audit_log_user_idx            on audit_log (user_id, created_at desc);
create index movements_doc_idx             on movements (doc_type, doc_id);
create index movements_product_idx         on movements (product_id, created_at desc);
create index product_aliases_prod_idx      on product_aliases (product_id);
create index product_aliases_trgm          on product_aliases using gin (alias gin_trgm_ops);
create index products_name_trgm            on products using gin (name gin_trgm_ops);
create index sessions_expires_idx          on sessions (expires_at);
create index sessions_user_idx             on sessions (user_id);
create unique index tech_cards_plu_uniq    on tech_cards (plu) where plu is not null and plu <> '';
create unique index users_login_lower_uidx on users (lower(login));
create index users_store_idx               on users (store_id);
create unique index waybills_number_active_uniq on waybills (btrim(number)) where status <> 'reversed';
create index waybills_status_idx           on waybills (status);

-- ---------- Справочные данные ----------

insert into units (code, name, dimension, base_factor) values
  ('г',  'грамм',     'mass',   1),
  ('мл', 'миллилитр', 'volume', 1),
  ('шт', 'штука',     'count',  1);

insert into stores (id, code, name, position) values
  (103, 'Mix 38103', 'Магазин 103', 1),
  (104, 'Mix 38104', 'Магазин 104', 2),
  (105, 'Mix 38105', 'Магазин 105', 3),
  (106, 'Mix 38106', 'Магазин 106', 4),
  (107, 'Mix 38107', 'Магазин 107', 5),
  (108, 'Mix 38108', 'Магазин 108', 6),
  (109, 'Mix 38109', 'Магазин 109', 7),
  (110, 'Mix 38110', 'Магазин 110', 8);