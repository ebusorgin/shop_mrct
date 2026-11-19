/**
 * Показатели торговой точки для её внутренней страницы: заказы, оборот,
 * динамика по месяцам, графики по позициям и сотрудники.
 *
 * Суммы считаются по тому же правилу, что и отчёт Otpremnica: цена фасовки —
 * за кг/л/шт, масса и объём переводятся из базовых единиц (г/мл) в тысячи.
 * PDV — 20%.
 */
import { pool } from '../db';
import { deliveryWindows } from './order-window';

export const VAT_RATE = 20;

export interface StoreProductTrendPoint {
  date: string;
  value: number;
  net: number;
}

export interface StoreProductTrend {
  name: string;
  nameSr: string;
  orders: number;
  totalNet: number;
  lastValue: number;
  points: StoreProductTrendPoint[];
}

/**
 * Позиция рейтинга «Топ продукции».
 *
 * Индекс — взвешенная сумма четырёх сигналов (0–100):
 *   экономика 40 % — доля в выручке (RFM «M», ABC-класс),
 *   сложный рост 30 % — CAGR месячной выручки,
 *   частота 20 % — в скольких доставках встречается (проникновение),
 *   свежесть 10 % — давность последнего заказа (RFM «R»).
 */
export interface StoreTopProduct {
  name: string;
  nameSr: string;
  score: number;
  abc: 'A' | 'B' | 'C';
  net: number;
  sharePct: number;
  orders: number;
  packages: number;
  /** CAGR месячной выручки, %: (последний месяц / первый) ^ (1 / месяцев) − 1. */
  cagrPct: number;
  /** Последние 90 дней к предыдущим 90, % (null — в прошлом окне продаж не было). */
  momentumPct: number | null;
  lastDate: string | null;
  rfm: { r: number; f: number; m: number };
}

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
  topProducts: StoreTopProduct[];
  productTrends: StoreProductTrend[];
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

/** Сумма заказа в деньгах: та же формула, что в отчёте-отгрузке (с учётом базы цены фасовки). */
const LINE_NET = `case pk.price_basis
                    when 'portion' then i.qty
                    when 'piece' then case when u.dimension = 'count' then i.qty * pk.qty_base else i.qty end
                    else case u.dimension
                           when 'count' then i.qty * pk.qty_base
                           else i.qty * pk.qty_base / 1000.0
                         end
                  end * pk.price`;

const round2 = (value: unknown): number => Math.round(Number(value ?? 0) * 100) / 100;

interface ProductTrendLine {
  cardId: number;
  name: string;
  nameSr: string;
  deliveryDate: string;
  packages: number;
  net: number;
}

const DAY_MS = 86_400_000;
/** Номинальная годовая ставка для графика «выручка со сложным процентом». */
const COMPOUND_ANNUAL_RATE = 0.24;
const COMPOUND_DAILY_RATE = Math.pow(1 + COMPOUND_ANNUAL_RATE, 1 / 365) - 1;

function dayNumber(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS;
}

/**
 * По каждой позиции строим накопительную кривую: фактическая выручка дня
 * добавляется к балансу, а баланс между доставками растёт по сложному проценту.
 * Получается «выручка, если её реинвестировать» — наглядный график динамики.
 */
function buildProductTrends(lines: ProductTrendLine[]): StoreProductTrend[] {
  const products = new Map<
    number,
    { name: string; nameSr: string; byDate: Map<string, { packages: number; net: number }> }
  >();

  for (const line of lines) {
    let product = products.get(line.cardId);
    if (!product) {
      product = { name: line.name, nameSr: line.nameSr, byDate: new Map() };
      products.set(line.cardId, product);
    }
    const day = product.byDate.get(line.deliveryDate) ?? { packages: 0, net: 0 };
    day.packages += Number(line.packages) || 0;
    day.net += Number(line.net) || 0;
    product.byDate.set(line.deliveryDate, day);
  }

  return [...products.entries()]
    .map(([cardId, product]) => {
      const dates = [...product.byDate.keys()].sort();
      let balance = 0;
      let lastDay: number | null = null;
      let totalNet = 0;
      const points = dates.map((date) => {
        const day = dayNumber(date);
        if (lastDay !== null) {
          balance *= Math.pow(1 + COMPOUND_DAILY_RATE, day - lastDay);
        }
        lastDay = day;
        const net = product.byDate.get(date)?.net ?? 0;
        balance += net;
        totalNet += net;
        return { date, value: round2(balance), net: round2(net) };
      });

      return {
        cardId,
        name: product.name,
        nameSr: product.nameSr,
        orders: dates.length,
        totalNet: round2(totalNet),
        lastValue: points.length ? points[points.length - 1].value : 0,
        points,
      };
    })
    .sort((a, b) => b.lastValue - a.lastValue || a.name.localeCompare(b.name))
    .map(({ cardId: _cardId, ...trend }) => trend);
}

const TOP_MONTHS = 12;
const TOP_LIMIT = 10;
const TOP_WEIGHTS = { money: 0.4, growth: 0.3, frequency: 0.2, recency: 0.1 } as const;

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** Ключи последних `count` календарных месяцев включительно, по возрастанию. */
function lastMonths(count: number): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1))
      .toISOString()
      .slice(0, 7)
  );
}

/**
 * Рейтинг продукции: экономика (доля выручки, ABC), сложный рост (CAGR),
 * маркетинг (RFM: свежесть, частота, деньги). Считаем по последним 12 месяцам.
 */
