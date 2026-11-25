-- 2026-11-25: move packaging (tare) items into "packages".
-- The six materials of category "упаковка" stay in materials as stock ledger
-- rows; packages references them through material_id.

BEGIN;

INSERT INTO packages (name, kind, material_id)
SELECT m.name,
       CASE
         WHEN m.name ILIKE 'банка%'      THEN 'jar'
         WHEN m.name ILIKE 'крышка%'     THEN 'lid'
         WHEN m.name ILIKE 'пакет%'      THEN 'bag'
         WHEN m.name ILIKE 'контейнер%'  THEN 'container'
         ELSE 'other'
       END,
       m.id
FROM materials m
WHERE m.category_id = 17
ON CONFLICT (name) DO UPDATE
  SET kind = EXCLUDED.kind, material_id = EXCLUDED.material_id;

COMMIT;
