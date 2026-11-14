/**
 * API магазинного сотрудника: он видит только свою точку.
 *
 *   GET /api/store — карточка своей точки (только просмотр: данные заполняет офис)
 *   GET /api/store/order-catalog — продукция производства для оформления заказа
 *   GET /api/store/orders/current — выбранный заказ (?date=YYYY-MM-DD) и окно приёма
 *   PUT /api/store/orders/current — сохранить/изменить заказ до срока приёма
 *   GET /api/store/orders/archive — история заказов своей точки по датам доставки
 */
import { Router } from 'express';
import { pool, tx } from '../db';
import { ApiError, wrap } from '../http';
import { audit } from '../services/audit';
import { requireStore } from '../services/auth';
import { orderArchive } from '../services/order-archive';
import { deliveryWindows } from '../services/order-window';
import { packagingLabel, packagingWeight } from '../services/packagings';

export const storeRouter = Router();

const CARD_SQL = `
  select s.id, s.code, s.name, s.active, s.position,
         s.address, s.phone, s.email,
         s.contact_person as "contactPerson",
         s.opening_hours as "openingHours",
         s.pib, s.mbr, s.account_no as "accountNo", s.note
    from stores s where s.id = $1 and s.deleted_at is null`;

storeRouter.get(
  '/',
  requireStore,
  wrap(async (req, res) => {
    const storeId = req.user?.storeId as number;
    const { rows } = await pool.query(CARD_SQL, [storeId]);
    if (!rows.length) throw new ApiError(404, 'Магазин не найден');
    res.json(rows[0]);
  })
);

/**
 * Продукция производства для формы заказа магазина: по строке на фасовку
 * (название техкарты + фасовка, вес упаковки, минимальный заказ), каталог.
 */
