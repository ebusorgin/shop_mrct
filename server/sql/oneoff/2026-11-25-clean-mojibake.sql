-- 2026-11-25: remove rows created with a wrong client encoding (double-encoded UTF-8).
BEGIN;

DELETE FROM product_sku_packages l
 USING packages p
 WHERE l.package_id = p.id AND p.material_id BETWEEN 633 AND 638;

DELETE FROM packages WHERE material_id BETWEEN 633 AND 638;
DELETE FROM stock WHERE product_id BETWEEN 633 AND 638;
DELETE FROM materials WHERE id BETWEEN 633 AND 638;
DELETE FROM units WHERE id IN (1192, 1193, 1194);
DELETE FROM material_categories WHERE id IN (123, 124);

COMMIT;
