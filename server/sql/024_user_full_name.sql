-- ФИО сотрудника: подпись в журнале действий и в колонках «кто сделал».
-- Логин остаётся техническим идентификатором входа, ФИО — то, что видит человек.

alter table users add column if not exists full_name text;

-- Снимок ФИО в журнале: строка журнала не должна терять автора,
-- если пользователя переименовали или удалили.
alter table audit_log add column if not exists user_name text;
update audit_log set user_name = user_login where user_name is null;

-- Журнал заказов подписываем ФИО рядом с логином.
alter table order_changes add column if not exists user_name text;
update order_changes set user_name = user_login where user_name is null;

-- Триггер журнала заказов: логин и ФИО берём из настроек транзакции (см. asUser).
create or replace function orders_audit_fn() returns trigger as $$
declare
  v_tab   int;
  v_store int;
  v_name  text;
  v_type  text;
  v_det   jsonb;
  v_uid   int;
  v_login text;
  v_full  text;
begin
  v_login := coalesce(nullif(current_setting('app.actor_login', true), ''), 'system');
  v_full  := coalesce(nullif(current_setting('app.actor_name', true), ''), v_login);
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

  insert into order_changes (tab_id, order_id, store_id, change_type, source_name, details, actor, user_id, user_login, user_name)
  values (v_tab, case when TG_OP = 'DELETE' then null else new.id end, v_store, v_type, v_name, v_det,
          v_login, v_uid, v_login, v_full);
  return null;
end;
$$ language plpgsql;
