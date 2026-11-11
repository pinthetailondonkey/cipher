import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('signed reputation actions retain the active account context across async boundaries', () => {
  const source = read('./useReputation.js');
  assert.match(source, /assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);\s*const \{ finalizeEvent \} = await import\('nostr-tools'\);\s*assertSecurityContextOwner/);
  assert.match(source, /await getAuthenticatedPool\(identity\);\s*assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);/);
  assert.match(source, /await Promise\.allSettled\(pool\.publish\(reputationRelays, (?:event|ev)\)\);\s*assertSecurityContextOwner/);
  assert.match(source, /enqueueNostrEvent\((?:event|ev), null, identity\.securityFence\)/);
  assert.match(source, /error\?\.code === 'SECURITY_CONTEXT_EXPIRED'/);
});

test('vendor stats and bulletin effects are fenced by the active account context', () => {
  const source = read('../hooks/useVendorStats.js');
  assert.match(source, /await db\.messages\.toArray\(\);\s*assertSecurityContextOwner/);
  assert.match(source, /assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);\s*setStats\(/);
  assert.match(source, /await getAuthenticatedPool\(identity\);\s*assertSecurityContextOwner/);
  assert.match(source, /await Promise\.allSettled\(pool\.publish\(reputationRelays, event\)\);\s*assertSecurityContextOwner/);
  assert.match(source, /enqueueNostrEvent\(event, null, identity\.securityFence\)/);
});

test('fenced outbox enqueue checks owner and incarnation around durable writes', () => {
  const source = read('../lib/outbox.js');
  assert.match(source, /enqueueNostrEvent\(event, relays = null, securityFence = null\)/);
  assert.match(source, /securityFence\.context\?\.owner !== owner[\s\S]*?securityFence\.assertCurrent\(\);[\s\S]*?await outbox\.put\([\s\S]*?securityFence\?\.assertCurrent\?\.\(\);[\s\S]*?await updateMessageStatus[\s\S]*?securityFence\?\.assertCurrent\?\.\(\);/);
});

test('lock, account removal and panic wipe retire IndexedDB context markers before cleanup', () => {
  const identity = read('../useIdentity.js');
  const lockPath = identity.slice(identity.indexOf('const lockApp = async'), identity.indexOf('// Every step runs on its own'));
  assert.match(lockPath, /await retireCurrentContext\('local-lock'\)/);
  assert.match(identity, /forgetDeviceProviderSecret\(context\.owner\)/);

  const retirement = identity.slice(identity.indexOf('const retireCurrentContext = async'), identity.indexOf('const onContextInvalidated'));
  assert.match(retirement, /await retireSharedSecurityContext\(context, async \(\) =>[\s\S]*?retireDatabaseSecurityContext\(context\)/);
  assert.match(retirement, /retireBitcoinAllocationContext\(context\)/);
  assert.match(retirement, /retired: retired\.persisted/);
  assert.match(identity, /window\.addEventListener\('pageshow', checkOnResume\)/);
  assert.match(identity, /document\.addEventListener\('visibilitychange', checkOnResume\)/);

  const accountCleanup = identity.slice(identity.indexOf('async function deleteLockedOutDatabase'), identity.indexOf('export function useIdentity'));
  assert.match(accountCleanup, /await retireAccountDatabaseContexts\(pubkey\)[\s\S]*?await retireAccountBitcoinAllocationContexts\(pubkey\)[\s\S]*?await destroyDeviceKey\(pubkey\)/);

  const remove = identity.slice(identity.indexOf('const removeAccount = async'), identity.indexOf('const switchAccount = async'));
  assert.match(remove, /await retireOwnerSharedSecurityContexts\(targetPk, async \(\) =>[\s\S]*?retireAccountDatabaseContexts\(targetPk\)[\s\S]*?retireAccountBitcoinAllocationContexts\(targetPk\)[\s\S]*?if \(!coordinated\.retired\)[\s\S]*?delete vaults\[targetPk\]/);

  const wipe = identity.slice(identity.indexOf('const panicWipe = async'), identity.indexOf('const removeAccount = async'));
  assert.match(wipe, /listSecurityContextOwners\(\)[\s\S]*?invalidateAllSecurityContexts[\s\S]*?await Promise\.all\(ownerInventory\.owners\.map/);
  assert.match(wipe, /try \{ localRetirement = await retireCurrentContext\('panic-wipe'\) \}[\s\S]*?catch \(error\)/);
  assert.match(wipe, /ownerInventory\.owners\.map\(async \(owner\) => \{\s*try \{[\s\S]*?catch \(error\)/);
  assert.match(wipe, /retireAccountBitcoinAllocationContexts\(owner\)/);
  assert.match(wipe, /durableContexts\.filter\(\(item\) => !item\.retired\)/);
});

test('production account DB opens require the identity security fence', () => {
  const bootstrap = read('../features/chat/useChatBootstrap.js');
  const dm = read('./useNIP44DM.js');
  assert.match(bootstrap, /if \(identity\?\.pk && identity\?\.securityFence\) openDBFor\(identity\.pk, identity\.securityFence\)/);
  // Three open sites now: bootstrap, the group-key engine, and the
  // test-profile DM lane receiver (each behind its own fence guard).
  assert.equal((dm.match(/openDBFor\(identity\.pk, identity\.securityFence\)/g) || []).length, 3);
  assert.match(dm, /if \(!identity\.securityFence\) return;\s+openDBFor\(identity\.pk, identity\.securityFence\)/);
  assert.match(dm, /if \(!identity\.securityFence\) continue;\s+openDBFor\(identity\.pk, identity\.securityFence\)/);
});
