import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeRestoredEntry } from './vaultEntry.js';

test('a restore keeps the entry it already had, including the 12 words', () => {
  const vault = { iv: [1], data: [2] };
  const prior = {
    vault: { iv: [9], data: [9] },
    handle: 'oldname',
    displayName: 'Old Name',
    createdAt: 1000,
    mnemonicEnc: { iv: [3], ct: [4] },
    // A field a future device-lock build may carry; a restore must not eat it.
    deviceEnvelope: { sealed: 'abc' },
    confirmed: false,
  };

  const merged = mergeRestoredEntry(prior, { vault, handle: 'oldname', now: 5000 });

  // The vault the PIN just opened wins; everything else survives.
  assert.deepEqual(merged.vault, vault);
  assert.deepEqual(merged.mnemonicEnc, prior.mnemonicEnc);
  assert.deepEqual(merged.deviceEnvelope, prior.deviceEnvelope);
  assert.equal(merged.displayName, 'Old Name');
  assert.equal(merged.createdAt, 1000);
  assert.equal(merged.handle, 'oldname');
  // Restore re-admits a finished account; it never turns it back into a draft.
  assert.equal(merged.confirmed, true);
});

test('a restore onto a device that holds nothing builds a finished entry', () => {
  const vault = { iv: [1], data: [2] };
  const merged = mergeRestoredEntry(undefined, { vault, handle: 'alice', now: 5000 });

  assert.deepEqual(merged.vault, vault);
  assert.equal(merged.handle, 'alice');
  assert.equal(merged.displayName, 'alice');
  assert.equal(merged.createdAt, 5000);
  assert.equal(merged.confirmed, true);
  assert.equal('mnemonicEnc' in merged, false);
});
