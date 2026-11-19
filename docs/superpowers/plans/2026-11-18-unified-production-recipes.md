# Единая сущность рецептур на карте производства — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Объединить техкарты и полуфабрикаты в узлы карты производства, перенести все текущие позиции и заказы на новую модель и убрать старые страницы.

**Architecture:** Источник истины — `prod_nodes` + `prod_ops` + `prod_packagings`. Старые таблицы остаются read-only архивом. Одноразовая миграция строит граф из 26 полуфабрикатов и 54 техкарт (10 сворачиваются в фасовки), переводит 13 930 строк заказов и ссылки Google Sheets на новые id. Сохранение карты становится upsert с архивированием, чтобы история заказов не теряла ссылки.

**Tech Stack:** Node.js/TypeScript, Express, PostgreSQL, Angular 19, pg, tsx.

**Spec:** `docs/superpowers/specs/2026-11-18-unified-production-recipes-design.md`

## Global Constraints

- Все суммы и количества в базовых единицах (г/мл/шт); пересчёт — через `toBaseCross`.
- Старые таблицы `tech_cards`, `tech_card_items`, `semi_products`, `semi_inputs`, `product_packagings` не изменяются и не читаются новым кодом.
- Миграция идемпотентна, выполняется в одной транзакции, маркер — `app_migrations.name = 'legacy_to_map_v1'`.
- Прод не деплоим и не меняем без отдельного подтверждения пользователя.
- Секреты (`server/credentials.json`, `.env`) не коммитить.
- После серверных изменений: `npm run build` в `server/`, перезапуск PM2 `mixmarkt-crm`.
- После клиентских: `npm run build` в `client/`.
- Не коммитить изменения без прямой просьбы пользователя.

---

## Task 0: Снять baseline старого поведения

**Files:**
- Create: `server/scripts/baseline-legacy.ts`
- Output: `.devtools/legacy-baseline.json` (gitignored)

**Interfaces:**
- Produces: JSON с `packagings: { [oldId]: RawNeed[] }`, `reports: { [date]: unknown }`, `catalog: unknown[]`.

- [ ] **Step 1: Написать скрипт baseline**

```ts
// server/scripts/baseline-legacy.ts
import { pool } from '../src/db';
import { expandCard } from '../src/services/expansion';
import { orderReport } from '../src/services/order-report';
import { writeFileSync } from 'node:fs';

async function main(): Promise<void> {
  const { rows: packs } = await pool.query(
    'select id, card_id as "cardId", qty_base::float8 as "qtyBase" from product_packagings order by id'
  );
  const { rows: cards } = await pool.query(
    'select id, portion_qty::float8 as "portionQty" from tech_cards'
  );
  const portionOf = new Map<number, number>(cards.map((c) => [Number(c.id), Number(c.portionQty)]));
  const packagings: Record<string, { productId: number; qty: number }[]> = {};
  for (const p of packs) {
    const portion = portionOf.get(Number(p.cardId)) ?? 0;
    if (!(portion > 0)) continue;
    const portions = Number(p.qtyBase) / portion;
    packagings[String(p.id)] = await expandCard(pool as never, Number(p.cardId), portions);
  }
  const { rows: dates } = await pool.query(
    'select distinct to_char(delivery_date, \'YYYY-MM-DD\') as d from store_orders order by d'
  );
  const reports: Record<string, unknown> = {};
  for (const row of dates) reports[String(row.d)] = await orderReport(String(row.d));
  const { rows: catalog } = await pool.query(`
    select pk.id, tc.name as "cardName", pk.qty_base::float8 as "qtyBase", u.code as "unitCode"
      from product_packagings pk
      join tech_cards tc on tc.id = pk.card_id
      join units u on u.id = tc.portion_unit_id
     where pk.available
     order by tc.name, pk.qty_base`);
  const reportsCost: Record<string, unknown> = {};
  for (const row of dates) reportsCost[String(row.d)] = await orderReport(String(row.d), null, 'cost');
  writeFileSync(
    '../.devtools/legacy-baseline.json',
    JSON.stringify({ packagings, reports, reportsCost, catalog }, null, 2)
  );
  console.log('baseline:', Object.keys(packagings).length, 'packagings,', dates.length, 'dates');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Запустить baseline**

Run: `cd server && npx tsx scripts/baseline-legacy.ts`
Expected: `baseline: 62 packagings, N dates`; файл `.devtools/legacy-baseline.json` создан.

- [ ] **Step 3: Проверить объём**

Run: `node -e "const b=require('./.devtools/legacy-baseline.json'); console.log(Object.keys(b.packagings).length, Object.keys(b.reports).length, Object.keys(b.reportsCost).length, b.catalog.length)"`
Expected: `62 N N 36`.

---

## Task 1: Схема — архив, трассировка, стабильные фасовки

**Files:**
- Modify: `server/sql/init.sql` (разделы `store_order_items`, `prod_nodes`, `prod_packagings`, конец файла)
- Note: помимо `title` добавлены `title_en`/`title_sr` — иначе сербские названия
  вариантов свёрнутых фасовок теряются в печати.
- Modify: `server/sql/sheets-init.sql` (комментарий `links_version`)

**Interfaces:**
- Produces: колонки `prod_nodes.archived`, `prod_nodes.legacy_kind/legacy_id`, `prod_ops.legacy_source/legacy_id`, `prod_packagings.archived/legacy_id/title`, `store_order_items.legacy_packaging_id`; final FK на `prod_packagings`.

- [ ] **Step 1: Добавить колонки карты**

В `server/sql/init.sql` после создания `prod_nodes`:

```sql
alter table prod_nodes add column if not exists archived boolean not null default false;
alter table prod_nodes add column if not exists legacy_kind text;
alter table prod_nodes add column if not exists legacy_id int;
alter table prod_ops add column if not exists legacy_source text;
alter table prod_ops add column if not exists legacy_id int;
alter table prod_packagings add column if not exists archived boolean not null default false;
alter table prod_packagings add column if not exists legacy_id int;
alter table prod_packagings add column if not exists title text;
create index if not exists prod_nodes_archived_idx on prod_nodes (archived);
create index if not exists prod_packagings_archived_idx on prod_packagings (archived);
```

Заменить частичный индекс фасовок:

```sql
drop index if exists prod_packagings_default_uniq;
create unique index if not exists prod_packagings_default_uniq
  on prod_packagings (node_id) where is_default and not archived;
```

- [ ] **Step 2: Подготовить `store_order_items`**

В `create table if not exists store_order_items` заменить внешний ключ на `prod_packagings` **нельзя** (таблица создаётся раньше). Оставить:

```sql
create table if not exists store_order_items (
  order_id     int not null references store_orders(id) on delete cascade,
  packaging_id int not null,
  legacy_packaging_id int,
  qty          int not null check (qty > 0 and qty <= 999),
  primary key (order_id, packaging_id)
);
```

После создания `prod_packagings` (ближе к концу файла) добавить:

```sql
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'store_order_items_prod_packaging_fkey'
  ) and (
    not exists (select 1 from store_order_items)
    or exists (select 1 from app_migrations where name = 'legacy_to_map_v1')
  ) then
    alter table store_order_items
      add constraint store_order_items_prod_packaging_fkey
      foreign key (packaging_id) references prod_packagings(id);
  end if;
end $$;
```

- [ ] **Step 3: Применить схему локально**

Run: `cd server && npx tsx src/init-db.ts`
Expected: без ошибок.

- [ ] **Step 4: Проверить колонки**

Run:
```bash
export PGPASSWORD=postgres
.devtools/pg18/pgsql/bin/psql.exe -h localhost -U postgres -d mixmarkt_crm -c "\d prod_nodes" -c "\d prod_packagings" -c "\d store_order_items"
```
Expected: `archived`, `legacy_*`, `title`, `legacy_packaging_id` присутствуют.

---

## Task 2: Планировщик импорта (чистая логика + тест)

**Files:**
- Create: `server/src/services/legacy-map-import.ts`
- Create: `server/test/legacy-map.pure.test.ts`
- Modify: `server/package.json` (скрипт `test:legacy`)

**Interfaces:**
- Produces:
  - `LegacySnapshot` — строки старых таблиц.
  - `MapPlan = { nodes: PlannedNode[]; ops: PlannedOp[]; warnings: string[] }`.
  - `planLegacyImport(data: LegacySnapshot): MapPlan`.
  - `PlannedNode.packagings: PlannedPackaging[]` c `legacyId`.

- [ ] **Step 1: Написать падающий тест**

```ts
// server/test/legacy-map.pure.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLegacyImport, type LegacySnapshot } from '../src/services/legacy-map-import';

