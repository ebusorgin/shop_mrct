-- ============================================================
-- 009 — хранение СТРОГО в базовых единицах (г / мл / шт).
-- Небазовые единицы (кг, т, л, des) убираются из слоя данных:
--   * количества пересчитываются в базовые во всех таблицах;
--   * цены пересчитываются за базовую единицу (сумма строки не меняется);
--   * справочник units оставляет только базовые, на уровне схемы —
--     check (base_factor = 1).
-- Перевод «кг на бумаге -> г в БД» живёт только в коде импорта
-- документов (DOC_UNITS), обратное — только в отображении (fmtQty).
-- ============================================================

-- 1) накладные: qty × базовый фактор, цена ÷ фактор — сумма строки инвариантна
update waybill_items i
   set qty   = i.qty * u.base_factor,
       price = i.price / u.base_factor,
       unit_id = b.id
  from units u
  join units b on b.dimension = u.dimension and b.base_factor = 1
 where i.unit_id = u.id
   and u.base_factor <> 1;

-- 2) товары: складская единица и минимум остатка
update products p
   set min_stock = p.min_stock * u.base_factor,
       unit_id   = b.id
  from units u
  join units b on b.dimension = u.dimension and b.base_factor = 1
 where p.unit_id = u.id
   and u.base_factor <> 1;

-- 3) техкарты: размер порции
update tech_cards t
   set portion_qty     = t.portion_qty * u.base_factor,
       portion_unit_id = b.id
  from units u
  join units b on b.dimension = u.dimension and b.base_factor = 1
 where t.portion_unit_id = u.id
   and u.base_factor <> 1;

-- 4) позиции техкарт: количество на порцию
update tech_card_items i
   set qty     = i.qty * u.base_factor,
       unit_id = b.id
  from units u
  join units b on b.dimension = u.dimension and b.base_factor = 1
 where i.unit_id = u.id
   and u.base_factor <> 1;

-- 5) полуфабрикаты: единица выхода (qty_per_output уже задана на 1000 базовых)
update semi_products s
   set unit_id = b.id
  from units u
  join units b on b.dimension = u.dimension and b.base_factor = 1
 where s.unit_id = u.id
   and u.base_factor <> 1;

-- 6) небазовые единицы из слоя данных — вон, и запрет на уровне схемы
delete from units where base_factor <> 1;

alter table units drop constraint if exists units_only_base;
alter table units add constraint units_only_base check (base_factor = 1);
