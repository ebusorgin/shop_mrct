/**
 * Складская категория «упаковка» и базовые упаковочные позиции.
 * Идемпотентно: повторный запуск ничего не дублирует.
 *
 * Запуск: cd server && npx tsx scripts/add-packaging.ts
 */
import '../src/config';
import { pool } from '../src/db';

const CATEGORY = 'упаковка';
const ICON = '📦';
const COLOR = '#efe7d8';

const NAMES = [
  'банка 1000г',
  'крышка к банке 1000г',
  'банка 450г',
  'крышка к банке 450г',
  'одноразовая посуда для горячего',
  'контейнер 2кг',
];

async function main(): Promise<void> {
  await pool.query(
    `insert into product_categories (name, icon, color)
     values ($1, $2, $3)
     on conflict (name) do update
       set icon = case when product_categories.icon = '' then excluded.icon else product_categories.icon end,
           color = case when product_categories.color = '' then excluded.color else product_categories.color end`,
    [CATEGORY, ICON, COLOR]
  );

  const { rows: units } = await pool.query("select id from units where code = 'шт'");
  if (!units.length) throw new Error('Не найдена единица «шт»');
  const unitId = Number(units[0].id);

  for (const name of NAMES) {
    await pool.query(
      `insert into products (name, category, unit_id, min_stock, active)
       values ($1, $2, $3, 0, true)
       on conflict (name) do nothing`,
      [name, CATEGORY, unitId]
    );
  }

  const { rows: products } = await pool.query(
    'select id, name from products where name = any($1) order by name',
    [NAMES]
  );
  for (const product of products) {
    await pool.query(
      'insert into stock (product_id) values ($1) on conflict (product_id) do nothing',
      [product.id]
    );
  }

  console.log(
    JSON.stringify(
      { category: CATEGORY, products: products.map((p) => p.name) },
      null,
      2
    )
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
