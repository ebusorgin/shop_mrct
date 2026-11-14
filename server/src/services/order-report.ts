/**
 * Отчёт-отгрузка (Otpremnica) по сохранённым заказам магазинов за дату доставки.
 * Цена фасовки хранится за единицу измерения (кг / л / шт), PDV — 20%.
 * storeId = null — документы по всем магазинам, у которых есть заказ на дату.
 */
import { pool } from '../db';

export const VAT_RATE = 20;

/** Реквизиты поставщика — из печатного образца Otpremnica. */
const SUPPLIER = {
  name: 'Mix Markt Gastro',
  address: '11070 Beograd (Novi Beograd) Bulevar Arsenija Carnojevica 30A st. 1VP',
  pib: '114917301',
  mbr: '22090808',
  account: '170-003007091300003',
};

export interface ReportLine {
  name: string;
  unit: 'kg' | 'l' | 'kom';
  qty: number;
  price: number;
  vatRate: number;
  net: number;
  vat: number;
  gross: number;
}

export interface ReportDoc {
  number: string;
  deliveryDate: string;
  /** Момент сохранения заказа — время в шапке документа. */
  savedAt: string;
  supplier: typeof SUPPLIER;
  buyer: { name: string; address: string; pib: string; mbr: string; account: string };
  lines: ReportLine[];
  net: number;
  vat: number;
  gross: number;
}

interface ReportRow {
  orderId: number;
  deliveryDate: string;
  savedAt: string;
  storeId: number;
  storeCode: string;
  storeName: string;
  storeAddress: string;
  storePib: string;
  storeMbr: string;
  storeAccount: string;
  cardName: string;
  cardNameSr: string;
  qty: number;
  qtyBase: number;
  price: number;
  dimension: 'mass' | 'volume' | 'count';
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function unitOf(dimension: ReportRow['dimension']): ReportLine['unit'] {
  if (dimension === 'mass') return 'kg';
  if (dimension === 'volume') return 'l';
  return 'kom';
}

export async function orderReport(
  deliveryDate: string,
  storeId: number | null
): Promise<{ documents: ReportDoc[] }> {
  const { rows } = await pool.query<ReportRow>(
    `select o.id as "orderId",
            to_char(o.delivery_date, 'YYYY-MM-DD') as "deliveryDate",
            o.updated_at as "savedAt",
            s.id as "storeId", s.code as "storeCode", s.name as "storeName",
            s.address as "storeAddress", s.pib as "storePib",
            s.mbr as "storeMbr", s.account_no as "storeAccount",
            tc.name as "cardName", tc.name_sr as "cardNameSr",
            i.qty, pk.qty_base::float8 as "qtyBase", pk.price::float8 as price,
            u.dimension
       from store_orders o
       join stores s on s.id = o.store_id
       join store_order_items i on i.order_id = o.id
       join product_packagings pk on pk.id = i.packaging_id
       join tech_cards tc on tc.id = pk.card_id
       join units u on u.id = tc.portion_unit_id
      where o.delivery_date = $1::date
        and ($2::int is null or o.store_id = $2)
      order by s.code, tc.name_sr nulls last, tc.name, pk.qty_base, i.qty`,
    [deliveryDate, storeId]
  );

  const docs = new Map<number, ReportDoc>();
  for (const r of rows) {
    let doc = docs.get(r.orderId);
    if (!doc) {
      doc = {
        number: `${r.deliveryDate.slice(0, 4)}-${r.orderId}`,
        deliveryDate: r.deliveryDate,
        savedAt: r.savedAt,
        supplier: SUPPLIER,
        buyer: {
          name: r.storeName,
          address: r.storeAddress,
          pib: r.storePib,
          mbr: r.storeMbr,
          account: r.storeAccount,
        },
        lines: [],
        net: 0,
        vat: 0,
        gross: 0,
      };
      docs.set(r.orderId, doc);
    }
    const unit = unitOf(r.dimension);
    const qty = r.dimension === 'count' ? r.qty * r.qtyBase : (r.qty * r.qtyBase) / 1000;
    const net = round2(qty * r.price);
    const vat = round2((net * VAT_RATE) / 100);
    doc.lines.push({
      name: r.cardNameSr || r.cardName,
      unit,
      qty,
      price: r.price,
      vatRate: VAT_RATE,
      net,
      vat,
      gross: round2(net + vat),
    });
    doc.net = round2(doc.net + net);
    doc.vat = round2(doc.vat + vat);
    doc.gross = round2(doc.gross + net + vat);
  }

  return { documents: [...docs.values()] };
}
