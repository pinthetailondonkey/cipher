import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SOURCE = readFileSync(new URL('./useMessageCommands.js', import.meta.url), 'utf8');
const FENCE = 'assertCurrent(securityFence)';

test('message deletion rechecks the account incarnation before local and relay effects', () => {
  const start = SOURCE.indexOf("if (action === 'delete') {");
  const end = SOURCE.indexOf("if (action === 'pin'", start);
  assert.ok(start >= 0 && end > start, 'delete action is located');
  const body = SOURCE.slice(start, end);
  assert.match(body, /let securityFence;\s*try \{ securityFence = captureFence\(\); \} catch \{ return; \}\s*try \{\s*assertCurrent\(securityFence\);\s*const state = useChatStore/);
  assert.match(body, /await deleteMessageForGood\([\s\S]*?assertCurrent\(securityFence\);/);
  assert.match(body, /await import\('nostr-tools'\);\s*assertCurrent\(securityFence\);/);
  assert.match(body, /await getAuthenticatedPool\(identity\);\s*assertCurrent\(securityFence\);/);
  assert.match(body, /await Promise\.allSettled\(pool\.publish\(generalRelays, deletionEvent\)\);\s*assertCurrent\(securityFence\);/);
  assert.ok(body.includes(FENCE));
});

test('delayed edit, reaction, retry, and pin callbacks hold effects after retirement', () => {
  assert.match(SOURCE, /await sendReaction\([\s\S]*?\);\s*assertCurrent\(securityFence\)/);
  assert.match(SOURCE, /await retrySecuringGroup\([\s\S]*?\);\s*assertCurrent\(securityFence\)/);
  assert.match(SOURCE, /await patchMessage\([\s\S]*?\)\) \{\s*assertCurrent\(securityFence\);\s*const updated = await db\.messages\.get\(msg\.id\);\s*assertCurrent\(securityFence\)/);
  assert.match(SOURCE, /await pinMessage\([\s\S]*?\);\s*assertCurrent\(securityFence\)/);
  assert.match(SOURCE, /await startOrderWithVendor\([\s\S]*?\);\s*assertCurrent\(securityFence\)/);
});

test('bookmark writes and delegated order completion use the captured identity', () => {
  const bookmark = SOURCE.slice(SOURCE.indexOf("if (action === 'bookmark')"), SOURCE.indexOf("if (action === 'edit_history')"));
  assert.match(bookmark, /securityFence = captureFence\(\)/);
  assert.match(bookmark, /assertCurrent\(securityFence\);\s*useChatStore\.getState\(\)\.toggleBookmark\([\s\S]*?assertCurrent\(securityFence\)/);
  const delegated = SOURCE.slice(SOURCE.indexOf('// Order actions delegated to handleOrderAction'));
  assert.match(delegated, /const handled = await handleOrderAction\(action, msg\);\s*assertCurrent\(securityFence\);\s*if \(handled\) return/);
});
