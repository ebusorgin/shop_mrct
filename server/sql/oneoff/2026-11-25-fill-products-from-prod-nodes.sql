-- 2026-11-25: seed the new "products" (recipes) table from prod_nodes.
-- Recipes are map nodes with kind 'state' (preps) or 'output' (dishes);
-- kind 'product' nodes are raw materials and now live in "materials".
-- Ids, names and catalogs are preserved; note becomes description.

BEGIN;

INSERT INTO products (id, name, name_en, name_sr, catalog_id, description, created_at)
SELECT n.id,
       n.name,
       n.name_en,
       n.name_sr,
       n.catalog_id,
       n.note,
       now()
FROM prod_nodes n
WHERE n.kind IN ('state', 'output')
ORDER BY n.id;

SELECT setval('products_id_seq', COALESCE((SELECT max(id) FROM products), 1), true);

COMMIT;
