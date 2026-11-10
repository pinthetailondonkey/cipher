import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SOURCE = readFileSync(new URL('./useChatBootstrap.js', import.meta.url), 'utf8');
const FENCE = 'assertSecurityContextOwner(syncIdentity.securityFence, syncIdentity.pk)';
const FETCH_FENCE = 'assertSecurityContextOwner(identity.securityFence, identity.pk)';

test('group history sync carries and rechecks its captured account incarnation', () => {
  assert.match(SOURCE, /\(\) => \(\{ pk: identity\?\.pk, sk: identity\?\.sk, securityFence: identity\?\.securityFence \}\)/);
  assert.match(SOURCE, /\[identity\?\.pk, identity\?\.sk, identity\?\.securityFence\]/);

  const start = SOURCE.indexOf('const syncGroupMessages = useCallback(async (groupId) => {');
  const end = SOURCE.indexOf('\n  }, [syncIdentity, setGroupMessages]);', start);
  assert.ok(start >= 0 && end > start, 'syncGroupMessages is present');
  const body = SOURCE.slice(start, end);
  assert.ok(body.split(FENCE).length - 1 >= 8, 'the captured fence is checked at each async boundary');
  const fenceAt = (position) => body.indexOf(FENCE, position);
  const poolAt = body.indexOf('const pool = await getAuthenticatedPool');
  const eventsAt = body.indexOf('const events = await queryAllPages');
  const standingAt = body.indexOf('const standing = await loadVerifiedMemberSnapshot');
  const decodeAt = body.indexOf('const decoded = await decodeGroupEvent');
  const saveAt = body.indexOf('await saveMessage(groupId, message)');
  const storeAt = body.indexOf('setGroupMessages((previous)');
  assert.ok(fenceAt() < poolAt && fenceAt(poolAt) > poolAt);
  assert.ok(fenceAt(eventsAt) > eventsAt);
  assert.ok(fenceAt(standingAt) > standingAt);
  assert.ok(fenceAt(decodeAt) > decodeAt);
  assert.ok(fenceAt(saveAt) > saveAt);
  assert.ok(fenceAt() < storeAt);
});

test('outbox UI callbacks retain their account fence across database awaits', () => {
  const start = SOURCE.indexOf('const handleOutboxStatus = async (event) => {');
  const end = SOURCE.indexOf("window.addEventListener('cipher:outbox-status'", start);
  assert.ok(start >= 0 && end > start, 'outbox status callback is present');
  const body = SOURCE.slice(start, end);
  const dbReadsAt = body.indexOf('await Promise.all');
  assert.ok(body.indexOf('if (!isCurrent()) return;') < dbReadsAt);
  assert.ok(body.indexOf('if (!isCurrent()) return;', dbReadsAt) > dbReadsAt);
  assert.match(body, /await db\.messages\.put\(updatedMessage\);\s*if \(!isCurrent\(\)\) return;/);
  assert.match(body, /if \(!isCurrent\(\)\) return;\s*if \(message\.isGroup\)/);
});

test('username restore, push registration, and member-baseline publish retain the active fence', () => {
  const usernameStart = SOURCE.indexOf('const fetchMyUsername = async () => {');
  const usernameEnd = SOURCE.indexOf('\n    };', usernameStart);
  const username = SOURCE.slice(usernameStart, usernameEnd);
  assert.ok(username.indexOf('await getAuthenticatedPool') < username.lastIndexOf('if (!isCurrent()) return;'));
  assert.ok(username.indexOf('await queryWithTimeout') < username.lastIndexOf('if (!isCurrent()) return;'));

  const pushStart = SOURCE.indexOf('const run = () => {', SOURCE.indexOf('registerWithGateway({') - 1200);
  const pushEnd = SOURCE.indexOf("window.addEventListener('cipher:network'", pushStart);
  const push = SOURCE.slice(pushStart, pushEnd);
  assert.match(push, /if \(cancelled \|\| !isCurrent\(\)\) return;/);
  assert.match(push, /\.then\(\(result\) => \{\s*if \(cancelled \|\| !isCurrent\(\)/);

  const baselineStart = SOURCE.indexOf('bindMemberBaselinePublisher(async (groupId, members) => {');
  const baselineEnd = SOURCE.indexOf('\n    });', baselineStart);
  const baseline = SOURCE.slice(baselineStart, baselineEnd);
  assert.ok(baseline.indexOf('await getAuthenticatedPool') < baseline.lastIndexOf('assertSecurityContextOwner'));
  assert.match(baseline, /await Promise\.allSettled\(pool\.publish\(relays, event\)\);\s*assertSecurityContextOwner/);
});

test('chat bootstrap fetch fences its DB cleanup and state updates across awaits', () => {
  const start = SOURCE.indexOf('const fetchChats = async (showLoader = false) => {');
  const end = SOURCE.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, 'fetchChats is present');
  const body = SOURCE.slice(start, end);
  assert.ok(body.indexOf('await stageOne') < body.indexOf(FETCH_FENCE, body.indexOf('await stageOne')));
  assert.ok(body.indexOf('await stageTwo') < body.indexOf(FETCH_FENCE, body.indexOf('await stageTwo')));
  assert.match(body, /await db\.messages\.bulkDelete\(expiredIds\);\s*assertSecurityContextOwner/);
  assert.match(body, /await db\.chatReads\.toArray\(\);\s*assertSecurityContextOwner/);
  assert.match(body, /await splitRows\(liveDbMsgs\);\s*assertSecurityContextOwner/);
  assert.match(body, /finally \{\s*if \(identity\?\.securityFence\?\.isCurrent\?\.\(\)\) setLoading\(false\);/);

  const splitStart = SOURCE.indexOf('const splitRows = async (rows) => {');
  const splitEnd = SOURCE.indexOf('\n  };', splitStart);
  const split = SOURCE.slice(splitStart, splitEnd);
  assert.match(split, /await new Promise\(\(r\) => setTimeout\(r, 0\)\);[\s\S]*?assertSecurityContextOwner/);
});

test('group-key update events cannot start a stale queued-send flush', () => {
  const start = SOURCE.indexOf("window.addEventListener('cipher:group-key-updated'");
  const effectStart = SOURCE.lastIndexOf('useEffect(() => {', start);
  const effectEnd = SOURCE.indexOf('\n  }, [identity?.pk, identity?.sk, identity?.securityFence]);', effectStart);
  const body = SOURCE.slice(effectStart, effectEnd);
  assert.match(body, /if \(!identity\?\.sk \|\| !identity\?\.securityFence\) return undefined/);
  assert.match(body, /assertSecurityContextOwner\(identity\.securityFence, identity\.pk\); \}\s*catch \{ return; \}/);
  assert.match(body, /flushSecuringGroupSends\(identity, groupId\)\.catch/);
  assert.match(SOURCE, /\[identity\?\.pk, identity\?\.sk, identity\?\.securityFence\]/);
});
