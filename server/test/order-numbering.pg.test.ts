/**
 * Интеграционные тесты нумерации отчётов-отгрузок (Otpremnica).
 *
 * Идут на отдельной временной базе PostgreSQL (mixmarkt_test_numbering_<pid>),
 * которая создаётся в before и удаляется в after, — данные CRM не затрагиваются.
 * Подключение берётся из server/.env (PGHOST, PGPORT, PGUSER, PGPASSWORD).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import '../src/config'; // загружает server/.env до подключения к базе

const TEST_DB = `mixmarkt_test_numbering_${process.pid}`;
const conn = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
};

let admin: Client;
let pool: typeof import('../src/db').pool;
let numbering: typeof import('../src/services/order-numbering');

const dateOffset = async (days: number): Promise<string> => {
  const { rows } = await pool.query<{ d: string }>(
    'select to_char(current_date + $1::int, \'YYYY-MM-DD\') as d',
    [days]
  );
  return rows[0].d;
};

const currentYear = async (): Promise<number> => {
  const { rows } = await pool.query<{ y: number }>('select extract(year from current_date)::int as y');
  return Number(rows[0].y);
};

const makeStore = async (code: string): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    'insert into stores (code) values ($1) returning id',
    [code]
  );
  return rows[0].id;
};

/** Заказ на дату: смещение в днях от сегодняшнего дня базы. */
const makeOrder = async (storeId: number, dayOffset: number): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    `insert into store_orders (store_id, delivery_date, comment)
     values ($1, current_date + $2::int, 'тест') returning id`,
    [storeId, dayOffset]
  );
  return rows[0].id;
};

const makeOrderOn = async (storeId: number, date: string): Promise<number> => {
  const { rows } = await pool.query<{ id: number }>(
    `insert into store_orders (store_id, delivery_date, comment)
     values ($1, $2::date, 'тест') returning id`,
    [storeId, date]
  );
  return rows[0].id;
};

const docOf = async (orderId: number): Promise<string | null> => {
  const { rows } = await pool.query<{ doc: string | null }>(
    'select doc_no::text as doc from store_orders where id = $1',
    [orderId]
  );
  return rows[0].doc;
};

const yearOf = async (orderId: number): Promise<number | null> => {
  const { rows } = await pool.query<{ y: number | null }>(
    'select doc_year as y from store_orders where id = $1',
    [orderId]
  );
  return rows[0].y == null ? null : Number(rows[0].y);
};

const counterValue = async (year: number): Promise<number> => {
  const { rows } = await pool.query<{ v: string }>(
    'select last_no::text as v from doc_counters where doc_year = $1',
    [year]
  );
  return Number(rows[0]?.v ?? 0);
};

const codeOf = async (orderId: number): Promise<string> => {
  const { rows } = await pool.query<{ code: string }>(
    'select s.code from store_orders o join stores s on s.id = o.store_id where o.id = $1',
    [orderId]
  );
  return rows[0].code;
};

