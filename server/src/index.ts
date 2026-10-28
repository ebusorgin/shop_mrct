import { createApp } from './app';
import { config } from './config';
import { migrate } from './migrate';
import { pool } from './db';
import { startOrderSyncLoop } from './services/order-sync';
import { ensureAdminUser, purgeExpiredSessions } from './services/auth';

async function main(): Promise<void> {
  await migrate();
  await ensureAdminUser();
  await purgeExpiredSessions();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`MIX markt CRM API: http://localhost:${config.port}/api`);
  });
  startOrderSyncLoop();
}

main().catch(async (e: unknown) => {
  // у сетевых ошибок Node (ECONNREFUSED/ENOTFOUND) message может быть пустым —
  // тогда печатаем stack, name, code и вложенные AggregateError.errors
  const err = e as { message?: string; stack?: string; name?: string; code?: string; errors?: unknown[] } | null;
  const details: string[] = [];
  if (err?.message) details.push(err.message);
  if (err?.code) details.push(`code=${err.code}`);
  if (err?.name && err.name !== 'Error') details.push(`name=${err.name}`);
  if (Array.isArray(err?.errors)) {
    for (const sub of err.errors as Array<{ message?: string; code?: string }>) {
      details.push(`  ↳ ${sub?.code ?? ''} ${sub?.message ?? ''}`.trimEnd());
    }
  }
  console.error('Старт не удался:', details.join('\n') || err?.stack || String(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
