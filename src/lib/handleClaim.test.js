import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HANDLE_AVAILABLE,
  HANDLE_TAKEN,
  HANDLE_UNKNOWN,
  classifyClaimEvents,
  handleFilter,
  lookupHandleClaim,
} from './handleClaim.js';

// The rule this file exists for: a lookup that did not answer must never be
// read as an answer. The old precheck resolved its own 3-second race with a
// fake event, so on a slow relay every handle read as TAKEN; a thrown error
// read as TAKEN too; and an empty read (including one a relay refused) read
// as AVAILABLE. One function, three different wrong answers.
//
// The slow case and the refused case are deliberately separate tests with
// separate fakes: if both went through one helper, one mistake would make both
// green and neither would be evidence.

const claim = (handle) => ({ id: 'e1', kind: 10003, tags: [['t', `cipher_username_${handle}`]] });

// ---- Available: asked, answered, nothing there -------------------------
test('a lookup that answers with no claim means the handle is available', async () => {
  const verdict = await lookupHandleClaim({ read: async () => [], username: 'lol' });
  assert.equal(verdict, HANDLE_AVAILABLE);
});

// ---- Taken: asked, answered, a real claim exists -----------------------
test('a lookup that answers with a claim means the handle is taken', async () => {
  const verdict = await lookupHandleClaim({ read: async () => [claim('lol')], username: 'lol' });
  assert.equal(verdict, HANDLE_TAKEN);
});

// ---- Slow is not taken -------------------------------------------------
test('a lookup that never answers is unknown, never taken', async () => {
  let asked = 0;
  const read = () => { asked += 1; return new Promise(() => {}); }; // never settles
  const verdict = await lookupHandleClaim({ read, username: 'lol', timeoutMs: 10 });
  assert.equal(verdict, HANDLE_UNKNOWN, 'a slow relay says nothing about the handle');
  assert.equal(asked, 2, 'one retry before it is called unknown');
});

// ---- A refusal is not taken, and not available either ------------------
test('a lookup that throws is unknown, never taken and never available', async () => {
  let asked = 0;
  const read = async () => { asked += 1; throw new Error('relay refused the read'); };
  const verdict = await lookupHandleClaim({ read, username: 'lol', timeoutMs: 50 });
  assert.equal(verdict, HANDLE_UNKNOWN);
  assert.equal(asked, 2, 'a refusal is retried once, then reported unknown');
});

// ---- The retry is what saves the common case ---------------------------
test('a first attempt that times out and a second that answers is that answer', async () => {
  let attempt = 0;
  const read = () => {
    attempt += 1;
    return attempt === 1 ? new Promise(() => {}) : Promise.resolve([claim('lol')]);
  };
  const verdict = await lookupHandleClaim({ read, username: 'lol', timeoutMs: 10 });
  assert.equal(verdict, HANDLE_TAKEN, 'the retry answers, so the slow first attempt is forgotten');
});

test('a slow first attempt followed by an empty answer is available', async () => {
  let attempt = 0;
  const read = () => {
    attempt += 1;
    return attempt === 1 ? new Promise(() => {}) : Promise.resolve([]);
  };
  assert.equal(await lookupHandleClaim({ read, username: 'lol', timeoutMs: 10 }), HANDLE_AVAILABLE);
});

test('a claim found on the first attempt is not asked for twice', async () => {
  let asked = 0;
  const read = async () => { asked += 1; return [claim('lol')]; };
  await lookupHandleClaim({ read, username: 'lol', timeoutMs: 50 });
  assert.equal(asked, 1);
});

// ---- The pieces, on their own ------------------------------------------
test('an unreadable answer is unknown rather than empty', () => {
  assert.equal(classifyClaimEvents(undefined), HANDLE_UNKNOWN);
  assert.equal(classifyClaimEvents(null), HANDLE_UNKNOWN);
  assert.equal(classifyClaimEvents('nope'), HANDLE_UNKNOWN);
  assert.equal(classifyClaimEvents([]), HANDLE_AVAILABLE);
  assert.equal(classifyClaimEvents([claim('lol')]), HANDLE_TAKEN);
});

test('the claim is looked for by its own tag, and only that tag', () => {
  assert.deepEqual(handleFilter('lol'), { kinds: [10003], '#t': ['cipher_username_lol'], limit: 5 });
});
