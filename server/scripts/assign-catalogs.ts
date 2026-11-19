/**
 * Раскладывает все рецептуры карты по каталогам продукции.
 * Идемпотентно: недостающие каталоги создаёт, null-каталоги заполняет,
 * уже заданные категории не перезаписывает.
 *
 * Запуск: cd server && npx tsx scripts/assign-catalogs.ts
 */
import '../src/config';
import { pool } from '../src/db';

const CATALOGS: { name: string; icon: string; color: string; position: number }[] = [
  { name: 'заготовки', icon: '🥣', color: '#d8c3a5', position: 6 },
  { name: 'выпечка', icon: '🥐', color: '#f0c987', position: 7 },
  { name: 'десерты', icon: '🍰', color: '#f3b6c2', position: 8 },
  { name: 'прочее', icon: '📦', color: '#d9d3c7', position: 9 },
];

/** Точные названия блюд -> каталог. */
const OUTPUT: Record<string, string> = {
  'Блинчики простые': 'выпечка',
  'Блины пустые': 'выпечка',
  'Блины с курицей': 'выпечка',
  'Блины с сыром/ветчиной': 'выпечка',
  'Блины со свининой': 'выпечка',
  'Блины творог/сгущенка': 'выпечка',
  'Вафельный торт': 'выпечка',
  'Кулич с изюмом': 'выпечка',
  'Кулич с цукатами': 'выпечка',
  'Манник с творогом': 'выпечка',
  'Орешки со сгущенкой': 'выпечка',
  'Торт со сгущенукой вафельный': 'выпечка',

  'Йогуртово-ягодный дессерт': 'десерты',
  'Твороженный десерт(запеканка)': 'десерты',

  'Витаминный салат 200г': 'салаты',
  'Мимоза': 'салаты',
  'Салат со свеклой и черносливом': 'салаты',

  'Окрошка': 'супы',

  'Котлета из рыбы с рисом и овощами': 'горячие блюда',
  'Перец фаршированный с рисом': 'горячие блюда',
  'Фунчеза с овощами': 'горячие блюда',
};

async function main(): Promise<void> {
  for (const c of CATALOGS) {
    await pool.query(
      `insert into product_catalogs (name, position, icon, color)
       values ($1,$2,$3,$4)
       on conflict (name) do update
         set position = excluded.position,
             icon = case when product_catalogs.icon = '' then excluded.icon else product_catalogs.icon end,
             color = case when product_catalogs.color = '' then excluded.color else product_catalogs.color end`,
      [c.name, c.position, c.icon, c.color]
    );
  }

  const { rows: catalogs } = await pool.query<{ id: number; name: string }>(
    'select id, name from product_catalogs'
  );
  const idByName = new Map(catalogs.map((c) => [c.name, Number(c.id)]));

  // Заготовки без категории — в «заготовки»; проданные соленья уже имеют свой каталог.
  const stateCatalog = idByName.get('заготовки')!;
  const { rowCount: states } = await pool.query(
    "update prod_nodes set catalog_id = $1 where kind = 'state' and not archived and catalog_id is null",
    [stateCatalog]
  );

  let outputs = 0;
  const unknown: string[] = [];
  const { rows: pending } = await pool.query<{ id: number; name: string }>(
    "select id, name from prod_nodes where kind = 'output' and not archived and catalog_id is null order by name"
  );
  for (const node of pending) {
    const catalogName = OUTPUT[node.name];
    const catalogId = catalogName ? idByName.get(catalogName) : undefined;
    if (!catalogId) {
      unknown.push(node.name);
      continue;
    }
    await pool.query('update prod_nodes set catalog_id = $1 where id = $2', [catalogId, node.id]);
    outputs++;
  }

  const { rows: left } = await pool.query<{ kind: string; n: number }>(
    `select kind, count(*)::int as n from prod_nodes
      where kind <> 'product' and not archived and catalog_id is null
      group by kind`
  );

  console.log(
    JSON.stringify(
      { createdOrUpdated: CATALOGS.map((c) => c.name), states, outputs, unknown, left },
      null,
      2
    )
  );
  await pool.end();
  if (unknown.length || left.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
