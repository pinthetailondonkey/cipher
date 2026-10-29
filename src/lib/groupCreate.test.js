import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ACCESS_PRIVATE,
  ACCESS_PUBLIC,
  JOIN_APPROVAL,
  JOIN_OPEN,
  PRIVATE_LEVEL_READY,
  groupCreateTags,
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
