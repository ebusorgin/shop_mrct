import * as fs from 'fs';
import * as path from 'path';
import { pool } from './db';
import { config } from './config';

/** Применяет не выполненные .sql миграции из каталога sql/ по порядку имён. */
export async function migrate(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = fs
    .readdirSync(config.sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query('select 1 from schema_migrations where name = $1', [file]);
    if (rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(config.sqlDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] применена ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`[migrate] ошибка в ${file}:`, e);
      throw e;
    } finally {
      client.release();
    }
  }

  await backfillWaybillPhotos();
}

/**
 * Одноразово (идемпотентно) переносит фото накладных с диска в БД (file_data bytea):
 * раньше в stored_file писался путь/имя файла, теперь файл — источник истины в таблице.
 */
async function backfillWaybillPhotos(): Promise<void> {
  const { rows } = await pool.query(
    "select id, stored_file from waybills where stored_file is not null and file_data is null"
  );
  const mimeOf = (f: string): string => (/\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : /\.pdf$/i.test(f) ? 'application/pdf' : 'image/jpeg');
  let moved = 0;
  for (const r of rows) {
    const base = path.basename(r.stored_file);
    const candidates = [r.stored_file, path.join(process.cwd(), 'uploads', base), path.join(process.cwd(), 'uploads', 'waybills', base)];
    const found = candidates.find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
    if (!found) continue;
    const data = await fs.promises.readFile(found);
    await pool.query('update waybills set file_data = $2, file_mime = $3 where id = $1', [r.id, data, mimeOf(base)]);
    moved++;
  }
  if (moved) console.log(`[migrate] фото накладных перенесено в БД: ${moved}`);
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
