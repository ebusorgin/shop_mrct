-- ============================================================
-- 019: триггер аудита заказов не должен ссылаться на удалённую строку.
-- Было: order_id = coalesce(new.id, old.id) → при DELETE нарушал FK
-- (order_changes.order_id → orders.id), и любое удаление линии падало.
-- Стало: для DELETE пишем order_id = NULL — история уже хранит store/tab/имя/old-значение.
create or replace function orders_audit_fn() returns trigger as $$
declare
  v_tab   int;
  v_store int;
  v_name  text;
  v_type  text;
  v_det   jsonb;
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
  values (v_tab, case when TG_OP = 'DELETE' then null else new.id end, v_store, v_type, v_name, v_det, 'db');
  return null;
end;
$$ language plpgsql;

-- Индекс для поиска минимума по товару при ручном оформлении (routes/orders.ts /place).
create index if not exists orders_source_name_date_idx on orders (source_name, date_tab desc);
create index if not exists orders_card_min_idx on orders (card_id, date_tab desc) where min_qty is not null;
