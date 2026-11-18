-- Одноразовая нумерация ПРОШЛЫХ документов 2026 года.
--
-- Якорь: действующий документ магазина 103 (2026-11-18) = 2026-843.
-- Прошлые документы 2026 получают непрерывный диапазон, заканчивающийся на 842:
--   820 документов -> 23…842.
-- Документы 2025 года не трогаем: они остаются с прежним видом «2025-<id>».
--
-- Скрипт идемпотентен: повторный запуск ничего не делает (маркер в app_migrations).
-- Запуск: psql -h 127.0.0.1 -U postgres -d mixmarkt_crm -f server/scripts/backfill-past-2026-doc-no.sql

begin;

do $$
declare
  anchor constant int := 843;
  n int;
  start_no int;
  conflicts int;
begin
  if exists (select 1 from app_migrations where name = 'backfill_past_2026_doc_no') then
    raise notice 'Нумерация прошлых документов 2026 уже применена';
    return;
  end if;

  if not exists (
    select 1
      from store_orders
     where store_id = 103
       and delivery_date >= current_date
       and doc_no = anchor
  ) then
    raise exception 'Якорь % не найден: у магазина 103 нет действующего документа с номером %', anchor, anchor;
  end if;

  select count(*)
    into n
    from store_orders o
   where o.delivery_date >= date '2026-01-01'
     and o.delivery_date < current_date
     and exists (select 1 from store_order_items i where i.order_id = o.id);

  if n = 0 then
    raise notice 'Прошлых документов 2026 нет — нумеровать нечего';
    return;
  end if;

  start_no := anchor - n;
  if start_no < 1 then
    raise exception 'Не хватает номеров ниже якоря %: прошлых документов %', anchor, n;
  end if;

  -- В целевом диапазоне не должно быть чужих документов (например, 2025 года
  -- с уже проставленным номером) — иначе уникальный индекс не даст записать.
  select count(*)
    into conflicts
    from store_orders o
   where o.doc_no between start_no and anchor - 1
     and not (
       o.delivery_date >= date '2026-01-01'
       and o.delivery_date < current_date
       and exists (select 1 from store_order_items i where i.order_id = o.id)
     );

  if conflicts > 0 then
    raise exception 'Диапазон %…% занят другими документами: %', start_no, anchor - 1, conflicts;
  end if;

  -- Сбрасываем прежние номера у перенумеровываемых строк: null не конфликтует.
  update store_orders o
     set doc_no = null
   where o.delivery_date >= date '2026-01-01'
     and o.delivery_date < current_date
     and exists (select 1 from store_order_items i where i.order_id = o.id);

  -- Хронологический порядок: дата доставки, точка, id.
  with t as (
    select o.id,
           row_number() over (order by o.delivery_date, o.store_id, o.id) as rn
      from store_orders o
     where o.delivery_date >= date '2026-01-01'
       and o.delivery_date < current_date
       and exists (select 1 from store_order_items i where i.order_id = o.id)
  )
  update store_orders o
     set doc_no = start_no + t.rn - 1
    from t
   where o.id = t.id;

  insert into app_migrations (name) values ('backfill_past_2026_doc_no')
  on conflict (name) do nothing;

  insert into audit_log (user_login, action, entity, entity_id, title, details)
  values (
    'system', 'update', 'store_order', '2026-past',
    'Нумерация прошлых отчётов 2026',
    jsonb_build_object('first', start_no, 'last', anchor - 1, 'documents', n)
  );

  raise notice 'Пронумеровано % документов: %…%', n, start_no, anchor - 1;
end $$;

commit;
