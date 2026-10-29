import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Shape assertions on the screen, not a rendered test: this repo has no DOM
// harness and adding one is a new dependency, which is out of bounds. The
// behaviour itself — available, taken, unknown, and the retry — is proved by
// execution in src/lib/handleClaim.test.js. What this file holds the screen to
// is that it uses that rule and cannot re-introduce the two defects: a check
// that is never called, and an answer that leaves the button dead.

const SCREEN = fs.readFileSync(new URL('./Create.jsx', import.meta.url), 'utf8');

test('the precheck is actually called, not bypassed', () => {
  assert.doesNotMatch(SCREEN, /BYPASSED/, 'the bypass is gone for good');
  assert.doesNotMatch(SCREEN, /const available = true/, 'no hard-coded answer');
  assert.match(SCREEN, /const verdict = await checkUsernameAvailable\(cleanHandle\)/,
    'the answer on screen comes from the lookup');
});

test('a taken handle is refused with a sentence and nothing is created', () => {
  const taken = SCREEN.indexOf('verdict === HANDLE_TAKEN');
  const creates = SCREEN.indexOf('identity.createVault');
  assert.ok(taken > -1, 'the taken answer is handled');
  assert.ok(creates > taken, 'the refusal returns before the vault is made');
  assert.match(SCREEN, /setError\('@' \+ cleanHandle \+ ' is taken\. Try another\.'\)/,
    'the sentence names the handle and says what to do');
});

test('every way out of a submit unlocks the button', () => {
  // More than one finally exists in this file (the pool close is one), so find
  // the block that actually unlocks rather than the first one in the text.
  const blocks = [...SCREEN.matchAll(/\} finally \{([\s\S]*?)\n    \}/g)].map((m) => m[1]);
  assert.ok(blocks.some((block) => block.includes('setLoading(false)')),
    'the unlock is a finally, so a refusal or a throw cannot strand it');
  const takenBranch = SCREEN.slice(SCREEN.indexOf('verdict === HANDLE_TAKEN'),
    SCREEN.indexOf('identity.createVault'));
  assert.doesNotMatch(takenBranch, /setLoading/, 'the taken branch leaves the unlock to the finally');
});

test('the slow-relay defect cannot come back through this file', () => {
  assert.doesNotMatch(SCREEN, /id: 'timeout'/, 'the fake event that read as taken is gone');
  assert.doesNotMatch(SCREEN, /events\.length === 0/, 'an empty read is no longer the whole rule');
  assert.match(SCREEN, /lookupHandleClaim\(\{ read: readClaims, username \}\)/,
    'the three-state rule is the only place an answer is decided');
});

test('the read goes through the AUTH-aware reader, not a bare querySync', () => {
  assert.match(SCREEN, /querySyncAfterAuth\(/, 'the codebase reader is used');
  assert.doesNotMatch(SCREEN, /pool\.querySync\(/, 'no direct query whose empty answer is ambiguous');
});
