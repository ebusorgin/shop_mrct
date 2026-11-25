-- 2026-11-25: recipes need their own base unit for composition rows.
-- Backfilled from prod_nodes.unit_id (all 109 recipes have one).

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_id int REFERENCES units(id);

UPDATE products p
   SET unit_id = n.unit_id
  FROM prod_nodes n
 WHERE n.id = p.id
   AND p.unit_id IS NULL;

ALTER TABLE products ALTER COLUMN unit_id SET NOT NULL;

COMMIT;
