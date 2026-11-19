import { createServer } from 'http';
import { createApp } from './app';
import { config } from './config';
import { initDb } from './init-db';
import { initSheetsDb } from './db-sheets';
import { pool } from './db';
import { ensureAdminUser, purgeExpiredSessions } from './services/auth';
import { freezeOrderPrices } from './services/order-price-snapshot';
import { attachLogWs } from './services/ws-log';

async function main(): Promise<void> {
  await initDb();
  await ensureAdminUser();
  await purgeExpiredSessions();
  // отдельная база для Google-таблицы — вспомогательное хранилище:
  // без неё CRM работает, а вкладка «Синхронизация Excel» покажет ошибку
  await initSheetsDb().catch((e: unknown) => {
    console.error('[sheets] отдельная база недоступна:', e instanceof Error ? e.message : e);
  });
  const app = createApp();
  const server = createServer(app);
  // живой лог «что делает сервер» для офисных страниц (разбор накладной и т.п.)
  attachLogWs(server);
  server.listen(config.port, config.host, () => {
    console.log(`MIX markt CRM API: http://${config.host}:${config.port}/api`);
  });
  // Слепки цен: как только дата доставки наступила, цены строк фиксируются,
  // чтобы будущие изменения цен не пересчитывали прошлые документы.
  const freeze = (): void => {
    freezeOrderPrices()
      .then((n) => {
        if (n > 0) console.log(`[prices] зафиксированы цены ${n} строк заказов`);
      })
      .catch((e: unknown) => {
        console.error('[prices] снимок цен:', e instanceof Error ? e.message : e);
      });
  };
  setTimeout(freeze, 5000);
  setInterval(freeze, 30 * 60 * 1000).unref();
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
