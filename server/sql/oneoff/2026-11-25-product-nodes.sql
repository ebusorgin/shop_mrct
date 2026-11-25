-- 2026-11-25: product_nodes - composition of each recipe.
-- A row is one component of a product: either a material or a nested product
-- (tested by "type"), with quantity and loss percentage.
-- Seeded from prod_op_inputs (539 lines, 1 operation per recipe).

BEGIN;

CREATE TABLE product_nodes (
  id             serial PRIMARY KEY,
  product_id     integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('material', 'product')),
  material_id    integer REFERENCES materials(id),
  sub_product_id integer REFERENCES products(id),
  qty            numeric NOT NULL CHECK (qty > 0),
  loss_pct       numeric NOT NULL DEFAULT 0 CHECK (loss_pct >= 0 AND loss_pct <= 100),
  CONSTRAINT product_nodes_ref_chk CHECK (
    (type = 'material' AND material_id IS NOT NULL AND sub_product_id IS NULL)
    OR (type = 'product' AND sub_product_id IS NOT NULL AND material_id IS NULL)
  )
);

CREATE INDEX product_nodes_product_idx ON product_nodes(product_id);
CREATE UNIQUE INDEX product_nodes_material_uniq
  ON product_nodes(product_id, material_id) WHERE type = 'material';
CREATE UNIQUE INDEX product_nodes_sub_product_uniq
  ON product_nodes(product_id, sub_product_id) WHERE type = 'product';

INSERT INTO product_nodes (product_id, type, material_id, sub_product_id, qty, loss_pct)
SELECT o.output_node_id,
       CASE WHEN n.kind = 'product' THEN 'material' ELSE 'product' END,
       CASE WHEN n.kind = 'product' THEN n.ref_id END,
       CASE WHEN n.kind <> 'product' THEN n.id END,
       i.qty,
       COALESCE(i.loss_pct, 0)
FROM prod_op_inputs i
JOIN prod_ops o  ON o.id = i.op_id
JOIN prod_nodes n ON n.id = i.node_id
ORDER BY o.output_node_id, i.id;

COMMIT;
