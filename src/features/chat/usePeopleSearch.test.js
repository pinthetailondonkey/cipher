import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileNameMatches } from './usePeopleSearch.js';

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
