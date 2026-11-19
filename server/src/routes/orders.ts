/**
 * Архив заказов магазинов для офиса.
 *
 *   GET /api/orders/archive — все сохранённые заказы с составом и итогами,
 *                             свежие даты доставки первыми.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { ZipArchive } from 'archiver';
import { pool } from '../db';
import { ApiError, wrap } from '../http';
import { audit } from '../services/audit';
import { orderArchive } from '../services/order-archive';
import { orderReport, VAT_RATE } from '../services/order-report';
import { createReportPdf } from '../services/order-report-pdf';
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

/** Общие параметры отчёта: дата, магазин, база цены и ставка PDV. */
function parseReportQuery(req: Request): {
  date: string;
  storeId: number | null;
  priceMode: 'sale' | 'cost';
  vatRate: number;
} {
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
  return { date, storeId, priceMode: rawPrice === 'cost' ? 'cost' : 'sale', vatRate };
}

/** Предпросмотр отчёта-отгрузки: ?date=YYYY-MM-DD&storeId=&price=sale|cost (без storeId — все магазины). */
ordersRouter.get(
  '/report',
  wrap(async (req, res) => {
    const { date, storeId, priceMode, vatRate } = parseReportQuery(req);
    res.json(await orderReport(date, storeId, priceMode, vatRate));
  })
);

/**
 * GET /api/orders/report/pdf — документы даты в PDF.
 * Один документ отдаётся как PDF; несколько — zip-архивом по файлу на магазин.
 * Параметры те же, что у отчёта.
 */
ordersRouter.get(
  '/report/pdf',
  wrap(async (req, res) => {
    const { date, storeId, priceMode, vatRate } = parseReportQuery(req);
    const { documents } = await orderReport(date, storeId, priceMode, vatRate);
    if (!documents.length) throw new ApiError(404, 'За эту дату нет документов');

    res.setHeader('Cache-Control', 'no-store');
    if (documents.length === 1) {
      // Единственный документ — прямо PDF, без лишней упаковки в архив.
      const doc = documents[0];
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Otpremnica-${doc.number}.pdf"`);
      const pdf = createReportPdf(doc);
      pdf.pipe(res);
      pdf.end();
      return;
    }

    const fileName = storeId == null ? `otpremnice-${date}.zip` : `otpremnica-${date}-store${storeId}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('warning', () => undefined);
    archive.on('error', (e: Error) => res.destroy(e));
    archive.pipe(res);
    for (const doc of documents) {
      const pdf = createReportPdf(doc);
      archive.append(pdf, { name: `Otpremnica-${doc.number}.pdf` });
      pdf.end();
    }
    await archive.finalize();
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

/**
 * GET /api/orders/price-snapshot?date=YYYY-MM-DD — состояние слепка цен и названий
 * строк заказов этой даты доставки.
 */
ordersRouter.get(
  '/price-snapshot',
  wrap(async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ApiError(400, 'date: требуется дата в формате YYYY-MM-DD');
    }
    const { rows } = await pool.query(
      `select count(i.packaging_id)::int as total,
              count(i.price_snapshot)::int as frozen,
              count(i.name_snapshot)::int as named,
              min(i.snapshot_at) as "frozenAt",
              (select o2.delivery_date <= current_date
                 from store_orders o2 where o2.delivery_date = $1::date limit 1) as past
         from store_order_items i
         join store_orders o on o.id = i.order_id
        where o.delivery_date = $1::date`,
      [date]
    );
    res.json({ date, ...rows[0] });
  })
);

/**
 * POST /api/orders/price-snapshot/refresh — переснять слепок даты по текущим ценам.
 * Body: { date }. Только для дат, которые уже наступили: история не пересчитывается
 * сама, переснимок — осознанное действие офиса.
 */
ordersRouter.post(
  '/price-snapshot/refresh',
  wrap(async (req, res) => {
    const date = typeof (req.body ?? {}).date === 'string' ? (req.body as { date: string }).date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new ApiError(400, 'date: требуется дата в формате YYYY-MM-DD');
    }
    const { rows: check } = await pool.query<{ past: boolean }>(
      'select $1::date <= current_date as past',
      [date]
    );
    if (!check[0]?.past) {
      throw new ApiError(409, 'Дата ещё не наступила — слепок снимется автоматически в 00:00');
    }
    const upd = await pool.query(
      `update store_order_items i
          set price_snapshot = pk.price,
              cost_snapshot  = pk.cost,
              basis_snapshot = pk.price_basis,
              name_snapshot  = coalesce(pk.title, tc.name),
              name_en_snapshot = coalesce(nullif(btrim(pk.title_en), ''), tc.name_en),
              name_sr_snapshot = coalesce(nullif(btrim(pk.title_sr), ''), tc.name_sr),
              qty_base_snapshot = pk.qty_base,
              dimension_snapshot = u.dimension,
              snapshot_at    = now()
         from store_orders o, prod_packagings pk
         join prod_nodes tc on tc.id = pk.node_id
         join units u on u.id = tc.unit_id
        where i.order_id = o.id
          and pk.id = i.packaging_id
          and o.delivery_date = $1::date`,
      [date]
    );
    await audit(req.user, {
      action: 'update',
      entity: 'store_order',
      title: `Слепок цен переснят на ${date}`,
      details: { rows: upd.rowCount ?? 0 },
    });
    res.json({ ok: true, rows: upd.rowCount ?? 0 });
  })
);

/**
 * PUT /api/orders/report/line — изменить количество позиции прямо в заказе.
 * Body: { orderId, packagingId, qty } — qty в упаковках (целое 1…999).
 * Офис правит ошибку магазина: строка заказа перезаписывается, отчёт
 * пересчитывается заново на клиенте.
 */
ordersRouter.put(
  '/report/line',
  wrap(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const orderId = Number(raw.orderId);
    const packagingId = Number(raw.packagingId);
    const qty = Number(raw.qty);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      throw new ApiError(400, 'orderId: требуется целое положительное число');
    }
    if (!Number.isInteger(packagingId) || packagingId <= 0) {
      throw new ApiError(400, 'packagingId: требуется целое положительное число');
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      throw new ApiError(400, 'qty: количество упаковок — целое число от 1 до 999');
    }

    const { rows: orderRows } = await pool.query<{ id: number; past: boolean }>(
      'select id, delivery_date < current_date as past from store_orders where id = $1',
      [orderId]
    );
    if (!orderRows.length) throw new ApiError(404, 'Заказ не найден');
    // Прошлые доставки — история: количество в них не меняется.
    if (orderRows[0].past) {
      throw new ApiError(409, 'Нельзя менять количество в прошлом заказе');
    }

    const upd = await pool.query(
      'update store_order_items set qty = $3 where order_id = $1 and packaging_id = $2',
      [orderId, packagingId, qty]
    );
    if (!upd.rowCount) throw new ApiError(404, 'Позиции нет в этом заказе');

    await pool.query(
      'update store_orders set updated_at = now(), updated_by = $2 where id = $1',
      [orderId, req.user?.id ?? null]
    );
    await audit(req.user, {
      action: 'update',
      entity: 'store_order',
      entityId: orderId,
      title: 'Количество позиции отчёта-отгрузки',
      details: { packagingId, qty },
    });
    res.json({ ok: true, orderId, packagingId, qty });
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
