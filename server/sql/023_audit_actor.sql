-- ============================================================
-- 023: Журнал действий пользователей + «кто это сделал» в данных.
--
--   audit_log — единый журнал: кто, что, когда, где и с какими деталями.
--   Плюс персональные поля там, где их видно в интерфейсе без запроса журнала:
--     waybills.accepted_by   — кто принял накладную на склад;
--     orders.status_by       — кто перевёл заказ в «подтверждён»/«собран»/«отменён»;
--     movements.user_login   — кто сделал движение по складу (корректировка/списание);
--     production_batches.created_by — кто отгрузил партию;
--     created_by/updated_by у справочников (продукты, полуфабрикаты, техкарты, точки).
--
-- Триггер журнала заказов теперь берёт автора из настройки транзакции
-- app.actor_id / app.actor_login (её ставит services/audit.ts → asUser()).
-- Идемпотентно.
-- ============================================================

create table if not exists audit_log (
  id          bigserial primary key,
  user_id     int references users(id) on delete set null,
  user_login  text not null default 'system',
  action      text not null,                       -- create|update|delete|post|reverse|adjust|login|logout|password|role|sync
  entity      text not null,                       -- product|waybill|semi|tech_card|batch|order|store|user|stock|sheet
  entity_id   text,
  title       text not null default '',            -- человекочитаемо: «Накладная №1042 · Milkos»
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);
create index if not exists audit_log_user_idx on audit_log (user_id, created_at desc);
create index if not exists audit_log_entity_idx on audit_log (entity, created_at desc);
create index if not exists audit_log_entity_id_idx on audit_log (entity, entity_id);

-- справочники: кто завёл и кто последним правил
alter table products      add column if not exists created_by int references users(id) on delete set null;
alter table products      add column if not exists updated_by int references users(id) on delete set null;
alter table semi_products add column if not exists created_by int references users(id) on delete set null;
alter table semi_products add column if not exists updated_by int references users(id) on delete set null;
alter table tech_cards    add column if not exists created_by int references users(id) on delete set null;
alter table tech_cards    add column if not exists updated_by int references users(id) on delete set null;
alter table stores        add column if not exists created_by int references users(id) on delete set null;
alter table stores        add column if not exists updated_by int references users(id) on delete set null;

-- накладные: приёмка на склад и отмена прихода
alter table waybills add column if not exists accepted_by    int references users(id) on delete set null;
alter table waybills add column if not exists accepted_login text;
alter table waybills add column if not exists accepted_at    timestamptz;
alter table waybills add column if not exists reversed_by    int references users(id) on delete set null;
alter table waybills add column if not exists reversed_login text;
alter table waybills add column if not exists reversed_at    timestamptz;
-- старые накладные: дата приёмки = дата создания, автор неизвестен
update waybills set accepted_at = created_at where accepted_at is null;

-- отгрузки готовой продукции
alter table production_batches add column if not exists created_by    int references users(id) on delete set null;
alter table production_batches add column if not exists created_login text;

-- движения склада: кто сделал
alter table movements add column if not exists user_id    int references users(id) on delete set null;
alter table movements add column if not exists user_login text;

-- заказы: кто оформил и кто сменил статус (принял заказ / собрал / отменил)
alter table orders add column if not exists created_by      int references users(id) on delete set null;
alter table orders add column if not exists status_by       int references users(id) on delete set null;
alter table orders add column if not exists status_by_login text;
alter table orders add column if not exists status_at       timestamptz;

-- журнал изменений заказов: автор строки
alter table order_changes add column if not exists user_id    int references users(id) on delete set null;
alter table order_changes add column if not exists user_login text;

-- Триггер журнала заказов: автора берём из настройки транзакции.
-- Если её нет (синхронизатор из Google Таблицы, миграции) — пишем 'system'.
create or replace function orders_audit_fn() returns trigger as $$
declare
  v_tab   int;
  v_store int;
  v_name  text;
  v_type  text;
  v_det   jsonb;
  v_uid   int;
  v_login text;
begin
  v_login := coalesce(nullif(current_setting('app.actor_login', true), ''), 'system');
  begin
    v_uid := nullif(current_setting('app.actor_id', true), '')::int;
  exception when others then
    v_uid := null;
  end;

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

  insert into order_changes (tab_id, order_id, store_id, change_type, source_name, details, actor, user_id, user_login)
  values (v_tab, case when TG_OP = 'DELETE' then null else new.id end, v_store, v_type, v_name, v_det,
          v_login, v_uid, v_login);
  return null;
end;
$$ language plpgsql;
