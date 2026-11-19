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

-- Реестр одноразовых изменений данных. Схема применяется при каждом старте,
-- но бэкфиллы не должны повторяться и не должны зависеть от текущей даты.
create table if not exists app_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);

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

-- Системные категории склада: их нельзя удалить (и переименовать).
alter table product_categories add column if not exists protected boolean not null default false;
-- Ручной порядок категорий (перетаскивание в настройках).
alter table product_categories add column if not exists position int not null default 0;
do $$
begin
  if not exists (select 1 from app_migrations where name = 'rawcat_position_v1') then
    with ordered as (
      select id, row_number() over (order by name) as rn from product_categories
    )
    update product_categories pc set position = o.rn from ordered o where o.id = pc.id;
    insert into app_migrations (name) values ('rawcat_position_v1');
  end if;
end $$;
insert into product_categories (name, icon, color, protected, position) values
  ('упаковка', '📦', '#efe7d8', true, coalesce((select max(position) + 1 from product_categories), 1)),
  ('прочее',   '🗂', '#e9e6df', true, coalesce((select max(position) + 1 from product_categories), 1) + 1)
on conflict (name) do update set protected = true;
update product_categories set protected = true
 where lower(btrim(name)) in ('упаковка', 'прочее');

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
  name_en         text not null default '',
  name_sr         text not null default '',
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

-- названия на английском и сербском: основной язык остаётся в name
alter table tech_cards add column if not exists name_en text not null default '';
alter table tech_cards add column if not exists name_sr text not null default '';

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

-- Фасовки техкарты: продаваемая позиция (SKU). Одна техкарта — несколько упаковок.
-- qty_base — вес нетто одной упаковки в единице выхода техкарты, min_order — минимум упаковок в заказе.
create table if not exists product_packagings (
  id         serial primary key,
  card_id    int not null,
  name       text not null check (btrim(name) <> ''),
  qty_base   numeric not null check (qty_base > 0 and qty_base < 'Infinity'::numeric),
  min_order  int not null default 1 check (min_order > 0),
  is_default boolean not null default false,
  price      numeric not null default 0,
  -- за что указана цена: unit — за кг/л/шт, portion — за упаковку (порцию), piece — за штуку
  price_basis text not null default 'unit' check (price_basis in ('unit','portion','piece')),
  -- себестоимость фасовки в RSD за ту же базу, что и цена; 0 — не задана
  cost       numeric not null default 0
);

-- цена продажи и база цены (кг/л/шт, порция или штука) — для отчёта-отгрузки магазину
alter table product_packagings add column if not exists price numeric not null default 0;
alter table product_packagings add column if not exists price_basis text not null default 'unit';
-- себестоимость (внутренняя цена) в RSD за ту же базу, что и цена продажи
alter table product_packagings add column if not exists cost numeric not null default 0;
-- в старых базах была кратность заказа order_step — заменяем минимальным заказом
alter table product_packagings add column if not exists min_order int not null default 1;
-- фасовку можно заказывать магазинам, только если она включена в доставку
alter table product_packagings add column if not exists available boolean not null default true;
alter table product_packagings drop column if exists order_step;
drop table if exists product_packaging_items;
-- ровно одна фасовка по умолчанию на техкарту
update product_packagings pk set is_default = false
 where pk.is_default
   and pk.id <> (select min(p2.id) from product_packagings p2 where p2.card_id = pk.card_id and p2.is_default);
update product_packagings pk set is_default = true
 where pk.id = (select min(p2.id) from product_packagings p2 where p2.card_id = pk.card_id)
   and not exists (select 1 from product_packagings p2 where p2.card_id = pk.card_id and p2.is_default);
create index if not exists product_packagings_card_idx on product_packagings (card_id);
create unique index if not exists product_packagings_default_uniq on product_packagings (card_id) where is_default;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_packagings_min_order_check'
       and conrelid = 'product_packagings'::regclass
  ) then
    alter table product_packagings add constraint product_packagings_min_order_check check (min_order > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'product_packagings_price_basis_check'
       and conrelid = 'product_packagings'::regclass
  ) then
    alter table product_packagings add constraint product_packagings_price_basis_check
      check (price_basis in ('unit','portion','piece'));
  end if;
end $$;

-- Каждая техкарта продаётся хотя бы одной фасовкой: существующим создаём базовую по выходу.
insert into product_packagings (card_id, name, qty_base, min_order, is_default)
select tc.id, trim_scale(tc.portion_qty)::text || ' ' || u.code, tc.portion_qty, 1, true
  from tech_cards tc
  join units u on u.id = tc.portion_unit_id
 where not exists (select 1 from product_packagings pk where pk.card_id = tc.id);

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

-- мягкое удаление: точка скрывается из справочника, история и заказы остаются
alter table stores add column if not exists deleted_at timestamptz;

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

