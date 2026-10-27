import assert from 'node:assert/strict';
import test from 'node:test';
import { groupMetaAnnouncement } from './groupMetaAnnouncement.js';

test('a replayed 9002 whose name equals the stored name announces nothing', () => {
  assert.equal(groupMetaAnnouncement({ current: { name: 'Market' }, name: 'Market', createdAt: 200 }), null);
});

test('a genuine rename announces exactly the old wording and yields the applied state', () => {
  const decision = groupMetaAnnouncement({ current: { name: 'Market' }, name: 'Bazaar', createdAt: 200 });
  assert.deepEqual(decision, {
    text: 'Group name was changed to "Bazaar"',
    name: 'Bazaar',
    appliedAt: 200,
  });
});

test('a 9002 older than the metadata already applied never announces, even with a foreign name', () => {
  assert.equal(groupMetaAnnouncement({ current: { name: 'Bazaar' }, name: 'Market', createdAt: 100, appliedAt: 200 }), null);
});

test('an equal created_at replay falls through to the name comparison', () => {
  assert.equal(groupMetaAnnouncement({ current: { name: 'Bazaar' }, name: 'Bazaar', createdAt: 200, appliedAt: 200 }), null);
  const changed = groupMetaAnnouncement({ current: { name: 'Bazaar' }, name: 'Market', createdAt: 200, appliedAt: 200 });
  assert.equal(changed.text, 'Group name was changed to "Market"');
});

test('a description edit announces only when the stored about differs', () => {
  assert.equal(groupMetaAnnouncement({ current: { name: 'Bazaar', about: 'goods' }, name: 'Bazaar', about: 'goods', createdAt: 200 }), null);
  const changed = groupMetaAnnouncement({ current: { name: 'Bazaar' }, name: 'Bazaar', about: 'goods', createdAt: 200 });
  assert.deepEqual(changed, { text: 'Group description was updated', about: 'goods', appliedAt: 200 });
});

test('a name and an about changed together announce the name and apply both', () => {
  const changed = groupMetaAnnouncement({ current: { name: 'Market', about: '' }, name: 'Bazaar', about: 'goods', createdAt: 300 });
  assert.equal(changed.text, 'Group name was changed to "Bazaar"');
  assert.equal(changed.name, 'Bazaar');
  assert.equal(changed.about, 'goods');
});

test('a missing or empty name tag is not a rename', () => {
  assert.equal(groupMetaAnnouncement({ current: { name: 'Bazaar' }, name: undefined, createdAt: 200 }), null);
  assert.equal(groupMetaAnnouncement({ current: { name: 'Bazaar' }, name: '', createdAt: 200 }), null);
});

test('missing timestamps degrade to the name comparison, not to silence', () => {
  const changed = groupMetaAnnouncement({ current: { name: 'Market' }, name: 'Bazaar' });
  assert.equal(changed.text, 'Group name was changed to "Bazaar"');
  assert.equal(changed.appliedAt, 0);
});
