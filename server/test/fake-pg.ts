/**
 * In-memory фейк Postgres-клиента для тестов склада/накладных без реальной БД.
 *
 * Recognizes ONLY the SQL shapes actually used by ingestWaybill / applyMovement /
 * reverseWaybill / confirmImport — routing by regex, everything else throws loudly,
 * so a new query in production code fails tests instead of silently passing.
 */
import type { PoolClient, QueryResult } from 'pg';

export interface FakeUnit {
  id: number;
  code: string;
  dimension: string;
  base_factor: number;
}
export interface FakeProduct {
  id: number;
  name: string;
  category: string;
  unit_id: number;
  g_per_pcs: number | null;
  ml_per_pcs: number | null;
  g_per_ml: number | null;
  created_by: number | null;
}
export interface FakeStock {
  product_id: number;
  qty: number;
  avg_cost: number;
}
export interface FakeMovement {
  id: number;
  product_id: number;
  type: string;
  qty: number;
  unit_cost: number;
  doc_type: string | null;
  doc_id: number | null;
  comment: string | null;
  user_id: number | null;
  user_login: string | null;
}
export interface FakeWaybill {
  id: number;
  number: string;
  supplier: string;
  doc_date: string | null;
  file_name: string | null;
  stored_file: string | null;
  file_data: Buffer | null;
  file_mime: string | null;
  extra_files: unknown;
  currency: string;
  supplier_pib: string | null;
  total_net: number;
  total_vat: number;
  total_gross: number;
  doc_total_net: number | null;
  doc_total_vat: number | null;
  doc_total_gross: number | null;
  accepted_by: number | null;
  accepted_login: string | null;
  status: string;
  reversed_by: number | null;
  reversed_login: string | null;
  reversed_at: unknown;
}
export interface FakeWaybillItem {
  id: number;
  waybill_id: number;
  product_id: number;
  qty: number;
  unit_id: number;
  price: number;
  vat_rate: number | null;
  vat_amount: number;
}
export interface FakeAlias {
  id: number;
  product_id: number;
  alias: string;
  alias_raw: string;
}
export interface FakeCard {
  id: number;
  name: string;
  portion_qty: number;
  portion_unit_id: number;
  plu: string | null;
}
export interface FakeCardItem {
  card_id: number;
  source_type: 'raw' | 'semi';
  ref_id: number;
  qty: number;
  unit_id: number;
  position: number;
}
export interface FakeSemi {
  id: number;
  name: string;
  unit_id: number;
  out_qty: number;
  g_per_pcs: number | null;
  ml_per_pcs: number | null;
  g_per_ml: number | null;
}
export interface FakeSemiInput {
  semi_id: number;
  source_type: 'raw' | 'semi';
  ref_id: number;
  qty_per_output: number;
  yield_pct: number | null;
}
export interface FakeBatch {
  id: number;
  card_id: number;
  portions: number;
  batch_date: string;
  note: string;
  cost_total: number;
  status: string;
  created_by: number | null;
  created_login: string | null;
}
export interface FakeBatchItem {
  id: number;
  batch_id: number;
  product_id: number;
  qty: number;
  unit_cost: number;
}
export interface FakeStore {
  id: number;
  name: string;
  active: boolean;
}
export interface FakeOrder {
  id: number;
  tab_id: number | null;
  store_id: number;
  card_id: number | null;
  source_name: string;
  min_qty: number | null;
  quantity: number;
  sheet_qty: number | null;
  unit_code: string | null;
  date_tab: string;
  status: string;
  source: string;
  note: string;
  created_by: number | null;
  db_edited_at: string | null;
  pushed_at: string | null;
}
export interface FakeAuditRow {
  user_id: number | null;
  user_login: string;
  action: string;
  entity: string;
  entity_id: string | null;
  title: string;
  details: string;
}

export interface FakeState {
  units: FakeUnit[];
  products: FakeProduct[];
  stock: FakeStock[];
  movements: FakeMovement[];
  waybills: FakeWaybill[];
  waybill_items: FakeWaybillItem[];
  product_aliases: FakeAlias[];
  audit_log: FakeAuditRow[];
  tech_cards: FakeCard[];
  tech_card_items: FakeCardItem[];
  semi_products: FakeSemi[];
  semi_inputs: FakeSemiInput[];
  production_batches: FakeBatch[];
  production_batch_items: FakeBatchItem[];
  stores: FakeStore[];
  orders: FakeOrder[];
}

