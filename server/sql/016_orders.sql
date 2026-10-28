-- ============================================================
-- 016: Заказы магазинов (синхронизированные из Google Таблицы и оформленные в CRM).
--   orders        — позиции заказов: магазин × товар × дата-лист;
--   order_changes — журнал изменений (всё через триггер, плюс детали diff от синхронизатора);
--   order_sync_run — состояние фонового синхронизатора (последний прогон, ошибки).
-- quantity — в БАЗОВЫХ единицах товара (г/мл/шт), как принято во всём CRM.
-- Идемпотентно.
-- ============================================================

create table if not exists orders (
  id            serial primary key,
  tab_id        int references order_tabs(id) on delete cascade, -- null для заказов, оформленных в CRM
  store_id      int not null references stores(id),
  card_id       int references tech_cards(id),   -- сопоставленная готовая продукция
  source_name   text not null,                   -- название как в источнике/выбрано магазином
  plu           text,                            -- PLU из таблицы (если был)
  min_qty       numeric,                         -- минимальный заказ на строку (баз. единицы источника)
  ek_price      numeric,                         -- входная цена источника (за kg/шт, как напечатано)
  vk_price      numeric,                           -- выходная цена источника
  quantity      numeric not null,                -- в базовых единицах (г/мл/шт)
  unit_code     text,                            -- единица источника ('кг' и т.п.) для показа «как в таблице»
  date_tab      date not null,                   -- дата листа-источника (denormalized для выборок)
  status        text not null default 'synced'
                check (status in ('synced','placed','confirmed','collected','cancelled')),
  source        text not null default 'g_sheet'
                check (source in ('g_sheet','manual')),
  note          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint orders_line_uniq unique (tab_id, store_id, source_name)
);
create index if not exists orders_store_date_idx on orders (store_id, date_tab desc);
create index if not exists orders_tab_idx on orders (tab_id);

-- Журнал изменений заказов. order_id может ссылаться на уже удалённую строку —
-- поэтому FK с on delete set null, а снимок значений храним в details.
create table if not exists order_changes (
  id          bigserial primary key,
  tab_id      int references order_tabs(id) on delete cascade,   -- привязка к последнему синхронизированному листу
  order_id    int references orders(id) on delete set null,
  store_id    int,
  change_type text not null check (change_type in ('created','qty_changed','removed','status_changed','updated')),
  source_name text,
  details     jsonb not null default '{}',
  actor       text not null default 'sync',       -- 'sync' | 'manual' | 'db'
  created_at  timestamptz not null default now()
);
create index if not exists order_changes_tab_idx on order_changes (tab_id, created_at desc);
create index if not exists order_changes_created_idx on order_changes (created_at desc);

-- Триггер: любое изменение заказа попадает в журнал автоматически.
create or replace function orders_audit_fn() returns trigger as $$
declare
  v_tab int; v_store int; v_name text; v_type text; v_det jsonb;
begin
  if (TG_OP = 'DELETE') then
    v_tab := old.tab_id; v_store := old.store_id; v_name := old.source_name; v_type := 'removed';
    v_det := jsonb_build_object('old', jsonb_build_object('quantity', old.quantity, 'status', old.status));
  elsif (TG_OP = 'INSERT') then
    v_tab := new.tab_id; v_store := new.store_id; v_name := new.source_name; v_type := 'created';
    v_det := jsonb_build_object('new', jsonb_build_object('quantity', new.quantity, 'status', new.status));
  else
    v_tab := new.tab_id; v_store := new.store_id; v_name := new.source_name;
    v_det := jsonb_build_object(
      'old', jsonb_build_object('quantity', old.quantity, 'status', old.status),
      'new', jsonb_build_object('quantity', new.quantity, 'status', new.status));
    v_type := case
      when new.quantity is distinct from old.quantity then 'qty_changed'
      when new.status   is distinct from old.status   then 'status_changed'
      else 'updated' end;
  end if;
  insert into order_changes (tab_id, order_id, store_id, change_type, source_name, details, actor)
  values (v_tab, coalesce(new.id, old.id), v_store, v_type, v_name, v_det, 'db');
  return null;
end;
$$ language plpgsql;

drop trigger if exists orders_audit on orders;
create trigger orders_audit
  after insert or update or delete on orders
  for each row execute function orders_audit_fn();

-- Состояние фонового синхронизатора (одна строка--singleton).
create table if not exists order_sync_run (
  id            int primary key default 1 check (id = 1),
  last_run_at   timestamptz,
  finished_at   timestamptz,
  status        text not null default 'idle' check (status in ('idle','running','ok','error')),
  tabs_synced   int not null default 0,
  tabs_failed   int not null default 0,
  last_error    text,
  next_run_at   timestamptz
);
insert into order_sync_run (id) values (1) on conflict (id) do nothing;
