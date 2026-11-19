/**
 * Снимок поведения старой модели (техкарты + полуфабрикаты) ДО перехода на карту.
 * Нужен, чтобы после миграции доказать: расход сырья и отчёты не изменились.
 *
 * Запуск: cd server && npx tsx scripts/baseline-legacy.ts
 * Результат: ../.devtools/legacy-baseline.json
 */
import '../src/config';
import { writeFileSync } from 'node:fs';
import { pool } from '../src/db';
import { expandCard } from '../src/services/expansion';
import { orderReport } from '../src/services/order-report';

async function main(): Promise<void> {
  const { rows: packs } = await pool.query(
    'select id, card_id as "cardId", qty_base::float8 as "qtyBase" from product_packagings order by id'
  );
  const { rows: cards } = await pool.query(
    'select id, portion_qty::float8 as "portionQty" from tech_cards'
  );
  const portionOf = new Map<number, number>(
    cards.map((c) => [Number(c.id), Number(c.portionQty)])
  );

  const packagings: Record<string, { productId: number; qty: number }[]> = {};
  for (const p of packs) {
    const portion = portionOf.get(Number(p.cardId)) ?? 0;
    if (!(portion > 0)) continue;
    const portions = Number(p.qtyBase) / portion;
    packagings[String(p.id)] = await expandCard(pool as never, Number(p.cardId), portions);
  }

  const { rows: dates } = await pool.query(
    "select distinct to_char(delivery_date, 'YYYY-MM-DD') as d from store_orders order by d"
  );
  const reports: Record<string, unknown> = {};
  const reportsCost: Record<string, unknown> = {};
  for (const row of dates) {
    reports[String(row.d)] = await orderReport(String(row.d));
    reportsCost[String(row.d)] = await orderReport(String(row.d), null, 'cost');
  }

  const { rows: catalog } = await pool.query(`
    select pk.id, tc.name as "cardName", pk.qty_base::float8 as "qtyBase", u.code as "unitCode"
      from product_packagings pk
      join tech_cards tc on tc.id = pk.card_id
      join units u on u.id = tc.portion_unit_id
     where pk.available
     order by tc.name, pk.qty_base`);

  writeFileSync(
    '../.devtools/legacy-baseline.json',
    JSON.stringify({ packagings, reports, reportsCost, catalog }, null, 2)
  );
  console.log(
    'baseline:',
    Object.keys(packagings).length,
    'packagings,',
    dates.length,
    'dates, catalog',
    catalog.length
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
