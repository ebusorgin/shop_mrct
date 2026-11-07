-- ============================================================
-- 039: Закрытие всех прошлых заказов и блокировка прошедших листов доставки.
--   Все заказы со статусами synced/placed на даты до сегодняшней переводятся в collected.
--   Все прошедшие листы доставки помечаются как locked.
-- ============================================================

update order_tabs
   set status = 'locked',
       locked_at = coalesce(locked_at, now())
 where extract_date < current_date and status = 'open';

insert into order_tabs (sheet_name, extract_date, status, locked_at)
select distinct to_char(date_tab, 'YYYY-MM-DD'), date_tab, 'locked', now()
  from orders
 where date_tab < current_date
   and not exists (select 1 from order_tabs t where t.extract_date = orders.date_tab)
on conflict do nothing;

update orders
   set status = 'collected',
       status_at = coalesce(status_at, now())
 where date_tab < current_date
   and status in ('synced', 'placed');