function buildTopProducts(lines: ProductTrendLine[]): StoreTopProduct[] {
  if (!lines.length) return [];

  const months = lastMonths(TOP_MONTHS);
  const from = months[0];
  const to = months[months.length - 1];
  const todayNo = Math.floor(Date.now() / DAY_MS);
  const dayNo = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

  interface Acc {
    name: string;
    nameSr: string;
    monthly: Map<string, number>;
    net: number;
    packages: number;
    dates: Set<string>;
    lastDate: string;
    recent: number;
    previous: number;
  }

  const byCard = new Map<number, Acc>();
  const deliveries = new Set<string>();

  for (const line of lines) {
    const month = line.deliveryDate.slice(0, 7);
    if (month < from || month > to) continue;
    deliveries.add(line.deliveryDate);

    let card = byCard.get(line.cardId);
    if (!card) {
      card = {
        name: line.name,
        nameSr: line.nameSr,
        monthly: new Map(),
        net: 0,
        packages: 0,
        dates: new Set(),
        lastDate: line.deliveryDate,
        recent: 0,
        previous: 0,
      };
      byCard.set(line.cardId, card);
    }

    const net = Number(line.net) || 0;
    card.net += net;
    card.packages += Number(line.packages) || 0;
    card.dates.add(line.deliveryDate);
    if (line.deliveryDate > card.lastDate) card.lastDate = line.deliveryDate;
    card.monthly.set(month, (card.monthly.get(month) ?? 0) + net);

    const age = todayNo - dayNo(line.deliveryDate);
    if (age >= 0 && age < 90) card.recent += net;
    else if (age >= 90 && age < 180) card.previous += net;
  }

  const totalNet = [...byCard.values()].reduce((sum, card) => sum + card.net, 0) || 1;
  const totalDeliveries = deliveries.size || 1;

  const rows = [...byCard.values()]
    .filter((card) => card.net > 0)
    .map((card) => {
      const sharePct = (card.net / totalNet) * 100;
      const series = months.map((month) => card.monthly.get(month) ?? 0);
      const first = series.findIndex((value) => value > 0);
      let last = -1;
      for (let i = series.length - 1; i >= 0; i--) {
        if (series[i] > 0) {
          last = i;
          break;
        }
      }
      // сложный процент: среднегеометрический темп роста месячной выручки
      const cagr =
        first >= 0 && last > first ? Math.pow(series[last] / series[first], 1 / (last - first)) - 1 : 0;

      const freqRatio = card.dates.size / totalDeliveries;
      const ageDays = Math.max(0, todayNo - dayNo(card.lastDate));
      const r = ageDays <= 14 ? 5 : ageDays <= 30 ? 4 : ageDays <= 60 ? 3 : ageDays <= 120 ? 2 : 1;
      const f = freqRatio >= 0.75 ? 5 : freqRatio >= 0.5 ? 4 : freqRatio >= 0.3 ? 3 : freqRatio >= 0.15 ? 2 : 1;
      const m = sharePct >= 10 ? 5 : sharePct >= 5 ? 4 : sharePct >= 2 ? 3 : sharePct >= 1 ? 2 : 1;

      const momentumPct =
        card.previous > 0 ? ((card.recent - card.previous) / card.previous) * 100 : card.recent > 0 ? 100 : null;
      const growthNorm = (clamp(cagr, -0.15, 0.15) + 0.15) / 0.3;
      const score = Math.round(
        100 *
          (TOP_WEIGHTS.money * (m / 5) +
            TOP_WEIGHTS.growth * growthNorm +
            TOP_WEIGHTS.frequency * (f / 5) +
            TOP_WEIGHTS.recency * (r / 5))
      );

      return {
        name: card.name,
        nameSr: card.nameSr,
        score,
        abc: 'C' as StoreTopProduct['abc'],
        net: round2(card.net),
        sharePct: round2(sharePct),
        orders: card.dates.size,
        packages: card.packages,
        cagrPct: round2(cagr * 100),
        momentumPct: momentumPct === null ? null : round2(momentumPct),
        lastDate: card.lastDate,
        rfm: { r, f, m },
      };
    });

  // ABC по накопленной доле выручки: A — первые 80 %, B — до 95 %, остальные C.
  let cumulative = 0;
  for (const row of [...rows].sort((a, b) => b.net - a.net)) {
    cumulative += row.sharePct;
    row.abc = cumulative <= 80 ? 'A' : cumulative <= 95 ? 'B' : 'C';
  }

  return rows.sort((a, b) => b.score - a.score || b.net - a.net).slice(0, TOP_LIMIT);
}

export async function storeStats(storeId: number): Promise<StoreStats> {
  const [totals, monthly, trends, recent, users, windows] = await Promise.all([
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
           join prod_packagings pk on pk.id = i.packaging_id
           join prod_nodes tc on tc.id = pk.node_id
           join units u on u.id = tc.unit_id
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
           join prod_packagings pk on pk.id = i.packaging_id
           join prod_nodes tc on tc.id = pk.node_id
           join units u on u.id = tc.unit_id
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
    pool.query<ProductTrendLine>(
      `select tc.id::int as "cardId", tc.name, coalesce(tc.name_sr, '') as "nameSr",
              to_char(o.delivery_date, 'YYYY-MM-DD') as "deliveryDate",
              sum(i.qty)::int as packages,
              sum(${LINE_NET})::float8 as net
         from store_orders o
         join store_order_items i on i.order_id = o.id
         join prod_packagings pk on pk.id = i.packaging_id
         join prod_nodes tc on tc.id = pk.node_id
         join units u on u.id = tc.unit_id
        where o.store_id = $1
        group by tc.id, tc.name, tc.name_sr, o.delivery_date
        order by tc.id, o.delivery_date`,
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
           join prod_packagings pk on pk.id = i.packaging_id
           join prod_nodes tc on tc.id = pk.node_id
           join units u on u.id = tc.unit_id
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
    topProducts: buildTopProducts(trends.rows),
    productTrends: buildProductTrends(trends.rows),
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
