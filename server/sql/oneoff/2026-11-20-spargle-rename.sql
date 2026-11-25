-- Разделяем названия двух позиций спаржи в заказах магазинов:
--   250 г  — «Салат из спаржи» (SR — Salata od spargle 250g),
--   3000 г — «Спаржа по корейски» (SR — Salata od spargle sa šargarepom 3kg).
--
-- Русское название задаём на уровне фасовки (prod_packagings.title): имя техкарты
-- (prod_nodes.name) не трогаем, потому что по нему авто-сопоставляются строки
-- Google-таблицы «Спаржа по корейски 250g».
-- Английское и сербское названия НЕ дублируем в фасовке: они берутся из карты
-- производства (prod_nodes.name_en / name_sr), чтобы правки в карте применялись
-- в заказах и отчётах.
--
-- Файл разовый: init-db его не выполняет. Повторный запуск безопасен.
begin;

update prod_packagings
   set title    = 'Салат из спаржи',
       title_en = null,
       title_sr = null
 where id = 3
   and node_id = 563;

-- Исторические заказы: в отчётах и архиве показываем новые названия.
update store_order_items
   set name_snapshot = 'Салат из спаржи'
 where packaging_id = 3
   and name_snapshot = 'Спаржа по корейски 250г';

-- Сербские имена берём из карты производства (250 г и 3000 г).
update store_order_items i
   set name_sr_snapshot = n.name_sr
  from prod_packagings pk
  join prod_nodes n on n.id = pk.node_id
 where i.packaging_id = pk.id
   and i.packaging_id in (3, 4)
   and btrim(n.name_sr) <> ''
   and i.name_sr_snapshot is distinct from n.name_sr;

commit;
