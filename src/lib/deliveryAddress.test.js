import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryFromNoteText, deliveryMisses, emptyDelivery, sealedNoteText } from './deliveryAddress.js';

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

// ————— vendor side: reading the seal back out —————

test('the vendor reads the seal back onto the form — a full round trip', () => {
  const form = { ...emptyDelivery(), name: 'Sam Jones', street: '12 Main St Apt 4', city: 'Austin', state: 'TX', postalCode: '78701' };
  const { form: read, misses } = deliveryFromNoteText(sealedNoteText(form));
  assert.deepEqual(misses, []);
  assert.deepEqual(read, form);
});

test('an unreadable note misses on the note itself and is never guessed', () => {
  for (const bad of ['', 'not json', '{"name": "x"', 'null', '[1,2,3]', '123', 'true']) {
    const { misses } = deliveryFromNoteText(bad);
    assert.deepEqual(misses.map((miss) => miss.field), ['note'], bad);
    assert.deepEqual(deliveryFromNoteText(bad).form, emptyDelivery());
  }
});

test('a note missing a field names that field with the buyer\'s words, so the vendor can ask for it', () => {
  const torn = JSON.stringify({ name: 'Sam', city: 'Austin', region: 'TX', postal: '78701', country: 'US' });
  const { misses } = deliveryFromNoteText(torn);
  assert.deepEqual(misses.map((miss) => miss.field), ['street']);
  assert.equal(misses[0].message, 'We need a street.');
});

test('a tampered-in note still meets the US shape checks — no trust edge crossed', () => {
  // A hand-forged note claiming a US state with more than two letters is
  // caught exactly like the buyer-side form was.
  const forged = JSON.stringify({ name: 'x', lines: ['1 North'], city: 'a', region: 'Texas', postal: '78701', country: 'US' });
  const { misses } = deliveryFromNoteText(forged);
  assert.deepEqual(misses.map((miss) => miss.field), ['state']);
  assert.match(misses[0].message, /two letters/);
});
