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
}

export function emptyState(): FakeState {
  return { units: [], products: [], stock: [], movements: [], waybills: [], waybill_items: [], product_aliases: [], audit_log: [] };
}

const copy = <T>(v: T): T => structuredClone(v);
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export class FakePg {
  readonly state: FakeState;
  private seq = { units: 0, products: 0, movements: 0, waybills: 0, waybill_items: 0, aliases: 0 };

  constructor(state?: FakeState) {
    this.state = state ?? emptyState();
    for (const u of this.state.units) this.seq.units = Math.max(this.seq.units, u.id);
    for (const p of this.state.products) this.seq.products = Math.max(this.seq.products, p.id);
    for (const m of this.state.movements) this.seq.movements = Math.max(this.seq.movements, m.id);
    for (const w of this.state.waybills) this.seq.waybills = Math.max(this.seq.waybills, w.id);
    for (const i of this.state.waybill_items) this.seq.waybill_items = Math.max(this.seq.waybill_items, i.id);
    for (const a of this.state.product_aliases) this.seq.aliases = Math.max(this.seq.aliases, a.id);
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

  async query(sql: string, params: unknown[] = []): Promise<Pick<QueryResult, 'rows'>> {
    const s = norm(sql);
    const P = (i: number): unknown => params[i - 1];
    const num = (i: number): number => Number(params[i - 1]);

    // ---------- SELECT ----------
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
