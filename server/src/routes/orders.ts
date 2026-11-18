/**
 * Архив заказов магазинов для офиса.
 *
 *   GET /api/orders/archive — все сохранённые заказы с составом и итогами,
 *                             свежие даты доставки первыми.
 */
import { Router } from 'express';
import { pool } from '../db';
import { ApiError, wrap } from '../http';
import { audit } from '../services/audit';
import { orderArchive } from '../services/order-archive';
import { orderReport, VAT_RATE } from '../services/order-report';
import {
  deliveryWriteoffPreview,
  deliveryWriteoffStatus,
  postDeliveryWriteoff,
} from '../services/delivery-writeoff';

export const ordersRouter = Router();

ordersRouter.get(
  '/archive',
  wrap(async (_req, res) => {
    res.json(await orderArchive(null));
  })
);

/** Предпросмотр отчёта-отгрузки: ?date=YYYY-MM-DD&storeId=&price=sale|cost (без storeId — все магазины). */
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
    const rawPrice = req.query.price;
    if (rawPrice !== undefined && rawPrice !== 'sale' && rawPrice !== 'cost') {
      throw new ApiError(400, 'price: ожидается sale или cost');
    }
    const rawVat = req.query.vat;
    let vatRate = VAT_RATE;
    if (rawVat !== undefined && rawVat !== '') {
      const n = Number(rawVat);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new ApiError(400, 'vat: ожидается число 0…100');
      vatRate = n;
    }
    res.json(await orderReport(date, storeId, rawPrice === 'cost' ? 'cost' : 'sale', vatRate));
  })
);

/**
 * PUT /api/orders/report/order — сохранить ручной порядок строк документа.
 * Body: { orderId, packagingIds: number[] } — id фасовок в новом порядке.
 * Порядок живёт у заказа (магазин + дата доставки) и не влияет на другие отчёты.
 */
ordersRouter.put(
  '/report/order',
  wrap(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const orderId = Number(raw.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      throw new ApiError(400, 'orderId: требуется целое положительное число');
    }
    if (!Array.isArray(raw.packagingIds)) {
      throw new ApiError(400, 'packagingIds: требуется массив id фасовок');
    }
    const ids = raw.packagingIds.map((id) => Number(id));
    if (
      !ids.length ||
      ids.length > 1000 ||
      ids.some((id) => !Number.isInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length
    ) {
      throw new ApiError(400, 'packagingIds: ожидается непустой список уникальных id');
    }

    const { rows: existing } = await pool.query<{ id: number }>(
      'select packaging_id as id from store_order_items where order_id = $1 order by packaging_id',
      [orderId]
    );
    if (!existing.length) throw new ApiError(404, 'Заказ не найден');

    const actual = new Set(existing.map((r) => r.id));
    const wanted = ids.filter((id) => actual.has(id));
    const seen = new Set(wanted);
    // Позиции, которых не было в присланном списке (заказ успели изменить),
    // дописываем в конец, чтобы они не пропали из документа.
    const final = [...wanted, ...existing.map((r) => r.id).filter((id) => !seen.has(id))];

    await pool.query('update store_orders set line_order = $2::int[] where id = $1', [orderId, final]);
    await audit(req.user, {
      action: 'update',
      entity: 'store_order',
      entityId: orderId,
      title: 'Порядок позиций отчёта-отгрузки',
      details: { positions: final.length },
    });
    res.json({ ok: true, packagingIds: final });
  })
);

// ---------- Ручное списание склада по доставке ----------
// Пока только по кнопке (автоматику не включаем): офис открывает дату доставки,
// видит предпросмотр сырья по техкартам и подтверждает списание.

function writeoffDate(value: unknown): string {
  const date = typeof value === 'string' ? value : '';
  return date;
}

function writeoffStore(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'storeId: требуется целое положительное число');
  return n;
}

/** Списания на дату: бейдж «уже списано» в архиве. */
ordersRouter.get(
  '/delivery-writeoff/status',
  wrap(async (req, res) => {
    res.json(await deliveryWriteoffStatus(writeoffDate(req.query.date)));
  })
);

/** Что уйдёт со склада по заказам даты: строки сырья и стоимость по средней. */
ordersRouter.get(
  '/delivery-writeoff/preview',
  wrap(async (req, res) => {
    res.json(await deliveryWriteoffPreview(writeoffDate(req.query.date), writeoffStore(req.query.storeId)));
  })
);

/** Подтверждение: движения writeoff по средней себестоимости. Повтор на дату/магазин запрещён. */
ordersRouter.post(
  '/delivery-writeoff',
  wrap(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const result = await postDeliveryWriteoff(
      writeoffDate(raw.date),
      writeoffStore(raw.storeId),
      req.user,
      typeof raw.note === 'string' ? raw.note.slice(0, 500) : ''
    );
    res.status(201).json(result);
  })
);
