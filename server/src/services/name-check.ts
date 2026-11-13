import { PoolClient } from 'pg';
import { ApiError } from '../http';

export type NameTable = 'products' | 'semi_products' | 'tech_cards';

const SECTION: Record<NameTable, string> = {
  products: 'Сырьё',
  semi_products: 'Полуфабрикаты',
  tech_cards: 'Техкарты',
};

/**
 * Название не должно повторяться в своём разделе: регистр и пробелы по краям не различаются.
 * Advisory-лок сериализует одновременные создания — иначе две вкладки проскочат проверку.
 */
export async function assertNameFree(
  client: PoolClient,
  name: string,
  table: NameTable,
  id?: number
): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtext('nomenclature-name'))`);
  const { rows } = await client.query<{ name: string }>(
    `select name from ${table} where lower(btrim(name)) = lower(btrim($1)) and ($2::int is null or id <> $2) limit 1`,
    [name, id ?? null]
  );
  if (rows.length) {
    throw new ApiError(409, `«${rows[0].name}» уже есть в разделе «${SECTION[table]}»`);
  }
}
