import { pool, tx } from './db';
import { migrate } from './migrate';
import { applyMovement } from './services/stock';

/**
 * Демо-данные: номенклатура из ТЗ (борщ), полуфабрикаты с уварком,
 * складской остаток через учебную накладную и техкарта «Борщ».
 * Идемпотентно: повторно запускать безопасно.
 */
async function seed(): Promise<void> {
  await migrate();

  const unit = async (code: string): Promise<number> => {
    const { rows } = await pool.query('select id from units where code = $1', [code]);
    return rows[0].id;
  };
  const [uG, uMl, uPcs] = await Promise.all([unit('г'), unit('мл'), unit('шт')]);

  // ---- номенклатура (хранение строго в базовых единицах: г / мл / шт) ----
  const products: [string, string, number, number][] = [
    // name, category, unit, min_stock (в базовых ед.)
    ['Картофель', 'овощи', uG, 5000],
    ['Морковь', 'овощи', uG, 3000],
    ['Свёкла', 'овощи', uG, 3000],
    ['Капуста белокочанная', 'овощи', uG, 5000],
    ['Лук репчатый', 'овощи', uG, 2000],
    ['Помидоры', 'овощи', uG, 3000],
    ['Перец болгарский', 'овощи', uG, 1000],
    ['Чеснок', 'овощи', uG, 300],
    ['Укроп свежий', 'зелень', uG, 300],
    ['Говядина на кости', 'мясо', uG, 5000],
    ['Вода', 'прочее', uMl, 100000],
    ['Масло растительное', 'бакалея', uMl, 2000],
    ['Томатная паста', 'бакалея', uG, 1000],
    ['Соль', 'бакалея', uG, 2000],
    ['Сахар', 'бакалея', uG, 2000],
    ['Уксус 9%', 'бакалея', uMl, 500],
    ['Лавровый лист', 'специи', uPcs, 50],
    ['Перец чёрный горошком', 'специи', uG, 200],
    ['Сметана', 'молочное', uG, 2000],
    ['Капуста квашеная', 'готовое', uG, 1000],
  ];
  for (const [name, category, unitId, minStock] of products) {
    const { rows } = await pool.query(
      `insert into products (name, category, unit_id, min_stock) values ($1,$2,$3,$4)
       on conflict (name) do nothing returning id`,
      [name, category, unitId, minStock]
    );
    if (rows.length) {
      await pool.query('insert into stock (product_id) values ($1)', [rows[0].id]);
    }
  }

  const pid = async (name: string): Promise<number> => {
    const { rows } = await pool.query('select id from products where name = $1', [name]);
    return rows[0].id;
  };

  // ---- приходная накладная (если склад пуст) ----
  const { rows: hasMoves } = await pool.query('select 1 from movements limit 1');
  if (!hasMoves.length) {
    const receipt: [string, number, number][] = [
      // product, qty (кг/л на бумаге), цена за бумажную единицу — в БД пишем базовые г/мл
      ['Картофель', 50, 45], ['Морковь', 20, 60], ['Свёкла', 15, 55],
      ['Капуста белокочанная', 25, 50], ['Лук репчатый', 15, 50], ['Помидоры', 12, 180],
      ['Перец болгарский', 6, 220], ['Чеснок', 1, 350], ['Укроп свежий', 1, 150],
      ['Говядина на кости', 12, 650], ['Масло растительное', 5000, 0.13],
      ['Томатная паста', 3, 240], ['Соль', 5, 30], ['Сахар', 4, 65],
      ['Уксус 9%', 1000, 0.4], ['Сметана', 6, 320],
    ];
    await tx(async (client) => {
      const { rows: wb } = await client.query(
        `insert into waybills (number, supplier, doc_date)
         values ('Демо-001', 'ООО «ОвощБаза»', current_date) returning id`
      );
      const waybillId = wb[0].id as number;
      for (const [name, qty, price] of receipt) {
        const id = await pidVia(client, name);
        const isVolume = ['Масло растительное', 'Уксус 9%'].includes(name);
        const unitId = isVolume ? uMl : uG;
        const factor = isVolume ? 1 : 1000; // бумага была в кг -> храним г
        await client.query(
          'insert into waybill_items (waybill_id, product_id, qty, unit_id, price) values ($1,$2,$3,$4,$5)',
          [waybillId, id, qty * factor, unitId, price / factor]
        );
        await applyMovement(client, {
          productId: id,
          type: 'receipt',
          delta: qty * factor,
          unitCost: price / factor,
          docType: 'waybill',
          docId: waybillId,
          comment: 'Демонстрационный приход',
        });
      }
      // вода «приходует» условно, чтобы была на складе (500 л = 500000 мл)
      const waterId = await pidVia(client, 'Вода');
      await applyMovement(client, {
        productId: waterId, type: 'adjustment', delta: 500000, docType: 'manual', comment: 'Демо: вода, мл',
      });
      const bayLeafId = await pidVia(client, 'Лавровый лист');
      await applyMovement(client, {
        productId: bayLeafId, type: 'adjustment', delta: 200, docType: 'manual', comment: 'Демо: лавровый лист, шт',
      });
      const pepperId = await pidVia(client, 'Перец чёрный горошком');
      await applyMovement(client, {
        productId: pepperId, type: 'adjustment', delta: 500, docType: 'manual', comment: 'Демо: перец горошком, г',
      });
    });
  }

  async function pidVia(client: import('pg').PoolClient, name: string): Promise<number> {
    const { rows } = await client.query('select id from products where name = $1', [name]);
    return rows[0].id;
  }

  // ---- полуфабрикаты ----
  // name, [kind, базовый вход], выход %, добавки [kind, вход, qty на 1 баз. ед. выхода]; kind: raw|semi
  const semis: [string, ['raw' | 'semi', string], number, ['raw' | 'semi', string, number][]][] = [
    ['Картофель варёный', ['raw', 'Картофель'], 90, []],
    ['Картофель резаный', ['raw', 'Картофель'], 95, []],
    ['Свёкла варёная', ['raw', 'Свёкла'], 80, []],
    ['Морковь чищенная', ['raw', 'Морковь'], 85, []],
    ['Лук чищенный', ['raw', 'Лук репчатый'], 88, []],
    ['Капуста шиникованная', ['raw', 'Капуста белокочанная'], 92, []],
    // вложенный полуфабрикат: делается из ДРУГИХ полуфабрикатов + сырьё
    ['Зажарка борщовая', ['semi', 'Свёкла варёная'], 85, [
      ['semi', 'Морковь чищенная', 0.6],
      ['semi', 'Лук чищенный', 0.4],
      ['raw', 'Масло растительное', 0.1],
    ]],
  ];
  const semiByName = async (name: string): Promise<number> =>
    (await pool.query('select id from semi_products where name = $1', [name])).rows[0].id;
  const resolve = async (kind: 'raw' | 'semi', name: string) =>
    kind === 'raw' ? { st: 'raw', id: await pid(name) } : { st: 'semi', id: await semiByName(name) };

  for (const [name, baseRef, yieldPct, additives] of semis) {
    const { rows } = await pool.query(
      `insert into semi_products (name, unit_id, note) values ($1, $2, 'Демо-заготовка')
       on conflict (name) do nothing returning id`,
      [name, uG] // выход считаем в грамма относительно базового продукта (кг -> г)
    );
    let sid = rows[0]?.id;
    if (!sid) sid = (await pool.query('select id from semi_products where name = $1', [name])).rows[0].id;
    const { rows: exists } = await pool.query('select 1 from semi_inputs where semi_id = $1 limit 1', [sid]);
    if (exists.length) continue;
    const b = await resolve(baseRef[0], baseRef[1]);
    await pool.query(
      `insert into semi_inputs (semi_id, source_type, ref_id, role, yield_pct) values ($1,$2,$3,'base',$4)`,
      [sid, b.st, b.id, yieldPct]
    );
    for (const [kind, addName, qpo] of additives) {
      const a = await resolve(kind, addName);
      await pool.query(
        `insert into semi_inputs (semi_id, source_type, ref_id, role, qty_per_output) values ($1,$2,$3,'additive',$4)`,
        [sid, a.st, a.id, qpo]
      );
    }
  }

  // ---- техкарта «Борщ (порция 400 г)» ----
  const semiId = async (name: string) =>
    (await pool.query('select id from semi_products where name = $1', [name])).rows[0].id;

  const { rows: borschtExists } = await pool.query('select 1 from tech_cards where name = $1', ['Борщ (порция)']);
  if (!borschtExists.length) {
    await tx(async (client) => {
      const { rows } = await client.query(
        `insert into tech_cards (name, portion_qty, portion_unit_id, note)
         values ('Борщ (порция)', 400, $1, 'Демо-техкарта из ТЗ') returning id`,
        [uG]
      );
      const cardId = rows[0].id as number;
      const items: ['raw' | 'semi', string, number, number][] = [
        // type, ref name, qty per portion, unit id
        ['raw', 'Говядина на кости', 120, uG],
        ['raw', 'Вода', 700, uMl],
        ['semi', 'Свёкла варёная', 70, uG],
        ['semi', 'Капуста шиникованная', 90, uG],
        ['semi', 'Картофель варёный', 110, uG],
        ['semi', 'Морковь чищенная', 30, uG],
        ['semi', 'Лук чищенный', 30, uG],
        ['raw', 'Помидоры', 60, uG],
        ['raw', 'Перец болгарский', 30, uG],
        ['raw', 'Чеснок', 4, uG],
        ['raw', 'Масло растительное', 8, uMl],
        ['raw', 'Томатная паста', 8, uG],
        ['raw', 'Соль', 4, uG],
        ['raw', 'Сахар', 2, uG],
        ['raw', 'Уксус 9%', 3, uMl],
        ['raw', 'Лавровый лист', 0.1, uPcs],
        ['raw', 'Перец чёрный горошком', 0.25, uG],
        ['raw', 'Укроп свежий', 4, uG],
        ['raw', 'Сметана', 30, uG],
      ];
      let pos = 0;
      for (const [type, refName, qty, unitId] of items) {
        const refId = type === 'raw' ? await pidVia(client, refName) : await semiId(refName);
        await client.query(
          `insert into tech_card_items (card_id, source_type, ref_id, qty, unit_id, position)
           values ($1,$2,$3,$4,$5,$6)`,
          [cardId, type, refId, qty, unitId, pos++]
        );
      }
    });
  }

  console.log('[seed] демо-данные загружены: склад + полуфабрикаты + техкарта «Борщ»');
  await pool.end();
}

seed().catch((e) => {
  console.error('[seed] ошибка:', e);
  process.exit(1);
});
