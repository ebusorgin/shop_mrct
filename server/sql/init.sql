-- Файл записан в UTF-8: фиксируем кодировку клиента, чтобы psql из консоли
-- с другой кодировкой не создал «кракозябры» в справочниках.
set client_encoding = 'utf8';

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
-- Старая история выпусков заменена новой моделью; таблицы больше не используются.
drop table if exists production_batch_items cascade;
drop table if exists production_batches cascade;
-- Старая модель полуфабрикатов/техкарт удалена; рецептуры живут в products/product_nodes.
drop table if exists product_packagings cascade;
drop table if exists tech_card_items cascade;
drop table if exists tech_cards cascade;
drop table if exists semi_inputs cascade;
drop table if exists semi_products cascade;

-- Исторические колонки старой модели больше не нужны.
alter table if exists store_order_items drop column if exists legacy_packaging_id;

-- ---------- Справочники и склад ----------

create table if not exists units (
  id          serial primary key,
  code        text unique not null,
  name        text not null,
  dimension   text not null check (dimension in ('mass','volume','count')),
  base_factor numeric not null default 1,
  constraint units_only_base check (base_factor = 1)
);

-- Складская номенклатура (сырьё и тара). Рецептуры живут в products ниже.
create table if not exists materials (
  id              serial primary key,
  name            text unique not null,
  category_id     int,
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

create table if not exists material_categories (
  id   serial primary key,
  name text unique not null
);

-- оформление категории сырья: иконка (эмодзи) и фоновый цвет
alter table material_categories add column if not exists icon text not null default '';
alter table material_categories add column if not exists color text not null default '';

create unique index if not exists material_categories_icon_uniq
  on material_categories (icon) where icon <> '';

-- Системные категории склада: их нельзя удалить (и переименовать).
alter table material_categories add column if not exists protected boolean not null default false;
-- Ручной порядок категорий (перетаскивание в настройках).
alter table material_categories add column if not exists position int not null default 0;
do $$
begin
  if not exists (select 1 from app_migrations where name = 'rawcat_position_v1') then
    with ordered as (
      select id, row_number() over (order by name) as rn from material_categories
    )
    update material_categories pc set position = o.rn from ordered o where o.id = pc.id;
    insert into app_migrations (name) values ('rawcat_position_v1');
  end if;
end $$;
insert into material_categories (name, icon, color, protected, position) values
  ('прочее', '🗂', '#e9e6df', true, coalesce((select max(position) + 1 from material_categories), 1))
on conflict (name) do update set protected = true;
update material_categories set protected = true
 where lower(btrim(name)) = 'прочее';

-- materials.category_id — единственный ключ категории сырья.
-- Текстовой колонки materials.category больше нет: имя живёт только в material_categories.
alter table materials add column if not exists category_id int;

do $$
declare
  has_text boolean;
  default_id int;
begin
  select exists (
    select 1
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = 'materials'
       and column_name = 'category'
  ) into has_text;

  if has_text then
    -- Перенести все текстовые категории в справочник, не создавая дублей по регистру.
    execute $mig$
      insert into material_categories (name)
      select distinct lower(btrim(p.category))
        from materials p
       where btrim(p.category) <> ''
         and not exists (
           select 1 from material_categories pc
            where lower(btrim(pc.name)) = lower(btrim(p.category))
         )
    $mig$;

    execute $mig$
      update materials p
         set category_id = pc.id
        from material_categories pc
       where p.category_id is null
         and lower(btrim(p.category)) = lower(btrim(pc.name))
    $mig$;
  end if;

  select id into default_id
    from material_categories
   where lower(btrim(name)) = 'прочее'
   limit 1;

  if default_id is null then
    insert into material_categories (name, protected)
    values ('прочее', true)
    returning id into default_id;
  end if;

  update materials set category_id = default_id where category_id is null;

  if has_text then
    execute 'alter table materials drop column category';
  end if;
end $$;

alter table materials alter column category_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'materials_category_id_fkey'
       and conrelid = 'materials'::regclass
  ) then
    alter table materials
      add constraint materials_category_id_fkey
      foreign key (category_id) references material_categories(id);
  end if;
end $$;

create index if not exists materials_category_idx on materials (category_id);

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

-- ---------- Новая модель рецептур ----------
-- products — рецептуры (блюда и заготовки). Раньше эта таблица называлась
-- складской номенклатурой; сырьё теперь в materials.
create table if not exists products (
  id          serial primary key,
  name        text not null check (btrim(name) <> ''),
  name_en     text not null default '',
  name_sr     text not null default '',
  unit_id     int references units(id),
  portion_qty numeric not null default 0,
  catalog_id  int references product_catalogs(id) on delete set null,
  description text not null default '',
  created_at  timestamptz not null default now()
);
alter table products add column if not exists unit_id int references units(id);
alter table products add column if not exists portion_qty numeric not null default 0;
create index if not exists products_catalog_idx on products (catalog_id);
create index if not exists products_name_trgm on products using gin (name gin_trgm_ops);

