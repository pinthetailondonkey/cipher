import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryMisses, emptyDelivery, sealedNoteText } from './deliveryAddress.js';

test('an untouched form misses five — the country arrived prefilled US', () => {
  const misses = deliveryMisses(emptyDelivery());
  assert.deepEqual(
    misses.map((miss) => miss.field),
    ['name', 'street', 'city', 'state', 'postalCode']
  );
});

test('a cleared form misses every field, with Money Moves\' words in form order', () => {
  const misses = deliveryMisses({ ...emptyDelivery(), country: '' });
  assert.deepEqual(
    misses.map((miss) => miss.field),
    ['name', 'street', 'city', 'state', 'postalCode', 'country']
  );
  assert.deepEqual(
    misses.map((miss) => miss.message),
    ['Who is this going to?', 'We need a street.', 'Which city?', 'Add the state.', 'Check the postal code.', 'Which country?']
  );
});

test('a complete US address passes, and US is the prefilled country', () => {
  assert.equal(emptyDelivery().country, 'US');
  const complete = { ...emptyDelivery(), name: 'Sam', street: '12 Main St', city: 'Austin', state: 'TX', postalCode: '78701' };
  assert.deepEqual(deliveryMisses(complete), []);
  // Five-plus-four is the same shape.
  assert.deepEqual(deliveryMisses({ ...complete, postalCode: '78701-1234' }), []);
});

test('a malformed US postal code misses with the same line as an empty one', () => {
  const base = { ...emptyDelivery(), name: 'Sam', street: '12 Main St', city: 'Austin', state: 'TX', country: 'US' };
  for (const bad of ['1234', '12abc', '123456', '7870 1']) {
    const miss = deliveryMisses({ ...base, postalCode: bad }).find((item) => item.field === 'postalCode');
    assert.equal(miss.message, 'Check the postal code.', bad);
  }
});

test('a US written another way still gets the postal and state shape checks', () => {
  const base = { ...emptyDelivery(), name: 'Sam', street: '12 Main St', city: 'Austin' };
  const miss = deliveryMisses({ ...base, country: 'usa', state: 'TX', postalCode: 'abcde' }).find((item) => item.field === 'postalCode');
  assert.equal(miss.message, 'Check the postal code.');
  // Deal's pin: a US region is two letters.
  const region = deliveryMisses({ ...base, country: 'US', state: 'Texas', postalCode: '78701' }).find((item) => item.field === 'state');
  assert.match(region.message, /two letters/);
});

test('another country keeps the check local: filled is fine, no invented shape', () => {
  const base = { ...emptyDelivery(), name: 'Sam', street: '10 Down St', city: 'London', state: 'LDN', country: 'GB' };
  assert.deepEqual(deliveryMisses({ ...base, postalCode: 'SW1A 1AA' }), []);
});

test('the address maps onto Deal\'s field shape for the sealed note', () => {
  const note = sealedNoteText({ ...emptyDelivery(), name: 'Sam Jones', street: '12 Main St Apt 4', city: 'Austin', state: 'tx', postalCode: '78701', country: 'US' });
  assert.deepEqual(JSON.parse(note), {
    name: 'Sam Jones',
    lines: ['12 Main St Apt 4'],
    city: 'Austin',
    region: 'tx',
    postal: '78701',
    country: 'US',
  });
});
