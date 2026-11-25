-- 2026-11-25: product_skus (sale variants) and packages (tare items).
-- A SKU belongs to a product; package_ids lists tare items used by the variant.

BEGIN;

CREATE TABLE packages (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  kind        text NOT NULL DEFAULT 'other' CHECK (kind IN ('jar', 'lid', 'bag', 'container', 'other')),
  material_id integer REFERENCES materials(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_skus (
  id          serial PRIMARY KEY,
  product_id  integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT '',
  package_ids integer[] NOT NULL DEFAULT '{}',
  price       numeric NOT NULL DEFAULT 0,
  cost_price  numeric NOT NULL DEFAULT 0,
  issue_type  text NOT NULL CHECK (issue_type IN ('weight', 'package')),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE INDEX product_skus_product_idx ON product_skus(product_id);
CREATE INDEX product_skus_active_idx ON product_skus(is_active) WHERE is_active;

COMMIT;
