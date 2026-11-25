-- 2026-11-25: split raw materials and recipes.
--   * former "products" (raw materials) is renamed to "materials"
--   * new "products" table holds recipes only (user-created)
-- Code is intentionally not adapted yet; prod_nodes stays untouched for now.

BEGIN;

-- 1. Raw materials: products -> materials
ALTER TABLE products RENAME TO materials;
ALTER SEQUENCE products_id_seq RENAME TO materials_id_seq;

ALTER TABLE materials RENAME CONSTRAINT products_pkey TO materials_pkey;
ALTER TABLE materials RENAME CONSTRAINT products_name_key TO materials_name_key;
ALTER TABLE materials RENAME CONSTRAINT products_category_id_fkey TO materials_category_id_fkey;
ALTER TABLE materials RENAME CONSTRAINT products_unit_id_fkey TO materials_unit_id_fkey;
ALTER TABLE materials RENAME CONSTRAINT products_created_by_fkey TO materials_created_by_fkey;
ALTER TABLE materials RENAME CONSTRAINT products_updated_by_fkey TO materials_updated_by_fkey;
ALTER TABLE materials RENAME CONSTRAINT products_g_per_ml_check TO materials_g_per_ml_check;
ALTER TABLE materials RENAME CONSTRAINT products_g_per_pcs_check TO materials_g_per_pcs_check;
ALTER TABLE materials RENAME CONSTRAINT products_ml_per_pcs_check TO materials_ml_per_pcs_check;
ALTER TABLE materials RENAME CONSTRAINT products_shelf_life_days_check TO materials_shelf_life_days_check;

ALTER INDEX products_category_idx RENAME TO materials_category_idx;
ALTER INDEX products_name_trgm RENAME TO materials_name_trgm;

-- 2. Recipes: new "products" table
CREATE TABLE products (
  id          serial PRIMARY KEY,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  name_en     text NOT NULL DEFAULT '',
  name_sr     text NOT NULL DEFAULT '',
  catalog_id  integer REFERENCES product_catalogs(id) ON DELETE SET NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_catalog_idx ON products(catalog_id);
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);

COMMIT;
