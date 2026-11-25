-- 2026-11-25: put materials.category_id right after name.
-- PostgreSQL cannot reorder columns in place, so the table is rebuilt
-- and dependent foreign keys are recreated.

BEGIN;

ALTER SEQUENCE materials_id_seq OWNED BY NONE;

CREATE TABLE materials_new (
  id              integer NOT NULL DEFAULT nextval('materials_id_seq'),
  name            text NOT NULL,
  category_id     integer NOT NULL,
  unit_id         integer NOT NULL,
  min_stock       numeric NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  g_per_pcs       numeric,
  ml_per_pcs      numeric,
  g_per_ml        numeric,
  shelf_life_days integer,
  created_by      integer,
  updated_by      integer,
  CONSTRAINT materials_new_pkey PRIMARY KEY (id),
  CONSTRAINT materials_new_name_key UNIQUE (name),
  CONSTRAINT materials_new_category_id_fkey FOREIGN KEY (category_id) REFERENCES product_categories(id),
  CONSTRAINT materials_new_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES units(id),
  CONSTRAINT materials_new_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT materials_new_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT materials_new_g_per_ml_check CHECK (g_per_ml IS NULL OR g_per_ml >= 0),
  CONSTRAINT materials_new_g_per_pcs_check CHECK (g_per_pcs IS NULL OR g_per_pcs >= 0),
  CONSTRAINT materials_new_ml_per_pcs_check CHECK (ml_per_pcs IS NULL OR ml_per_pcs >= 0),
  CONSTRAINT materials_new_shelf_life_days_check CHECK (shelf_life_days IS NULL OR shelf_life_days >= 0)
);

CREATE INDEX materials_new_category_idx ON materials_new(category_id);
CREATE INDEX materials_new_name_trgm ON materials_new USING gin (name gin_trgm_ops);

INSERT INTO materials_new (id, name, category_id, unit_id, min_stock, active, created_at,
                           g_per_pcs, ml_per_pcs, g_per_ml, shelf_life_days, created_by, updated_by)
SELECT id, name, category_id, unit_id, min_stock, active, created_at,
       g_per_pcs, ml_per_pcs, g_per_ml, shelf_life_days, created_by, updated_by
FROM materials;

-- Foreign keys of dependent tables must outlive the table swap.
ALTER TABLE movements           DROP CONSTRAINT movements_product_id_fkey;
ALTER TABLE prod_packaging_tare DROP CONSTRAINT prod_packaging_tare_product_id_fkey;
ALTER TABLE product_aliases     DROP CONSTRAINT product_aliases_product_id_fkey;
ALTER TABLE stock               DROP CONSTRAINT stock_product_id_fkey;
ALTER TABLE waybill_items       DROP CONSTRAINT waybill_items_product_id_fkey;

DROP TABLE materials;

ALTER TABLE materials_new RENAME TO materials;

ALTER TABLE materials RENAME CONSTRAINT materials_new_pkey TO materials_pkey;
ALTER TABLE materials RENAME CONSTRAINT materials_new_name_key TO materials_name_key;
ALTER TABLE materials RENAME CONSTRAINT materials_new_category_id_fkey TO materials_category_id_fkey;
ALTER TABLE materials RENAME CONSTRAINT materials_new_unit_id_fkey TO materials_unit_id_fkey;
ALTER TABLE materials RENAME CONSTRAINT materials_new_created_by_fkey TO materials_created_by_fkey;
ALTER TABLE materials RENAME CONSTRAINT materials_new_updated_by_fkey TO materials_updated_by_fkey;
ALTER TABLE materials RENAME CONSTRAINT materials_new_g_per_ml_check TO materials_g_per_ml_check;
ALTER TABLE materials RENAME CONSTRAINT materials_new_g_per_pcs_check TO materials_g_per_pcs_check;
ALTER TABLE materials RENAME CONSTRAINT materials_new_ml_per_pcs_check TO materials_ml_per_pcs_check;
ALTER TABLE materials RENAME CONSTRAINT materials_new_shelf_life_days_check TO materials_shelf_life_days_check;

ALTER INDEX materials_new_category_idx RENAME TO materials_category_idx;
ALTER INDEX materials_new_name_trgm RENAME TO materials_name_trgm;

ALTER SEQUENCE materials_id_seq OWNED BY materials.id;

ALTER TABLE movements
  ADD CONSTRAINT movements_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES materials(id);
ALTER TABLE prod_packaging_tare
  ADD CONSTRAINT prod_packaging_tare_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES materials(id) ON DELETE CASCADE;
ALTER TABLE product_aliases
  ADD CONSTRAINT product_aliases_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES materials(id) ON DELETE CASCADE;
ALTER TABLE stock
  ADD CONSTRAINT stock_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES materials(id) ON DELETE CASCADE;
ALTER TABLE waybill_items
  ADD CONSTRAINT waybill_items_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES materials(id);

COMMIT;

-- PostgreSQL 18 catalogs NOT NULL constraints and keeps the CREATE TABLE names;
-- normalize them to materials_* for consistency (PG 18 only, skipped on PG 16).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_new_id_not_null') THEN
    ALTER TABLE materials RENAME CONSTRAINT materials_new_id_not_null TO materials_id_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_new_name_not_null') THEN
    ALTER TABLE materials RENAME CONSTRAINT materials_new_name_not_null TO materials_name_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_new_category_id_not_null') THEN
    ALTER TABLE materials RENAME CONSTRAINT materials_new_category_id_not_null TO materials_category_id_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_new_unit_id_not_null') THEN
    ALTER TABLE materials RENAME CONSTRAINT materials_new_unit_id_not_null TO materials_unit_id_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_new_min_stock_not_null') THEN
    ALTER TABLE materials RENAME CONSTRAINT materials_new_min_stock_not_null TO materials_min_stock_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_new_active_not_null') THEN
    ALTER TABLE materials RENAME CONSTRAINT materials_new_active_not_null TO materials_active_not_null;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'materials_new_created_at_not_null') THEN
    ALTER TABLE materials RENAME CONSTRAINT materials_new_created_at_not_null TO materials_created_at_not_null;
  END IF;
END $$;
