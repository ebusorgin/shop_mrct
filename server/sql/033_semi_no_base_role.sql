-- ============================================================
-- 033: Состав полуфабриката без привязки к «базовому продукту».
--
-- Раньше ровно один вход (role='base') задавал выход заготовки, а остальные были
-- «добавками» с нормой на 1 ед. выхода. Теперь все входы равны: у каждого своё
-- АБСОЛЮТНОЕ количество на партию в колонке qty_per_output (имя оставили — переименование
-- numeric-колонки только мешает чтению диффов, смысл у него теперь «количество на партию»).
-- Масштаб партии задаёт semi_products.out_qty: сколько заготовки получаем из состава.
--
--   нужно входа = количество входа × (желаемый выход ÷ out_qty),
--   если у входа задан yield_pct — количество делится на выход (как и раньше).
--
-- Миграция обратима по смыслу: batch = 1 баз. ед. выхода, поэтому
--   base-вход    → qty_per_output = 1 ÷ (yield_pct/100)   (было: «весь выход ÷ выход»)
--   additive     → qty_per_output = qty_per_output × 1    (норма на 1 ед. уже и есть расход на партию)
-- Числа раскрываются в те же самые потребности сырья.
--
-- Заодно: стол-«блок-схема» больше не отдельная сущность — это и есть заготовка,
-- расположение блоков храним в semi_products.board.
-- Идемпотентно.
-- ============================================================

-- ---------- состав: одна формула для всех входов ----------
drop index if exists semi_inputs_one_base;
alter table semi_inputs drop constraint if exists semi_inputs_check;
alter table semi_inputs drop constraint if exists semi_inputs_role_check;
alter table semi_inputs drop column if exists role;

-- количество входа НА ПАРТИЮ (в базовых единицах самого входа) вместо «нормы на 1 ед. выхода»
comment on column semi_inputs.qty_per_output is
  'количество входа на партию, в базовых единицах входа; yield_pct (если задан) — потери при обработке этого входа';

-- ---------- партия: сколько заготовки получаем из состава ----------
alter table semi_products add column if not exists out_qty numeric not null default 1;
-- стол конструктора: {blocks, links} — расположение блоков той же самой заготовки
alter table semi_products add column if not exists board jsonb;

-- ---------- пересчёт существующих норм в абсолютные количества ----------
-- batch = 1 баз. ед. выхода ⇒ old additive-норма уже верна, base-вход becomes 1/выход
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'semi_inputs' and column_name = 'qty_per_output') then
    update semi_inputs si
       set qty_per_output = round(100.0 / si.yield_pct::numeric, 6)
      where si.qty_per_output is null
        and si.yield_pct is not null
        and si.yield_pct::numeric > 0;
  end if;
end $$;

-- вход без количества больше допускать нечем: old base-строки above получили норму,
-- остатки (если были) ставим в 1 — иначе NOT NULL-проверки расчёта будут падать на мусоре
update semi_inputs set qty_per_output = 1 where qty_per_output is null;

-- ---------- блок-схемы конструктора: схема = заготовка ----------
-- переносим столы сохранённых схем на заготовки по имени (совпадение редкое, но лишнее не теряетcя),
-- саму таблицу убираем — отдельная сущность больше не нужна
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'constructor_diagrams') then
    update semi_products sp
       set board = d.data
      from constructor_diagrams d
     where sp.board is null
       and lower(btrim(d.name)) = lower(btrim(sp.name));
    drop table constructor_diagrams;
  end if;
end $$;

-- записи в журнале про удалённую сущность больше ничего не описывают — убираем
delete from audit_log where entity = 'diagram';
