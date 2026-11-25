-- 2026-11-25: minimum order is not used in the new SKU model.
BEGIN;
ALTER TABLE product_skus DROP COLUMN IF EXISTS min_order;
COMMIT;
