-- 2026-11-25: strict SKU <-> tare link.
-- Replaces the product_skus.package_ids array with a junction table so that
-- every package id is enforced by a foreign key.

BEGIN;

CREATE TABLE product_sku_packages (
  sku_id     integer NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  package_id integer NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  PRIMARY KEY (sku_id, package_id)
);

CREATE INDEX product_sku_packages_package_idx ON product_sku_packages(package_id);

ALTER TABLE product_skus DROP COLUMN package_ids;

COMMIT;
