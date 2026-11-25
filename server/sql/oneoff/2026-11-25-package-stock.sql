-- 2026-11-25: warehouse accounting for tare (packages) in its own table.
BEGIN;

ALTER TABLE packages ADD COLUMN IF NOT EXISTS qty numeric NOT NULL DEFAULT 0;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS avg_cost numeric NOT NULL DEFAULT 0;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS package_movements (
  id         bigserial PRIMARY KEY,
  package_id int NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('receipt', 'writeoff', 'adjustment')),
  qty        numeric NOT NULL,
  unit_cost  numeric NOT NULL DEFAULT 0,
  doc_type   text,
  doc_id     int,
  comment    text,
  user_id    int REFERENCES users(id) ON DELETE SET NULL,
  user_login text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS package_movements_package_idx
  ON package_movements (package_id, created_at DESC);

COMMIT;
