import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nip19 } from 'nostr-tools';
import { usePeopleSearch, profileNameMatches, explicitGroupReference } from './usePeopleSearch.js';
import { useChatStore } from '../../store/chatStore.js';

const HEX = '1'.repeat(64);
const NPUB = nip19.npubEncode(HEX);
const IDENTITY = { pk: 'a'.repeat(64), npub: nip19.npubEncode('a'.repeat(64)), sk: 'b'.repeat(64) };

const runSearch = async (query) => {
  useChatStore.getState().setSearchQuery(query);
  // The factory keeps no hook state; it hands back the one search function.
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  const { handleSearch } = usePeopleSearch({ identity: IDENTITY });
  await handleSearch();
  return useChatStore.getState().searchResults;
};

test('an @handle resolves only to the profile whose own name is that handle', () => {
  const exactName = { content: JSON.stringify({ name: 'Alice', display_name: 'Alice A' }) };
  const exactDisplay = { content: JSON.stringify({ display_name: 'alice' }) };
  const approximate = { content: JSON.stringify({ name: 'Alicia', display_name: 'Alice Wonder' }) };
  assert.equal(profileNameMatches(exactName, 'alice'), true, 'a case-insensitive exact name is the same person');
  assert.equal(profileNameMatches(exactDisplay, 'alice'), true, 'an exact display name is the same person');
  assert.equal(profileNameMatches(approximate, 'alice'), false, 'a near miss is somebody else, never the requested person');
  assert.equal(profileNameMatches({ content: 'not json' }, 'alice'), false, 'unreadable content matches nobody');
  assert.equal(profileNameMatches(exactName, ''), false, 'an empty handle matches nobody');
});

test('only a signed group address is an explicit group reference', () => {
  const naddr = nip19.naddrEncode({ identifier: 'the-group', pubkey: HEX, kind: 39000 });
  assert.equal(explicitGroupReference(naddr), 'the-group', 'a group address still resolves to its id');
  assert.equal(explicitGroupReference('photographer'), '', 'an ordinary word is not a group id');
  assert.equal(explicitGroupReference('abcdef123456'), '', 'partial hex is not a confirmed group');
  assert.equal(explicitGroupReference(HEX), '', 'a public key is not a group id');
  assert.equal(explicitGroupReference(NPUB), '', 'a npub is not a group id');
  assert.equal(explicitGroupReference('naddr1notreally'), '', 'an address that will not decode names nothing');
});

test('searching an ordinary word yields no fabricated group row', async () => {
  const results = await runSearch('photographer');
  assert.deepEqual(results, [], 'a 12–20 character word is text, not a group');
});

test('searching partial hex yields no fabricated group row', async () => {
  const results = await runSearch('abcdef123456');
  assert.deepEqual(results, [], 'partial hex is text, not a confirmed group');
});

test('searching an npub still resolves to that person', async () => {
  const results = await runSearch(NPUB);
  assert.equal(results.length, 1, 'an npub names exactly one person');
  assert.equal(results[0].type, 'user');
  assert.equal(results[0].pubkey, HEX, 'the npub decodes to its public key');
});
