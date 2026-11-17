/**
 * Отчёт-отгрузка (Otpremnica) по сохранённым заказам магазинов за дату доставки.
 * Цена фасовки хранится за выбранную базу: кг/л/шт, порцию (упаковку) или штуку; PDV — 20%.
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
  /** id фасовки — стабильный ключ строки для ручного порядка (в печать не выводится). */
  packagingId: number;
  name: string;
  /** Единица количества в документе: кг/л/шт или порция — как задана база цены в фасовке. */
  unit: 'kg' | 'l' | 'kom' | 'porcija';
  qty: number;
  price: number;
  vatRate: number;
  net: number;
  vat: number;
  gross: number;
}

export interface ReportDoc {
  /** id заказа магазина — по нему сохраняется ручной порядок строк. */
  orderId: number;
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
  /** По какой цене построен документ: продажная или себестоимость. */
  priceMode: ReportPriceMode;
}

/** Цена в документе: продажная (как в каталоге) или себестоимость из техкарты. */
export type ReportPriceMode = 'sale' | 'cost';

interface ReportRow {
  orderId: number;
  packagingId: number;
  /** Сквозной номер отчёта из последовательности; null — старый заказ до введения нумерации. */
  docNo: string | null;
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
  cost: number;
  priceBasis: 'unit' | 'portion' | 'piece';
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

/**
 * Количество в единицах, за которые указана цена фасовки:
 * кг/л (unit, вес/объём), порции (portion, упаковки), штуки (piece).
 * Для штучной продукции цена за штуку — это количество штук в упаковках;
 * для весовой «за штуку» считаем одну упаковку одной штукой.
 */
function quantityOf(r: ReportRow): { unit: ReportLine['unit']; qty: number } {
  if (r.priceBasis === 'portion') {
    return { unit: 'porcija', qty: r.qty };
  }
  if (r.priceBasis === 'piece') {
    return { unit: 'kom', qty: r.dimension === 'count' ? r.qty * r.qtyBase : r.qty };
  }
  return {
    unit: unitOf(r.dimension),
    qty: r.dimension === 'count' ? r.qty * r.qtyBase : (r.qty * r.qtyBase) / 1000,
  };
}

export async function orderReport(
  deliveryDate: string,
  storeId: number | null,
  priceMode: ReportPriceMode = 'sale'
): Promise<{ documents: ReportDoc[] }> {
  const { rows } = await pool.query<ReportRow>(
    `select o.id as "orderId",
            o.doc_no as "docNo",
            i.packaging_id as "packagingId",
            to_char(o.delivery_date, 'YYYY-MM-DD') as "deliveryDate",
            o.updated_at as "savedAt",
            s.id as "storeId", s.code as "storeCode", s.name as "storeName",
            s.address as "storeAddress", s.pib as "storePib",
            s.mbr as "storeMbr", s.account_no as "storeAccount",
            tc.name as "cardName", tc.name_sr as "cardNameSr",
            i.qty, pk.qty_base::float8 as "qtyBase", pk.price::float8 as price, pk.cost::float8 as cost,
            pk.price_basis as "priceBasis", u.dimension
       from store_orders o
       join stores s on s.id = o.store_id
       join store_order_items i on i.order_id = o.id
       join product_packagings pk on pk.id = i.packaging_id
       join tech_cards tc on tc.id = pk.card_id
       join units u on u.id = tc.portion_unit_id
      where o.delivery_date = $1::date
        and ($2::int is null or o.store_id = $2)
      order by s.code,
               coalesce(array_position(o.line_order, i.packaging_id), 2147483647),
               tc.name_sr nulls last, tc.name, pk.qty_base, i.qty`,
    [deliveryDate, storeId]
  );

  const docs = new Map<number, ReportDoc>();
  for (const r of rows) {
    let doc = docs.get(r.orderId);
    if (!doc) {
      doc = {
        orderId: r.orderId,
        // С сегодняшнего дня — сквозной номер 2026-843, 2026-844…;
        // у старых заказов без номера остаётся прежний вид год-id.
        number: `${r.deliveryDate.slice(0, 4)}-${r.docNo ?? r.orderId}`,
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
        priceMode,
      };
      docs.set(r.orderId, doc);
    }
    const { unit, qty } = quantityOf(r);
    const price = priceMode === 'cost' ? r.cost : r.price;
    const net = round2(qty * price);
    const vat = round2((net * VAT_RATE) / 100);
    doc.lines.push({
      packagingId: r.packagingId,
      name: r.cardNameSr || r.cardName,
      unit,
      qty,
      price,
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
