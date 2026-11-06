import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { groupTimelinePlans } from '../lib/crypto/groupMembership.js';

// One stored value, one frame shape. The session stores the plan's FILTER
// ARRAY (session.subs.set(subId, plan.filters)) and a NIP-01 REQ frame
// carries those filters spread as top-level elements. The first subscribe
// did that. The post-AUTH flush sent the array nested one level deep
// (['REQ', subId, filter] where filter IS the stored array), so every
// resubscribe-after-auth was a malformed frame on any relay that validates
// frame shape. This walks the hook's own send expressions off the tree and
// executes each one against the SAME stored value: both must stringify to
// the same canonical frame.

const SOURCE = readFileSync(new URL('./useNIP29Group.js', import.meta.url), 'utf8');

// Every REQ frame this hook can put on the wire. The third element's
// expression is captured verbatim from the tree and re-executed below.
const REQ_SEND = /session\.ws\.send\(JSON\.stringify\(\['REQ',\s*subId,\s*(.*?)\]\)\);/g;

function lineOf(index) {
  return SOURCE.slice(0, index).split('\n').length;
}

function frameFromExpression(expression, bindings) {
  // Re-executes the captured send expression's array literal with the
  // names the send site itself uses, bound to the stored value.
  const build = new Function(
    'subId',
    'plan',
    'filter',
    'session',
    `'use strict'; return ['REQ', subId, ${expression}];`,
  );
  return JSON.stringify(build(bindings.subId, bindings.plan, bindings.filter, bindings.session));
}

test('the auth flush sends the same REQ frame the first subscribe sends', () => {
  // Name the stored value: this line is what both sends draw from.
  assert.match(
    SOURCE,
    /session\.subs\.set\(subId,\s*plan\.filters\)/,
    'the session stores the plan filter array under the sub id',
  );

  const sites = [...SOURCE.matchAll(REQ_SEND)].map((match) => ({
    expression: match[1],
    line: lineOf(match.index),
    index: match.index,
  }));
  assert.equal(
    sites.length,
    2,
    `expected exactly two REQ sends (first subscribe + auth flush), found ${sites.length}`,
  );

  // Pin each site by WHERE it lives, not by its shape: the flush is the REQ
  // send inside flushGroupSubs, the first subscribe is the REQ send three
  // lines under the store. Pinning by shape would let both sites drift
  // together.
  const flushBodyMatch = SOURCE.match(/function flushGroupSubs\(session\) \{[\s\S]*?\n\}/);
  assert.ok(flushBodyMatch, 'flushGroupSubs is present');
  const flushBodyStart = flushBodyMatch.index;
  const flushBodyEnd = flushBodyMatch.index + flushBodyMatch[0].length;
  const inFlushBody = sites.filter(
    (site) => site.index >= flushBodyStart && site.index < flushBodyEnd,
  );
  assert.equal(inFlushBody.length, 1, 'exactly one REQ send inside flushGroupSubs: the flush');
  const flush = inFlushBody[0];

  const storeMatch = SOURCE.match(/session\.subs\.set\(subId,\s*plan\.filters\);/);
  assert.ok(storeMatch, 'the store statement is present');
  const afterStore = SOURCE.slice(storeMatch.index, storeMatch.index + 400);
  const subscribeMatch = afterStore.match(
    /session\.ws\.send\(JSON\.stringify\(\['REQ',\s*subId,\s*(.*?)\]\)\);/,
  );
  assert.ok(
    subscribeMatch,
    'the first subscribe sends a REQ frame right after storing the plan filters',
  );
  const subscribe = {
    expression: subscribeMatch[1],
    line: lineOf(storeMatch.index + afterStore.indexOf(subscribeMatch[0])),
  };

  // The SAME stored value feeds both expressions, exactly as the hook binds
  // them: the subscribe reads plan.filters, the flush loop destructures the
  // stored map entry into `filter`.
  const plans = groupTimelinePlans(['g:flush-frame'], 123);
  const subId = 'group-sub-g:flush-frame-1a2b3c';
  const bindings = {
    subId,
    plan: plans[0],
    session: { subs: new Map([[subId, plans[0].filters]]) },
  };
  bindings.filter = bindings.session.subs.get(subId);
  const stored = plans[0].filters;
  const canonical = JSON.stringify(['REQ', subId, ...stored]);

  const firstFrame = frameFromExpression(subscribe.expression, bindings);
  const flushFrame = frameFromExpression(flush.expression, bindings);

  assert.equal(
    firstFrame,
    canonical,
    `the first subscribe (useNIP29Group.js:${subscribe.line}, the working path) spreads the stored filters`,
  );
  assert.equal(
    flushFrame,
    firstFrame,
    `the auth flush frame (useNIP29Group.js:${flush.line}) must equal the first-subscribe frame`,
  );
  assert.equal(
    flushFrame,
    canonical,
    `the auth flush frame (useNIP29Group.js:${flush.line}) must carry the stored filters spread, not nested`,
  );
});

test('a live member-doc event reaches the ingest door and only that arm', () => {
  // Step 2 slice 3 live arm: docs have no h tag, so onFrame must strip their
  // prefixed d-tag into a bare gid BEFORE any subscriber gating, then route
  // kind 30079 alone into refreshMemberDocs (which verifies-then-stores);
  // returning there keeps a doc from falling into control/message arms that
  // would read it as something else.
  const groupIdMatch = SOURCE.match(/let groupId = event\.tags\.find\(\(tag\) => tag\[0\] === 'h'\)/);
  assert.ok(groupIdMatch, 'onFrame derives the gid tolerating the h-less doc shape');
  const after = SOURCE.slice(groupIdMatch.index, groupIdMatch.index + 1200);
  assert.match(after, /MEMBER_DOC_D_PREFIX/, 'the doc d-tag prefix is stripped to the bare gid');
  const routeIdx = after.search(new RegExp(`if \\(event\\.kind === MEMBER_DOC_KIND\\)`));
  assert.ok(routeIdx !== -1, 'kind 30079 has its own routing arm');
  const arm = after.slice(routeIdx, routeIdx + 220);
  assert.match(arm, /refreshMemberDocs\(identity, groupId\)/, 'the arm ingests through the verify-then-store door');
  const snapshotIdx = after.indexOf('event.kind === 39002');
  assert.ok(snapshotIdx !== -1 && snapshotIdx > routeIdx,
    'the doc arm returns before the roster-snapshot arm can see a doc event');
});

test('the pinned-slot read stops naming the account once its alias pin is held', () => {
  // Wire-capture finding: the owner's kind-9005 read shipped authors:[account,
  // ...pin] even after capture, so four subscription frames per session named
  // the account on the group box. With a held pin the alias form answers
  // alone; without one the account arm still covers pre-capture creators.
  const idx = SOURCE.search(/ownerAuthorFilter/);
  assert.ok(idx !== -1, 'the dedicated owner-pin filter exists');
  const block = SOURCE.slice(idx, idx + 1800);
  assert.match(block, /actor \? \[actor\] : \[standing\.creator\]/,
    'a held pin replaces the account arm entirely (pin-or-account, never both)');
  assert.doesNotMatch(block, /standing\.creator, \.\.\.\(actor/,
    'the both-shapes array is gone');
  // Second leg from the same capture: on the creator's own device the pin
  // is known by construction even when the snapshot still holds plain rows.
  assert.match(block, /readAuthorityPin\(identity\.pk, groupId\)/,
    'the creator device answers from its own out-of-band pin before falling back to the account arm');
});
