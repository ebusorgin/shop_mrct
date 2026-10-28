-- ============================================================
-- 012 — Мульти-единицы полуфабриката: парные коэффициенты пересчёта
-- между размерностями (шт / г / мл) для ВЫХОДА полуфабриката.
-- Единица выхода остаётся semi_products.unit_id (базовая г/мл/шт); эти три
-- колонки включают дополнительные размерности, чтобы техкарта могла ссылаться
-- на полуфабрикат в одной размерности, а его выход/сырьё живут в другой.
--   g_per_pcs  — грамм в 1 штуке выхода (count<->mass); напр. варёное яйцо 53.
--   ml_per_pcs — мл в 1 штуке выхода    (count<->volume).
--   g_per_ml   — грамм в 1 мл, плотность (mass<->volume).
-- Любые NULL = связь не задана → прежний пересчёт только внутри размерности.
-- Идемпотентно.
-- ============================================================

alter table semi_products add column if not exists g_per_pcs  numeric check (g_per_pcs  is null or g_per_pcs  >= 0);
alter table semi_products add column if not exists ml_per_pcs numeric check (ml_per_pcs is null or ml_per_pcs >= 0);
alter table semi_products add column if not exists g_per_ml   numeric check (g_per_ml   is null or g_per_ml   >= 0);
