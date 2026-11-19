import { pool, tx } from './db';
import { initDb } from './init-db';
import { applyMovement } from './services/stock';

/**
 * Демо-данные: номенклатура из ТЗ (борщ), полуфабрикаты с выходом после обработки,
 * складской остаток через учебную накладную и техкарта «Борщ».
 * Идемпотентно: повторно запускать безопасно.
 */
async function seed(): Promise<void> {
  await initDb();

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

  // ---- демо-граф карты производства: сырьё -> заготовки -> борщ ----
  const { rows: mapExists } = await pool.query('select 1 from prod_nodes limit 1');
  if (!mapExists.length) {
    await tx(async (client) => {
      const rawNode = async (name: string): Promise<number> => {
        const p = await client.query('select id, unit_id from products where name = $1', [name]);
        if (!p.rows.length) throw new Error(`Seed: продукт «${name}» не найден`);
        const productId = Number(p.rows[0].id);
        const existing = await client.query(
          "select id from prod_nodes where kind = 'product' and ref_id = $1 limit 1",
          [productId]
        );
        if (existing.rows.length) return Number(existing.rows[0].id);
        const ins = await client.query(
          `insert into prod_nodes (kind, ref_id, name, unit_id, portion_qty, price, note)
           values ('product', $1, $2, $3, 0, 0, '') returning id`,
          [productId, name, p.rows[0].unit_id]
        );
        return Number(ins.rows[0].id);
      };

      const stateNode = async (
        name: string,
        inputName: string,
        qty: number,
        lossPct: number
      ): Promise<number> => {
        const input = await rawNode(inputName);
        const node = await client.query(
          `insert into prod_nodes (kind, name, unit_id, portion_qty, price, note)
           values ('state', $1, $2, 1000, 0, 'Демо-заготовка') returning id`,
          [name, uG]
        );
        const nodeId = Number(node.rows[0].id);
        const op = await client.query(
          `insert into prod_ops (name, plan_qty, plan_unit_id, output_node_id, note, position)
           values ('производство', 1000, $1, $2, '', 0) returning id`,
          [uG, nodeId]
        );
        await client.query(
          `insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct)
           values ($1,$2,$3,true,$4)`,
          [op.rows[0].id, input, qty, lossPct]
        );
        return nodeId;
      };

      const beet = await stateNode('Свёкла варёная', 'Свёкла', 1000, 20);
      const potato = await stateNode('Картофель варёный', 'Картофель', 1000, 10);
      const cabbage = await stateNode('Капуста шинкованная', 'Капуста белокочанная', 500, 8);

      const dish = await client.query(
        `insert into prod_nodes (kind, name, unit_id, portion_qty, price, note)
         values ('output', 'Борщ (порция)', $1, 400, 0, 'Демо-продукт из ТЗ') returning id`,
        [uG]
      );
      const dishId = Number(dish.rows[0].id);
      const op = await client.query(
        `insert into prod_ops (name, plan_qty, plan_unit_id, output_node_id, note, position)
         values ('сборка', 400, $1, $2, '', 0) returning id`,
        [uG, dishId]
      );
      const inputs: [number, number, number | null][] = [
        [await rawNode('Говядина на кости'), 120, null],
        [await rawNode('Вода'), 700, null],
        [beet, 70, null],
        [cabbage, 90, null],
        [potato, 110, null],
        [await rawNode('Морковь'), 30, null],
        [await rawNode('Лук репчатый'), 30, null],
        [await rawNode('Помидоры'), 60, null],
        [await rawNode('Перец болгарский'), 30, null],
        [await rawNode('Чеснок'), 4, null],
        [await rawNode('Масло растительное'), 8, null],
        [await rawNode('Томатная паста'), 8, null],
        [await rawNode('Соль'), 4, null],
        [await rawNode('Сахар'), 2, null],
        [await rawNode('Уксус 9%'), 3, null],
        [await rawNode('Лавровый лист'), 0.1, null],
        [await rawNode('Перец чёрный горошком'), 0.25, null],
        [await rawNode('Укроп свежий'), 4, null],
        [await rawNode('Сметана'), 30, null],
      ];
      for (const [nodeId, qty, loss] of inputs) {
        await client.query(
          `insert into prod_op_inputs (op_id, node_id, qty, in_mass, loss_pct)
           values ($1,$2,$3,true,$4)`,
          [op.rows[0].id, nodeId, qty, loss]
        );
      }
    });
  }

  console.log('[seed] демо-данные загружены: склад + карта производства «Борщ»');
  await pool.end();
}

seed().catch((e) => {
  console.error('[seed] ошибка:', e);
  process.exit(1);
});