-- Состав рецептуры: ровно одно из полей — сырьё (material_id) или вложенная рецептура.
create table if not exists product_nodes (
  id             serial primary key,
  product_id     int not null references products(id) on delete cascade,
  material_id    int references materials(id),
  sub_product_id int references products(id),
  qty            numeric not null check (qty > 0),
  loss_pct       numeric not null default 0 check (loss_pct >= 0 and loss_pct <= 100),
  constraint product_nodes_ref_chk check ((material_id is not null) <> (sub_product_id is not null))
);
create index if not exists product_nodes_product_idx on product_nodes (product_id);
create unique index if not exists product_nodes_material_uniq
  on product_nodes (product_id, material_id) where material_id is not null;
create unique index if not exists product_nodes_sub_product_uniq
  on product_nodes (product_id, sub_product_id) where sub_product_id is not null;

-- Тара (банки, крышки, пакеты): отдельный справочник, связь со складской позицией — material_id.
create table if not exists packages (
  id          serial primary key,
  name        text unique not null check (btrim(name) <> ''),
  kind        text not null default 'other' check (kind in ('jar', 'lid', 'bag', 'container', 'other')),
  qty         numeric not null default 0,
  avg_cost    numeric not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table packages add column if not exists qty numeric not null default 0;
alter table packages add column if not exists avg_cost numeric not null default 0;
alter table packages add column if not exists updated_at timestamptz not null default now();

-- Движения тары: приход, списание и корректировка.
create table if not exists package_movements (
  id         bigserial primary key,
  package_id int not null references packages(id) on delete cascade,
  type       text not null check (type in ('receipt', 'writeoff', 'adjustment')),
  qty        numeric not null,
  unit_cost  numeric not null default 0,
  doc_type   text,
  doc_id     int,
  comment    text,
  user_id    int references users(id) on delete set null,
  user_login text,
  created_at timestamptz not null default now()
);
create index if not exists package_movements_package_idx on package_movements (package_id, created_at desc);

-- Фасовки/варианты продажи рецептуры.
create table if not exists product_skus (
  id          serial primary key,
  product_id  int not null references products(id) on delete cascade,
  name        text not null default '',
  qty_base    numeric not null default 0,
  price       numeric not null default 0,
  price_basis text not null default 'unit' check (price_basis in ('unit', 'portion')),
  cost_price  numeric not null default 0,
  issue_type  text not null check (issue_type in ('weight', 'package')),
  is_active   boolean not null default true,
  archived    boolean not null default false
);
alter table product_skus add column if not exists qty_base numeric not null default 0;
alter table product_skus add column if not exists price_basis text not null default 'unit';
alter table product_skus add column if not exists archived boolean not null default false;
create index if not exists product_skus_archived_idx on product_skus (archived) where archived;
update product_skus set price_basis = 'unit' where price_basis = 'piece';
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'product_skus'::regclass
       and conname = 'product_skus_price_basis_check'
       and position('piece' in pg_get_constraintdef(oid)) > 0
  ) then
    alter table product_skus drop constraint product_skus_price_basis_check;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'product_skus'::regclass
       and conname = 'product_skus_price_basis_check'
  ) then
    alter table product_skus
      add constraint product_skus_price_basis_check check (price_basis in ('unit', 'portion'));
  end if;
end $$;
create index if not exists product_skus_product_idx on product_skus (product_id);
create index if not exists product_skus_active_idx on product_skus (is_active) where is_active;

create table if not exists product_sku_packages (
  sku_id     int not null references product_skus(id) on delete cascade,
  package_id int not null references packages(id) on delete cascade,
  primary key (sku_id, package_id)
);
create index if not exists product_sku_packages_package_idx on product_sku_packages (package_id);

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

