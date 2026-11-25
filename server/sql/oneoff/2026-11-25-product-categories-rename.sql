-- 2026-11-25: product_categories -> material_categories.
-- Raw-material categories follow the "materials" naming; product_catalogs
-- (finished-product catalogs) stay unchanged.

BEGIN;

ALTER TABLE product_categories RENAME TO material_categories;
ALTER SEQUENCE product_categories_id_seq RENAME TO material_categories_id_seq;

ALTER TABLE material_categories RENAME CONSTRAINT product_categories_pkey TO material_categories_pkey;
ALTER TABLE material_categories RENAME CONSTRAINT product_categories_name_key TO material_categories_name_key;

ALTER INDEX product_categories_icon_uniq RENAME TO material_categories_icon_uniq;

-- PostgreSQL 18 catalogues NOT NULL constraints as well; on PG 16 there are none.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_id_not_null') THEN
    ALTER TABLE material_categories RENAME CONSTRAINT product_categories_id_not_null TO material_categories_id_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_name_not_null') THEN
    ALTER TABLE material_categories RENAME CONSTRAINT product_categories_name_not_null TO material_categories_name_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_icon_not_null') THEN
    ALTER TABLE material_categories RENAME CONSTRAINT product_categories_icon_not_null TO material_categories_icon_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_color_not_null') THEN
    ALTER TABLE material_categories RENAME CONSTRAINT product_categories_color_not_null TO material_categories_color_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_protected_not_null') THEN
    ALTER TABLE material_categories RENAME CONSTRAINT product_categories_protected_not_null TO material_categories_protected_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_categories_position_not_null') THEN
    ALTER TABLE material_categories RENAME CONSTRAINT product_categories_position_not_null TO material_categories_position_not_null;
  END IF;
END $$;

COMMIT;
