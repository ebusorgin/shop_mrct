import assert from 'node:assert/strict';
import type { QueryResult } from 'pg';
import { FakePg, type FakeState } from './fake-pg';

/** Additional SQL shapes for packaging services and route tests. No real connections. */
export class PackagingPg extends FakePg {
  readonly queries: { sql: string; params: unknown[] }[] = [];
  private packagingSeq: number;
  private cardSeq: number;

  constructor(state: FakeState) {
    super(state);
    this.packagingSeq = Math.max(0, ...state.product_packagings.map((p) => p.id));
    this.cardSeq = Math.max(0, ...state.tech_cards.map((p) => p.id));
  }

  packagings(cardId: number, withItems = true) {
    return this.state.product_packagings.filter((p) => p.card_id === cardId).sort((a, b) => a.id - b.id).map((p) => ({
      id: p.id, name: p.name, qtyBase: p.qty_base, orderStep: p.order_step, isDefault: p.is_default,
      ...(withItems ? { items: this.state.product_packaging_items.filter((i) => i.packaging_id === p.id)
        .sort((a, b) => a.product_id - b.product_id).map((i) => {
          const product = this.state.products.find((x) => x.id === i.product_id)!;
          const unit = this.state.units.find((x) => x.id === product.unit_id)!;
          const stock = this.state.stock.find((x) => x.product_id === product.id);
          return { productId: i.product_id, qty: i.qty, productName: product.name, unitCode: unit.code,
            avgCost: stock?.avg_cost ?? 0, stockQty: stock?.qty ?? 0 };
        }) } : {}),
    }));
  }

