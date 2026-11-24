# Evidence index: data model and key mappings

Scope: current-state `shop_mrct` at `main` (a4fddd6) + local uncommitted files.  
Evidence types: schema, code, config, data snapshot. Confidence: high unless marked otherwise.

## Stores and infrastructure

| ID | Claim | Evidence | Confidence |
|---|---|---|---|
| store.main-db | Business data lives in PostgreSQL `mixmarkt_crm`, pool max 10 | `server/src/db.ts:3-11` | high |
| store.sheets-db | Sheet cache lives in separate PostgreSQL `mixmarkt_sheets`, pool max 4 | `server/src/db-sheets.ts:13-17` | high |
| store.sheets-schema | Sheets DB schema is `sheets-init.sql`, applied at startup | `server/src/db-sheets.ts:40-52`, `server/sql/sheets-init.sql` | high |
| store.main-schema | Main schema is one idempotent `init.sql`, applied at startup | `server/sql/init.sql:1-19`, `server/src/init-db.ts` | high |
| store.files-waybill | Waybill bytes live in DB `bytea` + `extra_files` base64; disk is a cache | `server/sql/init.sql:296-335`, `server/src/routes/waybills.ts:195-245` | high |
| store.files-invoices | Invoice scans are files under `client/public/invoices`, path in `supplier_invoices.source_file` | `server/sql/init.sql:904-929`, `server/src/routes/suppliers.ts` | high |
| store.secrets | `.env` and Google service account key are gitignored | `.gitignore:5-6,35`, `server/src/config.ts` | high |

## Identity and reference keys

| ID | Claim | Evidence | Confidence |
|---|---|---|---|
| key.units | Only base units, `base_factor = 1` enforced | `server/sql/init.sql:33-40` | high |
| key.products | `products.id` PK, `name` unique, `category` text, `unit_id` FK | `server/sql/init.sql:42-56` | high |
| key.aliases | `product_aliases.alias` unique; normalized by lowercase + ё→е + non-alnum→space | `server/sql/init.sql:106-113`, `server/src/routes/products.ts:42-45`, `server/src/routes/import.ts:28-31` | high |
| key.categories | `products.category_id` is a NOT NULL FK to `product_categories.id`; category name lives only in the dictionary | `server/sql/init.sql:91-163`, `server/src/services/categories.ts` | high |
| key.stock | `stock` PK is `product_id`, FK to products; created lazily on first movement | `server/sql/init.sql:115-121`, `server/src/services/stock.ts:34-43` | high |
| key.movements | `movements` PK id; `doc_type + doc_id` polymorphic, no FK | `server/sql/init.sql:123-135`, `server/src/services/stock.ts:25-74` | high |
| key.stores-users | `stores.id` int PK 103-110; `users.store_id` FK; null = office | `server/sql/init.sql:339-374`, `server/src/services/auth.ts:147-187` | high |
| key.sessions | `sessions.token_hash` PK stores sha256; cookie carries raw token | `server/sql/init.sql:384-390`, `server/src/services/auth.ts:74-125` | high |

## Production map

| ID | Claim | Evidence | Confidence |
|---|---|---|---|
| map.nodes | `prod_nodes.id` PK; `kind` product/state/output; `ref_id` points to products only for kind=product, no FK | `server/sql/init.sql:935-952`, `server/src/routes/production-map.ts:220-290` | high |
| map.ops | `prod_ops.output_node_id` points to `prod_nodes`, no FK; `yield_pct` stored but unused in expansion | `server/sql/init.sql:954-970`, `server/src/services/map-production.ts:89-141` | high |
| map.inputs | `prod_op_inputs` unique `(op_id,node_id)`, both references soft | `server/sql/init.sql:972-983` | high |
| map.packagings | `prod_packagings.id` is the packaging id space; `node_id` soft; one default per node via partial unique index | `server/sql/init.sql:991-1038` | high |
| map.tare | `prod_packaging_tare` is the only map table with real FKs to packaging and product | `server/sql/init.sql:1013-1019` | high |
| map.batches | `map_batches` stores names, not `op_id`/`node_id`; items store product snapshot | `server/sql/init.sql:1041-1061`, `server/src/services/map-production.ts:200-245` | high |
| map.legacy | Legacy tables and `legacy_*` columns are removed; the production map is the only recipe source | `server/sql/init.sql:31-46` | high |
| map.version | `map_meta.version` is an optimistic lock | `server/sql/init.sql:1063-1069`, `server/src/routes/production-map.ts:448-467` | high |

## Orders and reports

| ID | Claim | Evidence | Confidence |
|---|---|---|---|
| ord.identity | Order identity is `(store_id, delivery_date)` unique; items PK `(order_id, packaging_id)` | `server/sql/init.sql:611-668` | high |
| ord.packaging-space | `store_order_items.packaging_id` references `prod_packagings.id`; no legacy id column remains | `server/sql/init.sql:573-580,1071-1085` | high |
| ord.docno | `doc_year` + `doc_no` from `doc_counters`; unique pair, rendered `doc_year-doc_no` | `server/sql/init.sql:546-578`, `server/src/services/order-numbering.ts` | high |
| ord.line-order | `store_orders.line_order` stores packaging ids for manual report order | `server/sql/init.sql:634-636`, `server/src/routes/orders.ts:117-160` | high |
| ord.snapshots | Price/name/unit snapshots are columns on `store_order_items`, not a separate table | `server/sql/init.sql:672-684`, `server/src/services/order-price-snapshot.ts:11-53` | high |
| ord.report-joins | Report joins orders → items → prod_packagings → prod_nodes → units; uses snapshot fallback to live | `server/src/services/order-report.ts:166-278` | high |
| ord.store-isolation | Store id always comes from session, not request body/query | `server/src/routes/store.ts:32-41,130-178,184-263` | high |
| ord.vat | Office report accepts `vat` 0…100; store report uses default 20 | `server/src/routes/orders.ts:52-58`, `server/src/routes/store.ts:166-178` | high |