-- Даты доставок, выбранные вручную в календаре; магазинные пользователи не управляют календарём.
-- Повторяющиеся доставки живут в справочнике delivery_schedule_period и сюда не записываются.
create table if not exists delivery_schedule (
  delivery_date date primary key,
  created_at    timestamptz not null default now(),
  created_by    int references users(id) on delete set null
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
        ('product_packagings',     'product_packagings_card_id_fkey',        'foreign key (card_id) references tech_cards(id) on delete cascade'),
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
-- Уникальность номера действующей накладной. На живой БД с историческими дублями
-- обычный create unique index уронил бы старт CRM, поэтому индекс создаётся
-- в защищённом блоке: дубли остаются, в лог пишется предупреждение.
do $$
begin
  if not exists (select 1 from pg_class where relname = 'waybills_number_active_uniq') then
    begin
      execute 'create unique index waybills_number_active_uniq
                 on waybills (btrim(number)) where status <> ''reversed''';
    exception when unique_violation then
      raise warning 'waybills_number_active_uniq не создан: в накладных есть дубли номеров. Устраните дубли и перезапустите сервер.';
    end;
  end if;
end $$;
create index if not exists waybills_status_idx           on waybills (status);

-- ---------- Справочные данные ----------

insert into units (code, name, dimension, base_factor) values
  ('г',  'грамм',     'mass',   1),
  ('мл', 'миллилитр', 'volume', 1),
  ('шт', 'штука',     'count',  1)
on conflict do nothing;

-- Тара для фасовок: складские позиции категории «упаковка» (банки, крышки, контейнеры).
-- Нужны, чтобы в «Фасовки и цены» можно было добавлять тару к упаковке продукта.
insert into products (name, category, unit_id, min_stock, active)
select v.name, 'упаковка', (select id from units where code = 'шт'), 0, true
  from (values
    ('банка 1000г'),
    ('банка 450г'),
    ('крышка к банке 1000г'),
    ('крышка к банке 450г'),
    ('контейнер 2кг'),
    ('одноразовая посуда для горячего')
  ) as v(name)
on conflict (name) do nothing;

insert into stock (product_id)
select p.id from products p
 where lower(btrim(p.category)) = 'упаковка'
on conflict (product_id) do nothing;

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

-- Системный каталог продукции «прочее» удалять и переименовывать нельзя.
alter table product_catalogs add column if not exists protected boolean not null default false;

-- Каталоги для рецептур карты: заготовки, выпечка и десерты.
insert into product_catalogs (name, position, icon, color) values
  ('заготовки', 6, '🥣', '#d8c3a5'),
  ('выпечка', 7, '🥐', '#f0c987'),
  ('десерты', 8, '🍰', '#f3b6c2'),
  ('прочее', 9, '📦', '#d9d3c7')
on conflict (name) do update
  -- позицию не трогаем: порядок задаётся вручную в настройках и должен переживать перезапуск
  set icon = case when product_catalogs.icon = '' then excluded.icon else product_catalogs.icon end,
      color = case when product_catalogs.color = '' then excluded.color else product_catalogs.color end;
update product_catalogs set protected = true
 where lower(btrim(name)) = 'прочее';

-- ---------- Периоды повторяющихся доставок ----------
-- Справочник: активный день недели (ISO: 1 — понедельник … 7 — воскресенье) или активное
-- число месяца (1…31) делает каждый подходящий будущий день днём доставки. Эти даты в
-- delivery_schedule не записываются — там остаётся только ручной выбор календаря.

create table if not exists delivery_schedule_period (
  kind    text    not null check (kind in ('weekday', 'monthday')),
  value   int     not null,
  enabled boolean not null default false,
  primary key (kind, value),
  check ((kind = 'weekday' and value between 1 and 7) or (kind = 'monthday' and value between 1 and 31))
);

insert into delivery_schedule_period (kind, value)
select 'weekday',  generate_series(1, 7)
union all
select 'monthday', generate_series(1, 31)
on conflict (kind, value) do nothing;

-- Раньше правило лежало JSON-ом в app_settings: переносим выбранные дни в справочник.
update delivery_schedule_period p
   set enabled = true
  where exists (
    select 1
      from app_settings s
     where s.key = 'delivery_rule'
       and (s.value -> case when p.kind = 'weekday' then 'weekdays' else 'monthDays' end)
           @> to_jsonb(p.value)
  );

delete from app_settings where key = 'delivery_rule';

-- Даты, которые правило добавляло в расписание, больше не нужны; служебный столбец source с ними уходит.
do $period_cleanup$
begin
  if exists (select 1 from information_schema.columns
              where table_name = 'delivery_schedule' and column_name = 'source') then
    execute $no_rule_dates$delete from delivery_schedule where source = 'rule'$no_rule_dates$;
    alter table delivery_schedule drop column source;
  end if;
end
$period_cleanup$;

-- ---------- Заказы магазинов: один заказ на точку и дату доставки ----------
-- Строки заказа хранят количество упаковок фасовки; срок редактирования
-- ограничен окном приёма (deliverySettings.cutoffHours), проверка — на сервере.

create table if not exists store_orders (
  id            serial primary key,
  store_id      int not null references stores(id),
  delivery_date date not null,
  comment       text not null default '',
  created_by    int references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    int references users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

create unique index if not exists store_orders_store_date_uniq
  on store_orders (store_id, delivery_date);
create index if not exists store_orders_delivery_idx
  on store_orders (delivery_date desc);

-- Номера отчётов-отгрузок (Otpremnica): формат «год-номер», сквозная нумерация
-- с 843 для действующих и будущих заказов. Старые документы сохраняют прежний номер.
alter table store_orders add column if not exists doc_no bigint;
create unique index if not exists store_orders_doc_no_uniq
  on store_orders (doc_no) where doc_no is not null;
create sequence if not exists store_order_doc_seq start with 843 minvalue 1;

-- Ручной порядок строк в отчёте-отгрузке: массив id фасовок карты (prod_packagings).
-- Пусто/null — обычный порядок каталога; меняется перетаскиванием в отчёте.
alter table store_orders add column if not exists line_order int[];

-- Одноразовый бэкфилл: заказы на сегодня и вперёд получают номер в стабильном
-- порядке (дата доставки, точка, id), чтобы уже существующие отчёты не менялись.
do $$
declare r record;
begin
  if exists (select 1 from app_migrations where name = 'backfill_doc_no_843') then
    return;
  end if;

  for r in
    select id
      from store_orders
     where doc_no is null and delivery_date >= current_date
     order by delivery_date, store_id, id
  loop
    update store_orders set doc_no = nextval('store_order_doc_seq') where id = r.id;
  end loop;

  insert into app_migrations (name) values ('backfill_doc_no_843')
  on conflict (name) do nothing;
end $$;

create table if not exists store_order_items (
  order_id     int not null references store_orders(id) on delete cascade,
  -- после миграции на карту это prod_packagings.id; у существующих баз id
  -- переезжает туда же, старый id остаётся в legacy_packaging_id
  packaging_id int not null,
  legacy_packaging_id int,
  qty          int not null check (qty > 0 and qty <= 999),
  primary key (order_id, packaging_id)
);
-- старые базы: колонка появится при миграции/переименовании
alter table store_order_items add column if not exists legacy_packaging_id int;

-- Слепок цен строки заказа на момент наступления даты доставки.
-- Отчёт-отгрузка и архив читают эти значения, поэтому изменение цен фасовок
-- в будущем не пересчитывает прошлые документы.
alter table store_order_items add column if not exists price_snapshot numeric;
alter table store_order_items add column if not exists cost_snapshot numeric;
alter table store_order_items add column if not exists basis_snapshot text;
alter table store_order_items add column if not exists snapshot_at timestamptz;
-- Слепок названий и единиц: переименование блюда/фасовки в будущем не меняет прошлые документы.
alter table store_order_items add column if not exists name_snapshot text;
alter table store_order_items add column if not exists name_en_snapshot text;
alter table store_order_items add column if not exists name_sr_snapshot text;
alter table store_order_items add column if not exists qty_base_snapshot numeric;
alter table store_order_items add column if not exists dimension_snapshot text;

-- ---------- Списание склада по доставке (вручную, кнопкой) ----------
-- Каждая запись — факт списания сырья по техкартам всех заказов даты доставки.
-- store_id = null — списание по всем магазинам этой даты; иначе — по одному магазину.
create table if not exists store_delivery_writeoffs (
  id            bigserial primary key,
  delivery_date date not null,
  store_id      int references stores(id) on delete cascade,
  cost_total    numeric not null default 0,
  positions     int not null default 0,
  note          text not null default '',
  created_at    timestamptz not null default now(),
  created_by    int,
  created_login text
);
create unique index if not exists store_delivery_writeoffs_scope_uniq
  on store_delivery_writeoffs (delivery_date, (coalesce(store_id, 0)));
create index if not exists store_delivery_writeoffs_date_idx
  on store_delivery_writeoffs (delivery_date desc);

-- ---------- Поставщики и документы поставок
-- Накладные оцифрованы с фотографий и хранятся как документы поставщиков.
-- Остатки и движения (movements/stock) не трогаются: на склад ничего не зачисляется.

create table if not exists suppliers (
  id         serial primary key,
  code       text not null unique,
  name       text not null,
  legal_name text not null default '',
  address    text not null default '',
  pib        text not null default '',
  mb         text not null default '',
  phone      text not null default '',
  fax        text not null default '',
  email      text not null default '',
  accounts   jsonb not null default '[]',
  gln        text not null default '',
  contact    text not null default '',
  note       text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists supplier_invoices (
  id          serial primary key,
  supplier_id int not null references suppliers(id),
  number      text not null,
  doc_date    date not null,
  currency    text not null default 'RSD',
  recipient   text not null default '',
  buyer_code  text not null default '',
  order_ref   text not null default '',
  note        text not null default '',
  total_net   numeric(14,2),
  total_vat   numeric(14,2),
  total_gross numeric(14,2),
  source_file text,
  created_at  timestamptz not null default now(),
  unique (supplier_id, number)
);

create table if not exists supplier_invoice_items (
  id           serial primary key,
  invoice_id   int not null references supplier_invoices(id) on delete cascade,
  position     int not null,
  ident        text not null default '',
  name         text not null,
  qty          numeric(12,3) not null check (qty > 0),
  unit         text not null check (unit in ('KG','KOM')),
  price        numeric(14,2) not null default 0,
  discount_pct numeric(6,3) not null default 0,
  vat_rate     numeric(6,3),
  net          numeric(14,2) not null,
  unique (invoice_id, position)
);

create index if not exists supplier_invoices_supplier_idx on supplier_invoices (supplier_id, doc_date);
create index if not exists supplier_invoices_date_idx     on supplier_invoices (doc_date desc);

insert into suppliers (code, name, legal_name, address, pib, mb, phone, fax, email, accounts, gln, contact, note) values
  ('wfc', 'WFC', 'WFC DOO BEOGRAD', 'Vinogradska 40, 11271 Surčin', '114314751', '22005235', '011/2260501', '', '', '["Banca Intesa 160-6000001992843-18", "UniCredit 170-0030067183002-77"]'::jsonb, '8607000460005', 'MIROLJUB TOMAŠEVIĆ', ''),
  ('mmm-lasta', 'MMM Lasta', 'MMM LASTA preduzeće za proizvodnju, trgovinu i usluge d.o.o. Beograd', 'Borivoja Stevanovića 31, Beograd-Voždovac 11010', '103451283', '17566580', '+381 11 2832899', '', 'office@mmmlasta.co.rs', '[]'::jsonb, '', 'Biljana Terzić', 'Prodavac/otprema: Proizvodnja MIX market Gastro, Bulevar Arsenija Čarnojevića 30a, Beograd.'),
  ('metro', 'METRO', 'METRO CASH & CARRY d.o.o. Beograd', 'Distributivni centar 20, Autoput za Novi Sad 120, 11080 Beograd', '102864104', '17482700', '+381 11 3777119', '+381 11 3777110', '', '["340-11026297-76"]'::jsonb, '', '', '')
on conflict (code) do nothing;

insert into supplier_invoices (supplier_id, number, doc_date, recipient, buyer_code, order_ref, note, total_net, total_vat, total_gross)
select s.id, v.number, v.doc_date::date, v.recipient, v.buyer_code, v.order_ref, v.note, v.net, v.vat, v.gross
from (values
  ('wfc', '26-3501-046772', '2026-07-16', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 8681.6, 868.16, 9549.76),
  ('wfc', '26-3501-049753', '2026-07-28', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 10593.3, 1059.33, 11652.63),
  ('wfc', '26-3501-051985', '2026-08-05', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 33115.95, 3401.6, 36517.55),
  ('wfc', '26-3501-054422', '2026-08-14', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 7513.1, 886.31, 8399.41),
  ('wfc', '26-3501-055467', '2026-08-18', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 14328.34, 1545.33, 15873.67),
  ('wfc', '26-3501-058869', '2026-08-31', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 9555.7, 955.57, 10511.27),
  ('wfc', '26-3501-059406', '2026-09-02', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 13817.25, 1486.73, 15303.98),
  ('wfc', '26-3501-061112', '2026-09-08', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 19123.8, 1912.38, 21036.18),
  ('wfc', '26-3501-062139', '2026-09-11', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 12322.95, 1319.8, 13642.75),
  ('wfc', '26-3501-063449', '2026-09-16', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 19460.2, 1946.02, 21406.22),
  ('wfc', '26-3501-064886', '2026-09-21', 'MIX MARKT GASTRO DOO SMEDEREVO-SKOBALJ, Karađorđeva 5, 11322 Smederevo, PIB 114917301, MB 22090208', '', '', '', 27223.3, 2739.83, 29963.13),
  ('mmm-lasta', 'OT26-02465', '2026-09-15', 'Proizvodnja MIX market Gastro, Bulevar Arsenija Čarnojevića 30a, Beograd', 'K00546', 'PP26-02833', '', 29946.19, 3773.03, 33719.22),
  ('mmm-lasta', 'OT26-02511', '2026-09-15', 'Proizvodnja MIX market Gastro, Bulevar Arsenija Čarnojevića 30a, Beograd', 'K00546', 'PP26-02842', '', 30560, 3056, 33616),
  ('mmm-lasta', 'OT26-02744', '2026-09-17', 'Proizvodnja MIX market Gastro, Bulevar Arsenija Čarnojevića 30a, Beograd', 'K00546', 'PP26-03183', '', 21700, 4340, 26040),
  ('mmm-lasta', 'OT26-03082', '2026-09-20', 'Proizvodnja MIX market Gastro, Bulevar Arsenija Čarnojevića 30a, Beograd', 'K00546', 'PP26-03486', '', 6774, 997.8, 7771.8),
  ('metro', '0/0(020)0008/262037/26', '2026-09-19', '', '25 763150 3 1', '', 'Ukupno komada 155, težina 3.420 kg. Bank.trans.ID 003614, DINA Card.', 42802.21, 7227.32, 50029.53)
) as v(code, number, doc_date, recipient, buyer_code, order_ref, note, net, vat, gross)
join suppliers s on s.code = v.code
on conflict (supplier_id, number) do nothing;

insert into supplier_invoice_items (invoice_id, position, ident, name, qty, unit, price, discount_pct, vat_rate, net)
select i.id, v.position, v.ident, v.name, v.qty, v.unit, v.price, v.discount, v.vat, v.net
from (values
  ('wfc', '26-3501-046772', 1, 'VIP00055', 'BOROVNICA 125G', 2, 'KOM', 160, 0, 10, 320),
  ('wfc', '26-3501-046772', 2, 'VIP00242', 'KROMPIR CRVENI KG', 64, 'KG', 90, 0, 10, 5760),
  ('wfc', '26-3501-046772', 3, 'VIP00317', 'LUK CRNI KG', 30, 'KG', 38, 0, 10, 1140),
  ('wfc', '26-3501-046772', 4, 'VIP00321', 'LUK CRNI MLADI KG', 1.1, 'KG', 585, 0, 10, 643.5),
  ('wfc', '26-3501-046772', 5, 'VIP00587', 'ROTKVICA KG', 1.62, 'KG', 505, 0, 10, 818.1),
  ('wfc', '26-3501-049753', 1, 'VIP00098', 'CVEKLA KG', 31.04, 'KG', 65, 0, 10, 2017.6),
  ('wfc', '26-3501-049753', 2, 'VIP00242', 'KROMPIR CRVENI KG', 40.5, 'KG', 90, 0, 10, 3645),
  ('wfc', '26-3501-049753', 3, 'VIP00265', 'KUPUS BELI KG', 10.6, 'KG', 40, 0, 10, 424),
  ('wfc', '26-3501-049753', 4, 'VIP00629', 'ŠARGAREPA KG', 53.02, 'KG', 85, 0, 10, 4506.7),
  ('wfc', '26-3501-051985', 1, 'VIP00055', 'BOROVNICA 125G', 2, 'KOM', 160, 0, 10, 320),
  ('wfc', '26-3501-051985', 2, 'VIP00098', 'CVEKLA KG', 20.48, 'KG', 65, 0, 10, 1331.2),
  ('wfc', '26-3501-051985', 3, 'OST00039', 'JAJA SVEŽA M 180/1', 2, 'KOM', 1755, 0, 10, 3510),
  ('wfc', '26-3501-051985', 4, 'VIP00242', 'KROMPIR CRVENI KG', 54.15, 'KG', 85, 0, 10, 4602.75),
  ('wfc', '26-3501-051985', 5, 'VIP00265', 'KUPUS BELI KG', 150.6, 'KG', 45, 0, 10, 6777),
  ('wfc', '26-3501-051985', 6, 'VIP00322', 'LUK CRNI MLADI VEZA', 10, 'KOM', 60, 0, 10, 600),
  ('wfc', '26-3501-051985', 7, 'VIP00629', 'ŠARGAREPA KG', 31, 'KG', 85, 0, 10, 2635),
  ('wfc', '26-3501-051985', 8, 'VIP00683', 'PERŠUN PAKOVAN 250G', 2, 'KOM', 140, 0, 10, 280),
  ('wfc', '26-3501-051985', 9, 'VIP00464', 'PEČURKA ŠAMPINJONI KG', 32, 'KG', 380, 0, 10, 12160),
  ('wfc', '26-3501-051985', 10, 'VIP01569', 'MIROĐIJA 100G', 4, 'KOM', 225, 0, 20, 900),
  ('wfc', '26-3501-054422', 1, 'VIP00055', 'BOROVNICA 125G', 1, 'KOM', 160, 0, 10, 160),
  ('wfc', '26-3501-054422', 2, 'VIP01484', 'LUK BELI OGULJENI 1KG', 2, 'KOM', 795, 0, 10, 1590),
  ('wfc', '26-3501-054422', 3, 'VIP00322', 'LUK CRNI MLADI VEZA', 10, 'KOM', 60, 0, 10, 600),
  ('wfc', '26-3501-054422', 4, 'VIP01569', 'MIROĐIJA 100G', 6, 'KOM', 225, 0, 20, 1350),
  ('wfc', '26-3501-054422', 5, 'VIP00683', 'PERŠUN PAKOVAN 250G', 4, 'KOM', 140, 0, 10, 560),
  ('wfc', '26-3501-054422', 6, 'VIP00587', 'ROTKVICA KG', 1.04, 'KG', 560, 0, 10, 582.4),
  ('wfc', '26-3501-054422', 7, 'VIP00629', 'ŠARGAREPA KG', 31.42, 'KG', 85, 0, 10, 2670.7),
  ('wfc', '26-3501-055467', 1, 'OST00039', 'JAJA SVEŽA M 180/1', 2, 'KOM', 1980, 0, 10, 3960),
  ('wfc', '26-3501-055467', 2, 'VIP00218', 'KRASTAVAC KG', 10.36, 'KG', 135, 0, 10, 1398.6),
  ('wfc', '26-3501-055467', 3, 'VIP00242', 'KROMPIR CRVENI KG', 68.5, 'KG', 85, 0, 10, 5822.5),
  ('wfc', '26-3501-055467', 4, 'VIP00317', 'LUK CRNI KG', 9.98, 'KG', 38, 0, 10, 379.24),
  ('wfc', '26-3501-055467', 5, 'VIP00322', 'LUK CRNI MLADI VEZA', 10, 'KOM', 60, 0, 10, 600),
  ('wfc', '26-3501-055467', 6, 'VIP01569', 'MIROĐIJA 100G', 5, 'KOM', 225, 0, 20, 1125),
  ('wfc', '26-3501-055467', 7, 'VIP00683', 'PERŠUN PAKOVAN 250G', 2, 'KOM', 140, 0, 10, 280),
  ('wfc', '26-3501-055467', 8, 'VIP00587', 'ROTKVICA KG', 1, 'KG', 560, 0, 10, 560),
  ('wfc', '26-3501-055467', 9, 'VIP00285', 'LIMUN KG', 1.16, 'KG', 175, 0, 10, 203),
  ('wfc', '26-3501-058869', 1, 'VIP00093', 'CELER STABLO', 1.58, 'KG', 240, 0, 10, 379.2),
  ('wfc', '26-3501-058869', 2, 'VIP00242', 'KROMPIR CRVENI KG', 60, 'KG', 85, 0, 10, 5100),
  ('wfc', '26-3501-058869', 3, 'VIP00317', 'LUK CRNI KG', 20.16, 'KG', 45, 0, 10, 907.2),
  ('wfc', '26-3501-058869', 4, 'VIP00389', 'PAPRIKA BABURA BELA', 15.46, 'KG', 205, 0, 10, 3169.3),
  ('wfc', '26-3501-059406', 1, 'VIP00265', 'KUPUS BELI KG', 121.2, 'KG', 55, 0, 10, 6666),
  ('wfc', '26-3501-059406', 2, 'VIP00322', 'LUK CRNI MLADI VEZA', 10, 'KOM', 60, 0, 10, 600),
  ('wfc', '26-3501-059406', 3, 'VIP01569', 'MIROĐIJA 100G', 6, 'KOM', 175, 0, 20, 1050),
  ('wfc', '26-3501-059406', 4, 'VIP00683', 'PERŠUN PAKOVAN 250G', 4, 'KOM', 140, 0, 10, 560),
  ('wfc', '26-3501-059406', 5, 'VIP00629', 'ŠARGAREPA KG', 40.25, 'KG', 85, 0, 10, 3421.25),
  ('wfc', '26-3501-059406', 6, 'VIP00313', 'LUK BELI KG', 4.75, 'KG', 320, 0, 10, 1520),
  ('wfc', '26-3501-061112', 1, 'VIP00218', 'KRASTAVAC KG', 5.12, 'KG', 140, 0, 10, 716.8),
  ('wfc', '26-3501-061112', 2, 'VIP00242', 'KROMPIR CRVENI KG', 59.74, 'KG', 85, 0, 10, 5077.9),
  ('wfc', '26-3501-061112', 3, 'VIP00317', 'LUK CRNI KG', 19.44, 'KG', 45, 0, 10, 874.8),
  ('wfc', '26-3501-061112', 4, 'VIP00322', 'LUK CRNI MLADI VEZA', 10, 'KOM', 60, 0, 10, 600),
  ('wfc', '26-3501-061112', 5, 'VIP00587', 'ROTKVICA KG', 1, 'KG', 505, 0, 10, 505),
  ('wfc', '26-3501-061112', 6, 'VIP00629', 'ŠARGAREPA KG', 49.86, 'KG', 85, 0, 10, 4238.1),
  ('wfc', '26-3501-061112', 7, 'OST00039', 'JAJA SVEŽA M 180/1', 2, 'KOM', 1980, 0, 10, 3960),
  ('wfc', '26-3501-061112', 8, 'VIP00098', 'CVEKLA KG', 41.82, 'KG', 65, 0, 10, 2718.3),
  ('wfc', '26-3501-061112', 9, 'VIP00458', 'PATLIDŽAN PLAVI', 2.34, 'KG', 185, 0, 10, 432.9),
  ('wfc', '26-3501-062139', 1, 'VIP00218', 'KRASTAVAC KG', 5.12, 'KG', 140, 0, 10, 716.8),
  ('wfc', '26-3501-062139', 2, 'VIP00242', 'KROMPIR CRVENI KG', 59.59, 'KG', 85, 0, 10, 5065.15),
  ('wfc', '26-3501-062139', 3, 'VIP01484', 'LUK BELI OGULJENI 1KG', 2, 'KOM', 795, 0, 10, 1590),
  ('wfc', '26-3501-062139', 4, 'VIP00322', 'LUK CRNI MLADI VEZA', 10, 'KOM', 60, 0, 10, 600),
  ('wfc', '26-3501-062139', 5, 'VIP01569', 'MIROĐIJA 100G', 5, 'KOM', 175, 0, 20, 875),
  ('wfc', '26-3501-062139', 6, 'VIP00683', 'PERŠUN PAKOVAN 250G', 4, 'KOM', 140, 0, 10, 560),
  ('wfc', '26-3501-062139', 7, 'VIP00629', 'ŠARGAREPA KG', 30, 'KG', 85, 0, 10, 2550),
  ('wfc', '26-3501-062139', 8, 'VIP00212', 'KORIJANDER KG', 0.12, 'KG', 3050, 0, 10, 366),
  ('wfc', '26-3501-063449', 1, 'VIP00464', 'PEČURKA ŠAMPINJONI KG', 31.54, 'KG', 380, 0, 10, 11985.2),
  ('wfc', '26-3501-063449', 2, 'VIP00265', 'KUPUS BELI KG', 149.5, 'KG', 50, 0, 10, 7475),
  ('wfc', '26-3501-064886', 1, 'VIP00098', 'CVEKLA KG', 52, 'KG', 55, 0, 10, 2860),
  ('wfc', '26-3501-064886', 2, 'OST00039', 'JAJA SVEŽA M 180/1', 4, 'KOM', 1980, 0, 10, 7920),
  ('wfc', '26-3501-064886', 3, 'VIP00242', 'KROMPIR CRVENI KG', 60, 'KG', 80, 0, 10, 4800),
  ('wfc', '26-3501-064886', 4, 'VIP00265', 'KUPUS BELI KG', 100, 'KG', 50, 0, 10, 5000),
  ('wfc', '26-3501-064886', 5, 'VIP00317', 'LUK CRNI KG', 39.74, 'KG', 45, 0, 10, 1788.3),
  ('wfc', '26-3501-064886', 6, 'VIP00322', 'LUK CRNI MLADI VEZA', 10, 'KOM', 60, 0, 10, 600),
  ('wfc', '26-3501-064886', 7, 'VIP01569', 'MIRODIJA 100G', 1, 'KOM', 175, 0, 20, 175),
  ('wfc', '26-3501-064886', 8, 'VIP00629', 'ŠARGAREPA KG', 51, 'KG', 80, 0, 10, 4080),
  ('mmm-lasta', 'OT26-02465', 1, 'ME0009', 'Piletina - Batak i karab. bez kosti cca 3kg (PERUTNINA PTUJ)', 38.36, 'KG', 515, 15, 10, 16792.09),
  ('mmm-lasta', 'OT26-02465', 2, 'ML0030', 'Sir Gouda blok 48% cca 3.7kg (FRIENDSHIP 4/1)', 12.56, 'KG', 775, 20, 20, 7784.1),
  ('mmm-lasta', 'OT26-02465', 3, 'UM0004', 'Ulje suncokretovo 1 l 15/1', 30, 'KOM', 250, 28.4, 10, 5370),
  ('mmm-lasta', 'OT26-02511', 1, 'ME0025', 'Svinjetina - Plećka BK cca 4kg (AVAKOM)', 3.2, 'KG', 800, 0, 10, 2560),
  ('mmm-lasta', 'OT26-02511', 2, 'ME0025', 'Svinjetina - Plećka BK cca 4kg (AVAKOM)', 35, 'KG', 800, 0, 10, 28000),
  ('mmm-lasta', 'OT26-02744', 1, 'SO0005', 'Majonez Professional 5 l (POLIMARK)', 10, 'KOM', 2170, 0, 20, 21700),
  ('mmm-lasta', 'OT26-03082', 1, 'SO0026', 'Šećer kristal 1kg 10/1', 30, 'KOM', 130, 8.46, 10, 3570),
  ('mmm-lasta', 'OT26-03082', 2, 'SO0042', 'Sirće alkoholno 1L', 24, 'KOM', 85, 15, 20, 1734),
  ('mmm-lasta', 'OT26-03082', 3, 'SO0076', 'Začin Biber crni mleveni 1kg', 1, 'KOM', 1470, 0, 20, 1470),
  ('metro', '0/0(020)0008/262037/26', 1, '8600102141087', '500G MARA KORE ZA PITU', 1, 'KOM', 91.66, 0, 20, 91.66),
  ('metro', '0/0(020)0008/262037/26', 2, '8606100031184', '400G LAZAR BLACE MASLAC', 1, 'KOM', 599.99, 0, 20, 599.99),
  ('metro', '0/0(020)0008/262037/26', 3, '8601500137504', '1.5KG MK JOGURT 1%', 1, 'KOM', 156.38, 0, 10, 156.38),
  ('metro', '0/0(020)0008/262037/26', 4, '8600742000379', '100G SIRKO SIRNI NAMAZ 60', 1, 'KOM', 87.5, 0, 20, 87.5),
  ('metro', '0/0(020)0008/262037/26', 5, '8606002110772', '250G PRESIDENT SOMBORSKA', 1, 'KOM', 209.99, 0, 20, 209.99),
  ('metro', '0/0(020)0008/262037/26', 6, '3831006616967', '350G PIVKA PILECA KOBASIC', 84, 'KOM', 108.32, 15.38, 20, 7699.44),
  ('metro', '0/0(020)0008/262037/26', 7, '0281753000008', 'MC KRUSKA CONFERENCE', 0.29, 'KG', 327.28, 0, 10, 94.91),
  ('metro', '0/0(020)0008/262037/26', 8, '0283156000005', 'METRO POMORANDŽA KUTIJA', 0.22, 'KG', 200, 0, 10, 44),
  ('metro', '0/0(020)0008/262037/26', 9, '0282811000004', 'METRO JABUKA AJDAR', 0.71, 'KG', 154.54, 0, 10, 109.72),
  ('metro', '0/0(020)0008/262037/26', 10, '0282372000000', 'METRO LIMETA', 0.22, 'KG', 636.36, 0, 10, 140),
  ('metro', '0/0(020)0008/262037/26', 11, '8600609001174', '500G FL PARADADZ CHERRY', 1, 'KOM', 272.72, 0, 10, 272.72),
  ('metro', '0/0(020)0008/262037/26', 12, '0282501000004', 'METRO KRASTAVAC KORNIŠON', 0.62, 'KG', 213.63, 0, 10, 132.45),
  ('metro', '0/0(020)0008/262037/26', 13, '0282067000005', 'METRO SILJA CRVENA', 0.26, 'KG', 81.81, 0, 10, 21.27),
  ('metro', '0/0(020)0008/262037/26', 14, '0282014000009', 'METRO KUPUS KISELI LIST', 1.1, 'KG', 208.32, 0, 20, 229.15),
  ('metro', '0/0(020)0008/262037/26', 15, '4337182255406', '2200G METRO CHEF TOMATO P', 6, 'KOM', 1083.33, 13.232, 20, 5639.94),
  ('metro', '0/0(020)0008/262037/26', 16, '4337182156208', '400G ARO BORLOTTI PASULJ', 1, 'KOM', 99.17, 0, 20, 99.17),
  ('metro', '0/0(020)0008/262037/26', 17, '8600609006797', '4250G ARO KRASTAVAC 9-12', 20, 'KOM', 719.99, 21.296, 20, 11333.2),
  ('metro', '0/0(020)0008/262037/26', 18, '4337182053965', '10KG MC PIRINAC PARBOILE', 5, 'KOM', 2299.99, 0, 10, 11499.95),
  ('metro', '0/0(020)0008/262037/26', 19, '8606002210212', '10KG MASA K.KUH.EVAPORIS.', 1, 'KOM', 454.99, 0, 20, 454.99),
  ('metro', '0/0(020)0008/262037/26', 20, '8853662056067', '455ML SPIRA. PRELIV CHILL', 1, 'KOM', 659.99, 0, 20, 659.99),
  ('metro', '0/0(020)0008/262037/26', 21, '8600498150083', '500G DIJAMANT KECAP BLAGI', 1, 'KOM', 118.99, 0, 20, 118.99),
  ('metro', '0/0(020)0008/262037/26', 22, '8606016444016', '1KG ARO PSENICNO BRASNO T', 20, 'KOM', 47.99, 10.419, 10, 859.8),
  ('metro', '0/0(020)0008/262037/26', 23, '4337182216506', 'ARO PVC FOLIJA 300MX44CM', 3, 'KOM', 749, 0, 20, 2247)
) as v(code, number, position, ident, name, qty, unit, price, discount, vat, net)
join suppliers s on s.code = v.code
join supplier_invoices i on i.supplier_id = s.id and i.number = v.number
where not exists (select 1 from supplier_invoice_items x where x.invoice_id = i.id);

-- ---------- Исходные фото накладных ----------
-- Сжатые копии лежат в client/public/invoices (webp). Оригиналы — в папке SHOP вне репозитория.
update supplier_invoices i
   set source_file = v.file
  from (values
    ('wfc',       '26-3501-046772',              'wfc/26-3501-046772.webp'),
    ('wfc',       '26-3501-064886',              'wfc/26-3501-064886.webp'),
    ('wfc',       '26-3501-063449',              'wfc/26-3501-063449.webp'),
    ('wfc',       '26-3501-062139',              'wfc/26-3501-062139.webp'),
    ('wfc',       '26-3501-061112',              'wfc/26-3501-061112.webp'),
    ('wfc',       '26-3501-059406',              'wfc/26-3501-059406.webp'),
    ('wfc',       '26-3501-058869',              'wfc/26-3501-058869.webp'),
    ('wfc',       '26-3501-055467',              'wfc/26-3501-055467.webp'),
    ('wfc',       '26-3501-054422',              'wfc/26-3501-054422.webp'),
    ('wfc',       '26-3501-051985',              'wfc/26-3501-051985.webp'),
    ('wfc',       '26-3501-049753',              'wfc/26-3501-049753.webp'),
    ('mmm-lasta', 'OT26-03082',                  'mmm-lasta/ot26-03082.webp'),
    ('mmm-lasta', 'OT26-02744',                  'mmm-lasta/ot26-02744.webp'),
    ('mmm-lasta', 'OT26-02511',                  'mmm-lasta/ot26-02511.webp'),
    ('mmm-lasta', 'OT26-02465',                  'mmm-lasta/ot26-02465.webp'),
    ('metro',     '0/0(020)0008/262037/26',      'metro/262037.webp')
  ) as v(code, number, file)
  join suppliers s on s.code = v.code
 where i.supplier_id = s.id
   and i.number = v.number
   and i.source_file is distinct from v.file;

-- ---------- Карта производства (единый глобальный граф) ----------
-- Один общий стол: сырьё -> операции -> состояния -> блюда. Состояние и блюдо могут
-- использоваться несколькими операциями; количество входа задаётся на связи, а не на узле.

create table if not exists prod_nodes (
  id          serial primary key,
  kind        text not null check (kind in ('product','state','output')),
  ref_id      int,
  name        text not null default '',
  unit_id     int not null,
  x           numeric not null default 0,
  y           numeric not null default 0,
  position    int not null default 0,
  portion_qty numeric not null default 0 check (portion_qty >= 0),
  note        text not null default ''
);
create index if not exists prod_nodes_kind_idx on prod_nodes (kind);
-- архив вместо удаления: на фасовки ссылается история заказов
alter table prod_nodes add column if not exists archived boolean not null default false;
alter table prod_nodes add column if not exists legacy_kind text;
alter table prod_nodes add column if not exists legacy_id int;
create index if not exists prod_nodes_archived_idx on prod_nodes (archived);

create table if not exists prod_ops (
  id             serial primary key,
  name           text not null default '',
  yield_pct      numeric check (yield_pct is null or (yield_pct > 0 and yield_pct <= 100)),
  labor_hours    numeric not null default 0 check (labor_hours >= 0),
  output_node_id int not null,
  note           text not null default '',
  x              numeric not null default 0,
  y              numeric not null default 0,
  position       int not null default 0
);
create index if not exists prod_ops_output_idx on prod_ops (output_node_id);
alter table prod_ops add column if not exists legacy_source text;
alter table prod_ops add column if not exists legacy_id int;
-- план выхода операции: сколько нужно получить; выход считается как сумма ингредиентов
alter table prod_ops add column if not exists plan_qty numeric check (plan_qty is null or plan_qty >= 0);
alter table prod_ops add column if not exists plan_unit_id int;

create table if not exists prod_op_inputs (
  id      serial primary key,
  op_id   int not null,
  node_id int not null,
  qty     numeric not null check (qty > 0),
  in_mass boolean not null default true,
  loss_pct numeric check (loss_pct is null or (loss_pct >= 0 and loss_pct <= 100))
);
-- потери на конкретной связи: уварка, очистки и т. п. (в процентах от количества)
alter table prod_op_inputs add column if not exists loss_pct numeric check (loss_pct is null or (loss_pct >= 0 and loss_pct <= 100));
create index if not exists prod_op_inputs_op_idx on prod_op_inputs (op_id);
create unique index if not exists prod_op_inputs_uniq on prod_op_inputs (op_id, node_id);

-- карточка блюда в новой карте: названия на трёх языках, базовая цена и категория
alter table prod_nodes add column if not exists name_en text not null default '';
alter table prod_nodes add column if not exists name_sr text not null default '';
alter table prod_nodes add column if not exists catalog_id int;
alter table prod_nodes add column if not exists price numeric not null default 0;

-- Фасовки блюда в новой карте: витрина/продажа и цена по каждой упаковке.
create table if not exists prod_packagings (
  id          serial primary key,
  node_id     int not null,
  name        text not null default '',
  qty_base    numeric not null check (qty_base > 0),
  min_order   int not null default 1 check (min_order > 0),
  is_default  boolean not null default false,
  price       numeric not null default 0,
  price_basis text not null default 'unit' check (price_basis in ('unit','portion','piece')),
  cost        numeric not null default 0,
  available   boolean not null default true,
  position    int not null default 0
);
create index if not exists prod_packagings_node_idx on prod_packagings (node_id);
alter table prod_packagings add column if not exists archived boolean not null default false;
alter table prod_packagings add column if not exists legacy_id int;
alter table prod_packagings add column if not exists title text;
alter table prod_packagings add column if not exists title_en text;
alter table prod_packagings add column if not exists title_sr text;
-- тара фасовки: несколько позиций склада из категории «упаковка» на одну фасовку,
-- без повторов (пара «фасовка + позиция» — первичный ключ).
create table if not exists prod_packaging_tare (
  packaging_id int not null references prod_packagings(id) on delete cascade,
  product_id   int not null references products(id) on delete cascade,
  position     int not null default 0,
  primary key (packaging_id, product_id)
);
create index if not exists prod_packaging_tare_product_idx on prod_packaging_tare (product_id);
do $$
begin
  if not exists (select 1 from app_migrations where name = 'packaging_tare_multi_v1') then
    if exists (select 1 from information_schema.columns
                where table_schema = current_schema()
                  and table_name = 'prod_packagings' and column_name = 'tare_product_id') then
      insert into prod_packaging_tare (packaging_id, product_id, position)
        select id, tare_product_id, 0 from prod_packagings where tare_product_id is not null
        on conflict do nothing;
    end if;
    insert into app_migrations (name) values ('packaging_tare_multi_v1');
  end if;
end $$;
alter table prod_packagings drop constraint if exists prod_packagings_tare_fkey;
alter table prod_packagings drop column if exists tare_product_id;
create index if not exists prod_packagings_archived_idx on prod_packagings (archived);
drop index if exists prod_packagings_default_uniq;
create unique index if not exists prod_packagings_default_uniq
  on prod_packagings (node_id) where is_default and not archived;

-- ---------- Операционный контур карты производства: выпуск партий ----------
create table if not exists map_batches (
  id            serial primary key,
  op_name       text not null default '',
  output_name   text not null default '',
  qty           numeric not null check (qty > 0),
  unit_id       int,
  cost_total    numeric not null default 0,
  status        text not null default 'posted' check (status in ('posted','reversed')),
  note          text not null default '',
  created_at    timestamptz not null default now(),
  created_by    int,
  created_login text
);
create table if not exists map_batch_items (
  id         serial primary key,
  batch_id   int not null,
  product_id int not null,
  qty        numeric not null check (qty > 0),
  unit_cost  numeric not null default 0
);
create index if not exists map_batch_items_batch_idx on map_batch_items (batch_id);

-- Версия карты производства: защита от одновременного редактирования
create table if not exists map_meta (
  id         int primary key default 1,
  version    int not null default 1,
  updated_at timestamptz not null default now()
);
insert into map_meta (id, version) values (1, 1) on conflict (id) do nothing;

-- Строки заказов ссылаются на фасовки карты. На старых базах внешний ключ
-- добавляется только после миграции: до неё packaging_id ещё хранит старые id.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'store_order_items_prod_packaging_fkey'
  ) and (
    not exists (select 1 from store_order_items)
    or exists (select 1 from app_migrations where name = 'legacy_to_map_v1')
  ) then
    alter table store_order_items
      add constraint store_order_items_prod_packaging_fkey
      foreign key (packaging_id) references prod_packagings(id);
  end if;
end $$;
