import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/http';
import { packagingSnapshot, packagingsSql, parsePackagings, type Packaging } from '../src/services/packagings';

const valid = () => ({
  name: '  Коробка 6 шт  ', qtyBase: 6, orderStep: 3, isDefault: true,
  items: [{ productId: 1, qty: 1 }],
});
const badRequest = (e: unknown) => e instanceof ApiError && e.status === 400;

// Не JSON.stringify: NaN/Infinity должны дойти до DTO как числа, а не стать null.
const invalidNumbers: unknown[] = [NaN, Infinity, -Infinity, null, true, false, '', '3', {}, [], undefined, 0, -1];
for (const field of ['qtyBase', 'orderStep', 'id'] as const) {
  for (const value of invalidNumbers) {
    if (field === 'id' && value === undefined) continue;
    test(`DTO: ${field} rejects ${String(value)} (${typeof value})`, () => {
      assert.throws(() => parsePackagings([{ ...valid(), [field]: value }]), badRequest);
    });
  }
}
for (const field of ['productId', 'qty'] as const) {
  for (const value of invalidNumbers) {
    test(`DTO: item.${field} rejects ${String(value)} (${typeof value})`, () => {
      assert.throws(() => parsePackagings([{ ...valid(), items: [{ productId: 1, qty: 1, [field]: value }] }]), badRequest);
    });
  }
}
for (const value of [0.5, 2147483648, Number.MAX_SAFE_INTEGER]) {
  test(`DTO: integer fields reject ${value}`, () => {
    for (const field of ['id', 'orderStep']) {
      assert.throws(() => parsePackagings([{ ...valid(), [field]: value }]), badRequest);
    }
    assert.throws(() => parsePackagings([{ ...valid(), items: [{ productId: value, qty: 1 }] }]), badRequest);
  });
}

test('DTO: only orderStep; trim name, fractional net/component quantity and int boundary', () => {
  assert.deepEqual(parsePackagings([{ ...valid(), qtyBase: 0.25, orderStep: 2147483647, items: [{ productId: 2147483647, qty: 0.5 }] }]), [{
    name: 'Коробка 6 шт', qtyBase: 0.25, orderStep: 2147483647, isDefault: true,
    items: [{ productId: 2147483647, qty: 0.5 }],
  }]);
  assert.deepEqual(parsePackagings([valid()])[0], { ...valid(), name: 'Коробка 6 шт' });
  assert.deepEqual(parsePackagings([]), []);
  assert.deepEqual(parsePackagings([{ ...valid(), items: [] }])[0].items, []);
});

test('DTO: malformed arrays, entries, name, items and default flag rejected', () => {
  for (const raw of [undefined, null, true, 1, '[]', {}]) {
    assert.throws(() => parsePackagings(raw), badRequest);
  }
  for (const entry of [null, true, 1, 'packaging', []]) {
    assert.throws(() => parsePackagings([entry]), badRequest);
    assert.throws(() => parsePackagings([{ ...valid(), items: [entry] }]), badRequest);
  }
  for (const name of ['', '  ', null, true, 123, undefined]) {
    assert.throws(() => parsePackagings([{ ...valid(), name }]), badRequest);
  }
  for (const items of [null, {}, '', true, 1, undefined]) {
    assert.throws(() => parsePackagings([{ ...valid(), items }]), badRequest);
  }
  for (const isDefault of [null, 'true', 1, undefined]) {
    assert.throws(() => parsePackagings([{ ...valid(), isDefault }]), badRequest);
  }
});

test('DTO: exactly one default, unique packaging IDs and component product IDs', () => {
  assert.throws(() => parsePackagings([{ ...valid(), isDefault: false }]), badRequest);
  assert.throws(() => parsePackagings([valid(), valid()]), badRequest);
  assert.throws(() => parsePackagings([{ ...valid(), id: 1 }, { ...valid(), id: 1, isDefault: false }]), badRequest);
  assert.throws(() => parsePackagings([{ ...valid(), items: [{ productId: 1, qty: 1 }, { productId: 1, qty: 2 }] }]), badRequest);
  assert.equal(parsePackagings([valid(), { ...valid(), isDefault: false }]).length, 2,
    'the same component may appear in different packagings');
});

test('SQL projections: store only exposes packaging metadata, office includes all component fields', () => {
  const jsonKeys = (sql: string) => [...sql.matchAll(/'([A-Za-z]+)'\s*,/g)].map((m) => m[1]);
  assert.deepEqual(jsonKeys(packagingsSql(false)), ['id', 'name', 'qtyBase', 'orderStep', 'isDefault']);
  assert.doesNotMatch(packagingsSql(false), /product_packaging_items|\bstock\b|avg_cost|items|cost/i);
  assert.deepEqual(jsonKeys(packagingsSql(true)), [
    'id', 'name', 'qtyBase', 'orderStep', 'isDefault', 'items',
    'productId', 'qty', 'productName', 'unitCode', 'avgCost', 'stockQty',
  ]);
});

test('audit snapshot ignores live stock/cost but retains packaging definition and component quantities', () => {
  const p: Packaging = {
    ...valid(), id: 10,
    items: [{ productId: 1, qty: 1, productName: 'Коробка', unitCode: 'шт', avgCost: 5, stockQty: 20 }],
  };
  const snapshot = packagingSnapshot([p]);
  assert.deepEqual(snapshot, [{
    id: 10, name: p.name, qtyBase: 6, orderStep: 3, isDefault: true,
    items: [{ productId: 1, qty: 1, productName: 'Коробка', unitCode: 'шт' }],
  }]);
  p.items[0].avgCost = 99;
  p.items[0].stockQty = 1;
  assert.deepEqual(packagingSnapshot([p]), snapshot);
  p.items[0].qty = 2;
  assert.notDeepEqual(packagingSnapshot([p]), snapshot);
});
