-- 2026-11-25: recipe output and SKU size (old sum card / packaging weight).
-- products.portion_qty <- prod_nodes.portion_qty (batch output in recipe unit)
-- product_skus.qty_base  <- prod_packagings.qty_base (size in base unit)

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS portion_qty numeric NOT NULL DEFAULT 0;
UPDATE products p
   SET portion_qty = n.portion_qty
  FROM prod_nodes n
 WHERE n.id = p.id
   AND p.portion_qty = 0;

ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS qty_base numeric NOT NULL DEFAULT 0;
UPDATE product_skus s
   SET qty_base = p.qty_base
  FROM prod_packagings p
 WHERE p.id = s.id
   AND s.qty_base = 0;

COMMIT;
