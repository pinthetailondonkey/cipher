import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Day log #19: nothing fetched kind 0 for a peer whose first DM arrived
// live after bootstrap, so the chat header and the row showed the npub
// until a reload. The fix mirrors the groupSenderKey memo for DM peers:
// the set of peer keys in the dms map, and one effect that runs the
// db-cache-then-relay profile fetch when that set changes. This is a
// source-contract witness (mediaCrypto.test.js:45-47 precedent): it pins
// the wiring exists and that the header was not pointed at a second
// profile source. It does not prove a relay answered — the store writer
// itself is already covered by its own behavior elsewhere.

const read = (url) => fs.readFileSync(new URL(url, import.meta.url), 'utf8');

const SOURCE = read('./useChatBootstrap.js')
  .replace(/\s+/g, ' ')
  .replace(/\(\s+/g, '(')
  .replace(/\s+\)/g, ')')
  .replace(/\[\s+/g, '[')
  .replace(/\s+\]/g, ']');

test('the dm peer set is memoized and drives the same profile fetch the group senders get', () => {
  // The mirror of groupSenderKey: the sorted peer keys of the dms map, so
  // the effect fires when a NEW peer appears live, not on every message.
  assert.match(
    SOURCE,
    /const dmPeerKey = useMemo\(\(\) => Object\.keys\(dms\)\.sort\(\)\.join\(','\), \[dms\]\)/,
    'day log #19: the dm peer set must be memoized over the dms map, mirroring groupSenderKey',
  );
  assert.match(
    SOURCE,
    /useEffect\(\(\) => \{ if \(!dmPeerKey\) return; fetchProfilesForPubkeys\(dmPeerKey\.split\(','\)\); \}, \[dmPeerKey\]\)/,
    'day log #19: a new dm peer must reach fetchProfilesForPubkeys, the one store writer for kind 0',
  );
});

test('the fix stays on the store: the chat header does not grow a second profile source', () => {
  const header = read('../../components/chat/ChatHeader.jsx');
  assert.equal(header.includes('useProfiles'), false,
    'day log #19: ChatHeader must keep reading the store, not the useProfiles hook');
});
