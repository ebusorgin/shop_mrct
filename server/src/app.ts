import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { errHandler } from './http';
import { config } from './config';
import { metaRouter } from './routes/meta';
import { productsRouter } from './routes/products';
import { stockRouter } from './routes/stock';
import { waybillsRouter } from './routes/waybills';
import { importRouter } from './routes/import';
import { semisRouter } from './routes/semis';
import { cardsRouter } from './routes/cards';
import { batchesRouter } from './routes/batches';
import { dashboardRouter } from './routes/dashboard';
import { ordersRouter } from './routes/orders';
import { pointsRouter } from './routes/points';
import { auditRouter } from './routes/audit';
import { authRouter } from './routes/auth';
import { storeRouter } from './routes/store';
import { eventsRouter } from './routes/events';
import { hooksRouter } from './routes/hooks';
import { requireAuth, requireOffice } from './services/auth';

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  // импорт файлов: пакет base64-фото накладной (до ~24 МБ байт + ~33% на base64) — свой парсер до общего лимита
  app.use('/api/import', express.json({ limit: '80mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'mixmarkt-crm' }));
  // вход/выход и управление пользователями — свои проверки внутри роутера
  app.use('/api/auth', authRouter);
  // вебхук Google Таблицы: Google не приносит cookie — авторизация по секрету внутри роутера
  app.use('/api/hooks', hooksRouter);
  // всё остальное API — только с действующей сессией
  app.use('/api', requireAuth);
  // страница своего магазина — только для магазинных сотрудников
  app.use('/api/store', storeRouter);
  // офисные разделы: магазинному сотруднику закрыты (он видит только свою точку)
  app.use('/api/meta', requireOffice, metaRouter);
  app.use('/api/products', requireOffice, productsRouter);
  app.use('/api/stock', requireOffice, stockRouter);
  app.use('/api/waybills', requireOffice, waybillsRouter);
  app.use('/api/import', requireOffice, importRouter);
  app.use('/api/semis', requireOffice, semisRouter);
  app.use('/api/cards', requireOffice, cardsRouter);
  app.use('/api/batches', requireOffice, batchesRouter);
  app.use('/api/dashboard', requireOffice, dashboardRouter);
  // заказы: офисные ручки (/stores, /sync) закрыты внутри, остальные сужены до своей точки
  app.use('/api/orders', ordersRouter);
  app.use('/api/points', requireOffice, pointsRouter);
  // журнал действий: кто, что и когда сделал
  app.use('/api/audit', requireOffice, auditRouter);
  // живой канал «сервер -> браузер» (SSE): плашка «в таблице изменения»
  app.use('/api/events', eventsRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));

  // прод: раздаём собранный клиент (если собран) — SPA-fallback на index.html
  const indexHtml = path.join(config.clientDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.clientDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(indexHtml);
    });
  }

  app.use(errHandler);
  return app;
}
