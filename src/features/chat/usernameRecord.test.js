import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MEMBER_BASELINE_KIND } from '../../lib/crypto/memberBaseline.js';

// F11: one reader asked for the handle record under kind 30078 while the only
// writer published it under 10003, so my_username never filled from a relay for
// the whole life of the repo. Two other readers used 10003 and agreed with the
// writer, which is what makes 30078 a typo rather than a design difference.
//
// The trap is worth pinning rather than the typo: 30078 is a real record in
// this tree (the encrypted group member baseline), so a reader targeting it
// resolves against something rather than against nothing. A test that only
// checked "the reader has a plausible kind" would have passed all along.
//
// Source-contract witnesses, same precedent as dmPeerProfiles.test.js: the
// writer cannot be called here without a relay, and what broke was a string.

const read = (url) => fs.readFileSync(new URL(url, import.meta.url), 'utf8');

const WRITER = read('../../useIdentity.js');
const READERS = [
  ['useChatBootstrap.js', read('./useChatBootstrap.js')],
  ['usePeopleSearch.js', read('./usePeopleSearch.js')],
  ['handleClaim.js', read('../../lib/handleClaim.js')],
];

// The kind a filter asks for, taken from the first `kinds: [N]` whose filter
// also names the handle field. Every reader here builds exactly one such filter.
function handleRecordKind(source) {
  const sites = source.match(/kinds:\s*\[\d+\][\s\S]{0,140}/g) || [];
  for (const site of sites) {
    if (/username/i.test(site)) return site.match(/kinds:\s*\[(\d+)\]/)[1];
  }
  return null;
}

test('the handle record is published and read under the same kind', () => {
  const branch = WRITER.slice(WRITER.indexOf('if (username) {'));
  const writerKind = branch.match(/kind:\s*(\d+)/)?.[1];
  assert.equal(writerKind, '10003', 'the writer moved off 10003; every reader must follow');
  // The record is a username registry, not a NIP-51 bookmarks list: the d tag
  // is what tells the two apart when someone else's client writes 10003.
  assert.match(branch.slice(0, 400), /\['d', 'username'\]/,
    'the writer must keep the d=username tag that the readers filter on');
  assert.match(branch.slice(0, 400), /\['username', username\]/,
    'the writer must keep the username tag that the readers read');

  for (const [name, source] of READERS) {
    assert.equal(handleRecordKind(source), writerKind, `${name} reads the handle record under another kind`);
  }
});

test('no reader aims the handle record at the group baseline kind', () => {
  // The specific way this broke: 30078 is the member baseline, a different
  // record that exists in this tree, so the wrong kind still looked alive.
  assert.equal(MEMBER_BASELINE_KIND, 30078, 'the baseline kind moved; recheck the trap');
  assert.notEqual(MEMBER_BASELINE_KIND, Number(handleRecordKind(read('../../useIdentity.js'))),
    'the handle record and the member baseline must stay different kinds');
  for (const [name, source] of READERS) {
    assert.notEqual(handleRecordKind(source), String(MEMBER_BASELINE_KIND),
      `${name} is reading the group baseline as if it held a handle`);
  }
});