before(async () => {
  admin = new Client({ ...conn, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);

  process.env.PGDATABASE = TEST_DB;
  ({ pool } = await import('../src/db'));
  numbering = await import('../src/services/order-numbering');

  // Только то, что нужно нумерации; полная схема CRM для этих тестов не требуется.
  await pool.query(`
    create table stores (
      id serial primary key,
      code text not null unique,
      name text not null default ''
    );
    create table store_orders (
      id serial primary key,
      store_id int not null references stores(id),
      delivery_date date not null,
      doc_no bigint,
      doc_year int,
      comment text not null default ''
    );
    create unique index store_orders_doc_year_no_uniq
      on store_orders (doc_year, doc_no) where doc_no is not null;
    create table doc_counters (
      doc_year int primary key,
      last_no bigint not null default 0,
      updated_at timestamptz not null default now()
    );
  `);
});

after(async () => {
  await pool.end();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.end();
});

beforeEach(async () => {
  await pool.query('truncate store_orders, stores, doc_counters restart identity cascade');
  await pool.query(
    'insert into doc_counters (doc_year, last_no) values ($1, 866)',
    [await currentYear()]
  );
});

test('отчёт выдаёт подряд номера в порядке печати — по коду магазина', async () => {
  // Заказы созданы вразнобой, печатаются по возрастанию кода.
  const s7 = await makeStore('Mix 38107');
  const s3 = await makeStore('Mix 38103');
  const s5 = await makeStore('Mix 38105');
  const o7 = await makeOrder(s7, 3);
  const o3 = await makeOrder(s3, 3);
  const o5 = await makeOrder(s5, 3);

  const assigned = await numbering.ensureDeliveryDocNumbers(await dateOffset(3));

  assert.equal(assigned, 3);
  assert.equal(await docOf(o3), '867');
  assert.equal(await docOf(o5), '868');
  assert.equal(await docOf(o7), '869');
  assert.equal(await yearOf(o3), await currentYear());
  assert.equal(await counterValue(await currentYear()), 869);
});

test('повторная печать не меняет номера и не тратит счётчик', async () => {
  const s3 = await makeStore('Mix 38103');
  const s5 = await makeStore('Mix 38105');
  const o3 = await makeOrder(s3, 2);
  const o5 = await makeOrder(s5, 2);

  await numbering.ensureDeliveryDocNumbers(await dateOffset(2));
  const first = [await docOf(o3), await docOf(o5)];
  const second = await numbering.ensureDeliveryDocNumbers(await dateOffset(2));

  assert.equal(second, 0);
  assert.deepEqual([await docOf(o3), await docOf(o5)], first);
  assert.equal(await counterValue(await currentYear()), 868);
});

test('уже выданный номер не перезаписывается, новые продолжают счёт', async () => {
  const y = await currentYear();
  const s3 = await makeStore('Mix 38103');
  const s5 = await makeStore('Mix 38105');
  const o3 = await makeOrder(s3, 4);
  const o5 = await makeOrder(s5, 4);
  await pool.query('update store_orders set doc_no = 900, doc_year = $2 where id = $1', [o3, y]);

  const assigned = await numbering.ensureDeliveryDocNumbers(await dateOffset(4));

  assert.equal(assigned, 1);
  assert.equal(await docOf(o3), '900');
  assert.equal(await docOf(o5), '867');
});

test('прошедшую дату не нумерует ни отчёт, ни импорт', async () => {
  const s3 = await makeStore('Mix 38103');
  const old = await makeOrder(s3, -1);

  assert.equal(await numbering.ensureDeliveryDocNumbers(await dateOffset(-1)), 0);
  assert.equal(await docOf(old), null);

  const client = await pool.connect();
  try {
    await client.query('begin');
    assert.equal(await numbering.ensureFutureDocNumbers(client), 0);
    await client.query('commit');
  } finally {
    client.release();
  }
  assert.equal(await docOf(old), null);
});

test('номер при сохранении заказа: выдаётся один раз и не на прошлую дату', async () => {
  const today = await makeStore('Mix 38102');
  const future = await makeStore('Mix 38103');
  const past = await makeStore('Mix 38104');
  const oToday = await makeOrder(today, 0);
  const oFuture = await makeOrder(future, 5);
  const oPast = await makeOrder(past, -2);

  const client = await pool.connect();
  try {
    assert.equal(await numbering.assignOrderDocNumber(client, oToday), true);
    assert.equal(await numbering.assignOrderDocNumber(client, oFuture), true);
    assert.equal(await numbering.assignOrderDocNumber(client, oFuture), false);
    assert.equal(await numbering.assignOrderDocNumber(client, oPast), false);
  } finally {
    client.release();
  }

  assert.equal(await docOf(oToday), '867');
  assert.equal(await docOf(oFuture), '868');
  assert.equal(await docOf(oPast), null);
  assert.equal(await counterValue(await currentYear()), 868);
});

test('импорт нумерует все будущие даты по датам и кодам магазинов', async () => {
  const s5 = await makeStore('Mix 38105');
  const s3 = await makeStore('Mix 38103');
  const later3 = await makeOrder(s3, 5);
  const later5 = await makeOrder(s5, 5);
  const sooner5 = await makeOrder(s5, 2);
  const sooner3 = await makeOrder(s3, 2);
  const past = await makeOrder(s3, -1);

  const client = await pool.connect();
  try {
    await client.query('begin');
    assert.equal(await numbering.ensureFutureDocNumbers(client), 4);
    await client.query('commit');
  } finally {
    client.release();
  }

  assert.equal(await docOf(sooner3), '867');
  assert.equal(await docOf(sooner5), '868');
  assert.equal(await docOf(later3), '869');
  assert.equal(await docOf(later5), '870');
  assert.equal(await docOf(past), null);
});

test('с нового года счётчик начинается с 1', async () => {
  const y = await currentYear();
  const next = `${y + 1}-01-05`;
  const s3 = await makeStore('Mix 38103');
  const s5 = await makeStore('Mix 38105');
  const thisYear = await makeOrder(s3, 0);
  const next3 = await makeOrderOn(s3, next);
  const next5 = await makeOrderOn(s5, next);

  const client = await pool.connect();
  try {
    await client.query('begin');
    assert.equal(await numbering.ensureFutureDocNumbers(client), 3);
    await client.query('commit');
  } finally {
    client.release();
  }

  assert.equal(await docOf(thisYear), '867');
  assert.equal(await docOf(next3), '1');
  assert.equal(await docOf(next5), '2');
  assert.equal(await yearOf(next3), y + 1);
  assert.equal(await counterValue(y), 867);
  assert.equal(await counterValue(y + 1), 2);
});

test('параллельная печать не выдаёт один номер дважды', async () => {
  const stores = await Promise.all(['Mix 38103', 'Mix 38104', 'Mix 38105', 'Mix 38106', 'Mix 38107', 'Mix 38108'].map(makeStore));
  const orders = await Promise.all(stores.map((store) => makeOrder(store, 6)));
  const date = await dateOffset(6);

  const [a, b] = await Promise.all([
    numbering.ensureDeliveryDocNumbers(date),
    numbering.ensureDeliveryDocNumbers(date),
  ]);

  assert.equal(a + b, 6);
  const docs = await Promise.all(orders.map(docOf));
  assert.deepEqual([...docs].sort(), ['867', '868', '869', '870', '871', '872']);
  // Номера идут по коду магазина, а не по порядку вставки.
  const byCode = await Promise.all(orders.map(async (id) => ({ code: await codeOf(id), doc: await docOf(id) })));
  byCode.sort((x, y) => x.code.localeCompare(y.code));
  assert.deepEqual(byCode.map((r) => r.doc), ['867', '868', '869', '870', '871', '872']);
});