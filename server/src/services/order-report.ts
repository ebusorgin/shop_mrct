/**
 * Отчёт-отгрузка (Otpremnica) по сохранённым заказам магазинов за дату доставки.
 * Цена фасовки хранится за выбранную базу: кг/л/шт, порцию (упаковку) или штуку;
 * ставка PDV задаётся параметром отчёта (по умолчанию 20 %).
 * storeId = null — документы по всем магазинам, у которых есть заказ на дату.
 */
import { pool } from '../db';
import { ensureDeliveryDocNumbers } from './order-numbering';
import { freezeOrderSnapshots } from './order-price-snapshot';
import { sheetLineOrderForDate } from './google-sheet';

export const VAT_RATE = 20;

/** Реквизиты поставщика — из печатного образца Otpremnica. */
const SUPPLIER = {
  name: 'Mix Markt Gastro',
  address: '11070 Beograd (Novi Beograd) Bulevar Arsenija Carnojevica 30A st. 1VP',
  pib: '114917301',
  mbr: '22090808',
  account: '170-003007091300003',
};

/** Единица количества в документе: кг/л/шт или порция — как задана база цены в фасовке. */
export type ReportUnit = 'kg' | 'l' | 'kom' | 'porcija';

/** За что указана цена фасовки: кг/л/шт, порция (упаковка) или штука. */
export type PriceBasis = 'unit' | 'portion' | 'piece';

/** Размерность единицы техкарты. */
export type Dimension = 'mass' | 'volume' | 'count';

export interface ReportLine {
  /** id фасовки — стабильный ключ строки для ручного порядка (в печать не выводится). */
  packagingId: number;
  /** id рецептуры (узла карты производства) — для быстрого перехода в редактор. */
  nodeId: number;
  name: string;
  unit: ReportUnit;
  qty: number;
  /** Количество упаковок в заказе — то, что редактируется и хранится в строке заказа. */
  packQty: number;
  price: number;
  vatRate: number;
  net: number;
  vat: number;
  gross: number;
  /** Вес строки в кг (для объёма 1 л = 1 кг); 0 — для штучных без веса. */
  weightKg: number;
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
  /** Общий вес документа в кг. */
  weightKg: number;
  /** Ставка PDV, применённая к строкам документа, %. */
  vatRate: number;
  /** По какой цене построен документ: продажная или себестоимость. */
  priceMode: ReportPriceMode;
}

/** Цена в документе: продажная (как в каталоге) или себестоимость из техкарты. */
export type ReportPriceMode = 'sale' | 'cost';

