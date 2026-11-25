-- 2026-11-25: drop the old production-map model (recipes now live in
-- products/product_nodes/product_skus). Order lines keep their packaging link
-- by pointing the FK at product_skus (ids were preserved during migration).

BEGIN;

ALTER TABLE store_order_items DROP CONSTRAINT IF EXISTS store_order_items_prod_packaging_fkey;
ALTER TABLE store_order_items DROP CONSTRAINT IF EXISTS store_order_items_sku_fkey;
ALTER TABLE store_order_items
  ADD CONSTRAINT store_order_items_sku_fkey FOREIGN KEY (packaging_id) REFERENCES product_skus(id);

DROP TABLE IF EXISTS prod_packaging_tare;
DROP TABLE IF EXISTS prod_op_inputs;
DROP TABLE IF EXISTS prod_ops;
DROP TABLE IF EXISTS prod_nodes;
DROP TABLE IF EXISTS prod_packagings;
DROP TABLE IF EXISTS map_batch_items;
DROP TABLE IF EXISTS map_batches;
DROP TABLE IF EXISTS map_meta;

COMMIT;
