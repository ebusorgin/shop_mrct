-- ============================================================
-- 030: «Что на что изменилось» в журнале заказов.
-- Раньше для updated в details был снимок только quantity/status, и когда
-- синхронизатор обновлял цену/дату листа, журнал не мог сказать, что именно
-- поменялось. Триггер пишет полный снимок old/new плюс fields — список
-- реально изменившихся полей (numeric нормализуем к float8, чтобы хвостовые
-- нули не давали ложных diffs). Логика автора из 023 сохранена.
-- Идемпотентно.
-- ============================================================

create or replace function orders_audit_fn() returns trigger as $$
declare
  v_tab    int;
  v_store  int;
  v_name   text;
  v_type   text;
  v_det    jsonb;
  v_fields jsonb;
  v_uid    int;
  v_login  text;
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
      'old', jsonb_build_object(
        'quantity', old.quantity::float8, 'status', old.status,
        'min_qty', old.min_qty::float8, 'ek_price', old.ek_price::float8,
        'vk_price', old.vk_price::float8, 'unit_code', old.unit_code,
        'date_tab', old.date_tab::text, 'plu', old.plu, 'note', nullif(old.note, '')),
      'new', jsonb_build_object(
        'quantity', new.quantity::float8, 'status', new.status,
        'min_qty', new.min_qty::float8, 'ek_price', new.ek_price::float8,
        'vk_price', new.vk_price::float8, 'unit_code', new.unit_code,
        'date_tab', new.date_tab::text, 'plu', new.plu, 'note', nullif(new.note, '')));
    -- список изменившихся полей (сравнение по текстовым значениям снимка)
    select coalesce(jsonb_agg(f), '[]'::jsonb)
      into v_fields
      from unnest(array['quantity','status','min_qty','ek_price','vk_price',
                        'unit_code','date_tab','plu','note'])
           with ordinality as t(f, ord)
     where (v_det -> 'new' ->> f) is distinct from (v_det -> 'old' ->> f);
    v_det := v_det || jsonb_build_object('fields', v_fields);
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
