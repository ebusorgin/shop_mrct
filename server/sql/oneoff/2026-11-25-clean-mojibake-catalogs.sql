-- 2026-11-25: drop catalog duplicates created with a wrong client encoding.
BEGIN;
DELETE FROM product_catalogs
 WHERE id IN (2165, 2166, 2167, 2168, 2169, 2170, 2171, 2172, 2173)
   AND NOT EXISTS (SELECT 1 FROM products p WHERE p.catalog_id = product_catalogs.id);
COMMIT;
