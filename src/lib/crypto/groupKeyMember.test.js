import assert from 'node:assert/strict';
import test from 'node:test';
import { dmControlAction, installMemberGroupKey, isGroupKeyPayload } from '../../hooks/useGroupKeyMember.js';
import { parseGroupKeyBundle } from './groupKeyDistribution.js';

const HEX = 'ab'.repeat(32);

test('a key bundle is not a chat message, whether it uses t or type', () => {
  const modern = { v: 1, t: 'gkey', gid: 'g1', keys: [{ ep: 2, k: HEX }] };
  const legacy = { type: 'gkey', gid: 'g1', keys: [{ ep: 2, k: HEX }] };
  assert.equal(isGroupKeyPayload(modern), true);
  assert.equal(dmControlAction(modern), 'gkey');
  assert.equal(dmControlAction(legacy), 'gkey');
  assert.equal(dmControlAction({ type: 'text', message: 'hi' }), null);
  assert.equal(dmControlAction({ type: 'pin' }), 'pin');
  assert.deepEqual(parseGroupKeyBundle(modern), [{ groupId: 'g1', epoch: 2, hex: HEX }]);
});

test('install refuses a normal message, a bad key, and a bundle before the database is open', async () => {
  assert.equal(await installMemberGroupKey({ type: 'text', message: 'hi' }), false);
  assert.equal(await installMemberGroupKey({ t: 'gkey', gid: 'g1', keys: [{ ep: 1, k: 'zz' }] }), false);
  assert.equal(await installMemberGroupKey({ t: 'gkey', gid: 'g1', keys: [{ ep: 1, k: HEX }] }), false);
});
