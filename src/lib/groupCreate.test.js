import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  ACCESS_PRIVATE,
  ACCESS_PUBLIC,
  JOIN_APPROVAL,
  JOIN_OPEN,
  PRIVATE_LEVEL_READY,
  SEALED_ABOUT,
  SEALED_LABEL,
  groupCreateTags,
  heldSealedFields,
  relayFacingLabel,
} from './groupCreate.js';

const base = { name: 'Thursday', about: 'moved', groupId: 'g1', pubkey: 'ab'.repeat(32) };
const tagsOf = (tags, name) => tags.filter((t) => t[0] === name);

// The regression that answers "do existing groups break": a public create
// carries the tag shape the app built before this change, plus the join tag.
test('a public create keeps the shape the app sent before, and adds the join policy', () => {
  const { create, meta, join } = groupCreateTags(base);
  assert.deepEqual(create, [
    ['h', 'g1'], ['name', 'Thursday'], ['about', 'moved'], ['open'], ['p', 'ab'.repeat(32), 'admin'],
  ]);
  assert.deepEqual(join, [['h', 'g1']]);
  assert.deepEqual(meta, [
    ['h', 'g1'], ['name', 'Thursday'], ['about', 'moved'], ['join', 'approval'], ['cipher', 'true'],
  ]);
});

test('a private create is private AND closed, and never says open', () => {
  const { create } = groupCreateTags({ ...base, access: ACCESS_PRIVATE });
  assert.deepEqual(tagsOf(create, 'private'), [['private']]);
  assert.deepEqual(tagsOf(create, 'closed'), [['closed']]);
  assert.equal(tagsOf(create, 'open').length, 0);
});

// The state that used to lie: unticking "show in search" hid a public group
// from this app's Discover and from nothing else. A private group must never
// carry the discovery tag, and a stale caller passing the old flag must not be
// able to smuggle it back.
test('negative control: a private group sends no cipher tag, whatever else is passed', () => {
  assert.equal(tagsOf(groupCreateTags({ ...base, access: ACCESS_PRIVATE }).meta, 'cipher').length, 0);
  assert.equal(tagsOf(groupCreateTags({ ...base, access: ACCESS_PRIVATE, listed: true }).meta, 'cipher').length, 0);
});

test('the discovery tag is a consequence of the level, not a choice', () => {
  assert.deepEqual(tagsOf(groupCreateTags({ ...base, access: ACCESS_PUBLIC }).meta, 'cipher'), [['cipher', 'true']]);
  assert.equal(tagsOf(groupCreateTags({ ...base, access: ACCESS_PRIVATE }).meta, 'cipher').length, 0);
});

test('a private menu is still unlisted, and keeps its menu tags', () => {
  const { meta } = groupCreateTags({ ...base, access: ACCESS_PRIVATE, isChannel: true });
  assert.equal(tagsOf(meta, 'cipher').length, 0);
  assert.deepEqual(tagsOf(meta, 'channel'), [['channel', 'true']]);
  assert.deepEqual(tagsOf(meta, 'broadcast'), [['broadcast', 'true']]);
});

test('the join policy is a knob, not a consequence of access', () => {
  for (const access of [ACCESS_PUBLIC, ACCESS_PRIVATE]) {
    assert.deepEqual(tagsOf(groupCreateTags({ ...base, access }).meta, 'join'), [['join', JOIN_APPROVAL]]);
    assert.deepEqual(tagsOf(groupCreateTags({ ...base, access, joinPolicy: JOIN_OPEN }).meta, 'join'), [['join', JOIN_OPEN]]);
  }
});

// The screen and the caller, at the shape that carries the decision: the level
// must reach the create call, a menu must not carry one, and the switch that
// used to lie must be gone.
test('the create screen offers the level, and the old search switch is gone', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const modal = read('../components/chat/CreateGroupModal.jsx');
  const directory = read('../features/chat/useGroupDirectory.js');
  assert.match(modal, /createGroup\(event, level\)/, 'the chosen level reaches the create call');
  assert.match(modal, /const level = levelShown \? groupAccess : ACCESS_PUBLIC;/, 'a menu carries no level');
  assert.doesNotMatch(modal, /Show this \{isChannel \? 'menu' : 'group'\} in search/,
    'the misleading search switch is gone');
  assert.doesNotMatch(modal, /type="checkbox"/, 'and no checkbox took its place');
  assert.match(directory, /const gAccess = gChannel \? ACCESS_PUBLIC : access;/,
    'the caller refuses a private menu even if asked');
  assert.match(directory, /\{ access: gAccess \}/, 'and passes the level on');
});

