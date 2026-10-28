-- ============================================================
-- 011 — Мульти-единицы товара: парные коэффициенты пересчёта между
-- размерностями (шт / г / мл). Каноничная единица хранения остаётся
-- products.unit_id (в ней живут stock.qty / avg_cost / movements); эти три
-- колонки лишь включают дополнительные размерности, чтобы приход и техкарты
-- можно было вести в любой из них, а система переводила к каноничной.
--   g_per_pcs  — грамм в 1 штуке (count<->mass); напр. яйцо M = 55.
--   ml_per_pcs — мл в 1 штуке    (count<->volume).
--   g_per_ml   — грамм в 1 мл, плотность (mass<->volume); напр. сироп 1.4.
-- Любые NULL = соответствующая связь не задана → поведение как раньше
-- (кросс-размерный пересчёт для товара недоступен). Идемпотентно.
-- ============================================================

alter table products add column if not exists g_per_pcs  numeric check (g_per_pcs  is null or g_per_pcs  >= 0);
alter table products add column if not exists ml_per_pcs numeric check (ml_per_pcs is null or ml_per_pcs >= 0);
alter table products add column if not exists g_per_ml   numeric check (g_per_ml   is null or g_per_ml   >= 0);
