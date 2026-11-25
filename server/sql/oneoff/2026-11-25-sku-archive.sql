-- 2026-11-25: SKUs are archived instead of deleted (orders reference them).
BEGIN;
ALTER TABLE product_skus ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS product_skus_archived_idx ON product_skus (archived) WHERE archived;
COMMIT;