const base: LegacySnapshot = {
  products: [{ id: 1, name: 'картофель', unit_id: 1 }],
  semis: [
    { id: 10, name: 'картофель варёный', unit_id: 1, out_qty: 1000 },
    { id: 11, name: 'пюре', unit_id: 1, out_qty: 450 },
  ],
  semiInputs: [
    { semi_id: 10, source_type: 'raw', ref_id: 1, qty_per_output: 1000, yield_pct: 95 },
    { semi_id: 11, source_type: 'semi', ref_id: 10, qty_per_output: 340, yield_pct: null },
  ],
  cards: [
    { id: 20, name: 'картофель варёный', name_en: '', name_sr: '', portion_qty: 1000, portion_unit_id: 1, catalog_id: 5 },
    { id: 21, name: 'пюре 450г', name_en: '', name_sr: '', portion_qty: 450, portion_unit_id: 1, catalog_id: 5 },
    { id: 22, name: 'суп', name_en: '', name_sr: '', portion_qty: 300, portion_unit_id: 1, catalog_id: 5 },
  ],
  cardItems: [
    { card_id: 20, source_type: 'semi', ref_id: 10, qty: 1000, unit_id: 1, position: 0 },
    { card_id: 21, source_type: 'semi', ref_id: 11, qty: 450, unit_id: 1, position: 0 },
    { card_id: 22, source_type: 'raw', ref_id: 1, qty: 300, unit_id: 1, position: 0 },
  ],
  packagings: [
    { id: 100, card_id: 20, name: '1000 г', qty_base: 1000, min_order: 1, is_default: true, price: 100, price_basis: 'unit', cost: 50, available: true },
    { id: 101, card_id: 21, name: '450 г', qty_base: 450, min_order: 1, is_default: true, price: 200, price_basis: 'portion', cost: 80, available: true },
    { id: 102, card_id: 22, name: '300 г', qty_base: 300, min_order: 1, is_default: true, price: 300, price_basis: 'portion', cost: 90, available: true },
  ],
};

test('сворачивает техкарту-фасовку в полуфабрикат', () => {
  const plan = planLegacyImport(base);
  const semi = plan.nodes.find((n) => n.legacyKind === 'semi' && n.legacyId === 10)!;
  assert.ok(semi);
  assert.equal(plan.nodes.filter((n) => n.legacyKind === 'card' && n.legacyId === 20).length, 0);
  assert.equal(semi.packagings.some((p) => p.legacyId === 100), true);
});

test('переносит потери как 100 − yield', () => {
  const plan = planLegacyImport(base);
  const op = plan.ops.find((o) => o.legacySource === 'semi' && o.legacyId === 10)!;
  assert.equal(op.inputs[0].lossPct, 5);
  assert.equal(op.planQty, 1000);
});

test('не сворачивает техкарту с другим названием и составом', () => {
  const plan = planLegacyImport(base);
  assert.equal(plan.nodes.filter((n) => n.legacyKind === 'card' && n.legacyId === 22).length, 1);
  const cardOp = plan.ops.find((o) => o.legacySource === 'card' && o.legacyId === 22)!;
  assert.equal(cardOp.inputs[0].nodeKey, 'raw:1');
});

test('на одном узле остаётся одна фасовка по умолчанию', () => {
  const plan = planLegacyImport(base);
  for (const node of plan.nodes) {
    assert.ok(node.packagings.filter((p) => p.isDefault).length <= 1, node.name);
  }
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

Run: `cd server && npx tsx --test test/legacy-map.pure.test.ts`
Expected: FAIL `Cannot find module ... legacy-map-import`.

- [ ] **Step 3: Реализовать планировщик**

```ts
// server/src/services/legacy-map-import.ts
export interface LegacySnapshot {
  products: { id: number; name: string; unit_id: number }[];
  semis: { id: number; name: string; unit_id: number; out_qty: number }[];
  semiInputs: { semi_id: number; source_type: 'raw' | 'semi'; ref_id: number; qty_per_output: number; yield_pct: number | null }[];
  cards: { id: number; name: string; name_en: string; name_sr: string; portion_qty: number; portion_unit_id: number; catalog_id: number | null }[];
  cardItems: { card_id: number; source_type: 'raw' | 'semi' | 'product'; ref_id: number; qty: number; unit_id: number; position: number }[];
  packagings: {
    id: number; card_id: number; name: string; qty_base: number; min_order: number;
    is_default: boolean; price: number; price_basis: 'unit' | 'portion' | 'piece';
    cost: number; available: boolean;
  }[];
}

export interface PlannedPackaging {
  legacyId: number; name: string; title: string | null; qtyBase: number; minOrder: number;
  isDefault: boolean; price: number; priceBasis: 'unit' | 'portion' | 'piece';
  cost: number; available: boolean;
}
export interface PlannedNode {
  key: string; kind: 'product' | 'state' | 'output'; refId: number | null;
  legacyKind: 'semi' | 'card' | null; legacyId: number | null;
  name: string; nameEn: string; nameSr: string; catalogId: number | null;
  unitId: number; portionQty: number; price: number; note: string;
  packagings: PlannedPackaging[];
}
export interface PlannedOp {
  key: string; legacySource: 'semi' | 'card' | null; legacyId: number | null;
  name: string; planQty: number; planUnitId: number; outputKey: string;
  inputs: { nodeKey: string; qty: number; inMass: boolean; lossPct: number | null }[];
}
export interface MapPlan { nodes: PlannedNode[]; ops: PlannedOp[]; warnings: string[] }

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function planLegacyImport(data: LegacySnapshot): MapPlan {
  const warnings: string[] = [];
  const semiById = new Map(data.semis.map((s) => [s.id, s]));
  const cardById = new Map(data.cards.map((c) => [c.id, c]));
  const itemsByCard = new Map<number, LegacySnapshot['cardItems']>();
  for (const i of data.cardItems) {
    const arr = itemsByCard.get(i.card_id) ?? [];
    arr.push(i);
    itemsByCard.set(i.card_id, arr);
  }
  const inputBySemi = new Map<number, LegacySnapshot['semiInputs']>();
  for (const i of data.semiInputs) {
    const arr = inputBySemi.get(i.semi_id) ?? [];
    arr.push(i);
    inputBySemi.set(i.semi_id, arr);
  }

  const nodes: PlannedNode[] = [];
  const ops: PlannedOp[] = [];
  const rawKeys = new Set<number>();
  const nodeByCard = new Map<number, string>();
  const collapsed = new Set<number>();

  for (const semi of data.semis) {
    const key = `state:${semi.id}`;
    nodes.push({
      key, kind: 'state', refId: null, legacyKind: 'semi', legacyId: semi.id,
      name: semi.name, nameEn: '', nameSr: '', catalogId: null,
      unitId: semi.unit_id, portionQty: semi.out_qty, price: 0, note: '',
      packagings: [],
    });
    ops.push({
      key: `op:semi:${semi.id}`, legacySource: 'semi', legacyId: semi.id,
      name: 'производство', planQty: semi.out_qty, planUnitId: semi.unit_id, outputKey: key,
      inputs: (inputBySemi.get(semi.id) ?? []).map((i) => ({
        nodeKey: i.source_type === 'raw' ? `raw:${i.ref_id}` : `state:${i.ref_id}`,
        qty: i.qty_per_output,
        inMass: true,
        lossPct: i.yield_pct != null && i.yield_pct > 0 && i.yield_pct < 100 ? 100 - i.yield_pct : null,
      })),
    });
    for (const i of inputBySemi.get(semi.id) ?? []) if (i.source_type === 'raw') rawKeys.add(i.ref_id);
  }

  const packagingByCard = new Map<number, PlannedPackaging[]>();
  for (const p of data.packagings) {
    const arr = packagingByCard.get(p.card_id) ?? [];
    arr.push({
      legacyId: p.id, name: p.name, title: null, qtyBase: p.qty_base, minOrder: p.min_order,
      isDefault: p.is_default, price: p.price, priceBasis: p.price_basis, cost: p.cost, available: p.available,
    });
    packagingByCard.set(p.card_id, arr);
  }

  const isPackagingCard = (cardId: number): boolean => {
    const card = cardById.get(cardId);
    const items = itemsByCard.get(cardId) ?? [];
    if (!card || items.length !== 1) return false;
    const item = items[0];
    if (item.source_type !== 'semi' || item.qty !== card.portion_qty) return false;
    const semi = semiById.get(item.ref_id);
    if (!semi || semi.unit_id !== card.portion_unit_id) return false;
    const c = norm(card.name);
    const s = norm(semi.name);
    return c === s || c.startsWith(s + ' ');
  };

  for (const card of data.cards) {
    if (isPackagingCard(card.id)) {
      collapsed.add(card.id);
      const item = (itemsByCard.get(card.id) ?? [])[0];
      const semiNode = nodes.find((n) => n.legacyKind === 'semi' && n.legacyId === item.ref_id)!;
      if (semiNode.catalogId == null) semiNode.catalogId = card.catalog_id;
      const packs = packagingByCard.get(card.id) ?? [];
      const sameName = norm(card.name) === norm(semiNode.name);
      for (const p of packs) semiNode.packagings.push({ ...p, title: sameName ? null : card.name });
      nodeByCard.set(card.id, semiNode.key);
      continue;
    }

    const key = `output:${card.id}`;
    nodeByCard.set(card.id, key);
    nodes.push({
      key, kind: 'output', refId: null, legacyKind: 'card', legacyId: card.id,
      name: card.name, nameEn: card.name_en, nameSr: card.name_sr, catalogId: card.catalog_id,
      unitId: card.portion_unit_id, portionQty: card.portion_qty, price: 0, note: '',
      packagings: (packagingByCard.get(card.id) ?? []).map((p) => ({ ...p })),
    });
    const inputs = (itemsByCard.get(card.id) ?? []).map((i) => {
      if (i.source_type === 'raw') {
        rawKeys.add(i.ref_id);
        return { nodeKey: `raw:${i.ref_id}`, qty: i.qty, inMass: true, lossPct: null };
      }
      if (i.source_type === 'semi') return { nodeKey: `state:${i.ref_id}`, qty: i.qty, inMass: true, lossPct: null };
      const ref = cardById.get(i.ref_id);
      if (!ref) throw new Error(`Техкарта #${card.id}: ссылка на продукт #${i.ref_id} не найдена`);
      return {
        nodeKey: nodeByCard.get(i.ref_id) ?? `output:${i.ref_id}`,
        qty: i.qty,
        inMass: true,
        lossPct: null,
      };
    });
    ops.push({
      key: `op:card:${card.id}`, legacySource: 'card', legacyId: card.id,
      name: 'сборка', planQty: card.portion_qty, planUnitId: card.portion_unit_id, outputKey: key, inputs,
    });
  }

  for (const id of rawKeys) {
    const p = data.products.find((x) => x.id === id);
    if (!p) {
      warnings.push(`Сырьё #${id} не найдено в номенклатуре`);
      continue;
    }
    nodes.push({
      key: `raw:${id}`, kind: 'product', refId: id, legacyKind: null, legacyId: null,
      name: p.name, nameEn: '', nameSr: '', catalogId: null,
      unitId: p.unit_id, portionQty: 0, price: 0, note: '', packagings: [],
    });
  }

  // Ровно одна фасовка по умолчанию на узел: приоритет — исходная фасовка точного совпадения.
  for (const node of nodes) {
    let seen = false;
    for (const p of node.packagings) {
      if (p.isDefault && !seen) seen = true;
      else p.isDefault = false;
    }
    if (!seen && node.packagings.length) node.packagings[0].isDefault = true;
  }

  for (const node of nodes) {
    if (!node.name.trim()) warnings.push(`Узел ${node.key} без названия`);
  }
  return { nodes, ops, warnings };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `cd server && npx tsx --test test/legacy-map.pure.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Добавить npm-скрипт**

В `server/package.json`:

```json
"test:legacy": "tsx --test test/legacy-map.pure.test.ts"
```

---

## Task 3: Применение миграции, заказы, Google Sheets

**Files:**
- Modify: `server/src/services/legacy-map-import.ts` (добавить `applyLegacyMapImport`)
- Create: `server/src/migrate-legacy-to-map.ts`
- Modify: `server/package.json` (`migrate:map`)

**Interfaces:**
- Consumes: `planLegacyImport`.
- Produces: `applyLegacyMapImport(opts: { dryRun: boolean }): Promise<MigrationReport>`;
  `MigrationReport = { skipped: boolean; nodes: number; ops: number; packagings: number; ordersItems: number; warnings: string[] }`.

- [ ] **Step 1: Реализовать загрузку снимка и применение**

Добавить в `legacy-map-import.ts`:

```ts
import { pool, tx } from '../db';

