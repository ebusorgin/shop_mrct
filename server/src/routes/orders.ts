/**
 * Архив заказов магазинов для офиса.
 *
 *   GET /api/orders/archive — все сохранённые заказы с составом и итогами,
 *                             свежие даты доставки первыми.
 */
import { Router } from 'express';
import { ApiError, wrap } from '../http';
import { orderArchive } from '../services/order-archive';
import { orderReport } from '../services/order-report';

export const ordersRouter = Router();

ordersRouter.get(
  '/archive',
  wrap(async (_req, res) => {
    res.json(await orderArchive(null));
  })
);

/** Предпросмотр отчёта-отгрузки: ?date=YYYY-MM-DD&storeId= (без storeId — все магазины). */
ordersRouter.get(
  '/report',
  wrap(async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new ApiError(400, 'date: требуется дата в формате YYYY-MM-DD');
    }
    const rawStore = req.query.storeId;
    const storeId = rawStore === undefined || rawStore === '' ? null : Number(rawStore);
    if (storeId !== null && (!Number.isInteger(storeId) || storeId <= 0)) {
      throw new ApiError(400, 'storeId: требуется целое положительное число');
    }
    res.json(await orderReport(date, storeId));
  })
);
