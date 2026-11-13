/**
 * Отдельная база для скачанных листов Google-таблицы «Микс Маркт Гастро».
 *
 * С CRM-данными не смешивается: своя база (по умолчанию mixmarkt_sheets) и свой пул.
 * База создаётся при старте, схема — идемпотентным sql/sheets-init.sql.
 */
import * as fs from 'fs';
import { Client, Pool, PoolClient } from 'pg';
import { config } from './config';

const conn = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
};

export const sheetsPool = new Pool({ ...conn, database: config.sheetsDatabase, max: 4 });

sheetsPool.on('error', (err) => console.error('[pg:sheets] idle client error', err));

export async function sheetsTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await sheetsPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Создать базу, если её нет (CREATE DATABASE нельзя внутри транзакции — отдельное подключение). */
async function createDatabaseIfMissing(): Promise<void> {
  const name = config.sheetsDatabase;
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Некорректное имя отдельной БД: ${name}`);
  const admin = new Client({ ...conn, database: 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!rows.length) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
}

export async function initSheetsDb(): Promise<void> {
  await createDatabaseIfMissing();
  const sql = fs.readFileSync(config.sheetsSqlFile, 'utf8');
  const client = await sheetsPool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}
