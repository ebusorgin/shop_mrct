-- 2026-11-25: price/name snapshots are not used anymore.
BEGIN;
ALTER TABLE store_order_items
  DROP COLUMN IF EXISTS price_snapshot,
  DROP COLUMN IF EXISTS cost_snapshot,
  DROP COLUMN IF EXISTS basis_snapshot,
  DROP COLUMN IF EXISTS snapshot_at,
  DROP COLUMN IF EXISTS name_snapshot,
  DROP COLUMN IF EXISTS name_en_snapshot,
  DROP COLUMN IF EXISTS name_sr_snapshot,
  DROP COLUMN IF EXISTS qty_base_snapshot,
  DROP COLUMN IF EXISTS dimension_snapshot;
COMMIT;
