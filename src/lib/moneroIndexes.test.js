import assert from 'node:assert/strict';
import test from 'node:test';
import { moneroIndexesToCreate } from './vendorPayments.js';

test('Monero subaddress creation only fills indexes the cached wallet does not have', () => {
  assert.deepEqual(moneroIndexesToCreate(0, 5), [1, 2, 3, 4, 5]);
  assert.equal(moneroIndexesToCreate(4999, 5000).length, 1);
  assert.deepEqual(moneroIndexesToCreate(4999, 5000), [5000]);
  assert.deepEqual(moneroIndexesToCreate(5000, 5000), []);
  assert.deepEqual(moneroIndexesToCreate(5000, 5), []);
  const cold = moneroIndexesToCreate(0, 5000);
  assert.equal(cold.length, 5000);
  assert.equal(cold[0], 1);
  assert.equal(cold[cold.length - 1], 5000);
});
