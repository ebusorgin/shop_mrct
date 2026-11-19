/**
 * Сохранённые заказы магазинов с составом и итогами — общий источник для
 * офисного архива и истории заказов магазина. storeId = null — все магазины.
 * В ответе также будущие даты доставки: по ним календарь показывает дни,
 * на которые заказа ещё нет.
 */
import { pool } from '../db';
import { deliveryWindows } from './order-window';
import { freezeOrderPrices } from './order-price-snapshot';
import { reportQuantity, type Dimension, type PriceBasis, type ReportUnit } from './order-report';

/** Будущая дата доставки: open — приём заказа ещё не закрыт. */
export interface UpcomingDelivery {
  date: string;
  open: boolean;
}

/** Позиция заказа с количеством в единицах отчёта-отгрузки. */
interface ArchiveItem {
  packagingId: number;
  qty: number;
  qtyBase: number;
  priceBasis: PriceBasis;
  dimension: Dimension;
  /** Количество и единица ровно как в строке Otpremnica: кг/л/шт/порц. */
  reportQty: number;
  reportUnit: ReportUnit;
}

interface ArchiveOrderRow {
  items: ArchiveItem[];
  [key: string]: unknown;
}

export interface OrderArchivePayload {
  today: string;
  orders: unknown[];
  upcoming: UpcomingDelivery[];
}

export async function orderArchive(storeId: number | null): Promise<OrderArchivePayload> {
  await freezeOrderPrices();
  const [{ rows: orders }, windows] = await Promise.all([
    pool.query<ArchiveOrderRow>(
      `select o.id,
              to_char(o.delivery_date, 'YYYY-MM-DD') as "deliveryDate",
              o.store_id as "storeId", s.code as "storeCode", s.name as "storeName",
              o.comment,
              o.created_at as "createdAt", o.updated_at as "updatedAt",
              coalesce(sum(i.qty), 0)::int as packages,
              count(i.packaging_id)::int as positions,
              coalesce(sum(case when u.code = 'г' then i.qty * pk.qty_base else 0 end), 0)::float8 as "weightG",
              coalesce(json_agg(json_build_object(
                         'packagingId', i.packaging_id,
                         'qty', i.qty,
                         'cardName', coalesce(pk.title, tc.name),
                         'cardNameEn', coalesce(pk.title_en, tc.name_en),
                         'cardNameSr', coalesce(pk.title_sr, tc.name_sr),
                         'packagingName', pk.name,
                         'qtyBase', pk.qty_base::float8,
                         'unitCode', u.code,
                         'priceBasis', coalesce(i.basis_snapshot, pk.price_basis),
                         'dimension', u.dimension
                       ) order by coalesce(pk.title, tc.name), pk.qty_base)
                       filter (where i.packaging_id is not null), '[]') as items
         from store_orders o
         join stores s on s.id = o.store_id
         left join store_order_items i on i.order_id = o.id
         left join prod_packagings pk on pk.id = i.packaging_id
         left join prod_nodes tc on tc.id = pk.node_id
         left join units u on u.id = tc.unit_id
        where $1::int is null or o.store_id = $1
        group by o.id, s.code, s.name
        order by o.delivery_date desc, s.code`,
      [storeId]
    ),
    deliveryWindows(),
  ]);
  return {
    today: windows.today,
    // Единицы показа — те же, что в документе: база цены фасовки.
    orders: orders.map((order) => ({
      ...order,
      items: order.items.map((item) => {
        const { unit, qty } = reportQuantity(item.qty, item.qtyBase, item.priceBasis, item.dimension);
        return { ...item, reportQty: qty, reportUnit: unit };
      }),
    })),
    upcoming: windows.windows.map(({ date, open }) => ({ date, open })),
  };
}