storeRouter.get(
  '/order-catalog',
  requireStore,
  wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      select pk.id, tc.id as "cardId", tc.name as "cardName",
             tc.name_en as "cardNameEn", tc.name_sr as "cardNameSr", tc.note,
             pk.qty_base::float8 as "qtyBase", pk.min_order as "minOrder",
             pu.code as "unitCode",
             tc.catalog_id as "catalogId", cc.name as "catalogName",
             cc.icon as "catalogIcon", cc.color as "catalogColor"
        from product_packagings pk
        join tech_cards tc on tc.id = pk.card_id
        join units pu on pu.id = tc.portion_unit_id
        left join product_catalogs cc on cc.id = tc.catalog_id
       where pk.available
       order by cc.position nulls last, cc.name nulls last, tc.name, pk.qty_base`);
    res.json(
      rows.map(({ cardName, cardNameEn, cardNameSr, packagingName, qtyBase, unitCode, ...rest }) => {
        const packaging = packagingWeight(qtyBase, unitCode);
        return {
          ...rest,
          qtyBase,
          unitCode,
          name: packagingLabel(cardName, packaging),
          nameEn: cardNameEn ? packagingLabel(cardNameEn, packaging) : '',
          nameSr: cardNameSr ? packagingLabel(cardNameSr, packaging) : '',
        };
      })
    );
  })
);

/** Заказ точки на конкретную дату доставки; null — заказа ещё нет. */
interface StoreOrderPayload {
  id: number;
  deliveryDate: string;
  comment: string;
  updatedAt: string;
  items: { packagingId: number; qty: number }[];
}

async function loadStoreOrder(storeId: number, deliveryDate: string): Promise<StoreOrderPayload | null> {
  const { rows } = await pool.query<StoreOrderPayload>(
    `select o.id, to_char(o.delivery_date, 'YYYY-MM-DD') as "deliveryDate", o.comment,
            o.updated_at as "updatedAt",
            coalesce(json_agg(json_build_object('packagingId', i.packaging_id, 'qty', i.qty)
                              order by i.packaging_id)
                     filter (where i.packaging_id is not null), '[]') as items
       from store_orders o
       left join store_order_items i on i.order_id = o.id
      where o.store_id = $1 and o.delivery_date = $2
      group by o.id`,
    [storeId, deliveryDate]
  );
  return rows[0] ?? null;
}

/** Позиции заказа из запроса: фасовка и целое количество упаковок 1…999. */
function orderItemsInput(value: unknown): { packagingId: number; qty: number }[] {
  if (!Array.isArray(value) || !value.length || value.length > 500) {
    throw new ApiError(400, 'Поле «items»: нужен непустой список позиций');
  }
  const seen = new Set<number>();
  return value.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const packagingId = Number(item.packagingId);
    const qty = Number(item.qty);
    if (!Number.isInteger(packagingId) || packagingId <= 0) {
      throw new ApiError(400, 'Поле «packagingId»: нужен id фасовки');
    }
    if (seen.has(packagingId)) throw new ApiError(400, 'Позиция повторяется в заказе');
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      throw new ApiError(400, 'Количество: целое число упаковок от 1 до 999');
    }
    seen.add(packagingId);
    return { packagingId, qty };
  });
}

/** Заказ на выбранную дату доставки; без ?date= — на ближайшую с открытым приёмом. */
storeRouter.get(
  '/orders/current',
  requireStore,
  wrap(async (req, res) => {
    const storeId = req.user?.storeId as number;
    const requested = String(req.query['date'] ?? '').trim();
    const { today, cutoffHours, windows } = await deliveryWindows();
    const target = requested
      ? windows.find((window) => window.date === requested)
      : windows.find((window) => window.open);
    if (requested && !target) throw new ApiError(404, 'На выбранную дату доставки нет');
    const order = target ? await loadStoreOrder(storeId, target.date) : null;
    res.json({
      today,
      cutoffHours,
      deliveryDate: target?.date ?? null,
      deadline: target?.deadline ?? null,
      order,
    });
  })
);

/** История заказов своей точки: только чтение, свежие даты доставки первыми. */
storeRouter.get(
  '/orders/archive',
  requireStore,
  wrap(async (req, res) => {
    const storeId = req.user?.storeId as number;
    res.json(await orderArchive(storeId));
  })
);

/**
 * Сохранить заказ на выбранную дату. До срока приёма заказ можно менять
 * сколько угодно раз: заказ обновляется на месте, состав позиций заменяется целиком.
 */
storeRouter.put(
  '/orders/current',
  requireStore,
  wrap(async (req, res) => {
    const storeId = req.user?.storeId as number;
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const deliveryDate = String(raw.deliveryDate ?? '');
    const comment = String(raw.comment ?? '').trim().slice(0, 1000);
    const items = orderItemsInput(raw.items);

    const { today, cutoffHours, windows } = await deliveryWindows();
    const target = windows.find((window) => window.date === deliveryDate);
    if (!target) throw new ApiError(409, 'На выбранную дату доставки нет');
    if (!target.open) throw new ApiError(409, 'Срок приёма заказа на эту дату закрыт');

    const ids = items.map((item) => item.packagingId);
    const { rows: available } = await pool.query<{ id: number }>(
      'select id from product_packagings where available and id = any ($1::int[])',
      [ids]
    );
    if (available.length !== ids.length) {
      throw new ApiError(400, 'Часть позиций больше не доступна для заказа');
    }

    const { rows: existing } = await pool.query(
      'select 1 from store_orders where store_id = $1 and delivery_date = $2',
      [storeId, deliveryDate]
    );
    const orderId = await tx(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `insert into store_orders (store_id, delivery_date, comment, created_by, updated_by)
         values ($1, $2, $3, $4, $4)
         on conflict (store_id, delivery_date) do update
           set comment = excluded.comment, updated_at = now(), updated_by = excluded.updated_by
         returning id`,
        [storeId, deliveryDate, comment, req.user?.id ?? null]
      );
      const id = rows[0].id;
      await client.query('delete from store_order_items where order_id = $1', [id]);
      for (const item of items) {
        await client.query(
          'insert into store_order_items (order_id, packaging_id, qty) values ($1, $2, $3)',
          [id, item.packagingId, item.qty]
        );
      }
      return id;
    });

    await audit(req.user, {
      action: existing.length ? 'update' : 'create',
      entity: 'store_order',
      entityId: orderId,
      title: `Заказ магазина на ${deliveryDate}`,
      details: {
        deliveryDate,
        positions: items.length,
        packages: items.reduce((sum, item) => sum + item.qty, 0),
      },
    });

    res.json({
      today,
      cutoffHours,
      deliveryDate,
      deadline: target.deadline,
      order: await loadStoreOrder(storeId, deliveryDate),
    });
  })
);
