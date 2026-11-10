/**
 * Поток событий для браузера: GET /api/events (text/event-stream).
 * Требует сессию — как и остальное API (requireAuth подключён в app.ts до роутера).
 *
 * События: `orders-changed` (заказ оформлен/изменён/отменён в CRM).
 * EventSource переподключается сам, поэтому здесь ничего не кэшируем и не досылаем.
 */
import { Router } from 'express';
import { addSseClient } from '../services/live';

export const eventsRouter = Router();

eventsRouter.get('/', (req, res) => {
  addSseClient(req, res);
});