export function emptyState(): FakeState {
  return {
    units: [], products: [], stock: [], movements: [], waybills: [], waybill_items: [],
    product_aliases: [], audit_log: [],
    tech_cards: [], tech_card_items: [], semi_products: [], semi_inputs: [],
    production_batches: [], production_batch_items: [],
    stores: [], orders: [],
  };
}

const copy = <T>(v: T): T => structuredClone(v);
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export class FakePg {
  readonly state: FakeState;
  private seq = {
    units: 0, products: 0, movements: 0, waybills: 0, waybill_items: 0, aliases: 0,
    cards: 0, semis: 0, batches: 0, batch_items: 0, orders: 0,
  };

  constructor(state?: FakeState) {
    this.state = state ?? emptyState();
    for (const u of this.state.units) this.seq.units = Math.max(this.seq.units, u.id);
    for (const p of this.state.products) this.seq.products = Math.max(this.seq.products, p.id);
    for (const m of this.state.movements) this.seq.movements = Math.max(this.seq.movements, m.id);
    for (const w of this.state.waybills) this.seq.waybills = Math.max(this.seq.waybills, w.id);
    for (const i of this.state.waybill_items) this.seq.waybill_items = Math.max(this.seq.waybill_items, i.id);
    for (const a of this.state.product_aliases) this.seq.aliases = Math.max(this.seq.aliases, a.id);
    for (const c of this.state.tech_cards) this.seq.cards = Math.max(this.seq.cards, c.id);
    for (const s of this.state.semi_products) this.seq.semis = Math.max(this.seq.semis, s.id);
    for (const b of this.state.production_batches) this.seq.batches = Math.max(this.seq.batches, b.id);
    for (const bi of this.state.production_batch_items) this.seq.batch_items = Math.max(this.seq.batch_items, bi.id);
    for (const o of this.state.orders) this.seq.orders = Math.max(this.seq.orders, o.id);
  }

  private next(what: keyof FakePg['seq']): number {
    return ++this.seq[what];
  }

  /** id продукта по складскому названию (первый совпадение). */
  pid(name: string): number {
    const p = this.state.products.find((x) => x.name === name);
    if (!p) throw new Error(`FakePg: нет продукта «${name}» в фикстуре`);
    return p.id;
  }

  unit(code: string): number {
    const u = this.state.units.find((x) => x.code === code);
    if (!u) throw new Error(`FakePg: нет единицы «${code}» в фикстуре`);
    return u.id;
  }

  stockOf(productId: number): { qty: number; avgCost: number } {
    const s = this.state.stock.find((x) => x.product_id === productId);
    if (!s) throw new Error(`FakePg: нет строки склада для #${productId}`);
    return { qty: s.qty, avgCost: s.avg_cost };
  }

  movementsOf(productId: number): FakeMovement[] {
    return this.state.movements.filter((m) => m.product_id === productId);
  }

  waybill(id: number): FakeWaybill {
    const w = this.state.waybills.find((x) => x.id === id);
    if (!w) throw new Error(`FakePg: накладная #${id} не найдена`);
    return w;
  }

  /** Партия производства (для проверок списания/отката). */
  batch(id: number): FakeBatch {
    const b = this.state.production_batches.find((x) => x.id === id);
    if (!b) throw new Error(`FakePg: партия #${id} не найдена`);
    return b;
  }

  batchItems(id: number): FakeBatchItem[] {
    return this.state.production_batch_items.filter((x) => x.batch_id === id);
  }

  /** Себестоимость списания по партии: Σ количество × цена списания. */
  batchCost(id: number): number {
    return this.batchItems(id).reduce((s, i) => s + i.qty * i.unit_cost, 0);
  }

  order(id: number): FakeOrder {
    const o = this.state.orders.find((x) => x.id === id);
    if (!o) throw new Error(`FakePg: линия заказа #${id} не найдена`);
    return o;
  }

  async query(sql: string, params: unknown[] = []): Promise<Pick<QueryResult, 'rows'>> {
    const s = norm(sql);
    const P = (i: number): unknown => params[i - 1];
    const num = (i: number): number => Number(params[i - 1]);

    // ---------- SELECT ----------
    // автор транзакции для триггеров (asUser) — в фейке ничего не настраиваем
    if (/^select set_config/i.test(s)) return { rows: [{ x: 1 }] };
    // проверка дубля номера (ingestWaybill) — до обработчика «where id"
    if (/^select id, doc_date::text as "docdate" from waybills where btrim\(number\)/i.test(s)) {
      const want = String(P(1)).trim();
      const w = this.state.waybills.find((x) => x.number.trim() === want && x.status !== 'reversed');
      return { rows: w ? [{ id: w.id, docDate: w.doc_date }] : [] };
    }
    if (/^select id, number, status from waybills where id/i.test(s)) {
      const w = this.state.waybills.find((x) => x.id === num(1));
      return { rows: w ? [{ id: w.id, number: w.number, status: w.status }] : [] };
    }
    if (/^select id, dimension, base_factor::float8 as f from units/i.test(s)) {
      return { rows: this.state.units.map((u) => ({ id: u.id, dimension: u.dimension, f: u.base_factor })) };
    }
    if (/from units/i.test(s)) {
      // выбор одной единицы по id ("... from units where id = $1")
      const u = this.state.units.find((x) => x.id === num(1));
      return { rows: u ? [{ f: u.base_factor }] : [] };
    }
    if (/^select 1 from stock where product_id = any/i.test(s)) return { rows: [{ x: 1 }] }; // lock — no-op
    if (/^select qty::float8 as qty, avg_cost::float8 as avg_cost from stock where product_id/i.test(s)) {
      const st = this.state.stock.find((x) => x.product_id === num(1));
      return { rows: st ? [{ qty: st.qty, avg_cost: st.avg_cost }] : [] };
    }
    // postBatch: за цену списания берём только средневзвешенную
    if (/^select avg_cost::float8 as c from stock where product_id/i.test(s)) {
      const st = this.state.stock.find((x) => x.product_id === num(1));
      return { rows: st ? [{ c: st.avg_cost }] : [] };
    }
    // loadProductConv: все продукты разом — до общего обработчика `from products`
    if (/^select id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from products/i.test(s)) {
      return { rows: this.state.products.map((p) => ({ id: p.id, gp: p.g_per_pcs, mp: p.ml_per_pcs, gm: p.g_per_ml })) };
    }
    if (/from products/i.test(s)) {
      if (/unit_id/.test(s)) {
        const p = this.state.products.find((x) => x.id === num(1));
        if (!p) return { rows: [] };
        return { rows: [{ unit_id: p.unit_id, gp: p.g_per_pcs, mp: p.ml_per_pcs, gm: p.g_per_ml }] };
      }
      if (/lower\(name\)/i.test(s)) {
        const want = String(P(1)).toLowerCase();
        const p = this.state.products.find((x) => x.name.toLowerCase() === want);
        return { rows: p ? [{ id: p.id }] : [] };
      }
      if (/\bname\b/.test(s)) {
        const p = this.state.products.find((x) => x.id === num(1));
        return { rows: p ? [{ name: p.name }] : [] };
      }
      return { rows: this.state.products.some((x) => x.id === num(1)) ? [{ x: 1 }] : [] };
    }
    if (/from waybill_items i join products p/i.test(s)) {
      const rows = this.state.waybill_items
        .filter((i) => i.waybill_id === num(1))
        .map((i) => {
          const p = this.state.products.find((x) => x.id === i.product_id)!;
          return { productId: i.product_id, qty: i.qty, unitId: i.unit_id, baseUnitId: p.unit_id };
        });
      return { rows };
    }
    if (/from product_aliases where alias/i.test(s)) {
      return { rows: this.state.product_aliases.some((a) => a.alias === String(P(1))) ? [{ x: 1 }] : [] };
    }

    // ---------- техкарты / партии / каталог заказов ----------
    // каталог готовой продукции с единицей выхода (expandCard, /place, /catalog)
    if (/from tech_cards tc\s+join units u/i.test(s)) {
      return {
        rows: this.state.tech_cards
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => {
            const u = this.state.units.find((x) => x.id === c.portion_unit_id)!;
            return { id: c.id, name: c.name, plu: c.plu, unitCode: u.code, baseUnitCode: u.code, portionQty: c.portion_qty };
          }),
      };
    }
    // позиция техкарты с единицей связанного сырья/полуфабриката (expandCard)
    if (/from tech_card_items i\s+left join products/i.test(s)) {
      const rows = this.state.tech_card_items
        .filter((i) => i.card_id === num(1))
        .sort((a, b) => a.position - b.position)
        .map((i) => {
          const refUnit =
            i.source_type === 'raw'
              ? this.state.products.find((x) => x.id === i.ref_id)?.unit_id
              : this.state.semi_products.find((x) => x.id === i.ref_id)?.unit_id;
          return { source_type: i.source_type, ref_id: i.ref_id, qty: i.qty, unit_id: i.unit_id, ref_unit_id: refUnit ?? null };
        });
      return { rows };
    }
    // состав заготовки (loadSemiInputs)
    if (/from semi_inputs si\s+left join products/i.test(s)) {
      const rows = this.state.semi_inputs
        .filter((si) => si.semi_id === num(1))
        .map((si) => {
          const inUnit =
            si.source_type === 'raw'
              ? this.state.products.find((x) => x.id === si.ref_id)?.unit_id
              : this.state.semi_products.find((x) => x.id === si.ref_id)?.unit_id;
          return { source_type: si.source_type, ref_id: si.ref_id, qty: si.qty_per_output, yield_pct: si.yield_pct, in_unit_id: inUnit ?? null };
        });
      return { rows };
    }
    // коэффициенты выхода полуфабрикатов (loadSemiConv) — ДО обработчика «where id»
    if (/^select id, g_per_pcs::float8 as gp, ml_per_pcs::float8 as mp, g_per_ml::float8 as gm from semi_products/i.test(s)) {
      return { rows: this.state.semi_products.map((m) => ({ id: m.id, gp: m.g_per_pcs, mp: m.ml_per_pcs, gm: m.g_per_ml })) };
    }
    // выход заготовки: единица + размер партии (semiUnit / expandSemi)
    if (/from semi_products where id/i.test(s)) {
      const sm = this.state.semi_products.find((x) => x.id === num(1));
      return { rows: sm ? [{ unit_id: sm.unit_id, out_qty: sm.out_qty }] : [] };
    }
    // партия вместе с именем техкарты (reverseBatch)
    if (/from production_batches b\s+join tech_cards/i.test(s)) {
      const b = this.state.production_batches.find((x) => x.id === num(1));
      if (!b) return { rows: [] };
      const card = this.state.tech_cards.find((x) => x.id === b.card_id);
      return { rows: [{ name: card?.name ?? '', status: b.status, portions: b.portions }] };
    }
    // снимок состава партии (reverseBatch)
    if (/select product_id, qty::float8 as qty from production_batch_items/i.test(s)) {
      return { rows: this.batchItems(num(1)).map((i) => ({ product_id: i.product_id, qty: i.qty })) };
    }
    if (/from production_batches b/i.test(s)) throw new Error(`FakePg: production_batches SQL не описан:\n${s}`);
    // линия заказа по store/date/имени — слияние при повторном оформлении (/place)
    if (/select id, quantity::float8 as qty, status from orders/i.test(s)) {
      const store = num(1);
      const date = String(P(2));
      const name = String(P(3)).trim().toLowerCase();
      const o = this.state.orders.find(
        (x) => x.store_id === store && x.date_tab === date && x.source_name.trim().toLowerCase() === name
      );
      return { rows: o ? [{ id: o.id, qty: o.quantity, status: o.status }] : [] };
    }
    // строка заказа с текущим статусом (PATCH /orders/:id)
    if (/select o.id, o.store_id as "storeId", o.status, o.date_tab/i.test(s)) {
      const o = this.state.orders.find((x) => x.id === num(1));
      return { rows: o ? [{ id: o.id, storeId: o.store_id, status: o.status }] : [] };
    }
    // единица выхода + вес порции линии заказа (PATCH /orders/:id с unit)
    if (/from orders o left join tech_cards/i.test(s)) {
      const line = this.state.orders.find((x) => x.id === num(1));
      const card = line?.card_id ? this.state.tech_cards.find((x) => x.id === line.card_id) : undefined;
      const u = card ? this.state.units.find((x) => x.id === card.portion_unit_id) : undefined;
      return { rows: [{ baseUnit: u?.code ?? line?.unit_code ?? null, portionQty: card?.portion_qty ?? 0 }] };
    }
    // свежий минимум строки источника (route /place)
    if (/select min_qty::float8 as mn\s+from orders/i.test(s)) {
      const list = this.state.orders.filter((o) => {
        if (o.min_qty === null) return false;
        const byCard = P(1) != null && o.card_id === num(1);
        const byName = P(1) == null && o.source_name === String(P(2));
        return byCard || byName;
      });
      list.sort((a, b) => String(b.date_tab).localeCompare(String(a.date_tab)) || b.id - a.id);
      return { rows: list.length ? [{ mn: list[0].min_qty }] : [] };
    }
    if (/from orders/i.test(s)) throw new Error(`FakePg: orders SQL не описан:\n${s}`);
    if (/from tech_cards tc\s+join units u on u.id = tc.portion_unit_id where tc.id/i.test(s)) {
      const c = this.state.tech_cards.find((x) => x.id === num(1));
      if (!c) return { rows: [] };
      const u = this.state.units.find((x) => x.id === c.portion_unit_id)!;
      return { rows: [{ name: c.name, plu: c.plu, unitCode: u.code, portionQty: c.portion_qty }] };
    }
    if (/select name from tech_cards where id/i.test(s)) {
      const c = this.state.tech_cards.find((x) => x.id === num(1));
      return { rows: c ? [{ name: c.name }] : [] };
    }
    if (/from tech_cards/i.test(s)) throw new Error(`FakePg: tech_cards SQL не описан:\n${s}`);
    // активный магазин (route /place)
    if (/from stores where id/i.test(s)) {
      const st = this.state.stores.find((x) => x.id === num(1) && x.active);
      return { rows: st ? [{ id: st.id, name: st.name }] : [] };
    }
    if (/from movements/i.test(s)) {
      const excluded = new Set(this.state.waybills.filter((w) => w.status === 'reversed').map((w) => w.id));
      const rows = this.state.movements
        .filter((m) => m.product_id === num(1))
        .filter((m) => !(m.doc_type === 'waybill' && m.doc_id != null && excluded.has(m.doc_id)))
        .sort((a, b) => a.id - b.id)
        .map((m) => ({ type: m.type, qty: m.qty, cost: m.unit_cost }));
      return { rows };
    }
    if (/select id from waybills where status = 'reversed'/i.test(s)) {
      return { rows: this.state.waybills.filter((w) => w.status === 'reversed').map((w) => ({ id: w.id })) };
    }

    // ---------- UPDATE ----------
    if (/^update waybills set status = 'reversed'/i.test(s)) {
      const w = this.state.waybills.find((x) => x.id === num(1));
      if (!w) throw new Error(`FakePg: update reversed для несуществующей #${num(1)}`);
      if (w.status === 'reversed') throw new Error('FakePg: повторный update status — код должен отклонять раньше');
      w.status = 'reversed';
      w.reversed_by = P(2) as number | null;
      w.reversed_login = P(3) as string | null;
      w.reversed_at = 'now()';
      return { rows: [] };
    }
    if (/^update stock set qty/i.test(s)) {
      const st = this.state.stock.find((x) => x.product_id === num(1));
      if (!st) throw new Error(`FakePg: update stock для несуществующей строки #${num(1)}`);
      st.qty = num(2);
      st.avg_cost = num(3);
      return { rows: [] };
    }
    // себестоимость партии после списания сырья
    if (/^update production_batches set cost_total/i.test(s)) {
      const b = this.state.production_batches.find((x) => x.id === num(1));
      if (!b) throw new Error(`FakePg: update cost_total для несуществующей партии #${num(1)}`);
      b.cost_total = num(2);
      return { rows: [] };
    }
    // отмена партии: возврат сырья + обнуление себестоимости
    if (/^update production_batches set status = 'reversed'/i.test(s)) {
      const b = this.state.production_batches.find((x) => x.id === num(1));
      if (!b) throw new Error(`FakePg: update reversed для несуществующей партии #${num(1)}`);
      if (b.status === 'reversed') throw new Error('FakePg: повторный откат партии — код должен отклонять раньше');
      b.status = 'reversed';
      b.cost_total = 0;
      return { rows: [] };
    }
    // переналожение отменённой линии (/place): новое количество + возврат в работу
    if (/^update orders set quantity = \$2::numeric, status = 'placed'/i.test(s)) {
      const o = this.state.orders.find((x) => x.id === num(1));
      if (!o) throw new Error(`FakePg: update orders для несуществующей линии #${num(1)}`);
      o.quantity = num(2);
      o.status = 'placed';
      o.db_edited_at = 'now()';
      return { rows: [] };
    }
    // слияние с существующей линией: количество прирастает
    if (/^update orders set quantity = quantity \+ /i.test(s)) {
      const o = this.state.orders.find((x) => x.id === num(1));
      if (!o) throw new Error(`FakePg: update orders для несуществующей линии #${num(1)}`);
      o.quantity += num(2);
      o.db_edited_at = 'now()';
      return { rows: [] };
    }
    if (/^update orders set/i.test(s)) {
      const id = num(params.length);
      const o = this.state.orders.find((x) => x.id === id);
      if (!o) throw new Error(`FakePg: update orders для несуществующей линии #${id}`);
      for (const set of /set (.*) where id/i.exec(s)?.[1].split(', ') ?? []) {
        const col = set.split(' = ')[0];
        if (!/\$\d/.test(set)) continue; // updated_at = now() и т.п.
        const idx = Number(/\$(\d)/.exec(set)![1]);
        const v = P(idx);
        if (col === 'quantity' || col === 'min_qty') o[col] = v === null ? null : Number(v);
        else if (col === 'status') o.status = String(v);
        else if (col === 'note') o.note = String(v);
        else (o as Record<string, unknown>)[col] = v;
      }
      return { rows: [] };
    }

    // ---------- INSERT ----------
    if (/^insert into audit_log/i.test(s)) {
      this.state.audit_log.push({
        user_id: P(1) as number | null,
        user_login: String(P(2)),
        action: String(P(4)),
        entity: String(P(5)),
        entity_id: P(6) as string | null,
        title: String(P(7)),
        details: String(P(8)),
      });
      return { rows: [] };
    }
    if (/^insert into waybills/i.test(s)) {
      const id = this.next('waybills');
      this.state.waybills.push({
        id,
        number: String(P(1)),
        supplier: String(P(2)),
        doc_date: (P(3) as string | null) ?? new Date().toISOString().slice(0, 10),
        file_name: P(4) as string | null,
        stored_file: P(5) as string | null,
        file_data: P(6) as Buffer | null,
        file_mime: P(7) as string | null,
        extra_files: P(8) ? JSON.parse(String(P(8))) : null,
        currency: (P(9) as string | null) ?? 'RSD',
        supplier_pib: P(10) as string | null,
        total_net: num(11),
        total_vat: num(12),
        total_gross: num(13),
        doc_total_net: P(14) as number | null,
        doc_total_vat: P(15) as number | null,
        doc_total_gross: P(16) as number | null,
        accepted_by: P(17) as number | null,
        accepted_login: P(18) as string | null,
        status: 'posted',
        reversed_by: null,
        reversed_login: null,
        reversed_at: null,
      });
      return { rows: [{ id }] };
    }
    if (/^insert into waybill_items/i.test(s)) {
      const id = this.next('waybill_items');
      this.state.waybill_items.push({
        id,
        waybill_id: num(1),
        product_id: num(2),
        qty: num(3),
        unit_id: num(4),
        price: num(5),
        vat_rate: P(6) as number | null,
        vat_amount: num(7),
      });
      return { rows: [] };
    }
    if (/^insert into movements/i.test(s)) {
      const id = this.next('movements');
      this.state.movements.push({
        id,
        product_id: num(1),
        type: String(P(2)),
        qty: num(3),
        unit_cost: num(4),
        doc_type: P(5) as string | null,
        doc_id: P(6) as number | null,
        comment: P(7) as string | null,
        user_id: P(8) as number | null,
        user_login: P(9) as string | null,
      });
      return { rows: [] };
    }
    if (/^insert into products/i.test(s)) {
      const id = this.next('products');
      this.state.products.push({
        id,
        name: String(P(1)),
        category: String(P(2)),
        unit_id: num(3),
        g_per_pcs: null,
        ml_per_pcs: null,
        g_per_ml: null,
        created_by: P(4) as number | null,
      });
      return { rows: [{ id }] };
    }
    if (/^insert into stock/i.test(s)) {
      // форма create из confirm: values ($1, 0, 0) — qty/avg литералы, не параметры
      this.state.stock.push({ product_id: num(1), qty: params.length >= 3 ? num(2) : 0, avg_cost: params.length >= 3 ? num(3) : 0 });
      return { rows: [] };
    }
    // партия производства: дата по умолчанию — «сегодня», как coalesce($3::date, current_date)
    if (/^insert into production_batches/i.test(s)) {
      const id = this.next('batches');
      this.state.production_batches.push({
        id,
        card_id: num(1),
        portions: num(2),
        batch_date: (P(3) as string | null) ?? new Date().toISOString().slice(0, 10),
        note: String(P(4) ?? ''),
        cost_total: 0,
        status: 'posted',
        created_by: P(5) as number | null,
        created_login: P(6) as string | null,
      });
      return { rows: [{ id }] };
    }
    if (/^insert into production_batch_items/i.test(s)) {
      const id = this.next('batch_items');
      this.state.production_batch_items.push({ id, batch_id: num(1), product_id: num(2), qty: num(3), unit_cost: num(4) });
      return { rows: [] };
    }
    if (/^insert into orders/i.test(s)) {
      const id = this.next('orders');
      this.state.orders.push({
        id,
        tab_id: null,
        store_id: num(1),
        card_id: P(2) as number | null,
        source_name: String(P(3)),
        min_qty: P(4) == null ? null : num(4),
        quantity: num(5),
        sheet_qty: null,
        unit_code: P(6) as string | null,
        date_tab: String(P(7)),
        status: 'placed',
        source: 'manual',
        note: String(P(8) ?? ''),
        created_by: P(9) as number | null,
        db_edited_at: 'now()',
        pushed_at: null,
      });
      return { rows: [{ id }] };
    }
    if (/^insert into product_aliases/i.test(s)) {
      if (/on conflict \(alias\) do update/i.test(s)) {
        const alias = String(P(2));
        const existing = this.state.product_aliases.find((a) => a.alias === alias);
        if (existing) {
          existing.product_id = num(1);
          existing.alias_raw = String(P(3));
        } else {
          this.state.product_aliases.push({ id: this.next('aliases'), product_id: num(1), alias, alias_raw: String(P(3)) });
        }
        return { rows: [] };
      }
      throw new Error('FakePg: insert into product_aliases без on-conflict не описан');
    }

    throw new Error(`FakePg: нераспознанный SQL:\n${s}`);
  }
}

/** Клиент с query + BEGIN/COMMIT/ROLLBACK поверх снапшота: откат реально откатывает состояние. */
export function fakeTx(db: FakePg): (fn: (client: PoolClient) => Promise<any>) => Promise<any> {
  return async (fn) => {
    const snap = copy(db.state);
    const client = {
      query: (sql: string, params: unknown[] = []) => db.query(sql, params),
      release: () => undefined,
    } as unknown as PoolClient;
    try {
      const result = await fn(client);
      return result;
    } catch (e) {
      // ROLLBACK: возвращаем содержимое таблиц в снапшот, НЕ меняя сами ссылки на массивы
      for (const key of Object.keys(db.state) as (keyof FakeState)[]) {
        const live = db.state[key] as unknown[];
        live.length = 0;
        live.push(...(snap[key] as unknown[]));
      }
      throw e;
    }
  };
}
