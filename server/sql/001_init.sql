-- ============================================================
-- MIX markt CRM — базовая схема
-- Единицы измерения: всё хранится в БАЗОВЫХ единицах
--   mass -> граммы (г), volume -> миллилитры (мл), count -> штуки (шт)
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- Единицы измерения ----------
create table if not exists units (
  id            serial primary key,
  code          text unique not null,           -- 'г', 'кг', 'шт'...
  name          text not null,
  dimension     text not null check (dimension in ('mass','volume','count')),
  base_factor   numeric not null default 1      -- сколько базовых единиц в 1 этой
);

insert into units (code, name, dimension, base_factor) values
  ('г',   'грамм',        'mass',   1),
  ('кг',  'килограмм',    'mass',   1000),
  ('т',   'тонна',        'mass',   1000000),
  ('мл',  'миллилитр',    'volume', 1),
  ('л',   'литр',         'volume', 1000),
  ('шт',  'штука',        'count',  1),
  ('des', 'десяток',      'count',  10)
on conflict (code) do nothing;

-- ---------- Номенклатура (сырьё и товары склада) ----------
create table if not exists products (
  id          serial primary key,
  name        text unique not null,
  category    text not null default 'прочее',     -- 'овощи', 'мясо', 'бакалея'...
  unit_id     int not null references units(id),  -- базовая единица хранения
  min_stock   numeric not null default 0,         -- порог минимального остатка (алерт)
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------- Остатки на складе (материализованы, ведутся транзакционно) ----------
create table if not exists stock (
  product_id  int primary key references products(id) on delete cascade,
  qty         numeric not null default 0,          -- в базовых единицах товара
  avg_cost    numeric not null default 0,          -- средневзвешенная себестоимость за базовую единицу
  updated_at  timestamptz not null default now()
);

-- ---------- Движения товаров (журнал, основа склада) ----------
create table if not exists movements (
  id          bigserial primary key,
  product_id  int not null references products(id),
  type        text not null check (type in ('receipt','writeoff','adjustment')),
  qty         numeric not null,                    -- знак: + приход, - расход; в базовых единицах
  unit_cost   numeric not null default 0,          -- себестоимость за базовую единицу
  doc_type    text,                                -- 'waybill' | 'batch' | 'manual'
  doc_id      int,                                 -- ссылка на документ
  comment     text,
  created_at  timestamptz not null default now()
);
create index if not exists movements_product_idx on movements(product_id, created_at desc);
create index if not exists movements_doc_idx on movements(doc_type, doc_id);

-- ---------- Входящие накладные ----------
create table if not exists waybills (
  id          serial primary key,
  number      text not null,                       -- номер накладной поставщика
  supplier    text not null default '',
  doc_date    date not null default current_date,
  created_at  timestamptz not null default now()
);
create table if not exists waybill_items (
  id          serial primary key,
  waybill_id  int not null references waybills(id) on delete cascade,
  product_id  int not null references products(id),
  qty         numeric not null check (qty > 0),
  unit_id     int not null references units(id),   -- единица в накладной (может отличаться от складской)
  price       numeric not null default 0           -- цена за единицу этой же unit_id
);

-- ---------- Полуфабрикаты (конструктор заготовок с уваркой/очисткой) ----------
create table if not exists semi_products (
  id          serial primary key,
  name        text unique not null,                -- 'Картофель варёный'
  unit_id     int not null references units(id),   -- единица выхода (обычно кг)
  note        text default '',
  created_at  timestamptz not null default now()
);

-- Состав полуфабриката: ровно один компонент роли 'base' с уварком,
-- добавочки ('additive') — сколько нужно на 1 единицу выхода.
create table if not exists semi_inputs (
  id              serial primary key,
  semi_id         int not null references semi_products(id) on delete cascade,
  product_id      int not null references products(id),
  role            text not null check (role in ('base','additive')),
  yield_pct       numeric check (yield_pct > 0 and yield_pct <= 100), -- для base: выход после уварки/очистки, %
  qty_per_output  numeric check (qty_per_output > 0),                 -- для additive: расход баз. единиц на 1выхода
  constraint semi_inputs_check check (
    (role = 'base'     and yield_pct is not null and qty_per_output is null) or
    (role = 'additive' and qty_per_output is not null and yield_pct is null)
  )
);
create unique index if not exists semi_inputs_one_base on semi_inputs(semi_id) where role = 'base';

-- ---------- Технологические карты готовой продукции ----------
create table if not exists tech_cards (
  id            serial primary key,
  name          text not null,                     -- 'Борщ (порция)'
  portion_qty   numeric not null check (portion_qty > 0), -- размер порции/выхода
  portion_unit_id int not null references units(id),
  note          text default '',
  created_at    timestamptz not null default now()
);

-- Позиция техкарты: сырьё со склада ('raw') либо полуфабрикат ('semi'). Кол-во НА ПОРЦИЮ.
create table if not exists tech_card_items (
  id          serial primary key,
  card_id     int not null references tech_cards(id) on delete cascade,
  source_type text not null check (source_type in ('raw','semi')),
  ref_id      int not null,                        -- products.id или semi_products.id
  qty         numeric not null check (qty > 0),
  unit_id     int not null references units(id),
  position    int not null default 0
);

-- ---------- Расход готовой продукции (отгрузки с производства) ----------
create table if not exists production_batches (
  id          serial primary key,
  card_id     int not null references tech_cards(id),
  portions    int not null check (portions > 0),
  batch_date  date not null default current_date,
  cost_total  numeric not null default 0,          -- себестоимость всей партии (руб)
  note        text default '',
  status      text not null default 'posted' check (status in ('posted','reversed')),
  created_at  timestamptz not null default now()
);

-- Снимок списанного сырья по партии (сырьё после раскрытия полуфабрикатов/уварка)
create table if not exists production_batch_items (
  id          serial primary key,
  batch_id    int not null references production_batches(id) on delete cascade,
  product_id  int not null references products(id),
  qty         numeric not null,                    -- в базовых единицах продукта
  unit_cost   numeric not null default 0
);
