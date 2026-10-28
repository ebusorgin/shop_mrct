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
import { authRouter } from './routes/auth';
import { requireAuth } from './services/auth';

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  // импорт файлов: пакет base64-фото накладной (до ~24 МБ байт + ~33% на base64) — свой парсер до общего лимита
  app.use('/api/import', express.json({ limit: '80mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'mixmarkt-crm' }));
  // вход/выход и управление пользователями — свои проверки внутри роутера
  app.use('/api/auth', authRouter);
  // всё остальное API — только с действующей сессией
  app.use('/api', requireAuth);
  app.use('/api/meta', metaRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/waybills', waybillsRouter);
  app.use('/api/import', importRouter);
  app.use('/api/semis', semisRouter);
  app.use('/api/cards', cardsRouter);
  app.use('/api/batches', batchesRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/points', pointsRouter);

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
