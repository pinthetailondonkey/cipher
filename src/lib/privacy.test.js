import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { allowsLinkPreviews, getPrivacy, setPrivacy } from './privacy.js';
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

test('link previews are off until the user turns them on', () => {
  localStorage.setItem('cipher_active_pubkey', 'ef'.repeat(32));
  assert.equal(getPrivacy().linkPreviews, false);
  assert.equal(allowsLinkPreviews(), false);
  setPrivacy({ linkPreviews: true });
  assert.equal(allowsLinkPreviews(), true);
  setPrivacy({ linkPreviews: false });
  assert.equal(allowsLinkPreviews(), false);
  const bubble = fs.readFileSync(new URL('../components/MessageBubble.jsx', import.meta.url), 'utf8');
  assert.match(bubble, /previewUrl && allowsLinkPreviews\(\) && <LinkPreview/);
});

test('blocking from a profile is kept for that account and reaches the ingest filter', async () => {
  localStorage.setItem('cipher_active_pubkey', '12'.repeat(32));
  const { useChatStore } = await import('../store/chatStore.js');
  const someone = '34'.repeat(32);
  useChatStore.getState().toggleBlockUser(someone);
  assert.equal(useChatStore.getState().blockedUsers.includes(someone), true);
  assert.deepEqual(scopedGet('blocked', []), [someone]);
  useChatStore.getState().toggleBlockUser(someone);
  assert.deepEqual(scopedGet('blocked', []), []);
  const profile = fs.readFileSync(new URL('../components/ProfileModal.jsx', import.meta.url), 'utf8');
  assert.match(profile, /toggleBlockUser\(pubkey\)/);
  assert.match(profile, /blocked \? 'Unblock' : 'Block'/);
  const dm = fs.readFileSync(new URL('../hooks/useNIP44DM.js', import.meta.url), 'utf8');
  assert.ok(dm.indexOf('blocked.includes(counterparty)') < dm.indexOf("data.type === 'call'"));
});

test('no message action is offered that leads nowhere', () => {
  const bubble = fs.readFileSync(new URL('../components/MessageBubble.jsx', import.meta.url), 'utf8');
  const commands = fs.readFileSync(new URL('../features/chat/useMessageCommands.js', import.meta.url), 'utf8');
  const settings = fs.readFileSync(new URL('../components/chat/PrivacySettings.jsx', import.meta.url), 'utf8');
  assert.equal(bubble.includes("'forward'"), false);
  for (const gone of ["'forward'", "'select'", "'report'", "'report_scam'", "'mark_sold_out'", 'handleForwardSubmit', 'Report submitted']) {
    assert.equal(commands.includes(gone), false, gone);
  }
  assert.equal(settings.includes('Forwarding'), false);
  assert.equal('forwarding' in getPrivacy(), false);
});
