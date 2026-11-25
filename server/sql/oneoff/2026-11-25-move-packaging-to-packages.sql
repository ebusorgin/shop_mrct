-- 2026-11-25: packaging (tare) lives only in "packages", not in warehouse materials.
BEGIN;

DELETE FROM stock
 WHERE product_id IN (SELECT id FROM materials WHERE category_id = (
   SELECT id FROM material_categories WHERE name = 'упаковка'
 ));

DELETE FROM materials
 WHERE category_id = (SELECT id FROM material_categories WHERE name = 'упаковка');

DELETE FROM material_categories
 WHERE name = 'упаковка'
   AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.category_id = material_categories.id);

ALTER TABLE packages DROP COLUMN IF EXISTS material_id;

INSERT INTO packages (name, kind) VALUES
  ('банка 1000г', 'jar'),
  ('банка 450г', 'jar'),
  ('крышка к банке 1000г', 'lid'),
  ('крышка к банке 450г', 'lid'),
  ('контейнер 2кг', 'container'),
  ('одноразовая посуда для горячего', 'other')
ON CONFLICT (name) DO UPDATE SET kind = excluded.kind;

COMMIT;