// The join policy goes out a second time through the path that has been seen
// working. It must carry the full metadata: a 9002 is a state event, so a bare
// ['join'] event would erase the name, the about and the discovery tag on a
// relay that replaces state rather than adding to it.
test('the second join-policy event carries the full metadata, never a bare join tag', () => {
  const hook = fs.readFileSync(new URL('../hooks/useNIP29Group.js', import.meta.url), 'utf8');
  const block = hook.slice(hook.indexOf('if (joinPolicy === JOIN_APPROVAL)'));
  const event = block.slice(0, block.indexOf('};'));
  assert.match(event, /tags: tags\.meta/, 'the whole metadata goes with it');
  assert.doesNotMatch(event, /\['join', JOIN_APPROVAL\]\s*\]/, 'a bare join tag would erase the rest');
});

// ---- Sealed private-group names -----------------------------------------
// The gates below are read off the wire: real signed events built from the
// builder's tags, serialised whole, and searched for the words that must not
// be in them. A code-walk of the builder would not prove this; the frame does.

const REAL_NAME = 'Thursday night market';
const REAL_ABOUT = 'back room, ask for the usual';

const framesOf = (tags, secret) => [
  finalizeEvent({ kind: 9007, created_at: 1793000000, tags: tags.create, content: '' }, secret),
  finalizeEvent({ kind: 9002, created_at: 1793000000, tags: tags.meta, content: '' }, secret),
  finalizeEvent({ kind: 9021, created_at: 1793000000, tags: tags.join, content: '' }, secret),
];

test('gate 2: a private group\'s real name and description are in no relay-facing frame', () => {
  const secret = generateSecretKey();
  const tags = groupCreateTags({ ...base, name: REAL_NAME, about: REAL_ABOUT, access: ACCESS_PRIVATE });
  for (const frame of framesOf(tags, secret)) {
    const wire = JSON.stringify(frame);
    assert.equal(wire.includes('Thursday'), false, `kind ${frame.kind} carried the name`);
    assert.equal(wire.includes('back room'), false, `kind ${frame.kind} carried the description`);
    // The 9021 join names only the group; the two metadata-carrying events
    // must say the placeholder and nothing else.
    if (frame.kind === 9021) continue;
    assert.deepEqual(tagsOf(frame.tags, 'name'), [['name', SEALED_LABEL]]);
    assert.deepEqual(tagsOf(frame.tags, 'about'), [['about', SEALED_ABOUT]]);
  }
});

// The positive half of gate 2, and the reason this is not a blanket sealing:
// a public group's name is how the group is found. Sealing it would break
// discovery, so the placeholder must be a consequence of the level only.
test('gate 2, control: a public group still says its own name', () => {
  const secret = generateSecretKey();
  const tags = groupCreateTags({ ...base, name: REAL_NAME, about: REAL_ABOUT, access: ACCESS_PUBLIC });
  const wire = JSON.stringify(framesOf(tags, secret));
  assert.equal(wire.includes(REAL_NAME), true, 'discovery depends on this');
  assert.deepEqual(tags.sealed, null, 'and there is nothing to seal');
});

test('gate 3: two differently named private groups are byte-identical on the wire', () => {
  const alpha = groupCreateTags({ ...base, name: 'Alpha', about: 'one', groupId: 'g1', access: ACCESS_PRIVATE });
  const beta = groupCreateTags({ ...base, name: 'Beta', about: 'two', groupId: 'g2', access: ACCESS_PRIVATE });
  const without = (tags, name) => tags.filter((tag) => tag[0] !== name);
  // The only tags that may differ between two groups are the ones that name
  // the group itself and its creator.
  assert.deepEqual(without(alpha.meta, 'h'), without(beta.meta, 'h'));
  assert.deepEqual(without(alpha.create, 'h').filter((t) => t[0] !== 'p'),
    without(beta.create, 'h').filter((t) => t[0] !== 'p'));
  assert.deepEqual(without(alpha.meta, 'h'), without(groupCreateTags({ ...base, name: 'Omega', about: 'three', groupId: 'g3', access: ACCESS_PRIVATE }).meta, 'h'));
});

