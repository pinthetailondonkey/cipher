import assert from 'node:assert/strict';
import test from 'node:test';
import { getPrivacy, setPrivacy } from './privacy.js';
import { scopedGet, scopedSet } from './storage.js';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  key: (index) => Array.from(memory.keys())[index] || null,
  get length() { return memory.size; },
};

test('a privacy read returns the same object until the setting changes', () => {
  localStorage.setItem('cipher_active_pubkey', 'ab'.repeat(32));
  const first = getPrivacy();
  assert.equal(getPrivacy(), first);
  const changed = setPrivacy({ typing: false });
  assert.equal(changed.typing, false);
  const next = getPrivacy();
  assert.equal(next.typing, false);
  assert.equal(getPrivacy(), next);
  assert.notEqual(next, first);
});

test('an unchanged profile write keeps the same object', async () => {
  const { useChatStore } = await import('../store/chatStore.js');
  const before = useChatStore.getState().profiles;
  useChatStore.getState().setProfiles((current) => ({ ...current }));
  assert.equal(useChatStore.getState().profiles, before);
  const message = { id: 'm1' };
  useChatStore.getState().setDms({ room: [message] });
  useChatStore.getState().setDms((current) => ({ ...current, room: current.room }));
  assert.equal(useChatStore.getState().dms.room[0], message);
});

test('scoped storage does not allocate a new value on every read', () => {
  localStorage.setItem('cipher_active_pubkey', 'cd'.repeat(32));
  scopedSet('example', { ok: true });
  const first = scopedGet('example', {});
  assert.equal(scopedGet('example', {}), first);
  assert.deepEqual(first, { ok: true });
});
