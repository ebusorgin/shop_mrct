import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLegacyImport, type LegacySnapshot } from '../src/services/legacy-map-import';

const base: LegacySnapshot = {
  products: [{ id: 1, name: 'картофель', unit_id: 1 }],
  semis: [
    { id: 10, name: 'картофель варёный', unit_id: 1, out_qty: 1000 },
    { id: 11, name: 'пюре', unit_id: 1, out_qty: 450 },
  ],
  semiInputs: [
    { semi_id: 10, source_type: 'raw', ref_id: 1, qty_per_output: 1000, yield_pct: 95 },
    { semi_id: 11, source_type: 'semi', ref_id: 10, qty_per_output: 340, yield_pct: null },
  ],
  cards: [
    {
      id: 20, name: 'картофель варёный', name_en: '', name_sr: '',
      portion_qty: 1000, portion_unit_id: 1, catalog_id: 5,
    },
    {
      id: 21, name: 'пюре 450г', name_en: '', name_sr: '',
      portion_qty: 450, portion_unit_id: 1, catalog_id: 5,
    },
    {
      id: 22, name: 'суп', name_en: '', name_sr: '',
      portion_qty: 300, portion_unit_id: 1, catalog_id: 5,
    },
  ],
  cardItems: [
    { card_id: 20, source_type: 'semi', ref_id: 10, qty: 1000, unit_id: 1, position: 0 },
    { card_id: 21, source_type: 'semi', ref_id: 11, qty: 450, unit_id: 1, position: 0 },
    { card_id: 22, source_type: 'raw', ref_id: 1, qty: 300, unit_id: 1, position: 0 },
  ],
  packagings: [
    {
      id: 100, card_id: 20, name: '1000 г', qty_base: 1000, min_order: 1,
      is_default: true, price: 100, price_basis: 'unit', cost: 50, available: true,
    },
    {
      id: 101, card_id: 21, name: '450 г', qty_base: 450, min_order: 1,
      is_default: true, price: 200, price_basis: 'portion', cost: 80, available: true,
    },
    {
      id: 102, card_id: 22, name: '300 г', qty_base: 300, min_order: 1,
      is_default: true, price: 300, price_basis: 'portion', cost: 90, available: true,
    },
  ],
};

test('сворачивает техкарту-фасовку в полуфабрикат', () => {
  const plan = planLegacyImport(base);
  const semi = plan.nodes.find((n) => n.legacyKind === 'semi' && n.legacyId === 10)!;
  assert.ok(semi);
  assert.equal(
    plan.nodes.filter((n) => n.legacyKind === 'card' && n.legacyId === 20).length,
    0
  );
  assert.equal(semi.packagings.some((p) => p.legacyId === 100), true);
});

test('переносит потери как 100 − yield', () => {
  const plan = planLegacyImport(base);
  const op = plan.ops.find((o) => o.legacySource === 'semi' && o.legacyId === 10)!;
  assert.equal(op.inputs[0].lossPct, 5);
  assert.equal(op.planQty, 1000);
});

test('не сворачивает техкарту с другим названием и составом', () => {
  const plan = planLegacyImport(base);
  assert.equal(
    plan.nodes.filter((n) => n.legacyKind === 'card' && n.legacyId === 22).length,
    1
  );
  const cardOp = plan.ops.find((o) => o.legacySource === 'card' && o.legacyId === 22)!;
  assert.equal(cardOp.inputs[0].nodeKey, 'raw:1');
});

test('на одном узле остаётся одна фасовка по умолчанию', () => {
  const plan = planLegacyImport(base);
  for (const node of plan.nodes) {
    assert.ok(
      node.packagings.filter((p) => p.isDefault).length <= 1,
      node.name
    );
  }
});
