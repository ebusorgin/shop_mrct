import './config';
import { applyLegacyMapImport } from './services/legacy-map-import';
import { remapSheetsPackagingIds } from './services/sheets-remap';
import { pool } from './db';
import { sheetsPool } from './db-sheets';

/**
 * Одноразовый перенос техкарт и полуфабрикатов на карту производства.
 *   npm run migrate:map           — dry-run
 *   npm run migrate:map -- --apply — применить
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const report = await applyLegacyMapImport({ dryRun: !apply });
  if (apply && !report.skipped) {
    try {
      report.warnings.push(...(await remapSheetsPackagingIds()));
    } catch (e) {
      report.warnings.push(
        `Google Sheets не перенесены: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...report }, null, 2));
  await sheetsPool.end().catch(() => undefined);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
