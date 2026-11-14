/**
 * Показатели торговой точки для её внутренней страницы: заказы, оборот,
 * динамика по месяцам, топ продукции и сотрудники.
 *
 * Суммы считаются по тому же правилу, что и отчёт Otpremnica: цена фасовки —
 * за кг/л/шт, масса и объём переводятся из базовых единиц (г/мл) в тысячи.
 * PDV — 20%.
 */
import { pool } from '../db';
import { deliveryWindows } from './order-window';

export const VAT_RATE = 20;

export interface StoreStats {
  orders: {
    total: number;
    last30: number;
    last90: number;
    firstDate: string | null;
    lastDate: string | null;
  };
  revenue: {
    net: number;
    vat: number;
    gross: number;
    last30Net: number;
    avgNet: number;
  };
  nextDelivery: { date: string; open: boolean; hasOrder: boolean } | null;
  monthly: { month: string; orders: number; net: number }[];
  topProducts: { name: string; nameSr: string; packages: number; net: number }[];
  recentOrders: {
    id: number;
    deliveryDate: string;
    positions: number;
    packages: number;
    weightG: number;
    net: number;
  }[];
  users: { login: string; name: string; active: boolean; lastLogin: string | null }[];
}

/** Сумма заказа в деньгах: та же формула, что в отчёте-отгрузке. */
const LINE_NET = `case u.dimension
                    when 'count' then i.qty * pk.qty_base
                    else i.qty * pk.qty_base / 1000.0
                  end * pk.price`;

const round2 = (value: unknown): number => Math.round(Number(value ?? 0) * 100) / 100;

export async function storeStats(storeId: number): Promise<StoreStats> {
  const [totals, monthly, top, recent, users, windows] = await Promise.all([
    pool.query<{
      total: number;
      last30: number;
      last90: number;
      firstDate: string | null;
      lastDate: string | null;
      net: number;
      net30: number;
    }>(
      `with line as (
         select o.delivery_date, sum(${LINE_NET}) as net
           from store_orders o
           join store_order_items i on i.order_id = o.id
           join product_packagings pk on pk.id = i.packaging_id
           join tech_cards tc on tc.id = pk.card_id
           join units u on u.id = tc.portion_unit_id
          where o.store_id = $1
          group by o.delivery_date
       )
       select count(*)::int as total,
              count(*) filter (where delivery_date between current_date - 30 and current_date)::int as last30,
              count(*) filter (where delivery_date between current_date - 90 and current_date)::int as last90,
              to_char(min(delivery_date), 'YYYY-MM-DD') as "firstDate",
              to_char(max(delivery_date), 'YYYY-MM-DD') as "lastDate",
              coalesce(sum(net), 0)::float8 as net,
              coalesce(sum(net) filter (where delivery_date between current_date - 30 and current_date), 0)::float8 as net30
         from line`,
      [storeId]
    ),
    pool.query<{ month: string; orders: number; net: number }>(
      `with line as (
         select o.delivery_date, sum(${LINE_NET}) as net
           from store_orders o
           join store_order_items i on i.order_id = o.id
           join product_packagings pk on pk.id = i.packaging_id
           join tech_cards tc on tc.id = pk.card_id
           join units u on u.id = tc.portion_unit_id
          where o.store_id = $1
          group by o.delivery_date
       ), by_month as (
         select to_char(date_trunc('month', delivery_date), 'YYYY-MM') as month,
                count(*)::int as orders, sum(net) as net
           from line
          group by 1
       )
       select to_char(g, 'YYYY-MM') as month,
              coalesce(by_month.orders, 0)::int as orders,
              coalesce(by_month.net, 0)::float8 as net
         from generate_series(date_trunc('month', current_date) - interval '11 months',
                              date_trunc('month', current_date), interval '1 month') g
         left join by_month on by_month.month = to_char(g, 'YYYY-MM')
        order by g`,
      [storeId]
    ),
    pool.query<{ name: string; nameSr: string; packages: number; net: number }>(
      `select tc.name, coalesce(tc.name_sr, '') as "nameSr",
              sum(i.qty)::int as packages,
              sum(${LINE_NET})::float8 as net
         from store_orders o
         join store_order_items i on i.order_id = o.id
         join product_packagings pk on pk.id = i.packaging_id
         join tech_cards tc on tc.id = pk.card_id
         join units u on u.id = tc.portion_unit_id
        where o.store_id = $1
        group by tc.id, tc.name, tc.name_sr
        order by net desc, tc.name
        limit 5`,
      [storeId]
    ),
    pool.query<{
      id: number;
      deliveryDate: string;
      positions: number;
      packages: number;
      weightG: number;
      net: number;
    }>(
      `with line as (
         select o.id, o.delivery_date,
                sum(i.qty)::int as packages,
                count(*)::int as positions,
                sum(case when u.dimension = 'mass' then i.qty * pk.qty_base else 0 end)::float8 as weight_g,
                sum(${LINE_NET}) as net
           from store_orders o
           join store_order_items i on i.order_id = o.id
           join product_packagings pk on pk.id = i.packaging_id
           join tech_cards tc on tc.id = pk.card_id
           join units u on u.id = tc.portion_unit_id
          where o.store_id = $1
          group by o.id, o.delivery_date
       )
       select id, to_char(delivery_date, 'YYYY-MM-DD') as "deliveryDate",
              packages, positions, weight_g as "weightG", net::float8 as net
         from line
        order by delivery_date desc
        limit 8`,
      [storeId]
    ),
    pool.query<{ login: string; name: string; active: boolean; lastLogin: string | null }>(
      `select login,
              coalesce(nullif(btrim(full_name), ''), login) as name,
              active,
              to_char(last_login_at, 'YYYY-MM-DD HH24:MI') as "lastLogin"
         from users
        where store_id = $1
        order by login`,
      [storeId]
    ),
    deliveryWindows(),
  ]);

  const t = totals.rows[0];
  const total = Number(t?.total ?? 0);
  const net = round2(t?.net);
  const next = windows.windows.find((window) => window.date >= windows.today) ?? null;
  const { rows: nextOrder } = next
    ? await pool.query('select 1 from store_orders where store_id = $1 and delivery_date = $2', [
        storeId,
        next.date,
      ])
    : { rows: [] };

  return {
    orders: {
      total,
      last30: Number(t?.last30 ?? 0),
      last90: Number(t?.last90 ?? 0),
      firstDate: t?.firstDate ?? null,
      lastDate: t?.lastDate ?? null,
    },
    revenue: {
      net,
      vat: round2((net * VAT_RATE) / 100),
      gross: round2(net + (net * VAT_RATE) / 100),
      last30Net: round2(t?.net30),
      avgNet: total ? round2(net / total) : 0,
    },
    nextDelivery: next
      ? { date: next.date, open: next.open, hasOrder: nextOrder.length > 0 }
      : null,
    monthly: monthly.rows.map((row) => ({
      month: row.month,
      orders: Number(row.orders),
      net: round2(row.net),
    })),
    topProducts: top.rows.map((row) => ({
      name: row.name,
      nameSr: row.nameSr,
      packages: Number(row.packages),
      net: round2(row.net),
    })),
    recentOrders: recent.rows.map((row) => ({
      id: Number(row.id),
      deliveryDate: row.deliveryDate,
      positions: Number(row.positions),
      packages: Number(row.packages),
      weightG: Number(row.weightG ?? 0),
      net: round2(row.net),
    })),
    users: users.rows.map((row) => ({
      login: row.login,
      name: row.name,
      active: Boolean(row.active),
      lastLogin: row.lastLogin ?? null,
    })),
  };
}
