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
