# Data model: databases, keys and matching

Current-state data architecture of MIX markt CRM as of 2026-11-24.

Start here:

1. **[business-architecture.md](business-architecture.md)** — detailed Russian reference: where each domain is stored, primary/foreign keys, ID spaces, matching algorithms, canonical SQL joins, integrity boundaries.
2. **[system-model.summary.md](system-model.summary.md)** — one-page architecture summary and validation gaps.
3. **[system-model.evidence.md](system-model.evidence.md)** — evidence index with source references and confidence.

Diagram sources:

- [schema-core.mmd](schema-core.mmd) — reference data, stock, roles, audit.
- [schema-production.mmd](schema-production.mmd) — production map.
- [schema-orders.mmd](schema-orders.mmd) — orders, numbering, snapshots, delivery writeoffs.
- [schema-sheets.mmd](schema-sheets.mmd) — separate Google Sheets cache DB and cross-database links.
- [system-context.dot](system-context.dot) — actors, application, PostgreSQL, external systems, file storage.
- [system-model.dot](system-model.dot) — data flows between the sheet cache, procurement, production, orders and audit.
- [key-mapping.dot](key-mapping.dot) — dense map of ID spaces and how they reference each other.
- [products-vs-prod-nodes.md](products-vs-prod-nodes.md) — why `products` and `prod_nodes` both exist, where they overlap, and what to harden.
- [prod-ops/dependency-impact-findings.md](prod-ops/dependency-impact-findings.md) — whether `prod_ops` is needed, what depends on it, and merge/delete options.
- [prod-ops/impact-map.dot](prod-ops/impact-map.dot) — dependency graph from `prod_ops` to inputs, services, API and UI.

Scope limits: local copy of the production database from 2026-11-23; production was not queried. Volumes and row counts are local observations, not production guarantees.

Regenerate the model when `server/sql/init.sql`, `server/sql/sheets-init.sql`, the Google Sheet mapping or the production map changes.