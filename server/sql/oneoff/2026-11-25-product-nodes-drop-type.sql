-- 2026-11-25: drop product_nodes.type.
-- The filled reference column already tells the kind: material_id or
-- sub_product_id, exactly one of them is required.

BEGIN;

ALTER TABLE product_nodes DROP CONSTRAINT product_nodes_ref_chk;
ALTER TABLE product_nodes DROP COLUMN type;

ALTER TABLE product_nodes ADD CONSTRAINT product_nodes_ref_chk CHECK (
  (material_id IS NOT NULL) <> (sub_product_id IS NOT NULL)
);

-- The old partial indexes referenced "type" and are dropped with the column.
CREATE UNIQUE INDEX product_nodes_material_uniq
  ON product_nodes(product_id, material_id) WHERE material_id IS NOT NULL;
CREATE UNIQUE INDEX product_nodes_sub_product_uniq
  ON product_nodes(product_id, sub_product_id) WHERE sub_product_id IS NOT NULL;

COMMIT;
