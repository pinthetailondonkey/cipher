import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SOURCE = readFileSync(new URL('./useReactions.js', import.meta.url), 'utf8');
const FENCE = 'assertSecurityContextOwner(identity.securityFence, identity.pk)';

test('reaction send and revoke paths recheck context around local writes and relay sends', () => {
  const start = SOURCE.indexOf('const sendReaction = useCallback');
  const end = SOURCE.indexOf('\n  const subscribeToReactions', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);\s*const \{ finalizeEvent \} = await import/);
  assert.match(body, /await db\.tombstones\.put\([\s\S]*?assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);/);
  assert.match(body, /pool\.publish\(relays, del\)/);
  assert.match(body, /await Promise\.allSettled\(pool\.publish\(relays, ev\)\);\s*assertSecurityContextOwner/);
  assert.ok(body.includes(FENCE));
});

test('reaction subscriptions discard stale history and live callbacks', () => {
  const start = SOURCE.indexOf('const subscribeToReactions = useCallback');
  const end = SOURCE.indexOf('\n  const subscribeToGroupReactions', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /await queryWithTimeout\([\s\S]*?assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);/);
  assert.match(body, /await deletedIdsAmong\(\[ev\]\)[\s\S]*?assertSecurityContextOwner\(identity\.securityFence, identity\.pk\)/);
  assert.match(body, /try \{ assertSecurityContextOwner\(identity\.securityFence, identity\.pk\); \} catch \{ return; \}\s*setReactions/);

  const groupStart = SOURCE.indexOf('const subscribeToGroupReactions = useCallback');
  const groupEnd = SOURCE.indexOf('\n  return { sendReaction', groupStart);
  const group = SOURCE.slice(groupStart, groupEnd);
  assert.match(group, /const apply = async \(ev\) => \{\s*try \{ assertSecurityContextOwner/);
  assert.match(group, /await deletedIdsAmong\(\[ev\]\)[\s\S]*?try \{ assertSecurityContextOwner/);
});
