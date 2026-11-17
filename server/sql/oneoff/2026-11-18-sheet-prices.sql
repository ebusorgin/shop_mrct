-- Разовое выравнивание данных по листу 18.11 Google-таблицы «Микс Маркт Гастро».
-- Источник: spreadsheet 1YL2CweT4Lxjs3lPkRmfJjdY9VQ95yh7fbRFD-EhXXtE, лист 18.11.
-- EK -> себестоимость, VK -> продажная цена, «Ед-ца изм-я» -> база цены (кг/порция).
-- Порядок строк = порядок листа; спаржа 3 кг отделена от 250 г (магазин 104).
-- Файл разовый: init-db его не выполняет. Повторный запуск безопасен.
begin;

-- 1) Спаржа по-корейски 3 кг: отдельная фасовка (раньше была слита с 250 г)
insert into product_packagings (card_id, name, qty_base, min_order, is_default, price, price_basis, cost, available)
select 13, '3000 г', 3000, 1, false, 2200, 'unit', 1250, true
where not exists (select 1 from product_packagings where card_id = 13 and qty_base = 3000);
update product_packagings
   set price = 2200, cost = 1250, price_basis = 'unit'
 where card_id = 13 and qty_base = 3000;

-- 2) Цены и единицы из листа 18.11: EK -> себестоимость, VK -> продажная цена
update product_packagings pk
   set price = v.price, cost = v.cost, price_basis = v.basis
  from (values
  (5, 1500, 950, 'unit'),
  (6, 1500, 950, 'unit'),
  (7, 1500, 750, 'unit'),
  (8, 1500, 950, 'unit'),
  (9, 1500, 905, 'unit'),
  (10, 700, 450, 'unit'),
  (12, 1500, 750, 'unit'),
  (13, 1600, 900, 'unit'),
  (14, 1600, 900, 'unit'),
  (15, 1600, 900, 'unit'),
  (16, 1150, 650, 'unit'),
  (17, 1700, 980, 'unit'),
  (18, 390, 250, 'portion'),
  (19, 390, 250, 'portion'),
  (20, 390, 250, 'portion'),
  (21, 450, 320, 'portion'),
  (22, 450, 320, 'portion'),
  (23, 350, 220, 'portion'),
  (24, 390, 250, 'portion'),
  (25, 550, 330, 'portion'),
  (28, 185, 185, 'portion'),
  (29, 185, 185, 'portion'),
  (30, 135, 135, 'portion'),
  (31, 135, 135, 'portion'),
  (32, 750, 420, 'unit'),
  (33, 450, 270, 'portion'),
  (35, 1600, 900, 'unit'),
  (36, 350, 220, 'portion'),
  (45, 2200, 1250, 'unit'),
  (46, 450, 250, 'unit'),
  (47, 1000, 650, 'unit'),
  (55, 450, 270, 'portion')
  ) as v(id, price, cost, basis)
 where pk.id = v.id;

-- 3) Магазин 104: 1 упаковка 3 кг отделяется от 7 упаковок по 250 г
insert into store_order_items (order_id, packaging_id, qty)
select o.id, (select id from product_packagings where card_id = 13 and qty_base = 3000), 1
  from store_orders o
  join stores s on s.id = o.store_id
 where s.code = 'Mix 38104' and o.delivery_date = '2026-11-18'
on conflict (order_id, packaging_id) do update set qty = excluded.qty;
update store_order_items i
   set qty = 7
  from store_orders o
  join stores s on s.id = o.store_id
 where i.order_id = o.id
   and s.code = 'Mix 38104'
   and o.delivery_date = '2026-11-18'
   and i.packaging_id = 25;

-- 4) Ручной порядок строк = порядок листа 18.11 (неизвестные — в конце)
with rank_map(pid, ord) as (
  values
  (7, 4),
  (6, 5),
  (5, 6),
  (12, 8),
  (9, 9),
  (10, 10),
  (8, 11),
  (47, 12),
  (14, 14),
  (13, 15),
  (32, 17),
  (46, 18),
  (45, 20),
  (35, 22),
  (15, 23),
  (16, 24),
  (17, 25),
  (22, 27),
  (36, 28),
  (23, 29),
  (21, 30),
  (20, 32),
  (18, 33),
  (19, 34),
  (24, 35),
  (33, 37),
  (55, 38),
  (25, 39),
  (29, 40),
  (28, 41),
  (31, 42),
  (30, 43),
  ((select id from product_packagings where card_id = 13 and qty_base = 3000), 19)
), orders as (
  select id from store_orders where delivery_date = '2026-11-18'
)
update store_orders o
   set line_order = (
     select array_agg(i.packaging_id order by coalesce(r.ord, 999999), i.packaging_id)
       from store_order_items i
       left join rank_map r on r.pid = i.packaging_id
      where i.order_id = o.id
   )
 where o.id in (select id from orders);

commit;
