import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { LOOKING_UP_MEMBERS, createSettleGate, rosterInFlight, rosterNotice } from './memberRosterNotice.js';

// The rule: the member area may claim progress only while a read is actually
// running on a group whose roster is not yet known. A failed read is unknown,
// and unknown must look like absent, not like still-loading forever.

// ---- Direction one: a read in flight on an unknown roster says so ---------
test('an unread group with a read in flight shows the line', () => {
  assert.equal(rosterNotice({ rosterKnown: false, loading: true }), LOOKING_UP_MEMBERS);
});

// ---- Direction two: the line is gone the moment the read settles ---------
test('an unread group whose read settled shows no line, and no number', () => {
  // Same state the old unconditional `memberList.length === 0` line never left:
  // a read that failed (or returned nothing) leaves the list empty, the roster
  // unknown, and nothing in flight.
  assert.equal(rosterNotice({ rosterKnown: false, loading: false }), '');
});

test('a known roster shows its number and never the line', () => {
  assert.equal(rosterNotice({ rosterKnown: true, loading: false }), '');
});

test('a live roster that lands mid-read never gets the line drawn over it', () => {
  // The 39002 arm can mark the group while this panel's own fetch is pending.
  // Progress over a number already on screen is a lie about what is missing.
  assert.equal(rosterNotice({ rosterKnown: true, loading: true }), '');
});

test('no arguments is the absent state, not the loading one', () => {
  assert.equal(rosterNotice(), '');
  assert.equal(rosterNotice({}), '');
});

// ---- What counts as in flight, keyed by the group on screen --------------
test('a group that has not reported yet has a read in flight', () => {
  assert.equal(rosterInFlight({ settledGroupId: null, openGroupId: 'g1', done: false }), true);
});

test('a group that reported is not in flight, whatever else was read', () => {
  assert.equal(rosterInFlight({ settledGroupId: 'g1', openGroupId: 'g1', done: true }), false);
});

test('switching chats is in flight again even if the old group reported', () => {
  // The old group settled; the new one has not. Deriving from the id is what
  // makes this true without a setState when the effect starts.
  assert.equal(rosterInFlight({ settledGroupId: 'g1', openGroupId: 'g2', done: true }), true);
  // And a late settle for g1 cannot mark g2 done: the settle names its group.
  assert.equal(rosterInFlight({ settledGroupId: 'g1', openGroupId: 'g2', done: true }), true);
});

test('with no group open nothing is in flight', () => {
  assert.equal(rosterInFlight({ settledGroupId: null, openGroupId: null, done: false }), false);
  assert.equal(rosterInFlight(), false);
});

// ---- A retry is still one read ------------------------------------------
// The read may move to the next node after a failure. That is one read, not a
// second one, and it must not draw progress over a number already on screen.
test('a retried read for the same group never flips the line back over a number', () => {
  // done is what a settle wrote, and nothing writes it back to false, so a
  // retry for the group that already reported is not in flight.
  const inFlight = rosterInFlight({ settledGroupId: 'g1', openGroupId: 'g1', done: true });
  assert.equal(inFlight, false, 'a retry is not a new read');
  assert.equal(rosterNotice({ rosterKnown: true, loading: inFlight }), '',
    'no line over a number that is already on screen');
});

test('a second failure still ends in absence, not in the line', () => {
  const inFlight = rosterInFlight({ settledGroupId: 'g1', openGroupId: 'g1', done: true });
  assert.equal(rosterNotice({ rosterKnown: false, loading: inFlight }), '');
  assert.equal(rosterNotice({ rosterKnown: false, loading: false }), '');
});

// ---- The gate: a read that outlives its panel moves nothing --------------
test('a settle inside its own read runs exactly once', () => {
  const gate = createSettleGate();
  let settled = 0;
  assert.equal(gate.settle(() => { settled += 1; }), true);
  assert.equal(settled, 1);
});

test('a settle after the panel unmounted or switched group is dropped', () => {
  const gate = createSettleGate();
  let settled = 0;
  gate.close();
  assert.equal(gate.isOpen(), false);
  assert.equal(gate.settle(() => { settled += 1; }), false);
  assert.equal(settled, 0, 'the old read must not clear the new group in-flight state');
});

// ---- The screen, at the shape that carries the rule ----------------------
test('the sidebar has no unconditional looking-up line left', () => {
  const sidebar = fs.readFileSync(new URL('../components/chat/GroupInfoSidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /rosterNotice\(\{ rosterKnown, loading: rosterLoading \}\)/,
    'the line comes from the one rule');
  assert.doesNotMatch(sidebar, /memberList\.length === 0 && <p/,
    'the line is not gated on an empty list');
  assert.match(sidebar, /gate\.settle\(\(\) => setRosterSettled\(\{ groupId: group\.id, done: true \}\)\)/,
    'the success arm settles the line, naming the group it settled');
  assert.match(sidebar, /rosterInFlight\(\{/, 'in flight is derived from the group id');
  assert.match(sidebar, /gate\.close\(\)/, 'the effect closes the gate on cleanup');
  assert.match(sidebar, /\(fetchError\) => \{[\s\S]{0,240}gate\.settle\(/,
    'a rejection is a settle arm, not a missed one');
});
