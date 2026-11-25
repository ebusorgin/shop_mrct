-- 2026-11-25: SKU table columns from the old packaging editor.
-- min_order  <- prod_packagings.min_order
-- price_basis (unit | portion | piece) <- prod_packagings.price_basis

BEGIN;

ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS min_order integer NOT NULL DEFAULT 1;
ALTER TABLE product_skus DROP CONSTRAINT IF EXISTS product_skus_min_order_check;
ALTER TABLE product_skus ADD CONSTRAINT product_skus_min_order_check CHECK (min_order >= 1);

ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS price_basis text NOT NULL DEFAULT 'unit';
ALTER TABLE product_skus DROP CONSTRAINT IF EXISTS product_skus_price_basis_check;
ALTER TABLE product_skus ADD CONSTRAINT product_skus_price_basis_check CHECK (price_basis IN ('unit', 'portion', 'piece'));

UPDATE product_skus s
   SET min_order = p.min_order,
       price_basis = p.price_basis
  FROM prod_packagings p
 WHERE p.id = s.id;

COMMIT;
