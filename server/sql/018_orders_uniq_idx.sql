-- ============================================================
-- 018: Жёсткий уникальный индекс линии заказа (tab, store, source_name)
-- — защита от дублей при повторах синхронизации после частичных сбоев.
-- Дубли (если появились после частичного сбоя) схлопываем: остаётся строка с наибольшим id.
delete from orders o
 where o.tab_id is not null
   and exists (
     select 1 from orders x
      where x.tab_id = o.tab_id and x.store_id = o.store_id and x.source_name = o.source_name
        and x.id > o.id
   );

create unique index if not exists orders_line_uniq_idx
  on orders (tab_id, store_id, source_name);
