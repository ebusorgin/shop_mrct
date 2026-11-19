import { pool } from '../db';
import { sheetsTx } from '../db-sheets';

/**
 * Переводит ссылки в отдельной базе листов Google со старых фасовок
 * (product_packagings) на фасовки карты (prod_packagings).
 * Старый id берём из prod_packagings.legacy_id.
 */
export async function remapSheetsPackagingIds(): Promise<string[]> {
  const warnings: string[] = [];
  const { rows } = await pool.query<{ legacyId: number; id: number }>(
    'select legacy_id as "legacyId", id from prod_packagings where legacy_id is not null'
  );
  const map = new Map(rows.map((r) => [Number(r.legacyId), Number(r.id)]));
  if (!map.size) return ['Google Sheets: нет соответствий фасовок — пропущено'];

  await sheetsTx(async (client) => {
    const { rows: links } = await client.query(
      `select spreadsheet_id, tab_name, row_name, packaging_id, card_id
         from google_sheet_manual_links`
    );
    for (const l of links) {
      let newId: number | null =
        l.packaging_id == null ? null : map.get(Number(l.packaging_id)) ?? null;
      if (newId == null && l.card_id != null) {
        // старые связи хранили id техкарты: берём её фасовку по умолчанию в архиве
        const { rows: oldPack } = await pool.query(
          'select id from product_packagings where card_id = $1 and is_default limit 1',
          [Number(l.card_id)]
        );
        const oldId = oldPack[0]?.id == null ? null : Number(oldPack[0].id);
        if (oldId != null) newId = map.get(oldId) ?? null;
      }
      if (newId !== l.packaging_id || l.card_id != null) {
        await client.query(
          `update google_sheet_manual_links
              set packaging_id = $4, card_id = null
            where spreadsheet_id = $1 and tab_name = $2 and row_name = $3`,
          [l.spreadsheet_id, l.tab_name, l.row_name, newId]
        );
      }
    }

    const { rows: tabs } = await client.query(
      "select spreadsheet_id, position, links from google_sheet_tabs where links <> '[]'::jsonb"
    );
    let unmapped = 0;
    for (const tab of tabs) {
      if (!Array.isArray(tab.links)) continue;
      const mapped = tab.links.map((v: unknown) => {
        if (typeof v !== 'number') return null;
        const id = map.get(v);
        if (id == null) unmapped++;
        return id ?? null;
      });
      await client.query(
        'update google_sheet_tabs set links = $3::jsonb where spreadsheet_id = $1 and position = $2',
        [tab.spreadsheet_id, tab.position, JSON.stringify(mapped)]
      );
    }
    if (unmapped) warnings.push(`Google Sheets: не сопоставлено ссылок в листах — ${unmapped}`);
    await client.query('update google_sheets set links_version = 2');
  });
  return warnings;
}