-- Старая модель полуфабрикатов и техкарт удалена; рецептуры живут в products/product_nodes.

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
        ('movements',              'movements_product_id_fkey',              'foreign key (product_id) references materials(id)'),
        ('movements',              'movements_user_id_fkey',                 'foreign key (user_id) references users(id) on delete set null'),
        ('product_aliases',        'product_aliases_product_id_fkey',        'foreign key (product_id) references materials(id) on delete cascade'),
        ('materials',              'materials_created_by_fkey',               'foreign key (created_by) references users(id) on delete set null'),
        ('materials',              'materials_unit_id_fkey',                  'foreign key (unit_id) references units(id)'),
        ('materials',              'materials_updated_by_fkey',               'foreign key (updated_by) references users(id) on delete set null'),
        ('sessions',               'sessions_user_id_fkey',                  'foreign key (user_id) references users(id) on delete cascade'),
        ('stock',                  'stock_product_id_fkey',                  'foreign key (product_id) references materials(id) on delete cascade'),
        ('stores',                 'stores_created_by_fkey',                 'foreign key (created_by) references users(id) on delete set null'),
        ('stores',                 'stores_updated_by_fkey',                 'foreign key (updated_by) references users(id) on delete set null'),
        ('users',                  'users_store_id_fkey',                    'foreign key (store_id) references stores(id) on delete set null'),
        ('waybill_items',          'waybill_items_product_id_fkey',          'foreign key (product_id) references materials(id)'),
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
create index if not exists materials_name_trgm            on materials using gin (name gin_trgm_ops);
create index if not exists sessions_expires_idx          on sessions (expires_at);
create index if not exists sessions_user_idx             on sessions (user_id);
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

-- Тара для фасовок — отдельный справочник packages, вне складской номенклатуры.
insert into packages (name, kind) values
  ('банка 1000г', 'jar'),
  ('банка 450г', 'jar'),
  ('крышка к банке 1000г', 'lid'),
  ('крышка к банке 450г', 'lid'),
  ('контейнер 2кг', 'container'),
  ('одноразовая посуда для горячего', 'other')
on conflict (name) do nothing;

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

-- Номера отчётов-отгрузок (Otpremnica): номер порядковый внутри года.
-- Год берётся из delivery_date; уникальна пара (doc_year, doc_no).
alter table store_orders add column if not exists doc_no bigint;
alter table store_orders add column if not exists doc_year int;

create table if not exists doc_counters (
  doc_year   int primary key,
  last_no    bigint not null default 0,
  updated_at timestamptz not null default now()
);

drop index if exists store_orders_doc_no_uniq;
create unique index if not exists store_orders_doc_year_no_uniq
  on store_orders (doc_year, doc_no) where doc_no is not null;

-- Бэкфилл года для уже выданных номеров и счётчиков по годам.
update store_orders
   set doc_year = extract(year from delivery_date)::int
 where doc_no is not null and doc_year is null;

insert into doc_counters (doc_year, last_no)
select doc_year, max(doc_no)
  from store_orders
 where doc_year is not null and doc_no is not null
 group by doc_year
on conflict (doc_year) do update
  set last_no = greatest(doc_counters.last_no, excluded.last_no),
      updated_at = now();

-- Старая глобальная последовательность больше не используется.
drop sequence if exists store_order_doc_seq;

-- Ручной порядок строк в отчёте-отгрузке: массив id фасовок (product_skus).
-- Пусто/null — обычный порядок каталога; меняется перетаскиванием в отчёте.
alter table store_orders add column if not exists line_order int[];

create table if not exists store_order_items (
  order_id     int not null references store_orders(id) on delete cascade,
  packaging_id int not null,
  qty          int not null check (qty > 0 and qty <= 999),
  primary key (order_id, packaging_id)
);

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

-- ---------- Рецептуры ----------
-- Старая карта производства (prod_nodes/prod_ops/prod_op_inputs/prod_packagings)
-- удалена: рецептуры живут в products, состав — в product_nodes, фасовки — в product_skus.



-- Строки заказов ссылаются на фасовки новой модели (product_skus).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'store_order_items_sku_fkey'
  ) then
    alter table store_order_items
      add constraint store_order_items_sku_fkey
      foreign key (packaging_id) references product_skus(id);
  end if;
end $$;

