# System model summary: data stores and key mappings

**System:** MIX markt CRM (`A:\projects\shop_mrct`)  
**Scope:** current-state data architecture, local copy of production DB from 2026-11-23  
**Skill:** `architecture-visualization:system-modeler`, with domain rules from `mix-markt-business-logic`

## Boundary

MIX markt CRM is a self-hosted business application for a food-production company and its stores. The runtime is an Angular SPA and an Express/TypeScript API over PostgreSQL. A Google Sheet is an external read-only source for orders and assortment; OpenAI/Qoder CLI is used for document recognition only.

## Data stores

- **PostgreSQL `mixmarkt_crm`** — the only source of business truth: products, stock, movements, waybills, suppliers, production map, orders, reports, users, audit, settings, Qoder chat.
- **PostgreSQL `mixmarkt_sheets`** — a separate database and pool that caches Google Sheet tabs and manual row-to-packaging decisions. It is not merged with CRM data.
- **File storage** — waybill bytes in the main DB with a disk cache; invoice scans under `client/public/invoices`; labels under `client/public/labels`.
- **External Google Sheet** — the live order source; cached in `mixmarkt_sheets`.

## Key identity spaces

- `products.id` — warehouse raw material/product.
- `prod_nodes.id` — a node in the production map (raw, prep/state, dish/output).
- `prod_ops.id` — an operation/recipe.
- `prod_packagings.id` — the packaging/SKU id used by orders, reports and sheet links.
- `store_orders.id` + `(store_id, delivery_date)` — order identity.
- `waybills.id`, `map_batches.id`, `store_delivery_writeoffs.id` — document identities referenced by `movements.doc_type + doc_id`.
- Legacy model: `tech_cards`, `semi_products`, `product_packagings` and their child tables are removed together with the legacy migration code; recipes and packagings live only in the production map.

## Important relationships

- Stock is a materialized projection of `movements`; `applyMovement` updates `stock` and writes the journal in one transaction.
- Order report joins `store_orders → store_order_items → prod_packagings → prod_nodes → units`, using snapshots when the delivery date has passed.
- Sheet rows map to packagings by exact sale name, card name, base name + size/default, then manual override keyed by normalized row name.
- Invoice lines map to products by exact normalized name, alias, lexicon, LLM (only when lexicon is silent), then trigram candidates.
- Suppliers match by PIB, GLN, bank account, then name; own production is excluded and new suppliers are auto-created.
- The legacy model and its migration code are removed; the production map is the only source for recipes and packagings.

## Evidence strength

High for schema, keys, code paths and local row counts. Medium for production-only behavior. The model does not assume that a table field proves a business action; mutation paths are cited separately in the evidence index.

## Validation gaps

- Production row counts and file storage were not queried.
- Map references (`prod_nodes.ref_id`, `prod_ops.output_node_id`, `prod_op_inputs.*`, `prod_packagings.node_id`) are enforced by services, not FKs.
- `map_batches` stores operation/output names, not ids, so historical batches cannot be joined to current operations by key.
- `stock` is sparse: 97 of 118 products have no row in the local copy.
- Waybill files can exist both in DB and on disk; no XOR constraint.

## Next actions

1. If production accuracy is required, run the same schema/count checks on production with explicit authorization.
3. Decide whether map history needs `op_id`/`node_id` in `map_batches`.
4. Use [business-architecture.md](business-architecture.md) as the detailed reference and [key-mapping.dot](key-mapping.dot) as the visual index.

## Maintenance note

Regenerate this model when `init.sql`, `sheets-init.sql`, the Google Sheet mapping or the production map changes. The canonical diagram sources are the `.mmd` and `.dot` files in this folder; do not edit rendered exports only.