interface ReportRow {
  orderId: number;
  packagingId: number;
  /** id рецептуры — строки отчёта ссылаются на карточку производства. */
  nodeId: number;
  /** Порядковый номер внутри года; null — старый заказ до введения нумерации. */
  docNo: string | null;
  /** Год номера; null у старых заказов без doc_no. */
  docYear: number | null;
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
  priceBasis: PriceBasis;
  dimension: Dimension;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function unitOf(dimension: Dimension): ReportUnit {
  if (dimension === 'mass') return 'kg';
  if (dimension === 'volume') return 'l';
  return 'kom';
}

/**
 * Количество в единицах, за которые указана цена фасовки:
 * кг/л (unit, вес/объём), порции (portion, упаковки), штуки (piece).
 * Для штучной продукции цена за штуку — это количество штук в упаковках;
 * для весовой «за штуку» считаем одну упаковку одной штукой.
 * Общий для отчёта-отгрузки и архива заказов: единицы на экране и в документе
 * должны совпадать.
 */
export function reportQuantity(
  qty: number,
  qtyBase: number,
  priceBasis: PriceBasis,
  dimension: Dimension
): { unit: ReportUnit; qty: number } {
  if (priceBasis === 'portion') {
    return { unit: 'porcija', qty };
  }
  if (priceBasis === 'piece') {
    return { unit: 'kom', qty: dimension === 'count' ? qty * qtyBase : qty };
  }
  return {
    unit: unitOf(dimension),
    qty: dimension === 'count' ? qty * qtyBase : (qty * qtyBase) / 1000,
  };
}

export async function orderReport(
  deliveryDate: string,
  storeId: number | null,
  priceMode: ReportPriceMode = 'sale',
  vatRate: number = VAT_RATE
): Promise<{ documents: ReportDoc[] }> {
  // Сначала добираем номера документов, затем фиксируем слепок цен и строим отчёт.
  await ensureDeliveryDocNumbers(deliveryDate);
  // Даты, которые уже наступили, сначала фиксируют слепок — дальше читаем его.
  await freezeOrderSnapshots();
  const { rows } = await pool.query<ReportRow>(
    `select o.id as "orderId",
            o.doc_no as "docNo",
            o.doc_year as "docYear",
            i.packaging_id as "packagingId",
            tc.id as "nodeId",
            to_char(o.delivery_date, 'YYYY-MM-DD') as "deliveryDate",
            o.updated_at as "savedAt",
            s.id as "storeId", s.code as "storeCode", s.name as "storeName",
            s.address as "storeAddress", s.pib as "storePib",
            s.mbr as "storeMbr", s.account_no as "storeAccount",
            coalesce(i.name_snapshot, pk.title, tc.name) as "cardName",
            coalesce(i.name_sr_snapshot, pk.title_sr, nullif(tc.name_sr, ''), '') as "cardNameSr",
            i.qty, coalesce(i.qty_base_snapshot, pk.qty_base)::float8 as "qtyBase",
            coalesce(i.price_snapshot, pk.price)::float8 as price,
            coalesce(i.cost_snapshot, pk.cost)::float8 as cost,
            coalesce(i.basis_snapshot, pk.price_basis) as "priceBasis",
            coalesce(i.dimension_snapshot, u.dimension) as dimension
       from store_orders o
       join stores s on s.id = o.store_id
       join store_order_items i on i.order_id = o.id
       join prod_packagings pk on pk.id = i.packaging_id
       join prod_nodes tc on tc.id = pk.node_id
       join units u on u.id = tc.unit_id
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
        // Номер — год и порядковый номер внутри года (2027-1, 2027-2…);
        // у старых заказов без номера остаётся прежний вид год-id.
        number: `${r.docYear ?? r.deliveryDate.slice(0, 4)}-${r.docNo ?? r.orderId}`,
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
        weightKg: 0,
        vatRate,
        priceMode,
      };
      docs.set(r.orderId, doc);
    }
    const { unit, qty } = reportQuantity(r.qty, r.qtyBase, r.priceBasis, r.dimension);
    const price = priceMode === 'cost' ? r.cost : r.price;
    const net = round2(qty * price);
    const rate = vatRate;
    const vat = round2((net * rate) / 100);
    // Вес не зависит от базы цены: считаем по количеству упаковок и весу упаковки.
    // Объём переводим в кг условно 1 л = 1 кг; штучное без веса — 0.
    const weightKg = r.dimension === 'count' ? 0 : Math.round(r.qty * r.qtyBase) / 1000;
    doc.lines.push({
      packagingId: r.packagingId,
      nodeId: r.nodeId,
      name: r.cardNameSr || r.cardName,
      unit,
      qty,
      packQty: r.qty,
      price,
      vatRate: rate,
      net,
      vat,
      gross: round2(net + vat),
      weightKg,
    });
    doc.net = round2(doc.net + net);
    doc.vat = round2(doc.vat + vat);
    doc.gross = round2(doc.gross + net + vat);
    doc.weightKg = Math.round((doc.weightKg + weightKg) * 1000) / 1000;
  }

  // Строгое правило: строки документа идут в порядке листа Excel за эту дату.
  // Позиции, которых в листе нет, остаются в конце в прежнем порядке.
  const sheetOrder = await sheetLineOrderForDate(deliveryDate);
  if (sheetOrder) {
    for (const doc of docs.values()) {
      doc.lines.sort((a, b) => {
        const pa = sheetOrder.get(a.packagingId) ?? Number.MAX_SAFE_INTEGER;
        const pb = sheetOrder.get(b.packagingId) ?? Number.MAX_SAFE_INTEGER;
        return pa - pb;
      });
    }
  }

  return { documents: [...docs.values()] };
}