-- ---------- Чат с Qoder (вкладка в настройках, только администратор) ----------
-- Диалоги принадлежат пользователю: чужой диалог не виден и не продолжаем.
create table if not exists qoder_dialogs (
  id         serial primary key,
  user_id    int not null references users(id) on delete cascade,
  title      text not null default 'Новый диалог',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists qoder_dialogs_user_idx on qoder_dialogs (user_id, updated_at desc);

create table if not exists qoder_messages (
  id         serial primary key,
  dialog_id  int not null references qoder_dialogs(id) on delete cascade,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists qoder_messages_dialog_idx on qoder_messages (dialog_id, id);

-- ---------- Комментарии к таблицам ----------
-- Идемпотентно: comment on table выполняется при каждом старте и задаёт
-- человекочитаемое описание таблицы в pg_description (видно в psql и клиентах).

comment on table app_migrations is
  'Реестр одноразовых миграций и бэкфиллов (rawcat_position_v1, packaging_tare_multi_v1 и др.). Нужен, чтобы изменения данных не повторялись при каждом старте.';

comment on table app_settings is
  'Настройки CRM в формате JSON по строковому ключу: валюта, срок приёма заказов, транспорт GPT. Кто и когда изменил — в updated_by и updated_at.';

comment on table units is
  'Базовые единицы измерения: г, мл, шт. У всех base_factor = 1, потому что склад, движения и составы ведутся только в базовых единицах.';

comment on table materials is
  'Складская номенклатура: сырьё и тара. Хранит название, category_id (FK на material_categories), базовую единицу, коэффициенты пересчёта, минимальный остаток, срок годности и признак активности.';

comment on table products is
  'Рецептуры (блюда и заготовки): названия RU/EN/SR, каталог готовой продукции, описание и дата создания. Состав — в product_nodes, фасовки — в product_skus.';

comment on table material_categories is
  'Справочник категорий складского сырья: название, иконка, цвет, защищённость и порядок. materials.category_id — внешний ключ на эту таблицу.';

comment on table product_catalogs is
  'Справочник каталогов готовой продукции (салаты, супы, заготовки, выпечка и т. п.), на который ссылаются узлы карты производства.';

comment on table product_aliases is
  'Псевдонимы товаров из накладных: нормализованное написание и исходный текст, привязанные к products.id. Используются для автоматического сопоставления строк документов.';

comment on table stock is
  'Материализованный текущий остаток и средневзвешенная себестоимость по каждому продукту. Источник истины — movements; stock обновляется через applyMovement, строка может появиться при первом движении.';

comment on table movements is
  'Журнал движений склада: приход, списание и корректировка. Хранит знаковое количество в базовых единицах, себестоимость, документ-источник (doc_type и doc_id) и автора операции.';

comment on table waybills is
  'Шапки приходных накладных поставщиков: номер, дата, поставщик, суммы, ставки, статус posted или reversed, фото и сканы документа, данные приёмки и отмены.';

comment on table waybill_items is
  'Строки приходной накладной в единицах документа: количество, цена без PDV, ставка и сумма налога. На склад количество попадает пересчитанным в базовые единицы.';

comment on table suppliers is
  'Справочник поставщиков: код, название, юридическое имя, реквизиты PIB, MB и GLN, банковские счета, контакты и заметки. Используется для распознавания продавца в накладных.';

comment on table supplier_invoices is
  'Оцифрованные документы поставщиков: шапка счёта, реквизиты, суммы и путь к скану. Это документ, а не приход: остатки склада и движения он не меняет.';

comment on table supplier_invoice_items is
  'Позиции оцифрованного счёта поставщика: название, количество в KG или KOM, цена, скидка, ставка PDV и сумма. Склад и движения не меняет.';

comment on table stores is
  'Торговые точки (магазины): числовой номер, уникальный код, название, реквизиты, контакты и активность. Удаление мягкое через deleted_at, история сохраняется.';

comment on table users is
  'Пользователи CRM: логин, scrypt-пароль, роль администратора, привязка к магазину и активность. store_id = null означает офисного пользователя.';

comment on table sessions is
  'Сессии входа: sha256 токена из cookie mix_session, пользователь, срок действия и user-agent. Сам токен в базе не хранится.';

comment on table delivery_schedule is
  'Ручные даты доставки, выбранные в календаре. Повторяющиеся дни хранятся отдельно в delivery_schedule_period и в эту таблицу не материализуются.';

comment on table delivery_schedule_period is
  'Правило повторяющихся доставок: день недели или число месяца и признак включения. По нему календарь вычисляет будущие даты, не записывая их в delivery_schedule.';

comment on table store_orders is
  'Заказы магазинов: один заказ на пару store_id и delivery_date. Хранит комментарий, номер Otpremnica (doc_year + doc_no) и ручной порядок строк line_order.';

comment on table doc_counters is
  'Счётчики номеров Otpremnica по годам: last_no — последний выданный номер внутри года. Сброс начинается с 1 для каждого нового года.';

comment on table store_order_items is
  'Позиции заказа магазина: фасовка карты и целое количество упаковок, а также слепки цены, себестоимости, названия и единицы на дату доставки.';

comment on table store_delivery_writeoffs is
  'Факты ручного списания сырья по доставке: дата, магазин (null — все магазины даты), стоимость, число позиций, автор и заметка. Повтор на ту же дату и магазин запрещён.';



comment on table audit_log is
  'Журнал действий: кто, что и когда сделал, сущность и entity_id, заголовок и JSON-детали. Ссылка на сущность полиморфная, без внешнего ключа.';

comment on table qoder_dialogs is
  'Диалоги чата с Qoder: принадлежат пользователю, имеют заголовок и время создания и обновления.';

comment on table qoder_messages is
  'Сообщения диалогов Qoder: роль user или assistant, текст и время создания.';

-- ---------- Комментарии к колонкам (mixmarkt_crm) ----------
-- Идемпотентно: описания обновляются при каждом старте.
comment on column app_migrations.name is 'Имя одноразовой миграции или бэкфилла.';
comment on column app_migrations.applied_at is 'Когда миграция была применена.';
comment on column app_settings.key is 'Ключ настройки: currency, delivery или gpt.';
comment on column app_settings.value is 'Значение настройки в JSON.';
comment on column app_settings.updated_at is 'Когда настройка последний раз изменялась.';
comment on column app_settings.updated_by is 'Логин того, кто изменил настройку.';
comment on column audit_log.id is 'Первичный ключ записи журнала.';
comment on column audit_log.user_id is 'Пользователь, совершивший действие (users.id).';
comment on column audit_log.user_login is 'Логин пользователя на момент действия.';
comment on column audit_log.action is 'Тип действия: create, update, delete, post, reverse, adjust, login и т. п.';
comment on column audit_log.entity is 'Сущность журнала: product, waybill, store_order, production_map и т. п.';
comment on column audit_log.entity_id is 'Идентификатор сущности в её таблице, хранится текстом.';
comment on column audit_log.title is 'Человекочитаемое описание события.';
comment on column audit_log.details is 'Детали события в JSON: изменённые поля и параметры.';
comment on column audit_log.created_at is 'Дата и время события.';
comment on column audit_log.user_name is 'ФИО пользователя на момент действия.';
comment on column delivery_schedule.delivery_date is 'Ручная дата доставки.';
comment on column delivery_schedule.created_at is 'Когда дата добавлена в календарь.';
comment on column delivery_schedule.created_by is 'Кто добавил дату (users.id).';
comment on column delivery_schedule_period.kind is 'Тип правила: weekday или monthday.';
comment on column delivery_schedule_period.value is 'День недели 1–7 или число месяца 1–31.';
comment on column delivery_schedule_period.enabled is 'Включено ли правило в календаре.';

comment on column movements.id is 'Первичный ключ движения склада.';
comment on column movements.product_id is 'Продукт движения (products.id).';
comment on column movements.type is 'Тип движения: receipt, writeoff или adjustment.';
comment on column movements.qty is 'Изменение остатка со знаком, в базовых единицах.';
comment on column movements.unit_cost is 'Себестоимость базовой единицы для движения.';
comment on column movements.doc_type is 'Тип документа-источника: waybill, map_batch, map_ship, store_delivery или manual.';
comment on column movements.doc_id is 'id документа-источника; полиморфная ссылка без внешнего ключа.';
comment on column movements.comment is 'Комментарий к движению.';
comment on column movements.created_at is 'Когда движение записано.';
comment on column movements.user_id is 'Автор движения (users.id).';
comment on column movements.user_login is 'Логин автора движения.';

comment on column product_aliases.id is 'Первичный ключ псевдонима.';
comment on column product_aliases.product_id is 'Продукт, к которому привязан псевдоним (products.id).';
comment on column product_aliases.alias is 'Нормализованное написание для поиска; уникально.';
comment on column product_aliases.alias_raw is 'Исходное написание из документа.';
comment on column product_aliases.source is 'Источник псевдонима: waybill или manual.';
comment on column product_aliases.created_at is 'Когда псевдоним добавлен.';
comment on column product_catalogs.id is 'Первичный ключ каталога готовой продукции.';
comment on column product_catalogs.name is 'Название каталога.';
comment on column product_catalogs.position is 'Порядок каталога в интерфейсе.';
comment on column product_catalogs.icon is 'Иконка каталога.';
comment on column product_catalogs.color is 'Фоновый цвет каталога.';
comment on column product_catalogs.protected is 'Системный каталог, который нельзя удалить.';
comment on column material_categories.id is 'Первичный ключ категории сырья.';
comment on column material_categories.name is 'Название категории.';
comment on column material_categories.icon is 'Иконка категории.';
comment on column material_categories.color is 'Фоновый цвет категории.';
comment on column material_categories.protected is 'Системная категория, которую нельзя удалить.';
comment on column material_categories.position is 'Порядок категории в интерфейсе.';
comment on column materials.id is 'Первичный ключ складской позиции.';
comment on column materials.name is 'Название позиции; уникально.';
comment on column materials.unit_id is 'Базовая единица хранения (units.id).';
comment on column materials.min_stock is 'Минимальный остаток в базовых единицах.';
comment on column materials.active is 'Признак активной позиции.';
comment on column materials.created_at is 'Когда позиция создана.';
comment on column materials.g_per_pcs is 'Граммов в одной штуке.';
comment on column materials.ml_per_pcs is 'Миллилитров в одной штуке.';
comment on column materials.g_per_ml is 'Граммов в одном миллилитре (плотность).';
comment on column materials.shelf_life_days is 'Срок годности в днях.';
comment on column materials.created_by is 'Кто создал позицию (users.id).';
comment on column materials.updated_by is 'Кто изменил позицию (users.id).';
comment on column materials.category_id is 'Категория сырья (material_categories.id).';
comment on column products.id is 'Первичный ключ рецептуры.';
comment on column products.name is 'Название рецептуры (RU).';
comment on column products.name_en is 'Название на английском.';
comment on column products.name_sr is 'Название на сербском.';
comment on column products.unit_id is 'Базовая единица рецептуры (units.id) — в ней задаются количества в составе.';
comment on column products.portion_qty is 'Выход партии (в единице рецептуры) для проверки Σ ингредиентов.';
comment on column products.catalog_id is 'Каталог готовой продукции (product_catalogs.id).';
comment on column products.description is 'Описание рецептуры.';
comment on column products.created_at is 'Когда рецептура создана.';
comment on column product_nodes.product_id is 'Рецептура-владелец строки (products.id).';
comment on column product_nodes.material_id is 'Сырьё строки (materials.id).';
comment on column product_nodes.sub_product_id is 'Вложенная рецептура (products.id).';
comment on column product_nodes.qty is 'Количество в базовой единице компонента.';
comment on column product_nodes.loss_pct is 'Потери на связи, %.';
comment on column packages.name is 'Название тары (банка, крышка, пакет).';
comment on column packages.kind is 'Вид тары: jar, lid, bag, container, other.';
comment on column packages.qty is 'Остаток тары, шт.';
comment on column packages.avg_cost is 'Средневзвешенная себестоимость одной штуки.';
comment on column packages.updated_at is 'Когда остаток тары менялся.';
comment on column product_skus.product_id is 'Рецептура (products.id).';
comment on column product_skus.name is 'Название варианта.';
comment on column product_skus.qty_base is 'Размер фасовки в базовой единице рецептуры (г/мл/шт).';
comment on column product_skus.price_basis is 'База цены: unit (за единицу рецептуры) или portion (за упаковку).';
comment on column product_skus.price is 'Цена продажи.';
comment on column product_skus.cost_price is 'Себестоимость.';
comment on column product_skus.issue_type is 'Тип выдачи: weight или package.';
comment on column product_skus.is_active is 'В продаже.';
comment on column product_skus.archived is 'Убрана в архив (мягкое удаление): скрыта из продажи, но остаётся в истории заказов.';
comment on column product_sku_packages.sku_id is 'Фасовка (product_skus.id).';
comment on column product_sku_packages.package_id is 'Тара (packages.id).';
comment on column qoder_dialogs.id is 'Первичный ключ диалога Qoder.';
comment on column qoder_dialogs.user_id is 'Владелец диалога (users.id).';
comment on column qoder_dialogs.title is 'Заголовок диалога.';
comment on column qoder_dialogs.created_at is 'Когда диалог создан.';
comment on column qoder_dialogs.updated_at is 'Когда диалог последний раз обновлялся.';
comment on column qoder_messages.id is 'Первичный ключ сообщения.';
comment on column qoder_messages.dialog_id is 'Диалог (qoder_dialogs.id).';
comment on column qoder_messages.role is 'Роль автора сообщения: user или assistant.';
comment on column qoder_messages.content is 'Текст сообщения.';
comment on column qoder_messages.created_at is 'Когда сообщение создано.';
comment on column sessions.token_hash is 'sha256 токена сессии; первичный ключ.';
comment on column sessions.user_id is 'Пользователь сессии (users.id).';
comment on column sessions.created_at is 'Когда сессия создана.';
comment on column sessions.expires_at is 'Срок действия сессии.';
comment on column sessions.user_agent is 'User-Agent входа.';
comment on column stock.product_id is 'Продукт (products.id); первичный ключ.';
comment on column stock.qty is 'Текущий остаток в базовых единицах.';
comment on column stock.avg_cost is 'Средневзвешенная себестоимость.';
comment on column stock.updated_at is 'Когда остаток последний раз менялся.';
comment on column store_delivery_writeoffs.id is 'Первичный ключ списания по доставке.';
comment on column store_delivery_writeoffs.delivery_date is 'Дата доставки.';
comment on column store_delivery_writeoffs.store_id is 'Магазин (stores.id); null — все магазины даты.';
comment on column store_delivery_writeoffs.cost_total is 'Стоимость списанного сырья.';
comment on column store_delivery_writeoffs.positions is 'Количество позиций списания.';
comment on column store_delivery_writeoffs.note is 'Заметка к списанию.';
comment on column store_delivery_writeoffs.created_at is 'Когда списание проведено.';
comment on column store_delivery_writeoffs.created_by is 'Автор списания (users.id).';
comment on column store_delivery_writeoffs.created_login is 'Логин автора списания.';
comment on column store_order_items.order_id is 'Заказ (store_orders.id); часть составного PK.';
comment on column store_order_items.qty is 'Количество упаковок в заказе.';
comment on column store_order_items.packaging_id is 'Фасовка (product_skus.id); часть составного PK.';
comment on column store_orders.id is 'Первичный ключ заказа.';
comment on column store_orders.store_id is 'Магазин (stores.id).';
comment on column store_orders.delivery_date is 'Дата доставки; вместе с store_id уникальна.';
comment on column store_orders.comment is 'Комментарий магазина к заказу.';
comment on column store_orders.created_by is 'Кто создал заказ (users.id).';
comment on column store_orders.created_at is 'Когда заказ создан.';
comment on column store_orders.updated_by is 'Кто изменил заказ (users.id).';
comment on column store_orders.updated_at is 'Когда заказ последний раз менялся.';
comment on column store_orders.doc_no is 'Порядковый номер Otpremnica внутри года.';
comment on column store_orders.doc_year is 'Год номера Otpremnica, берётся из delivery_date.';
comment on column store_orders.line_order is 'Ручной порядок id фасовок в отчёте.';
comment on column doc_counters.doc_year is 'Год, к которому относится счётчик.';
comment on column doc_counters.last_no is 'Последний выданный номер внутри года.';
comment on column doc_counters.updated_at is 'Когда счётчик последний раз увеличивался.';
comment on column stores.id is 'Номер магазина; первичный ключ.';
comment on column stores.code is 'Уникальный код магазина, например Mix 38103.';
comment on column stores.name is 'Название магазина.';
comment on column stores.active is 'Признак активного магазина.';
comment on column stores.position is 'Порядок магазина в интерфейсе.';
comment on column stores.address is 'Адрес магазина.';
comment on column stores.phone is 'Телефон.';
comment on column stores.email is 'Email.';
comment on column stores.contact_person is 'Контактное лицо.';
comment on column stores.opening_hours is 'Часы работы.';
comment on column stores.note is 'Заметка.';
comment on column stores.created_at is 'Когда магазин создан.';
comment on column stores.updated_at is 'Когда карточка магазина изменена.';
comment on column stores.created_by is 'Кто создал (users.id).';
comment on column stores.updated_by is 'Кто изменил (users.id).';
comment on column stores.pib is 'PIB магазина.';
comment on column stores.mbr is 'MB или MBR магазина.';
comment on column stores.account_no is 'Банковский счёт магазина.';
comment on column stores.deleted_at is 'Мягкое удаление: магазин скрыт, история сохранена.';
comment on column supplier_invoice_items.id is 'Первичный ключ строки счёта.';
comment on column supplier_invoice_items.invoice_id is 'Счёт поставщика (supplier_invoices.id).';
comment on column supplier_invoice_items.position is 'Номер строки в счёте.';
comment on column supplier_invoice_items.ident is 'Артикул или штрихкод позиции.';
comment on column supplier_invoice_items.name is 'Название позиции.';
comment on column supplier_invoice_items.qty is 'Количество.';
comment on column supplier_invoice_items.unit is 'Единица количества: KG или KOM.';
comment on column supplier_invoice_items.price is 'Цена.';
comment on column supplier_invoice_items.discount_pct is 'Скидка в процентах.';
comment on column supplier_invoice_items.vat_rate is 'Ставка PDV в процентах.';
comment on column supplier_invoice_items.net is 'Сумма строки без PDV.';
comment on column supplier_invoices.id is 'Первичный ключ счёта поставщика.';
comment on column supplier_invoices.supplier_id is 'Поставщик (suppliers.id).';
comment on column supplier_invoices.number is 'Номер документа.';
comment on column supplier_invoices.doc_date is 'Дата документа.';
comment on column supplier_invoices.currency is 'Валюта документа.';
comment on column supplier_invoices.recipient is 'Получатель из документа.';
comment on column supplier_invoices.buyer_code is 'Код покупателя.';
comment on column supplier_invoices.order_ref is 'Ссылка на заказ поставщику.';
comment on column supplier_invoices.note is 'Заметка.';
comment on column supplier_invoices.total_net is 'Сумма без PDV.';
comment on column supplier_invoices.total_vat is 'Сумма PDV.';
comment on column supplier_invoices.total_gross is 'Сумма с PDV.';
comment on column supplier_invoices.source_file is 'Путь к скану документа.';
comment on column supplier_invoices.created_at is 'Когда счёт оцифрован.';
comment on column suppliers.id is 'Первичный ключ поставщика.';
comment on column suppliers.code is 'Уникальный код поставщика.';
comment on column suppliers.name is 'Краткое название.';
comment on column suppliers.legal_name is 'Юридическое название.';
comment on column suppliers.address is 'Адрес.';
comment on column suppliers.pib is 'PIB поставщика.';
comment on column suppliers.mb is 'MB поставщика.';
comment on column suppliers.phone is 'Телефон.';
comment on column suppliers.fax is 'Факс.';
comment on column suppliers.email is 'Email.';
comment on column suppliers.accounts is 'Банковские счета в JSON.';
comment on column suppliers.gln is 'GLN поставщика.';
comment on column suppliers.contact is 'Контактное лицо.';
comment on column suppliers.note is 'Заметка.';
comment on column suppliers.created_at is 'Когда поставщик добавлен.';
comment on column units.id is 'Первичный ключ единицы.';
comment on column units.code is 'Код единицы: г, мл или шт.';
comment on column units.name is 'Название единицы.';
comment on column units.dimension is 'Размерность: mass, volume или count.';
comment on column units.base_factor is 'Коэффициент к базовой единице; всегда 1.';
comment on column users.id is 'Первичный ключ пользователя.';
comment on column users.login is 'Логин; уникален без учёта регистра.';
comment on column users.password_hash is 'scrypt-хеш пароля.';
comment on column users.is_admin is 'Признак администратора.';
comment on column users.active is 'Признак активного пользователя.';
comment on column users.created_at is 'Когда пользователь создан.';
comment on column users.updated_at is 'Когда пользователь изменён.';
comment on column users.last_login_at is 'Последний вход.';
comment on column users.full_name is 'ФИО для подписи в журнале.';
comment on column users.store_id is 'Магазин пользователя (stores.id); null — офис.';
comment on column waybill_items.id is 'Первичный ключ строки накладной.';
comment on column waybill_items.waybill_id is 'Накладная (waybills.id).';
comment on column waybill_items.product_id is 'Продукт (products.id).';
comment on column waybill_items.qty is 'Количество в единице документа.';
comment on column waybill_items.unit_id is 'Единица документа (units.id).';
comment on column waybill_items.price is 'Цена без PDV за единицу документа.';
comment on column waybill_items.vat_rate is 'Ставка PDV в процентах.';
comment on column waybill_items.vat_amount is 'Сумма PDV по строке.';
comment on column waybills.id is 'Первичный ключ накладной.';
comment on column waybills.number is 'Номер накладной; уникален среди неотменённых.';
comment on column waybills.supplier is 'Название поставщика текстом.';
comment on column waybills.doc_date is 'Дата документа.';
comment on column waybills.created_at is 'Когда накладная создана.';
comment on column waybills.file_name is 'Имя загруженного файла.';
comment on column waybills.stored_file is 'Имя файла на диске (кэш).';
comment on column waybills.status is 'Статус: posted или reversed.';
comment on column waybills.supplier_pib is 'PIB поставщика.';
comment on column waybills.currency is 'Валюта документа.';
comment on column waybills.total_net is 'Сумма без PDV по строкам.';
comment on column waybills.total_vat is 'PDV по строкам.';
comment on column waybills.total_gross is 'Сумма с PDV по строкам.';
comment on column waybills.doc_total_net is 'Напечатанная в документе сумма без PDV.';
comment on column waybills.doc_total_vat is 'Напечатанный в документе PDV.';
comment on column waybills.doc_total_gross is 'Напечатанная в документе сумма с PDV.';
comment on column waybills.file_data is 'Байты основного файла накладной.';
comment on column waybills.file_mime is 'MIME-тип основного файла.';
comment on column waybills.extra_files is 'Дополнительные листы накладной в JSON/base64.';
comment on column waybills.accepted_by is 'Кто принял накладную (users.id).';
comment on column waybills.accepted_login is 'Логин принявшего.';
comment on column waybills.accepted_at is 'Когда накладная принята.';
comment on column waybills.reversed_by is 'Кто отменил накладную (users.id).';
comment on column waybills.reversed_login is 'Логин отменившего.';
comment on column waybills.reversed_at is 'Когда накладная отменена.';

