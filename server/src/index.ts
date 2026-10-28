import { createApp } from './app';
import { config } from './config';
import { migrate } from './migrate';
import { pool } from './db';
import { startOrderSyncLoop } from './services/order-sync';

async function main(): Promise<void> {
  await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`MIX markt CRM API: http://localhost:${config.port}/api`);
  });
  startOrderSyncLoop();
}

main().catch(async (e) => {
  console.error('Старт не удался:', e.message ?? e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
