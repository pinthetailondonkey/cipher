import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSecurityContextFence, establishSecurityContext, invalidateAllSecurityContexts,
  invalidateSecurityContext, retireSecurityContext, assertSecurityContextOwner,
  listSecurityContextOwners,
} from './securityContextFence.js';

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function channelHub() {
  const listeners = new Set();
  return {
    channel() {
      return {
        addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
        removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
        postMessage(data) { for (const listener of listeners) listener({ data }); },
      };
    },
  };
}

const ownerA = 'a'.repeat(64);
const ownerB = 'b'.repeat(64);

test('same-account tabs own independent incarnations without overwriting one another', () => {
  const backing = storage();
  let id = 0;
  const randomId = () => `incarnation-${String(++id).padStart(12, '0')}`;
  const first = establishSecurityContext({ owner: ownerA, storage: backing, randomId });
  const secondTab = establishSecurityContext({ owner: ownerA, storage: backing, randomId });
  const otherAccount = establishSecurityContext({ owner: ownerB, storage: backing, randomId });
  assert.notEqual(first.incarnation, secondTab.incarnation);
  assert.notEqual(first.incarnation, otherAccount.incarnation);
  const firstFence = createSecurityContextFence({ context: first, storage: backing });
  const secondFence = createSecurityContextFence({ context: secondTab, storage: backing });
  assert.equal(firstFence.isCurrent(), true);
  assert.equal(secondFence.isCurrent(), true);
});

test('local retirement invalidates only that tab and preserves the sibling account context', () => {
  const backing = storage();
  let id = 0;
  const randomId = () => `incarnation-${String(++id).padStart(12, '0')}`;
  const first = establishSecurityContext({ owner: ownerA, storage: backing, randomId });
  const second = establishSecurityContext({ owner: ownerA, storage: backing, randomId });
  const firstFence = createSecurityContextFence({ context: first, storage: backing });
  const secondFence = createSecurityContextFence({ context: second, storage: backing });
  firstFence.invalidate('local-lock');
  const result = retireSecurityContext({ context: first, storage: backing });
  assert.equal(result.persisted, true);
  assert.equal(firstFence.isCurrent(), false);
  assert.equal(secondFence.isCurrent(), true);
});

test('durable account invalidation makes a suspended tab fail closed', () => {
  const backing = storage();
  const context = establishSecurityContext({ owner: ownerA, storage: backing, randomId: () => 'incarnation-00000001' });
  const fence = createSecurityContextFence({ context, storage: backing });
  assert.equal(fence.isCurrent(), true);
  const result = invalidateSecurityContext({ owner: ownerA, storage: backing });
  assert.deepEqual({ persisted: result.persisted, invalidated: result.invalidated }, { persisted: true, invalidated: true });
  assert.equal(fence.isCurrent(), false);
  assert.throws(() => fence.assertCurrent(), { code: 'SECURITY_CONTEXT_EXPIRED' });
});

test('account invalidation broadcasts only to the exact account incarnation', () => {
  const backing = storage();
  const hub = channelHub();
  const a = establishSecurityContext({ owner: ownerA, storage: backing, randomId: () => 'incarnation-aaaaaaaa' });
  const b = establishSecurityContext({ owner: ownerB, storage: backing, randomId: () => 'incarnation-bbbbbbbb' });
  let aInvalidations = 0;
  let bInvalidations = 0;
  const aFence = createSecurityContextFence({ context: a, storage: backing, channel: hub.channel(), onInvalidate: () => { aInvalidations += 1; } });
  const bFence = createSecurityContextFence({ context: b, storage: backing, channel: hub.channel(), onInvalidate: () => { bInvalidations += 1; } });
  const result = invalidateSecurityContext({ owner: ownerA, storage: backing, channel: hub.channel() });
  assert.equal(result.broadcast, true);
  assert.equal(aFence.isCurrent(), false);
  assert.equal(bFence.isCurrent(), true);
  assert.equal(aInvalidations, 1);
  assert.equal(bInvalidations, 0);
});

test('invalidating an account with no live marker is a successful no-op', () => {
  const result = invalidateSecurityContext({ owner: ownerA, storage: storage() });
  assert.deepEqual(result, { invalidated: true, persisted: true, broadcast: false, errors: [] });
});

test('storage refusal is explicit and all-context invalidation does not claim success', () => {
  const backing = storage();
  const context = establishSecurityContext({ owner: ownerA, storage: backing, randomId: () => 'incarnation-aaaaaaaa' });
  createSecurityContextFence({ context, storage: backing });
  const refusing = { ...backing, removeItem() { throw new Error('storage denied'); } };
  const one = invalidateSecurityContext({ owner: ownerA, storage: refusing });
  assert.equal(one.persisted, false);
  assert.match(one.errors.join(' '), /storage denied/);
  const all = invalidateAllSecurityContexts({ storage: { get length() { throw new Error('enumeration denied'); } } });
  assert.equal(all.persisted, false);
  assert.match(all.errors.join(' '), /enumerate/);
});

test('whole-origin invalidation clears and broadcasts each known account context', () => {
  const backing = storage();
  const hub = channelHub();
  const a = establishSecurityContext({ owner: ownerA, storage: backing, randomId: () => 'incarnation-aaaaaaaa' });
  const b = establishSecurityContext({ owner: ownerB, storage: backing, randomId: () => 'incarnation-bbbbbbbb' });
  const aFence = createSecurityContextFence({ context: a, storage: backing, channel: hub.channel() });
  const bFence = createSecurityContextFence({ context: b, storage: backing, channel: hub.channel() });
  const result = invalidateAllSecurityContexts({ storage: backing, channel: hub.channel() });
  assert.equal(result.persisted, true);
  assert.equal(result.results.length, 2);
  assert.equal(aFence.isCurrent(), false);
  assert.equal(bFence.isCurrent(), false);
});

test('owner inventory captures accounts before whole-origin invalidation clears the markers', () => {
  const backing = storage();
  establishSecurityContext({ owner: ownerA, storage: backing, randomId: () => 'incarnation-aaaaaaaa' });
  establishSecurityContext({ owner: ownerA, storage: backing, randomId: () => 'incarnation-aaaaaaab' });
  establishSecurityContext({ owner: ownerB, storage: backing, randomId: () => 'incarnation-bbbbbbbb' });
  assert.deepEqual(listSecurityContextOwners({ storage: backing }), { owners: [ownerA, ownerB], errors: [] });
});

test('caller fence contract rejects missing, mismatched, and retired account contexts', () => {
  const backing = storage();
  const context = establishSecurityContext({ owner: ownerA, storage: backing, randomId: () => 'incarnation-aaaaaaaa' });
  const fence = createSecurityContextFence({ context, storage: backing });
  assert.equal(assertSecurityContextOwner(fence, ownerA), undefined);
  assert.throws(() => assertSecurityContextOwner(fence, ownerB), { code: 'SECURITY_CONTEXT_EXPIRED' });
  assert.throws(() => assertSecurityContextOwner(null, ownerA), { code: 'SECURITY_CONTEXT_EXPIRED' });
  retireSecurityContext({ context, storage: backing });
  assert.throws(() => assertSecurityContextOwner(fence, ownerA), { code: 'SECURITY_CONTEXT_EXPIRED' });
});
