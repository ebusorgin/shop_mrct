-- 2026-11-25: only two price bases: unit (per recipe unit) and portion (per package).
BEGIN;
UPDATE product_skus SET price_basis = 'unit' WHERE price_basis = 'piece';
ALTER TABLE product_skus DROP CONSTRAINT IF EXISTS product_skus_price_basis_check;
ALTER TABLE product_skus ADD CONSTRAINT product_skus_price_basis_check CHECK (price_basis IN ('unit', 'portion'));
COMMIT;