export async function loadLegacySnapshot(client: import('pg').PoolClient) {
  const q = async (sql: string) => (await client.query(sql)).rows;
  return {
    products: await q('select id, name, unit_id from products order by id'),
    semis: await q('select id, name, unit_id, out_qty::float8 as out_qty from semi_products order by id'),
    semiInputs: await q(`select semi_id, source_type, ref_id, qty_per_output::float8 as qty_per_output,
                                yield_pct::float8 as yield_pct from semi_inputs order by id`),
    cards: await q(`select id, name, name_en, name_sr, portion_qty::float8 as portion_qty,
                           portion_unit_id, catalog_id from tech_cards order by id`),
    cardItems: await q(`select card_id, source_type, ref_id, qty::float8 as qty, unit_id, position
                          from tech_card_items order by card_id, position, id`),
    packagings: await q(`select id, card_id, name, qty_base::float8 as qty_base, min_order,
                                is_default, price::float8 as price, price_basis,
                                cost::float8 as cost, available
                           from product_packagings order by id`),
  };
}

export interface MigrationReport {
  skipped: boolean; nodes: number; ops: number; packagings: number;
  ordersItems: number; warnings: string[];
}

export async function applyLegacyMapImport(opts: { dryRun: boolean }): Promise<MigrationReport> {
  return tx(async (client) => {
    const marker = await client.query("select 1 from app_migrations where name = 'legacy_to_map_v1'");
    if (marker.rows.length) {
      return { skipped: true, nodes: 0, ops: 0, packagings: 0, ordersItems: 0, warnings: [] };
    }
    const snapshot = await loadLegacySnapshot(client);
    const plan = planLegacyImport(snapshot as never);
    if (opts.dryRun) {
      return {
        skipped: false, nodes: plan.nodes.length, ops: plan.ops.length,
        packagings: plan.nodes.reduce((s, n) => s + n.packagings.length, 0),
        ordersItems: 0, warnings: plan.warnings,
      };
    }

    await client.query('delete from prod_packagings');
    await client.query('delete from prod_op_inputs');
    await client.query('delete from prod_ops');
    await client.query('delete from prod_nodes');

    const nodeIdByKey = new Map<string, number>();
    for (let i = 0; i < plan.nodes.length; i++) {
      const n = plan.nodes[i];
      const { rows } = await client.query(
        `insert into prod_nodes (kind, ref_id, name, name_en, name_sr, catalog_id, unit_id,
                                 x, y, position, portion_qty, price, note, legacy_kind, legacy_id)
         values ($1,$2,$3,$4,$5,$6,$7,0,0,$8,$9,$10,$11,$12,$13) returning id`,
        [n.kind, n.refId, n.name, n.nameEn, n.nameSr, n.catalogId, n.unitId, i,
         n.portionQty, n.price, n.note, n.legacyKind, n.legacyId]
      );
      nodeIdByKey.set(n.key, Number(rows[0].id));
    }

    const packIdByLegacy = new Map<number, number>();
    let packCount = 0;
    for (const n of plan.nodes) {
      const nodeId = nodeIdByKey.get(n.key)!;
      for (let j = 0; j < n.packagings.length; j++) {
        const p = n.packagings[j];
        const { rows } = await client.query(
          `insert into prod_packagings (node_id, name, qty_base, min_order, is_default, price,
                                        price_basis, cost, available, position, legacy_id, title)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [nodeId, p.name, p.qtyBase, p.minOrder, p.isDefault, p.price, p.priceBasis,
           p.cost, p.available, j, p.legacyId, p.title]
        );
        packIdByLegacy.set(p.legacyId, Number(rows[0].id));
        packCount++;
      }
    }

    for (let i = 0; i < plan.ops.length; i++) {
      const o = plan.ops[i];
      const outputNodeId = nodeIdByKey.get(o.outputKey);
      if (!outputNodeId) throw new Error(`Выход операции ${o.key} не найден`);
      const { rows } = await client.query(
        `insert into prod_ops (name, plan_qty, plan_unit_id, labor_hours, output_node_id,
                               note, x, y, position, legacy_source, legacy_id)
         values ($1,$2,$3,0,$4,'',0,0,$5,$6,$7) returning id`,
        [o.name, o.planQty, o.planUnitId, outputNodeId, i, o.legacySource, o.legacyId]
      );
      const opId = Number(rows[0].id);
      for (const inp of o.inputs) {
        const nodeId = nodeIdByKey.get(inp.nodeKey);
        if (!nodeId) throw new Error(`Вход операции ${o.key}: узел ${inp.nodeKey} не найден`);
        await client.query(
          'insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct) values ($1,$2,$3,$4,$5)',
          [opId, nodeId, inp.qty, inp.inMass, inp.lossPct]
        );
      }
    }

    // Заказы: новая колонка packaging_id (старую переименовываем один раз).
    const hasLegacy = await client.query(
      "select 1 from information_schema.columns where table_name='store_order_items' and column_name='legacy_packaging_id'"
    );
    if (!hasLegacy.rows.length) {
      await client.query('alter table store_order_items drop constraint if exists store_order_items_packaging_id_fkey');
      await client.query('alter table store_order_items rename column packaging_id to legacy_packaging_id');
    }
    await client.query('alter table store_order_items add column if not exists packaging_id int');

    for (const [oldId, newId] of packIdByLegacy) {
      await client.query(
        'update store_order_items set packaging_id = $2 where legacy_packaging_id = $1',
        [oldId, newId]
      );
    }
    const missing = await client.query(
      'select count(*)::int as n from store_order_items where packaging_id is null'
    );
    if (Number(missing.rows[0].n) > 0) {
      throw new Error(`Не сопоставлено строк заказов: ${missing.rows[0].n}`);
    }

    const { rows: orders } = await client.query(
      'select id, line_order from store_orders where line_order is not null'
    );
    for (const o of orders) {
      const mapped = (o.line_order as number[])
        .map((id) => packIdByLegacy.get(id))
        .filter((x): x is number => !!x);
      await client.query('update store_orders set line_order = $2::int[] where id = $1', [o.id, mapped]);
    }

    await client.query('alter table store_order_items alter column packaging_id set not null');
    await client.query('alter table store_order_items drop constraint if exists store_order_items_pkey');
    await client.query('alter table store_order_items add primary key (order_id, packaging_id)');
    await client.query(`
      do $$ begin
        if not exists (select 1 from pg_constraint where conname='store_order_items_prod_packaging_fkey') then
          alter table store_order_items add constraint store_order_items_prod_packaging_fkey
            foreign key (packaging_id) references prod_packagings(id);
        end if;
      end $$`);

    await client.query('update map_meta set version = version + 1, updated_at = now() where id = 1');
    await client.query("insert into app_migrations (name) values ('legacy_to_map_v1')");

    const ordersItems = await client.query('select count(*)::int as n from store_order_items');
    return {
      skipped: false, nodes: plan.nodes.length, ops: plan.ops.length,
      packagings: packCount, ordersItems: Number(ordersItems.rows[0].n), warnings: plan.warnings,
    };
  });
}
```

- [ ] **Step 2: CLI**

```ts
// server/src/migrate-legacy-to-map.ts
import { applyLegacyMapImport } from './services/legacy-map-import';
import { pool } from './db';
import { remapSheetsPackagingIds } from './services/sheets-remap';

async function main(): Promise<void> {
  const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';
  const report = await applyLegacyMapImport({ dryRun: mode !== 'apply' });
  if (!report.skipped && mode === 'apply') {
    report.warnings.push(...(await remapSheetsPackagingIds()));
  }
  console.log(JSON.stringify({ mode, ...report }, null, 2));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Ремап Google Sheets**

Создать `server/src/services/sheets-remap.ts`:

```ts
import { pool } from '../db';
import { sheetsPool, sheetsTx } from '../db-sheets';

/**
 * Переводит ссылки в отдельной БД листов со старых фасовок на новые.
 * Старый id берём из prod_packagings.legacy_id.
 */
export async function remapSheetsPackagingIds(): Promise<string[]> {
  const warnings: string[] = [];
  const { rows } = await pool.query<{ legacyId: number; id: number }>(
    'select legacy_id as "legacyId", id from prod_packagings where legacy_id is not null'
  );
  const map = new Map(rows.map((r) => [Number(r.legacyId), Number(r.id)]));
  if (!map.size) return ['Google Sheets: нет соответствий фасовок — пропущено'];

  await sheetsTx(async (client) => {
    const { rows: links } = await client.query(
      'select spreadsheet_id, tab_name, row_name, packaging_id, card_id from google_sheet_manual_links'
    );
    for (const l of links) {
      let newId: number | null = l.packaging_id == null ? null : map.get(Number(l.packaging_id)) ?? null;
      if (newId == null && l.card_id != null) {
        // старые связи хранили id техкарты: берём её фасовку по умолчанию в старом архиве
        const { rows: oldPack } = await pool.query(
          'select id from product_packagings where card_id = $1 and is_default limit 1',
          [Number(l.card_id)]
        );
        const oldId = oldPack[0]?.id == null ? null : Number(oldPack[0].id);
        if (oldId != null) newId = map.get(oldId) ?? null;
      }
      if (newId !== l.packaging_id) {
        await client.query(
          'update google_sheet_manual_links set packaging_id = $4, card_id = null where spreadsheet_id=$1 and tab_name=$2 and row_name=$3',
          [l.spreadsheet_id, l.tab_name, l.row_name, newId]
        );
      }
    }

    const { rows: tabs } = await client.query(
      'select spreadsheet_id, position, links from google_sheet_tabs where links <> \'[]\'::jsonb'
    );
    for (const tab of tabs) {
      if (!Array.isArray(tab.links)) continue;
      const mapped = tab.links.map((v: unknown) =>
        typeof v === 'number' && map.has(v) ? map.get(v) : null
      );
      await client.query(
        'update google_sheet_tabs set links = $3::jsonb where spreadsheet_id=$1 and position=$2',
        [tab.spreadsheet_id, tab.position, JSON.stringify(mapped)]
      );
    }
    await client.query('update google_sheets set links_version = 2');
  });
  return warnings;
}
```

- [ ] **Step 4: Добавить npm-скрипт**

```json
"migrate:map": "tsx src/migrate-legacy-to-map.ts"
```

- [ ] **Step 5: Dry-run**

Run: `cd server && npm run migrate:map`
Expected: JSON `mode: "dry-run", nodes: 136, ops: 70, packagings: 62` (70 рецептур + 66 узлов сырья), warnings — только несбалансированные операции.

- [ ] **Step 6: Применить локально**

Run: `cd server && npm run migrate:map -- --apply`
Expected: JSON `mode: "apply"`, `ordersItems: 13930`, markers; без ошибок.

- [ ] **Step 7: Проверить данные**

Run:
```bash
export PGPASSWORD=postgres
.devtools/pg18/pgsql/bin/psql.exe -h localhost -U postgres -d mixmarkt_crm -c "
select (select count(*) from prod_nodes where kind='state') states,
       (select count(*) from prod_nodes where kind='output') outputs,
       (select count(*) from prod_nodes where kind='product') raws,
       (select count(*) from prod_ops) ops,
       (select count(*) from prod_packagings) packs,
       (select count(*) from prod_packagings where available) available,
       (select count(*) from store_order_items) order_items,
       (select count(*) from store_order_items where legacy_packaging_id is null) no_legacy,
       (select count(*) from app_migrations where name='legacy_to_map_v1') marker;"
```
Expected: `states 26, outputs 44, ops 70, packs 62, available 36, order_items 13930, no_legacy 0, marker 1`.

---

## Task 4: Сохранение карты — upsert и архив, предупреждения, guard

**Files:**
- Create: `server/src/services/map-save.ts`
- Create: `server/src/services/map-migration.ts`
- Modify: `server/src/routes/production-map.ts:268-322` (удалить `replaceMap`, вызывать `saveMap`)
- Modify: `server/src/routes/production-map.ts:203-249` (`validateShape` — уникальность имён, активные ссылки)
- Modify: `server/src/routes/production-map.ts:393-433` (`validatePlanBalance` → warnings)
- Modify: `server/src/routes/production-map.ts:324-334` (GET фильтры архива)
- Modify: `server/src/routes/production-map.ts:435-464` (PUT ответ с warnings)
- Modify: `server/src/app.ts` (удалить semis/cards/batches, добавить guard)
- Delete: `server/src/routes/semis.ts`, `server/src/routes/cards.ts`, `server/src/routes/batches.ts`

**Interfaces:**
- Produces: `saveMap(client, nodes, ops): Promise<void>`; `requireMapMigrated` middleware.
- PUT response: `{ ok: true, version: number, warnings: { opUid: number; plan: number; net: number; diff: number }[] }`.

- [ ] **Step 1: Добавить guard**

```ts
// server/src/services/map-migration.ts
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db';

let applied: boolean | null = null;

export async function mapMigrationApplied(): Promise<boolean> {
  if (applied != null) return applied;
  const { rows } = await pool.query(
    "select 1 from app_migrations where name = 'legacy_to_map_v1'"
  );
  applied = rows.length > 0;
  return applied;
}

export function requireMapMigrated(_req: Request, res: Response, next: NextFunction): void {
  mapMigrationApplied()
    .then((ok) => {
      if (!ok) {
        res.status(503).json({ error: 'Требуется миграция данных на карту производства' });
        return;
      }
      next();
    })
    .catch(next);
}
```

В `app.ts` удалить импорты и `app.use` для `semisRouter`, `cardsRouter`, `batchesRouter`; добавить:

```ts
app.use(['/api/store/order-catalog', '/api/store/orders', '/api/orders'], requireMapMigrated);
```

(разместить после `app.use('/api', requireAuth)` и до роутеров магазина/заказов).

- [ ] **Step 2: GET карты — только активные**

В `NODES_SQL` добавить `where n.archived = false`. В запросе операций:

```sql
from prod_ops o
join prod_nodes n on n.id = o.output_node_id and n.archived = false
order by o.position, o.id
```

Фасовки: `from prod_packagings where archived = false`.

- [ ] **Step 3: `map-save.ts`**

```ts
import type { PoolClient } from 'pg';
import { ApiError } from '../http';

interface SaveNode {
  uid: number; kind: 'product' | 'state' | 'output'; refId: number | null;
  name: string; nameEn: string; nameSr: string; catalogId: number | null;
  unitId: number; x: number; y: number; portionQty: number; price: number; note: string;
  packagings: {
    uid?: number; name: string; qtyBase: number; minOrder: number; isDefault: boolean;
    price: number; priceBasis: 'unit' | 'portion' | 'piece'; cost: number; available: boolean;
  }[];
}
interface SaveOp {
  uid: number; name: string; yieldPct: number | null; planQty: number | null;
  planUnitId: number | null; laborHours: number; outputUid: number; note: string;
  x: number; y: number;
  inputs: { nodeUid: number; qty: number; inMass: boolean; lossPct: number | null }[];
}

/**
 * Upsert карты. Позиции, которых нет в payload, архивируются: на их фасовки
 * ссылается история заказов, удалять нельзя.
 */
export async function saveMap(client: PoolClient, nodes: SaveNode[], ops: SaveOp[]): Promise<void> {
  // Только активные id: uid нового узла может совпасть с архивным id.
  const existingNodes = new Set<number>(
    (await client.query('select id from prod_nodes where not archived for update')).rows
      .map((r) => Number(r.id))
  );
  const nodeIdByUid = new Map<number, number>();

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (existingNodes.has(n.uid)) {
      await client.query(
        `update prod_nodes set kind=$2, ref_id=$3, name=$4, name_en=$5, name_sr=$6,
                catalog_id=$7, unit_id=$8, x=$9, y=$10, position=$11, portion_qty=$12,
                price=$13, note=$14, archived=false where id=$1`,
        [n.uid, n.kind, n.refId, n.name, n.nameEn, n.nameSr, n.catalogId, n.unitId,
         n.x, n.y, i, n.portionQty, n.price, n.note]
      );
      nodeIdByUid.set(n.uid, n.uid);
    } else {
      const { rows } = await client.query(
        `insert into prod_nodes (kind, ref_id, name, name_en, name_sr, catalog_id, unit_id,
                                 x, y, position, portion_qty, price, note, archived)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false) returning id`,
        [n.kind, n.refId, n.name, n.nameEn, n.nameSr, n.catalogId, n.unitId,
         n.x, n.y, i, n.portionQty, n.price, n.note]
      );
      nodeIdByUid.set(n.uid, Number(rows[0].id));
    }
  }

  const keep = [...nodeIdByUid.values()];
  const archivedNodes = await client.query(
    `update prod_nodes set archived = true
      where not archived and not (id = any($1::int[])) returning id`,
    [keep.length ? keep : [0]]
  );
  if (archivedNodes.rows.length) {
    const ids = archivedNodes.rows.map((r) => Number(r.id));
    await client.query(
      `update prod_packagings set archived = true, is_default = false
        where node_id = any($1::int[]) and not archived`, [ids]
    );
  }

  // Фасовки активных узлов
  for (const n of nodes) {
    const nodeId = nodeIdByUid.get(n.uid)!;
    if (n.kind === 'product') continue;
    // Снимаем default заранее: иначе перенос default с одной фасовки на другую
    // нарушит частичный уникальный индекс.
    await client.query(
      'update prod_packagings set is_default = false where node_id = $1 and is_default',
      [nodeId]
    );
    const keepPacks: number[] = [];
    for (let j = 0; j < n.packagings.length; j++) {
      const p = n.packagings[j];
      if (p.uid && (await client.query(
        'select 1 from prod_packagings where id=$1 and node_id=$2 and not archived', [p.uid, nodeId]
      )).rows.length) {
        await client.query(
          `update prod_packagings set name=$3, qty_base=$4, min_order=$5, is_default=$6,
                  price=$7, price_basis=$8, cost=$9, available=$10, position=$11,
                  archived=false where id=$1 and node_id=$2`,
          [p.uid, nodeId, p.name, p.qtyBase, p.minOrder, p.isDefault, p.price,
           p.priceBasis, p.cost, p.available, j]
        );
        keepPacks.push(Number(p.uid));
      } else {
        const { rows } = await client.query(
          `insert into prod_packagings (node_id, name, qty_base, min_order, is_default,
                                        price, price_basis, cost, available, position, archived)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) returning id`,
          [nodeId, p.name, p.qtyBase, p.minOrder, p.isDefault, p.price, p.priceBasis,
           p.cost, p.available, j]
        );
        keepPacks.push(Number(rows[0].id));
      }
    }
    await client.query(
      `update prod_packagings set archived = true, is_default = false
        where node_id = $1 and not archived and not (id = any($2::int[]))`,
      [nodeId, keepPacks.length ? keepPacks : [0]]
    );
  }

  // Операции: обновляем/вставляем; отсутствующие сохраняем ради истории заказов.
  const existingOps = new Set<number>(
    (await client.query(
      `select o.id from prod_ops o join prod_nodes n on n.id = o.output_node_id
        where not n.archived for update`
    )).rows.map((r) => Number(r.id))
  );
  const opIdByUid = new Map<number, number>();
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const outputNodeId = nodeIdByUid.get(o.outputUid);
    if (!outputNodeId) throw new ApiError(400, 'Выход операции не найден');
    if (existingOps.has(o.uid)) {
      await client.query(
        `update prod_ops set name=$2, yield_pct=$3, plan_qty=$4, plan_unit_id=$5,
                labor_hours=$6, output_node_id=$7, note=$8, x=$9, y=$10, position=$11
          where id=$1`,
        [o.uid, o.name, o.yieldPct, o.planQty, o.planUnitId, o.laborHours, outputNodeId,
         o.note, o.x, o.y, i]
      );
      opIdByUid.set(o.uid, o.uid);
    } else {
      const { rows } = await client.query(
        `insert into prod_ops (name, yield_pct, plan_qty, plan_unit_id, labor_hours,
                               output_node_id, note, x, y, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [o.name, o.yieldPct, o.planQty, o.planUnitId, o.laborHours, outputNodeId,
         o.note, o.x, o.y, i]
      );
      opIdByUid.set(o.uid, Number(rows[0].id));
    }
  }

  for (const o of ops) {
    const opId = opIdByUid.get(o.uid)!;
    await client.query('delete from prod_op_inputs where op_id = $1', [opId]);
    for (const inp of o.inputs) {
      const nodeId = nodeIdByUid.get(inp.nodeUid);
      if (!nodeId) throw new ApiError(400, 'Вход операции не найден');
      await client.query(
        'insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct) values ($1,$2,$3,$4,$5)',
        [opId, nodeId, inp.qty, inp.inMass, inp.lossPct]
      );
    }
  }
}
```

- [ ] **Step 4: Подключить в route**

Заменить `replaceMap` на `saveMap`; `uid` фасовки добавить в `PackagingDto`:

```ts
interface PackagingDto {
  uid?: number;
  /* остальные поля без изменений */
}
```

В parseBody сохранять `uid: p.uid == null ? undefined : reqInt(p, 'uid')`; при сборке узла передавать `packagings`.

`validateShape` добавить проверку имён:

```ts
const seenNames = new Set<string>();
for (const n of nodes) {
  if (n.kind === 'product') continue;
  const key = n.name.trim().toLowerCase();
  if (!key) throw new ApiError(400, 'У рецептуры должно быть название');
  if (seenNames.has(key)) throw new ApiError(400, `Название «${n.name}» повторяется`);
  seenNames.add(key);
}
```

`validatePlanBalance` вернуть warnings:

```ts
interface BalanceWarning { opUid: number; plan: number; net: number; diff: number }

async function validatePlanBalance(...): Promise<BalanceWarning[]> {
  const warnings: BalanceWarning[] = [];
  // ... прежние проверки конверсии и циклов остаются throw
  if (Math.abs(plan - net) > 0.01) {
    warnings.push({ opUid: op.uid, plan: round3(plan), net: round3(net), diff: round3(plan - net) });
  }
  return warnings;
}
```

В PUT:

```ts
const warnings = await validatePlanBalance(client, nodes, ops);
await saveMap(client, nodes as never, ops as never);
// ...
res.json({ ok: true, version: nextVersion, warnings });
```

(вернуть `warnings` из `tx` наружу через переменную, как `nextVersion`).

Ценовые проверки в parseBody: только для доступных фасовок:

```ts
if (packagings.some((p) => p.available && !(p.price > 0))) {
  throw new ApiError(400, 'Укажите цену для каждой доступной фасовки');
}
const hasAvailable = packagings.some((p) => p.available);
if (hasAvailable && catalogId == null) {
  throw new ApiError(400, 'Выберите каталог для результата с доступной фасовкой');
}
```

- [ ] **Step 5: Собрать и перезапустить**

Run: `cd server && npm run build`
Run: `cd .. && npx pm2 restart mixmarkt-crm --update-env`
Expected: `/api/health` → ok.

- [ ] **Step 6: Проверить сохранение с дисбалансом**

Получить карту и отправить PUT с `planQty`, не равным сумме (например, у операции «чистка» изменить `planQty` на 1). Ожидаем 200 и `warnings.length > 0`; затем повторным PUT вернуть исходное значение.

---

## Task 5: Каталог магазина и сохранение заказов

**Files:**
- Modify: `server/src/routes/store.ts:46-77` (order-catalog)
- Modify: `server/src/routes/store.ts:196-203`, `221-227` (проверка доступности)

- [ ] **Step 1: Переписать каталог**

```sql
select pk.id, n.id as "cardId", n.name as "cardName",
       n.name_en as "cardNameEn", n.name_sr as "cardNameSr", n.note,
       pk.qty_base::float8 as "qtyBase", pk.min_order as "minOrder",
       u.code as "unitCode",
       n.catalog_id as "catalogId", cc.name as "catalogName",
       cc.icon as "catalogIcon", cc.color as "catalogColor"
  from prod_packagings pk
  join prod_nodes n on n.id = pk.node_id
  join units u on u.id = n.unit_id
  left join product_catalogs cc on cc.id = n.catalog_id
 where pk.available and not pk.archived and not n.archived
 order by cc.position nulls last, cc.name nulls last, n.name, pk.qty_base
```

- [ ] **Step 2: Проверки доступности**

Оба запроса заменить на:

```sql
select id from prod_packagings where available and not archived and id = any($1::int[])
```

- [ ] **Step 3: Проверка**

С авторизованной магазинной сессией:
`GET /api/store/order-catalog` → 36 строк, `cardId` — id узла.
`PUT /api/store/orders/current` с позицией доступной фасовки → 200; с архивной/недоступной → 400.

---

## Task 6: Отчёт, архив, история, статистика

**Files:**
- Modify: `server/src/services/order-report.ts:140-158`
- Modify: `server/src/services/order-archive.ts:50-69`
- Modify: `server/src/services/order-history.ts:101-107`
- Modify: `server/src/services/store-stats.ts:320-400`
- Modify: `server/src/routes/orders.ts:84` (без изменений, но проверить)
- Modify: `server/src/routes/store.ts` (report/archive вызывают сервисы)

- [ ] **Step 1: Отчёт**

Заменить join:

```sql
join prod_packagings pk on pk.id = i.packaging_id
join prod_nodes tc on tc.id = pk.node_id
join units u on u.id = tc.unit_id
...
coalesce(pk.title, nullif(tc.name_sr, ''), tc.name) as "cardNameSr",
tc.name as "cardName",
```

`cardName` использовать для строки, если `title` пуст. Практичнее:

```sql
coalesce(pk.title, tc.name) as "cardName",
tc.name as "nodeName",
coalesce(nullif(tc.name_sr, ''), '') as "nodeNameSr",
```

В TS:

```ts
name: r.cardNameSr || r.cardName,
```

Оставить `price`, `cost`, `qty_base`, `price_basis`, `dimension` как есть.

- [ ] **Step 2: Архив**

Аналогично: `prod_packagings`, `prod_nodes`, `u.id = tc.unit_id`, `cardName = coalesce(pk.title, tc.name)`.

- [ ] **Step 3: История**

`select id from prod_packagings` — история листов может ссылаться и на архивные фасовки.

- [ ] **Step 4: Статистика**

Во всех четырёх запросах `store-stats.ts` заменить `product_packagings` → `prod_packagings`, `tech_cards tc on tc.id = pk.card_id` → `prod_nodes tc on tc.id = pk.node_id`, `tc.portion_unit_id` → `tc.unit_id`.

- [ ] **Step 5: Сверить с baseline**

Создать `server/scripts/verify-map-migration.ts`:

```ts
import { readFileSync } from 'node:fs';
import { pool } from '../src/db';
import { orderReport } from '../src/services/order-report';
import { expandNodeNeed } from '../src/services/map-production';

const baseline = JSON.parse(readFileSync('../.devtools/legacy-baseline.json', 'utf8'));

interface Line { packagingId: number; name: string; unit: string; qty: number; price: number;
  net: number; vat: number; gross: number; weightKg: number }
interface Doc { orderId: number; number: string; lines: Line[]; net: number; vat: number;
  gross: number; weightKg: number }

function normalize(docs: Doc[], legacyOf: (id: number) => number | null): unknown {
  return docs.map((d) => ({
    orderId: d.orderId, number: d.number, net: d.net, vat: d.vat, gross: d.gross,
    weightKg: d.weightKg,
    lines: d.lines
      .map((l) => ({ ...l, legacyId: legacyOf(l.packagingId) }))
      .sort((a, b) => (a.legacyId ?? 0) - (b.legacyId ?? 0) || a.name.localeCompare(b.name)),
  }));
}

async function main(): Promise<void> {
  let bad = 0;
  const { rows: packRows } = await pool.query<{ id: number; legacyId: number | null }>(
    'select id, legacy_id as "legacyId" from prod_packagings'
  );
  const legacyOf = (id: number): number | null => {
    const row = packRows.find((r) => Number(r.id) === id);
    return row?.legacyId == null ? null : Number(row.legacyId);
  };

  for (const [oldId, expect] of Object.entries(baseline.packagings)) {
    const { rows } = await pool.query(
      `select id, node_id as "nodeId", qty_base::float8 as "qtyBase"
         from prod_packagings where legacy_id = $1`, [Number(oldId)]
    );
    if (!rows.length) { console.error('нет фасовки для legacy', oldId); bad++; continue; }
    const need = await expandNodeNeed(Number(rows[0].nodeId), Number(rows[0].qtyBase));
    const actual = new Map(need.map((n) => [n.productId, n.qty]));
    for (const e of expect as { productId: number; qty: number }[]) {
      const a = actual.get(e.productId) ?? 0;
      if (Math.abs(a - e.qty) > 0.001) {
        console.error('расход', oldId, e.productId, 'ожидали', e.qty, 'получили', a);
        bad++;
      }
    }
  }
  for (const [date, expect] of Object.entries(baseline.reports)) {
    const actual = await orderReport(date);
    if (JSON.stringify(normalize(actual.documents as Doc[], legacyOf)) !==
        JSON.stringify(normalize((expect as { documents: Doc[] }).documents, (id) => id))) {
      console.error('отчёт (sale) не совпал', date);
      bad++;
    }
  }
  for (const [date, expect] of Object.entries(baseline.reportsCost)) {
    const actual = await orderReport(date, null, 'cost');
    if (JSON.stringify(normalize(actual.documents as Doc[], legacyOf)) !==
        JSON.stringify(normalize((expect as { documents: Doc[] }).documents, (id) => id))) {
      console.error('отчёт (cost) не совпал', date);
      bad++;
    }
  }
  console.log(bad ? `FAIL: ${bad}` : 'OK: расход и отчёты совпадают');
  await pool.end();
  if (bad) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

(путь baseline поправить на абсолютный либо запускать из `server/` и читать `../.devtools/...` — так и есть).

- [ ] **Step 6: Запустить сверку**

Функция `expandNodeNeed` добавляется в Task 7 Step 1 — выполнить его до этого шага.
Run: `cd server && npx tsx scripts/verify-map-migration.ts`
Expected: `OK: расход и отчёты совпадают`.

Если расхождения: сравнить `loss_pct`/`plan_qty`/единицы у конкретной позиции; не ослаблять допуск 0,001.

---

## Task 7: Списание по доставке через граф карты

**Files:**
- Modify: `server/src/services/map-production.ts` (экспорт `expandNodeNeed`)
- Modify: `server/src/services/delivery-writeoff.ts:121-200`
- Modify: `server/src/routes/orders.ts` (preview/status — только если меняются поля)

- [ ] **Step 1: Экспортировать раскрытие**

В `map-production.ts`:

```ts
export async function expandNodeNeed(
  nodeId: number,
  requiredOut: number
): Promise<{ productId: number; qty: number }[]> {
  return tx(async (client) => {
    const g = await loadGraph(client);
    const producer = g.producerByOut.get(nodeId);
    if (!producer) throw new ApiError(409, 'Для результата нет операции-производителя');
    const units = await loadUnits(client);
    const conv = await loadProductConv(client);
    const need = new Map<number, number>();
    await expand(g, producer, requiredOut, need, 0, units, conv);
    return [...need.entries()].map(([productId, qty]) => ({ productId, qty: round3(qty) }));
  });
}
```

- [ ] **Step 2: Переписать loadOrderRows/buildNeeds**

Обновить интерфейс `OrderRow` (убрать `cardId`, `portionQty`, добавить `nodeId`) и импорт:
вместо `expandCard` импортировать `expandNodeNeed` из `./map-production`.

`loadOrderRows`:

```sql
select o.id as "orderId", o.store_id as "storeId", s.code as "storeCode", s.name as "storeName",
       o.doc_no::text as "docNo",
       i.qty, pk.qty_base::float8 as "qtyBase",
       n.id as "nodeId", coalesce(pk.title, n.name) as "cardName"
  from store_orders o
  join stores s on s.id = o.store_id
  join store_order_items i on i.order_id = o.id
  join prod_packagings pk on pk.id = i.packaging_id
  join prod_nodes n on n.id = pk.node_id
 where o.delivery_date = $1::date and ($2::int is null or o.store_id = $2)
 order by s.code, o.id, n.name
```

`buildNeeds`: вместо `portionQty` и `expandCard`:

```ts
const byNode = new Map<number, { name: string; out: number }>();
for (const r of rows) {
  const out = r.qty * r.qtyBase;
  if (!(out > 0)) throw new ApiError(400, `Не удалось посчитать количество для «${r.cardName}»`);
  const node = byNode.get(r.nodeId) ?? { name: r.cardName, out: 0 };
  node.out += out;
  byNode.set(r.nodeId, node);
  // ... orders/positions как раньше
}
const need = new Map<number, number>();
for (const [nodeId, info] of byNode) {
  const raw = await expandNodeNeed(nodeId, round3(info.out));
  for (const n of raw) need.set(n.productId, (need.get(n.productId) ?? 0) + n.qty);
}
```

- [ ] **Step 3: Проверить preview**

Run (офисная сессия): `GET /api/orders/delivery-writeoff/preview?date=2026-11-18`
Expected: `positions > 0`, `orders` не пуст, нет 500.

- [ ] **Step 4: Сверить с baseline через отчёт**

Повторить `verify-map-migration.ts` (он уже проверяет расход по фасовкам).

---

## Task 8: Google Sheets и вспомогательные модули

**Files:**
- Modify: `server/src/services/google-sheet.ts:278-305`, `364-380`, `486-505`
- Modify: `server/src/routes/products.ts:74-113`
- Modify: `server/src/routes/dashboard.ts:20-50`
- Modify: `server/src/routes/settings.ts:488-497`
- Modify: `server/src/routes/ai.ts:34-42`, обработка `sourceType`
- Modify: `server/src/services/name-check.ts`
- Modify: `server/src/seed.ts`

- [ ] **Step 1: Google Sheets**

В `loadMatchers` и `packagingLabel`-запросе:

```sql
select pk.id, pk.node_id as "cardId", n.name as "cardName", pk.name as "packagingName",
       pk.qty_base::float8 as "qtyBase", pk.is_default as "isDefault",
       u.code as "unitCode", u.dimension
  from prod_packagings pk
  join prod_nodes n on n.id = pk.node_id
  join units u on u.id = n.unit_id
 where not pk.archived
```

Ручные связи читать только по `packaging_id`; `card_id` больше не использовать (миграция его обнулила и заполнила `packaging_id`). `defaultByCard` оставить по `node_id`.

- [ ] **Step 2: Где используется сырьё**

```sql
select n.id, n.name, i.qty::float8 as qty, u.code as "unitCode",
       n.portion_qty::float8 as "portionQty", nu.code as "portionUnitCode"
  from prod_op_inputs i
  join prod_ops o on o.id = i.op_id
  join prod_nodes n on n.id = o.output_node_id and not n.archived
  join prod_nodes pn on pn.id = i.node_id
  join units u on u.id = pn.unit_id
  join units nu on nu.id = n.unit_id
 where pn.kind = 'product' and pn.ref_id = $1
 order by n.name
```

Вернуть `{ semis: [], cards: rows }` — клиент склада продолжит работать.

- [ ] **Step 3: Панель**

`production_batches` → `map_batches`; поля: `b.output_name as "cardName"`, `b.qty` вместо `portions`, `b.created_at::date` вместо `batch_date`. Первый запрос:

```sql
select coalesce(sum(cost_total),0)::float8 as "todayCost",
       count(*) filter (where status='posted')::int as "todayBatches"
  from map_batches where created_at::date = current_date
```

- [ ] **Step 4: Настройки каталогов**

`count(tc.id)` → `count(n.id)`, `left join tech_cards tc on tc.catalog_id = pc.id` → `left join prod_nodes n on n.catalog_id = pc.id and not n.archived and n.kind <> 'product'`.

- [ ] **Step 5: ИИ и проверка имён**

Удалить `SQL_SEMI` и ветку `sourceType === 'semi'`; всегда использовать продукт. В `name-check.ts` оставить только `products` (тип `NameTable = 'products'`, `SECTION` с одной записью).

- [ ] **Step 6: Seed**

Заменить блок с `semis` и техкартой «Борщ (порция)» (строки ~130–217) на
идемпотентный демо-граф:

```ts
await tx(async (client) => {
  const { rows: exists } = await client.query(
    "select 1 from prod_nodes where name = 'Борщ (порция)' limit 1"
  );
  if (exists.length) return;
  const pid = async (name: string): Promise<number> =>
    (await client.query('select id from products where name = $1', [name])).rows[0].id;
  const raw = async (name: string): Promise<number> => {
    const id = await pid(name);
    const { rows } = await client.query(
      'select id from prod_nodes where kind = $1 and ref_id = $2 limit 1',
      ['product', id]
    );
    if (rows.length) return Number(rows[0].id);
    const ins = await client.query(
      `insert into prod_nodes (kind, ref_id, name, unit_id, portion_qty, price, note)
       values ('product', $1, $2, (select unit_id from products where id = $1), 0, 0, '') returning id`,
      [id, name]
    );
    return Number(ins.rows[0].id);
  };

  const potato = await raw('Картофель');
  const milk = await raw('Молоко');
  const butter = await raw('Масло сливочное');

  const state = await client.query(
    `insert into prod_nodes (kind, name, unit_id, portion_qty, price, note)
     values ('state', 'Картофель варёный', $1, 1000, 0, 'Демо-заготовка') returning id`,
    [uG]
  );
  const stateId = Number(state.rows[0].id);
  const stateOp = await client.query(
    `insert into prod_ops (name, plan_qty, plan_unit_id, output_node_id, note, position)
     values ('варка', 1000, $1, $2, '', 0) returning id`,
    [uG, stateId]
  );
  await client.query(
    'insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct) values ($1,$2,$3,true,$4)',
    [stateOp.rows[0].id, potato, 1000, 5]
  );

  const dish = await client.query(
    `insert into prod_nodes (kind, name, unit_id, portion_qty, price, note, catalog_id)
     values ('output', 'Борщ (порция)', $1, 400, 0, 'Демо-продукт из ТЗ', null) returning id`,
    [uG]
  );
  const dishId = Number(dish.rows[0].id);
  const dishOp = await client.query(
    `insert into prod_ops (name, plan_qty, plan_unit_id, output_node_id, note, position)
     values ('сборка', 400, $1, $2, '', 0) returning id`,
    [uG, dishId]
  );
  const inputs: [number, number, number | null][] = [
    [stateId, 100, 5],
    [milk, 50, null],
    [butter, 10, null],
  ];
  for (const [nodeId, qty, loss] of inputs) {
    await client.query(
      'insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct) values ($1,$2,$3,true,$4)',
      [dishOp.rows[0].id, nodeId, qty, loss]
    );
  }
  await client.query(
    `insert into prod_packagings (node_id, name, qty_base, min_order, is_default, price,
                                  price_basis, cost, available, position)
     values ($1, '400 г', 400, 1, true, 0, 'portion', 0, false, 0)`,
    [dishId]
  );
});
```

Каталог/цена не обязательны, пока фасовка недоступна. Демо-данные должны открываться
на `/map` без ошибок.

- [ ] **Step 7: Сборка**

Run: `cd server && npm run build`
Expected: без ошибок.

---

## Task 9: Клиент — убрать старые страницы и меню

**Files:**
- Modify: `client/src/app/app.routes.ts:41-46`
- Modify: `client/src/app/app.component.ts:126-151`
- Modify: `client/src/app/core/api.service.ts:94-118`
- Modify: `client/public/i18n/ru.json`, `en.json`, `sr.json`
- Delete: `client/src/app/pages/semis.component.ts`, `client/src/app/pages/cards.component.ts`
- Keep: `client/src/app/core/semi-calc.ts` (используется `picker.component.ts`)

- [ ] **Step 1: Роуты**

Удалить маршруты `semis` и `cards`; добавить:

```ts
{ path: 'semis', pathMatch: 'full', redirectTo: 'map' },
{ path: 'cards', pathMatch: 'full', redirectTo: 'map' },
```

- [ ] **Step 2: Меню**

Удалить два пункта; переименовать ключ карты:

```ts
{ path: 'map', icon: '🍲', labelKey: 'nav.productionMap' },
```

В i18n добавить `nav.productionMap`: `ru` — «Карта производства», `en` — «Production map», `sr` — «Mapa proizvodnje».

- [ ] **Step 3: API service**

Удалить методы `semis$`, `semi$`, `createSemi`, `patchSemi`, `deleteSemi`, `cards$`, `card$`, `createCard`, `patchCard`, `deleteCard`, `cardExpansion$`; метод `saveProductionMap` типизировать:

```ts
saveProductionMap(body: unknown): Observable<{
  ok: boolean; version: number;
  warnings: { opUid: number; plan: number; net: number; diff: number }[];
}> {
  return this.http.put<{ ok: boolean; version: number; warnings: any[] }>(
    `${this.base}/production-map`, body
  );
}
```

- [ ] **Step 4: Сборка**

Run: `cd client && npm run build`
Expected: без ошибок.

---

## Task 10: Клиент — список рецептур, предупреждения, uid фасовок

**Files:**
- Modify: `client/src/app/pages/production-map.component.ts`
- Modify: `client/src/app/core/production-map-calc.ts:200-215`

- [ ] **Step 1: Предупреждение о дисбалансе в расчёте**

В `production-map-calc.ts` заменить пустой блок:

```ts
if (plan > 0 && Math.abs(plan - mass) > 0.01) {
  opWarnings.push(
    `партия ${round3(plan)} ≠ сумма ${round3(mass)} ${outNode.unitCode}`
  );
}
```

- [ ] **Step 2: Список рецептур**

В компоненте добавить сигналы:

```ts
panel = signal<'raw' | 'recipes'>('raw');
recipeQuery = signal('');
recipes = computed(() => {
  const q = this.recipeQuery().trim().toLowerCase();
  return this.nodes()
    .filter((n) => n.kind !== 'product')
    .filter((n) => !q || n.name.toLowerCase().includes(q))
    .map((n) => {
      const op = this.producerByOutput().get(n.uid);
      const warns = op ? this.calc().ops[op.uid]?.warnings ?? [] : [];
      return {
        uid: n.uid,
        name: n.name,
        kind: n.kind,
        kindLabel: n.kind === 'state' ? 'заготовка' : 'блюдо',
        packs: n.packagings.length,
        priceOk: n.packagings.filter((p) => p.available && !this.packPriceOk(p)).length === 0,
        warning: warns.length > 0 ? warns[0] : '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
});
```

В шапке боковой панели заменить `<b>Сырьё</b>` на две кнопки:

```html
<div class="raw-head">
  <button type="button" class="raw-tab" [class.on]="panel() === 'raw'" (click)="panel.set('raw')">Сырьё</button>
  <button type="button" class="raw-tab" [class.on]="panel() === 'recipes'" (click)="panel.set('recipes')">Рецептуры</button>
  <span class="raw-count">{{ panel() === 'raw' ? filteredProducts().length : recipes().length }}</span>
</div>
```

Показ списка:

```html
@if (panel() === 'recipes') {
  <div class="raw-search">
    <input [ngModel]="recipeQuery()" (ngModelChange)="recipeQuery.set($event)" placeholder="Поиск рецептуры…" />
  </div>
  <div class="raw-list">
    @for (r of recipes(); track r.uid) {
      <button type="button" class="raw-item recipe-item" (click)="selected.set({ kind: 'node', uid: r.uid })">
        <span class="raw-name" [title]="r.name">{{ r.name }}</span>
        <span class="kind-badge" [class.state]="r.kind === 'state'">{{ r.kindLabel }}</span>
        <span class="raw-unit">{{ r.packs }}</span>
        @if (r.warning) { <span class="recipe-warn" [title]="r.warning">!</span> }
      </button>
    } @empty {
      <div class="raw-empty">Рецептуры не найдены</div>
    }
  </div>
} @else {
  <!-- существующий список сырья без изменений -->
}
```

Добавить CSS:

```css
.raw-tab { border: 0; background: transparent; font-size: 11px; font-weight: 700; color: var(--muted); padding: 4px 6px; cursor: pointer; }
.raw-tab.on { color: var(--ink); border-bottom: 2px solid var(--ink); }
.kind-badge { font-size: 9px; padding: 1px 5px; border-radius: 6px; background: #eef3ea; color: #3d5a2e; white-space: nowrap; }
.kind-badge.state { background: #f1ece2; color: #7a5b2e; }
.recipe-warn { color: var(--red); font-weight: 800; }
```

- [ ] **Step 3: Бейдж в карточке операции**

Рядом с названием операции в блоке (`<span class="op-icon">⚙</span>`) добавить:

```html
@if (opCalc(b.op.uid)?.warnings?.length) {
  <span class="op-warn" [title]="opCalc(b.op.uid)?.warnings?.join('; ')">!</span>
}
```

CSS: `.op-warn { margin-left: auto; color: var(--red); font-weight: 800; }`.

- [ ] **Step 4: Сохранение без блокировки дисбаланса**

Удалить блок `// техкарта: нетто-ингредиенты должны точно давать партию N` из `save()`. Оставить проверки количества и потерь. После успеха:

```ts
next: (r) => {
  this.saving.set(false);
  const n = r.warnings?.length ?? 0;
  this.toast.show(
    n ? `Карта сохранена, предупреждений: ${n}` : 'Карта производства сохранена',
    n ? 'warn' : 'ok',
    2400
  );
  this.reload();
},
```

- [ ] **Step 5: Передавать uid фасовок**

В body сохранения добавить `uid: p.uid`. Убрать клиентскую проверку «каталог обязателен» для узлов без доступных фасовок:

```ts
const hasAvailable = n.packagings.some((p) => p.available);
const noPrice = n.packagings.find((p) => p.available && !this.packPriceOk(p));
if (noPrice) { /* прежняя ошибка */ }
if (hasAvailable && n.catalogId == null) { /* прежняя ошибка */ }
```

- [ ] **Step 6: Сборка**

Run: `cd client && npm run build`
Expected: без ошибок.

---

## Task 11: Приёмка

**Files:**
- Modify: `README.md` (раздел «Производство» — новая модель и миграция)
- No production changes.

- [ ] **Step 1: Серверные проверки**

Run:
```bash
cd server
npm run test:legacy
npm run build
```
Expected: 4 теста PASS, сборка без ошибок.

- [ ] **Step 2: Клиент**

Run: `cd ../client && npm run build`
Expected: без ошибок; `client/dist/crm/browser` обновлён.

- [ ] **Step 3: Перезапуск**

Run: `cd .. && npx pm2 restart mixmarkt-crm --update-env`
Expected: `/api/health` → `{"ok":true,...}`.

- [ ] **Step 4: Сверка данных**

Run: `cd server && npx tsx scripts/verify-map-migration.ts`
Expected: `OK: расход и отчёты совпадают`.

- [ ] **Step 5: Браузер — офис**

Создать временных офисного и магазинного пользователей (локально, только для проверки):

```bash
cd server && npx tsx -e "
import { hashPassword } from './src/services/auth';
import { pool } from './src/db';
(async () => {
  const h = hashPassword('qa-pass-2026');
  await pool.query(\"insert into users (login, password_hash, is_admin, active) values ('qa_office', \$1, true, true) on conflict (login) do update set password_hash = excluded.password_hash, is_admin = true, active = true\", [h]);
  await pool.query(\"insert into users (login, password_hash, is_admin, active, store_id) values ('qa_store', \$1, false, true, 103) on conflict (login) do update set password_hash = excluded.password_hash, is_admin = false, active = true, store_id = 103\", [h]);
  await pool.end();
})();"
```

Войти `qa_office / qa-pass-2026` в `http://localhost:4000`:
- меню без «Полуфабрикаты»/«Техкарты»;
- `/map`: видны 26 заготовок и 44 блюда в списке «Рецептуры»;
- у «картофель варённый» операция с потерями 5 %, партия 1000 г;
- «Морковь по-корейски» имеет фасовки 250/300/3000 г;
- сохранить карту без изменений — 200/тост;
- изменить партию «чистка» на 1 — сохранение проходит с предупреждением; вернуть назад;
- выпустить партию «варка» (1 000 г) — операция завершается, в истории выпусков появляется запись;
- отгрузить «Пюре» — операция завершается без 500.

- [ ] **Step 6: Браузер — магазин**

Войти `qa_store / qa-pass-2026` (store_id = 103):
- каталог заказа: 36 позиций;
- отчёт за `2026-11-18`: строки, вес, нетто, PDV, итог совпадают с baseline;
- перетаскивание строк работает (line_order новые id);
- себестоимость в магазинном отчёте не показывается.

- [ ] **Step 7: Удалить временного пользователя**

```sql
delete from sessions where user_id in (select id from users where login in ('qa_office','qa_store'));
delete from users where login in ('qa_office','qa_store');
```

- [ ] **Step 8: Отчёт о результате**

Сообщить: миграция применена локально, сверка OK, сборки прошли, проверки офис/магазин выполнены. Прод не трогали; для выката нужен `pg_dump`, `npm run migrate:map -- --apply` и подтверждение пользователя.
