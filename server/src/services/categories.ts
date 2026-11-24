import type { PoolClient } from 'pg';
import { ApiError } from '../http';

type Queryable = Pick<PoolClient, 'query'>;

/** Категория по умолчанию: системная «прочее». */
export async function defaultCategoryId(client: Queryable): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `select id from product_categories
      where lower(btrim(name)) = 'прочее'
      limit 1`
  );
  if (!rows.length) throw new ApiError(500, 'В справочнике нет категории «прочее» — проверьте product_categories');
  return Number(rows[0].id);
}

/** Проверить, что категория существует, и вернуть её id. */
export async function assertCategoryId(client: Queryable, id: number): Promise<number> {
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'categoryId: требуется целое положительное число');
  const { rows } = await client.query<{ id: number }>(
    'select id from product_categories where id = $1',
    [id]
  );
  if (!rows.length) throw new ApiError(400, `Категория #${id} не найдена`);
  return Number(rows[0].id);
}

/**
 * Разрешить id по внешнему названию (ответ ИИ, словарь товароведа).
 * В БД и API имя категории не хранится: это только входной ярлык,
 * который сразу превращается в category_id.
 */
export async function resolveCategoryIdByName(client: Queryable, name: string | null | undefined): Promise<number> {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return defaultCategoryId(client);
  const { rows } = await client.query<{ id: number }>(
    `select id from product_categories
      where lower(btrim(name)) = $1
      limit 1`,
    [n]
  );
  if (rows.length) return Number(rows[0].id);
  const inserted = await client.query<{ id: number }>(
    `insert into product_categories (name)
     values ($1)
     on conflict (name) do update set name = excluded.name
     returning id`,
    [n]
  );
  return Number(inserted.rows[0].id);
}

/** Справочник категорий: id + имя для отображения и AI-подсказок. */
export async function categoryOptions(client: Queryable): Promise<{ id: number; name: string }[]> {
  const { rows } = await client.query<{ id: number; name: string }>(
    'select id, name from product_categories order by position, name'
  );
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));
}