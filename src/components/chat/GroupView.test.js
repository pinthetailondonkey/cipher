import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./GroupView.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('group message and listing writes retain one identity fence across persistence and send', () => {
  for (const [label, startToken, endToken] of [
    ['group message', 'const sendGroupText', 'const visibleMessages'],
    ['group listing', 'const postListing', 'return ('],
  ]) {
    const start = SOURCE.indexOf(startToken);
    const end = SOURCE.indexOf(endToken, start);
    assert.ok(start >= 0 && end > start, `${label} callback is found`);
    const branch = SOURCE.slice(start, end);
    assert.match(branch, /assertCurrent\(\); await saveMessage\(groupId, optimistic\); assertCurrent\(\);/);
    assert.match(branch, /await sendGroupMessage\([\s\S]*?\); assertCurrent\(\)/);
    assert.match(branch, /await saveMessage\(groupId, confirmed\); assertCurrent\(\)/);
  }
});

test('storefront photo upload stops local effects after account retirement', () => {
  const photo = SOURCE.slice(SOURCE.indexOf('const pickPhoto'), SOURCE.indexOf('const money'));
  assert.match(photo, /assertSecurityContextOwner\(securityFence, owner\)/);
  assert.match(photo, /const upload = import\.meta\.env\?\.VITE_TEST_HOOKS === '1'[\s\S]*?\? window\.__cipherMediaUpload : uploadAttachment; const uploaded = await upload\([\s\S]*?\); assertSecurityContextOwner\(securityFence, owner\); setPhoto/);
  assert.match(photo, /if \(securityFence\?\.isCurrent\?\.\(\)\) setAddingPhoto\(false\)/);
});

test('group retry, profile hydration, and pending-send refresh stop after retirement', () => {
  assert.match(SOURCE, /await retrySecuringGroup\(identity, activeGroup\.id\); assertCurrent\(\); setToast/);
  assert.match(SOURCE, /loadGroupProfile\([\s\S]*?if \(cancelled \|\| !profile\?\.id \|\| !securityFence\?\.isCurrent\?\.\(\)\) return/);
  assert.match(SOURCE, /const refresh = \(\) => \{ if \(!securityFence\?\.isCurrent\?\.\(\)\) return/);
});
