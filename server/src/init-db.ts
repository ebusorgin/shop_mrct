import * as fs from 'fs';
import { pool } from './db';
import { config } from './config';

/**
 * Инициализирует схему из единственного sql/init.sql при каждом старте.
 * Файл идемпотентный: повторный запуск не меняет существующую схему и данные.
 */
export async function initDb(): Promise<void> {
  const sql = fs.readFileSync(config.sqlFile, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[init] ошибка инициализации БД:', e);
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  initDb()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