  override async query(sql: string, params: unknown[] = []): Promise<Pick<QueryResult, 'rows'>> {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params: structuredClone(params) });
    const placeholders = [...s.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(params.length, Math.max(0, ...placeholders), `SQL parameter count: ${s}`);
    const n = (i: number) => Number(params[i - 1]);
    const state = this.state;
    const result = (rows: unknown[] = []) => ({ rows });

    if (/^select coalesce\(\( select jsonb_agg/.test(s)) {
      return result(state.tech_cards.some((c) => c.id === n(1)) ? [{ packagings: this.packagings(n(1)) }] : []);
    }
    if (/^select \* from \( select tc.id/.test(s) || /^select tc.id, tc.name, tc.note/.test(s)) {
      const cards = params.length ? state.tech_cards.filter((c) => c.id === n(1)) : state.tech_cards;
      return result(cards.map((c) => ({ id: c.id, name: c.name, portionQty: c.portion_qty,
        portionUnitId: c.portion_unit_id, portionUnitCode: state.units.find((u) => u.id === c.portion_unit_id)!.code,
        ...(/as items/.test(s) ? { items: [] } : {}),
        packagings: this.packagings(c.id, /'items'/.test(s)),
      })));
    }
    if (/^select dimension from units where id = \$1$/.test(s)) {
      return result(state.units.filter((u) => u.id === n(1)).map((u) => ({ dimension: u.dimension })));
    }
    if (/^select id from products where id = any\(\$1::int\[\]\) order by id for share$/.test(s)) {
      return result(state.products.filter((p) => (params[0] as number[]).includes(p.id)).map((p) => ({ id: p.id })));
    }
    if (/^select id from product_packagings where card_id = \$1 order by id$/.test(s)) {
      return result(state.product_packagings.filter((p) => p.card_id === n(1)).map((p) => ({ id: p.id })));
    }
    if (/^delete from product_packagings where card_id = \$1 and not \(id = any\(\$2::int\[\]\)\)$/.test(s)) {
      const removed = state.product_packagings.filter((p) => p.card_id === n(1) && !(params[1] as number[]).includes(p.id));
      state.product_packagings = state.product_packagings.filter((p) => !removed.includes(p));
      state.product_packaging_items = state.product_packaging_items.filter((i) => !removed.some((p) => p.id === i.packaging_id));
      return result();
    }
    if (/^update product_packagings set is_default = false where card_id = \$1$/.test(s)) {
      for (const p of state.product_packagings.filter((p) => p.card_id === n(1))) p.is_default = false;
      return result();
    }
    const insert = /^insert into product_packagings \(card_id, name, qty_base, order_step, is_default\) values \(\$1,\$2,\$3,\$4,\$5\) returning id$/.test(s);
    const update = /^update product_packagings set name=\$2, qty_base=\$3, order_step=\$4, is_default=\$5 where card_id=\$1 and id=\$6$/.test(s);
    if (insert || update) {
      const id = insert ? ++this.packagingSeq : n(6);
      assert.equal(typeof params[4], 'boolean');
      assert.ok(Number.isInteger(n(4)) && n(4) > 0 && n(4) <= 2147483647);
      assert.ok(!params[4] || !state.product_packagings.some((p) => p.card_id === n(1) && p.id !== id && p.is_default), 'unique default index');
      const values = { id, card_id: n(1), name: String(params[1]), qty_base: n(3), order_step: n(4), is_default: params[4] as boolean };
      if (insert) state.product_packagings.push(values);
      else {
        const p = state.product_packagings.find((p) => p.id === id && p.card_id === n(1));
        assert.ok(p, 'UPDATE must address an owned packaging');
        Object.assign(p, values);
      }
      return result(insert ? [{ id }] : []);
    }
    if (/^delete from product_packaging_items where packaging_id = \$1$/.test(s)) {
      state.product_packaging_items = state.product_packaging_items.filter((i) => i.packaging_id !== n(1));
      return result();
    }
    if (/^insert into product_packaging_items \(packaging_id, product_id, qty\) values \(\$1,\$2,\$3\)$/.test(s)) {
      assert.ok(state.product_packagings.some((p) => p.id === n(1)));
      assert.ok(state.products.some((p) => p.id === n(2)));
      assert.ok(!state.product_packaging_items.some((p) => p.packaging_id === n(1) && p.product_id === n(2)));
      state.product_packaging_items.push({ packaging_id: n(1), product_id: n(2), qty: n(3) });
      return result();
    }
    if (/^select tc.portion_qty::float8 as "portionQty", u.code as "unitCode"/.test(s)) {
      assert.match(s, /where tc.id = \$1 for share of tc$/);
      return result(state.tech_cards.filter((c) => c.id === n(1)).map((c) => ({
        portionQty: c.portion_qty, unitCode: state.units.find((u) => u.id === c.portion_unit_id)!.code,
      })));
    }
    if (/^select name, qty_base::float8 as "qtyBase" from product_packagings where id = \$1 and card_id = \$2$/.test(s)) {
      return result(state.product_packagings.filter((p) => p.id === n(1) && p.card_id === n(2)).map((p) => ({ name: p.name, qtyBase: p.qty_base })));
    }
    if (/^select product_id as "productId", qty::float8 as qty from product_packaging_items where packaging_id = \$1 order by product_id$/.test(s)) {
      return result(state.product_packaging_items.filter((i) => i.packaging_id === n(1)).map((i) => ({ productId: i.product_id, qty: i.qty })));
    }
    if (/^select portion_qty::float8 as qty, portion_unit_id from tech_cards/.test(s)) {
      return result(state.tech_cards.filter((c) => c.id === n(1)).map((c) => ({ qty: c.portion_qty, portion_unit_id: c.portion_unit_id })));
    }
    if (/^select p.name, u.code as "unitCode", coalesce\(s.qty,0\)/.test(s)) {
      return result(state.products.filter((p) => p.id === n(1)).map((p) => {
        const stock = state.stock.find((st) => st.product_id === p.id);
        return { name: p.name, unitCode: state.units.find((u) => u.id === p.unit_id)!.code,
          stockQty: stock?.qty ?? 0, unitCost: stock?.avg_cost ?? 0 };
      }));
    }
    if (/^select name, portion_qty::float8 as portion_qty, portion_unit_id, note, catalog_id from tech_cards/.test(s)) {
      return result(state.tech_cards.filter((c) => c.id === n(1)).map((c) => ({ ...c, note: '', catalog_id: null })));
    }
    if (/^select count\(\*\)::int as n from tech_card_items/.test(s)) {
      return result([{ n: state.tech_card_items.filter((i) => i.card_id === n(1)).length }]);
    }
    if (/^select ref_id from tech_card_items where source_type = 'product'/.test(s)) {
      return result(state.tech_card_items.filter((i) => i.card_id === n(1) && i.source_type === 'product').map((i) => ({ ref_id: i.ref_id })));
    }
    if (/^insert into tech_cards /.test(s)) {
      const id = ++this.cardSeq;
      state.tech_cards.push({ id, name: String(params[0]), portion_qty: n(2), portion_unit_id: n(3), plu: null });
      return result([{ id }]);
    }
    if (/^update tech_cards set name=/.test(s)) {
      Object.assign(state.tech_cards.find((c) => c.id === n(1))!, { name: params[1], portion_qty: n(3), portion_unit_id: n(4) });
      return result();
    }
    if (/^delete from tech_card_items where card_id/.test(s)) {
      state.tech_card_items = state.tech_card_items.filter((i) => i.card_id !== n(1));
      return result();
    }
    if (/^insert into tech_card_items /.test(s)) {
      state.tech_card_items.push({ card_id: n(1), source_type: params[1] as 'raw' | 'semi' | 'product', ref_id: n(3), qty: n(4), unit_id: n(5), position: n(6) });
      return result();
    }
    if (/^select 1 from tech_cards where id/.test(s)) {
      return result(state.tech_cards.filter((c) => c.id === n(1)).map(() => ({ x: 1 })));
    }
    if (/^select coalesce\(qty, 0\)::float8 as qty from stock/.test(s)) {
      return result(state.stock.filter((st) => st.product_id === n(1)).map((st) => ({ qty: st.qty })));
    }
    if (/^select \(select count\(\*\) from semi_inputs/.test(s)) {
      assert.match(s, /from product_packaging_items where product_id = \$1/);
      assert.match(s, /from production_batch_items where product_id = \$1/);
      return result([{ used: state.semi_inputs.filter((i) => i.source_type === 'raw' && i.ref_id === n(1)).length
        + state.tech_card_items.filter((i) => i.source_type === 'raw' && i.ref_id === n(1)).length
        + state.product_packaging_items.filter((i) => i.product_id === n(1)).length
        + state.production_batch_items.filter((i) => i.product_id === n(1)).length }]);
    }
    if (/^update products set active = false/.test(s)) {
      Object.assign(state.products.find((p) => p.id === n(1))!, { active: false });
      return result();
    }
    if (/^select b.id, b.card_id as "cardId"/.test(s)) {
      return result(state.production_batches.map((b) => ({ id: b.id, cardId: b.card_id, portions: b.portions,
        packagingName: b.packaging_name, packagingQtyBase: b.packaging_qty_base, packagingUnitCode: b.packaging_unit_code })));
    }
    if (/product_packagings|product_packaging_items/.test(s)) throw new Error(`Unrecognized packaging SQL: ${s}`);
    return super.query(sql, params);
  }
}