test('gate 4, relay side: a rename leaves the tags byte-identical', () => {
  const before = groupCreateTags({ ...base, name: 'Old name', about: 'old words', groupId: 'g1', access: ACCESS_PRIVATE });
  const after = groupCreateTags({ ...base, name: 'New name', about: 'new words', groupId: 'g1', access: ACCESS_PRIVATE });
  assert.equal(JSON.stringify(after.meta), JSON.stringify(before.meta));
  assert.equal(JSON.stringify(after.create), JSON.stringify(before.create));
  // The same rule applied to a rename that goes through the update path.
  assert.deepEqual(
    relayFacingLabel({ name: 'New name', about: 'new words', access: ACCESS_PRIVATE }),
    relayFacingLabel({ name: 'Old name', about: 'old words', access: ACCESS_PRIVATE }),
  );
});

// The negative control for the whole idea: the sealing must be the level's
// consequence, not a caller's choice. A private group cannot be made to leak
// by passing the real words, and a public one cannot be sealed by accident.
test('gate 3, control: the placeholder does not depend on the name, and cannot be opted out of', () => {
  const weird = groupCreateTags({ ...base, name: SEALED_LABEL, about: SEALED_ABOUT, groupId: 'g9', access: ACCESS_PRIVATE });
  assert.deepEqual(tagsOf(weird.meta, 'name'), [['name', SEALED_LABEL]]);
  assert.equal(JSON.stringify(weird.meta).includes('Thursday'), false);
});

test('the builder hands the caller the real words to seal, and only on a private group', () => {
  assert.deepEqual(groupCreateTags({ ...base, access: ACCESS_PRIVATE }).sealed, { name: 'Thursday', about: 'moved' });
  assert.equal(groupCreateTags({ ...base, access: ACCESS_PUBLIC }).sealed, null);
});

// A directory rebuild merges the relay's row over the device's. The two facts
// that live only on this device have to come back, or the next guard reads a
// row that looks relay-sourced and lets the placeholder through.
test('a rebuild keeps the level and the sealed mark from the device\'s own record', () => {
  assert.deepEqual(heldSealedFields({ id: 'g1', name: 'x', access: ACCESS_PRIVATE, labelSealed: true }),
    { access: ACCESS_PRIVATE, labelSealed: true });
  assert.deepEqual(heldSealedFields({ id: 'g2', name: 'y' }), {}, 'nothing invented when nothing is held');
  assert.deepEqual(heldSealedFields(null), {});
});

// The Private description is a function of the measurement. Until every part of
// it is measured, the control says why it is not ready rather than guessing.
test('the Private level is not selectable before its sentence is measured', () => {
  const modal = fs.readFileSync(new URL('../components/chat/CreateGroupModal.jsx', import.meta.url), 'utf8');
  assert.match(modal, /disabled=\{!PRIVATE_LEVEL_READY\}/);
  assert.match(modal, /Private groups are not available yet\./);
  assert.equal(PRIVATE_LEVEL_READY, false);
});

// Fail closed: a typo must never produce a group that is more visible than the
// person asked for.
test('an unknown level or join policy throws instead of falling back', () => {
  assert.throws(() => groupCreateTags({ ...base, access: 'privte' }), /Unknown access level/);
  assert.throws(() => groupCreateTags({ ...base, joinPolicy: 'nope' }), /Unknown join policy/);
  assert.throws(() => groupCreateTags({ ...base, access: 'PRIVATE' }), /Unknown access level/);
  assert.throws(() => groupCreateTags({ ...base, groupId: '' }), /needs an id/);
  assert.throws(() => groupCreateTags({ ...base, pubkey: '' }), /needs a creator/);
});
