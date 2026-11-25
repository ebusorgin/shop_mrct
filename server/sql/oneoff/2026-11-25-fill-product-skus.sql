-- 2026-11-25: fill product_skus from prod_packagings.
-- Mapping:
--   id          <- prod_packagings.id (kept for traceability with old orders)
--   product_id  <- node_id (recipe id, preserved in products)
--   name        <- packaging name (size is part of the name, e.g. "1000 г")
--   price/cost  <- price/cost
--   issue_type  <- price_basis 'unit' (price per kg/l) => weight, otherwise package
--   is_active   <- available
-- Tare links: prod_packaging_tare -> packages (matched by material_id).

BEGIN;

INSERT INTO product_skus (id, product_id, name, price, cost_price, issue_type, is_active)
SELECT p.id,
       p.node_id,
       p.name,
       p.price,
       p.cost,
       CASE WHEN p.price_basis = 'unit' THEN 'weight' ELSE 'package' END,
       p.available
FROM prod_packagings p
WHERE NOT p.archived
ORDER BY p.id;

SELECT setval('product_skus_id_seq', COALESCE((SELECT max(id) FROM product_skus), 1), true);

INSERT INTO product_sku_packages (sku_id, package_id)
SELECT t.packaging_id, pk.id
FROM prod_packaging_tare t
JOIN packages pk ON pk.material_id = t.product_id
ON CONFLICT DO NOTHING;

COMMIT;
