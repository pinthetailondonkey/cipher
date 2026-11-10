import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./useGroupDirectory.js', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ');

test('group-directory cache writes and read markers retain the account incarnation', () => {
  assert.match(source, /useMyGroups\(pubkey, securityFence\)[\s\S]*?assertSecurityContextOwner\(securityFence, pubkey\); setGroupsStore\(\(prev\) => \{ assertSecurityContextOwner\(securityFence, pubkey\);/);
  assert.match(source, /await db\.chatReads\.put\([\s\S]*?assertCurrent\(\); setUnreadCounts/);
});

test('joining, directory fetch, and group creation recheck before later store effects', () => {
  const join = source.slice(source.indexOf('const joinGroupById'), source.indexOf('const fetchGroups'));
  assert.match(join, /await joinGroup\([\s\S]*?assertCurrent\(\);[\s\S]*?setGroups\(/);
  assert.match(join, /if \(err\?\.code === 'SECURITY_CONTEXT_EXPIRED'\) return/);
  assert.match(join, /finally \{ try \{ assertCurrent\(\); setLoading\(false\)/);

  const fetch = source.slice(source.indexOf('const fetchGroups'), source.indexOf('const createGroup'));
  assert.match(fetch, /await getAuthenticatedPool\(identity\); assertCurrent\(\);/);
  assert.match(fetch, /await queryWithTimeout\([\s\S]*?assertCurrent\(\);/);
  assert.match(fetch, /setGroups\(allGroups\)/);

  const create = source.slice(source.indexOf('const createGroup'), source.indexOf('return { markAsRead'));
  assert.match(create, /await createGroupHook\([\s\S]*?assertCurrent\(\);[\s\S]*?openChat\(/);
  assert.match(create, /if \(err\?\.code === 'SECURITY_CONTEXT_EXPIRED'\) return/);
});
