import { PoolClient } from 'pg';
import { ApiError } from '../http';

export type NameTable = 'products' | 'semi_products' | 'tech_cards';
export type NameColumn = 'name' | 'name_en' | 'name_sr';

const SECTION: Record<NameTable, string> = {
  products: 'Сырьё',
  semi_products: 'Полуфабрикаты',
  tech_cards: 'Техкарты',
};

/**
 * Название не должно повторяться в своём разделе: регистр и пробелы по краям не различаются.
 * Для техкарт проверяется каждая языковая колонка отдельно (name, name_en, name_sr).
 * Advisory-лок сериализует одновременные создания — иначе две вкладки проскочат проверку.
 */
export async function assertNameFree(
  client: PoolClient,
  name: string,
  table: NameTable,
  id?: number,
  column: NameColumn = 'name'
): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtext('nomenclature-name'))`);
  const { rows } = await client.query<{ value: string }>(
    `select ${column} as value from ${table}
      where btrim(${column}) <> '' and lower(btrim(${column})) = lower(btrim($1))
        and ($2::int is null or id <> $2)
      limit 1`,
    [name, id ?? null]
  );
  if (rows.length) {
    throw new ApiError(409, `«${rows[0].value}» уже есть в разделе «${SECTION[table]}»`);
  }
}