## Google Sheets

| ID | Claim | Evidence | Confidence |
|---|---|---|---|
| sheet.meta | `google_sheets` one row per spreadsheet; `unmatched` stored as JSON | `server/sql/sheets-init.sql:5-11,25-32` | high |
| sheet.tabs | `google_sheet_tabs` PK `(spreadsheet_id,position)`; `rows` and `links` are parallel JSON arrays | `server/sql/sheets-init.sql:14-20` | high |
| sheet.manual | Manual links keyed by normalized row name, not row index; `null` means explicitly unmatched | `server/sql/sheets-init.sql:22-38`, `server/src/services/google-sheet.ts:368-410` | high |
| sheet.matchers | Exact sale name → exact card → base-name group with size/default tie-breaks | `server/src/services/google-sheet.ts:279-354` | high |
| sheet.row-recognition | `summaryStart` cuts summary block; `itemName` filters non-item rows | `server/src/services/google-sheet.ts:199-234` | high |
| sheet.sync | Sync replaces tabs, stores only auto-links, applies manual overrides on read | `server/src/services/google-sheet.ts:517-545` | high |
| sheet.version-read | Sheet links always use `prod_packagings.id`; `links_version` and `card_id` are removed | `server/sql/sheets-init.sql:27-45`, `server/src/services/google-sheet.ts:420-460` | high |

## Matching algorithms

| ID | Claim | Evidence | Confidence |
|---|---|---|---|
| match.product-order | Product match order: exact normalized name → alias → lexicon → LLM (only if lexicon silent) → trigram candidates | `server/src/routes/import.ts:565-647`, `server/src/services/product-lexicon.ts:300-338` | high |
| match.trigram | Candidate search uses `pg_trgm.similarity > 0.30`, top 4, names and aliases | `server/src/routes/import.ts:380-395` | high |
| match.confirm | Confirm creates product in base unit + stock row and saves alias; alias conflict is not silently rebound | `server/src/routes/import.ts:2040-2089` | high |
| match.supplier | Supplier order: PIB → GLN (13) → bank account digits → name → transcript name; own production excluded | `server/src/services/supplier-match.ts:99-154` | high |
| match.supplier-create | New supplier is auto-created with slug code, canonical PIB/MB/GLN/accounts, duplicate recheck | `server/src/services/supplier-match.ts:261-332` | high |
| match.units | Document units are mapped to base units; cross-dimension requires product coefficients | `server/src/routes/import.ts:60-100,300-345`, `server/src/routes/waybills.ts:105-147` | high |
| match.sheet-import | Sheet tab date from name + "Доставка …", store columns 103/Mix 38103, qty rounded up to packs | `server/src/services/order-history.ts:25-180` | high |
| match.legacy | Legacy migration and its tables are removed; no runtime path reads the old model | `server/sql/init.sql:31-46`, `server/package.json` | high |

## Data snapshot observations (local copy, 2026-11-23)

These are observed values, not schema claims.

| Observation | Evidence |
|---|---|
| 118 products, only 21 have `stock` rows | SQL against local `mixmarkt_crm` |
| 4 movements, all `manual` adjustments | SQL against local `mixmarkt_crm` |
| 221 nodes, 109 ops, 549 inputs, 72 packagings | SQL against local `mixmarkt_crm` |
| 1022 orders, 14 173 items, all items have `price_snapshot` | SQL against local `mixmarkt_crm` |
| 16 supplier invoices, 4 suppliers | SQL against local `mixmarkt_crm` |
| 115 sheet tabs, 48 manual links | SQL against local `mixmarkt_sheets` |
| 673 audit records, 15 Qoder messages | SQL against local `mixmarkt_crm` |

## Unknowns / validation tasks

| ID | Unknown | Why it matters | Next check |
|---|---|---|---|
| unknown.prod-volumes | Production volumes may differ from the local copy | Row counts and sparse stock are local observations | Run the same counts on production when authorized |
| unknown.map-history | `map_batches` has no `op_id`/`node_id` | Cannot join historical batches to current operations by key | Decide whether to add ids or accept name-based history |
| unknown.file-consistency | Waybill bytes may exist in DB and on disk; no XOR constraint | Restore/backup may pick different sources | Inspect production `waybills` and uploads |
| unknown.supplier-link | Waybill stores supplier as text, not `suppliers.id` | Renaming a supplier does not rewrite old waybills | Check whether reporting needs a canonical supplier FK |
| unknown.category-import | AI/lexicon still return a category label, which is resolved to `category_id` at the import boundary | Unknown labels fall back to `прочее`; they must not create silent dictionary drift | Check import with a new category label and confirm the created product gets a valid `category_id` |