/**
 * Доказывает, что после перехода на карту расход сырья и отчёты не изменились.
 * Запуск: cd server && npx tsx scripts/verify-map-migration.ts
 */
import '../src/config';
import { readFileSync } from 'node:fs';
import { pool } from '../src/db';
import { orderReport } from '../src/services/order-report';
import { expandNodeNeed } from '../src/services/map-production';

interface RawNeed { productId: number; qty: number }
interface Line {
  packagingId: number; name: string; unit: string; qty: number; price: number;
  net: number; vat: number; gross: number; weightKg: number;
}
interface Doc {
  orderId: number; number: string; lines: Line[];
  net: number; vat: number; gross: number; weightKg: number;
}

const baseline = JSON.parse(readFileSync('../.devtools/legacy-baseline.json', 'utf8'));

function normalize(docs: Doc[], legacyOf: (id: number) => number | null): unknown {
  return docs.map((d) => ({
    orderId: d.orderId,
    number: d.number,
    net: d.net,
    vat: d.vat,
    gross: d.gross,
    weightKg: d.weightKg,
    lines: d.lines
      .map((l) => {
        const legacyId = legacyOf(l.packagingId);
        return { ...l, packagingId: legacyId, legacyId };
      })
      .sort((a, b) => (a.legacyId ?? 0) - (b.legacyId ?? 0) || a.name.localeCompare(b.name)),
  }));
}

async function main(): Promise<void> {
  let bad = 0;
  const { rows: packRows } = await pool.query<{ id: number; legacyId: number | null }>(
    'select id, legacy_id as "legacyId" from prod_packagings'
  );
  const legacyById = new Map(packRows.map((r) => [Number(r.id), r.legacyId == null ? null : Number(r.legacyId)]));
  const legacyOf = (id: number): number | null => legacyById.get(id) ?? null;

  for (const [oldId, expect] of Object.entries(baseline.packagings)) {
    const { rows } = await pool.query(
      `select id, node_id as "nodeId", qty_base::float8 as "qtyBase"
         from prod_packagings where legacy_id = $1`,
      [Number(oldId)]
    );
    if (!rows.length) {
      console.error('нет фасовки для legacy', oldId);
      bad++;
      continue;
    }
    const need = await expandNodeNeed(Number(rows[0].nodeId), Number(rows[0].qtyBase));
    const actual = new Map(need.map((n) => [n.productId, n.qty]));
    for (const e of expect as RawNeed[]) {
      const a = actual.get(e.productId) ?? 0;
      if (Math.abs(a - e.qty) > 0.001) {
        console.error('расход', oldId, e.productId, 'ожидали', e.qty, 'получили', a);
        bad++;
      }
    }
  }

  for (const [date, expect] of Object.entries(baseline.reports)) {
    const actual = await orderReport(date);
    const a = JSON.stringify(normalize(actual.documents as Doc[], legacyOf));
    const b = JSON.stringify(
      normalize((expect as { documents: Doc[] }).documents, (id) => id)
    );
    if (a !== b) {
      console.error('отчёт (sale) не совпал', date);
      bad++;
    }
  }
  for (const [date, expect] of Object.entries(baseline.reportsCost)) {
    const actual = await orderReport(date, null, 'cost');
    const a = JSON.stringify(normalize(actual.documents as Doc[], legacyOf));
    const b = JSON.stringify(
      normalize((expect as { documents: Doc[] }).documents, (id) => id)
    );
    if (a !== b) {
      console.error('отчёт (cost) не совпал', date);
      bad++;
    }
  }

  console.log(bad ? `FAIL: ${bad}` : 'OK: расход и отчёты совпадают');
  await pool.end();
  if (bad) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
