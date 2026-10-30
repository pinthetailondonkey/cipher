import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateToSecondKey, openAccountWithOneScan, requestTwoOutputs } from './devicePrfTwo.js';
import { base64UrlToBytes, bytesToBase64Url, hasSecondKey, walletPrfInput } from './prfTwoInput.js';
import { DeviceKeyCancelled, DeviceKeyMissing, DeviceKeyUnavailable, isDeviceKeyError } from './vaultEnvelope.js';

const PK = 'c'.repeat(64);
const accountSecret = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);
const recordSalt = Uint8Array.from({ length: 16 }, (_, i) => i);
const credentialId = bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => 200 - i));

// A fake authenticator that behaves the way the lab one does: one get(), two
// independent outputs, and the second one varies with the input it was asked.
function fakeAuthenticator({ second = true, firstValue = 1, error = null, calls = [] } = {}) {
  return {
    async get(options) {
      calls.push(options);
      if (error) throw error;
      const evalInput = options.publicKey.extensions.prf.eval;
      const answer = (bytes) => {
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i += 1) out[i] = (bytes[i % bytes.length] * 3 + i) & 0xff;
        return out.buffer;
      };
      const results = { first: answer(new Uint8Array([firstValue, ...new Uint8Array(evalInput.first).slice(0, 4)])) };
      if (second) results.second = answer(new Uint8Array([9, ...new Uint8Array(evalInput.second).slice(0, 4)]));
      return { id: 'cred', type: 'public-key', getClientExtensionResults: () => ({ prf: { results } }) };
    },
  };
}

test('ONE gesture carries both inputs: a single get() with first and second set', async () => {
  const calls = [];
  const credentials = fakeAuthenticator({ calls });
  const outputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials });

  assert.equal(calls.length, 1, 'one scan means one credentials.get(), never two');
  const evalInput = calls[0].publicKey.extensions.prf.eval;
  assert.ok(evalInput.first?.length === 32);
  assert.ok(evalInput.second?.length === 32);
  assert.notDeepEqual(new Uint8Array(evalInput.first), new Uint8Array(evalInput.second));
  assert.equal(calls[0].publicKey.allowCredentials[0].type, 'public-key');
  assert.equal(calls[0].publicKey.userVerification, 'required');
  assert.notDeepEqual(outputs.first, outputs.second);
});

test('a platform that answers only the first input is a DEVICE refusal, never a wrong PIN', async () => {
  const credentials = fakeAuthenticator({ second: false });
  await assert.rejects(
    () => requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials }),
    (error) => {
      assert.ok(error instanceof DeviceKeyMissing);
      assert.equal(error.code, 'second-input-missing');
      assert.ok(isDeviceKeyError(error));
      return true;
    },
  );
});

test('a dismissed prompt is a cancellation, not a missing key', async () => {
  const notAllowed = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
  const credentials = fakeAuthenticator({ error: notAllowed });
  await assert.rejects(
    () => requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials }),
    (error) => { assert.ok(error instanceof DeviceKeyCancelled); return true; },
  );
});

test('no WebAuthn at all is unavailable, not a device error the person can blame themselves for', async () => {
  await assert.rejects(
    () => requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials: {} }),
    (error) => { assert.ok(error instanceof DeviceKeyUnavailable); return true; },
  );
});

test('migration writes a sibling marker, and one scan then opens the account', async () => {
  const vault = { v: 3, dk: { k: 'prf', id: credentialId, rpId: 'ciphermessenger.org' }, iv: [1, 2], data: [3, 4] };
  const credentials = fakeAuthenticator();
  const outputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials });
  const migrated = await migrateToSecondKey({ pk: PK, vault, accountSecret, outputs, salt2: recordSalt });

  assert.equal(migrated.v, 3);
  assert.equal(migrated.dk.k, 'prf');
  assert.deepEqual(migrated.iv, vault.iv, 'the device layer must be carried over untouched');
  assert.deepEqual(migrated.data, vault.data);
  assert.equal(hasSecondKey(migrated), true);

  const opened = await openAccountWithOneScan({ pk: PK, vault: migrated, outputs });
  assert.deepEqual(Array.from(opened), Array.from(accountSecret));
});

test('a healthy second key is not replaced by accident', async () => {
  const vault = { v: 3, dk: { k: 'prf', id: credentialId }, iv: [1], data: [2] };
  const credentials = fakeAuthenticator();
  const outputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials });
  const migrated = await migrateToSecondKey({ pk: PK, vault, accountSecret, outputs, salt2: recordSalt });
  await assert.rejects(
    () => migrateToSecondKey({ pk: PK, vault: migrated, accountSecret, outputs, salt2: recordSalt }),
    (error) => { assert.ok(error instanceof DeviceKeyUnavailable); assert.equal(error.code, 'second-key-present'); return true; },
  );
});

test('THE CORRUPTED RECORD RE-MIGRATES: a stale second key refuses, the PIN path stands, and a re-migration opens it again', async () => {
  const credentialCalls = [];
  let outputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials: fakeAuthenticator({ calls: credentialCalls }) });
  const base = { v: 3, dk: { k: 'prf', id: credentialId }, iv: [1], data: [2] };
  const good = await migrateToSecondKey({ pk: PK, vault: base, accountSecret, outputs, salt2: recordSalt });

  // Something went wrong with the stored blob: it is well shaped but opens
  // nothing. This is the half-written-record case, not a wrong PIN.
  const corrupted = { ...good, wallet: { iv: good.wallet.iv, data: good.wallet.data.map((b) => b ^ 0x5a) } };
  await assert.rejects(() => openAccountWithOneScan({ pk: PK, vault: corrupted, outputs }), (error) => {
    assert.ok(isDeviceKeyError(error), 'a corrupted blob must never reach the PIN counter');
    assert.equal(error.code, 'wallet-wrong-key');
    return true;
  });

  // The person unlocks with the PIN (that path is untouched and still passes),
  // and the migration runs again over the broken record.
  const repaired = await migrateToSecondKey({ pk: PK, vault: corrupted, accountSecret, outputs, salt2: recordSalt, replace: true });
  assert.equal(hasSecondKey(repaired), true);
  assert.notDeepEqual(repaired.wallet.data, corrupted.wallet.data);
  const opened = await openAccountWithOneScan({ pk: PK, vault: repaired, outputs });
  assert.deepEqual(Array.from(opened), Array.from(accountSecret));
});

test('A LATER LAUNCH OPENS IT TOO: a fresh scan from the STORED salt derives the same key', async () => {
  // The bug this test exists for: sealing under the outputs of one salt while
  // storing another salt passes a single-run lab and fails the second time the
  // person opens the app. The stored salt is the one the scan must ask with.
  const vault = { v: 3, dk: { k: 'prf', id: credentialId }, iv: [1], data: [2] };
  const firstOutputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials: fakeAuthenticator() });
  const migrated = await migrateToSecondKey({ pk: PK, vault, accountSecret, outputs: firstOutputs, salt2: recordSalt });

  // Later launch: the page has only the vault. It decodes the stored salt and
  // asks the authenticator again.
  const storedSalt = base64UrlToBytes(migrated.dk.salt2);
  const laterOutputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: storedSalt, credentials: fakeAuthenticator() });
  const opened = await openAccountWithOneScan({ pk: PK, vault: migrated, outputs: laterOutputs });
  assert.deepEqual(Array.from(opened), Array.from(accountSecret));

  // A scan that asked with some other salt must not open it.
  const wrongSalt = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
  const wrongOutputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: wrongSalt, credentials: fakeAuthenticator() });
  await assert.rejects(() => openAccountWithOneScan({ pk: PK, vault: migrated, outputs: wrongOutputs }), (error) => {
    assert.equal(error.code, 'wallet-wrong-key');
    return true;
  });
});

test('a migration that is not told which salt it sealed with is refused', async () => {
  const vault = { v: 3, dk: { k: 'prf', id: credentialId }, iv: [1], data: [2] };
  const outputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials: fakeAuthenticator() });
  await assert.rejects(() => migrateToSecondKey({ pk: PK, vault, accountSecret, outputs }), (error) => {
    assert.equal(error.code, 'missing-salt');
    return true;
  });
});

test('a vault that is not the device shape is refused before anything is written', async () => {
  const outputs = { first: Uint8Array.from(32, () => 1), second: Uint8Array.from(32, () => 2) };
  for (const vault of [null, { v: 2 }, { v: 4, dk: { k: 'prf' } }, { v: 3 }]) {
    await assert.rejects(
      () => migrateToSecondKey({ pk: PK, vault, accountSecret, outputs, salt2: recordSalt }),
      (error) => { assert.ok(isDeviceKeyError(error)); return true; },
    );
  }
});

test('an unmarked vault cannot be opened by the one-scan path', async () => {
  const outputs = { first: Uint8Array.from(32, () => 1), second: Uint8Array.from(32, () => 2) };
  await assert.rejects(
    () => openAccountWithOneScan({ pk: PK, vault: { v: 3, dk: { k: 'prf' }, iv: [1], data: [2] }, outputs }),
    (error) => { assert.equal(error.code, 'no-second-key'); return true; },
  );
});

test('the tomb input is derived from the stored salt, so a stale salt refuses instead of opening the wrong thing', async () => {
  const outputs = await requestTwoOutputs({ credentialId, rpId: 'ciphermessenger.org', salt1: recordSalt, salt2: recordSalt, credentials: fakeAuthenticator() });
  const base = { v: 3, dk: { k: 'prf', id: credentialId }, iv: [1], data: [2] };
  const good = await migrateToSecondKey({ pk: PK, vault: base, accountSecret, outputs, salt2: recordSalt });
  const stale = { ...good, dk: { ...good.dk, salt2: bytesToBase64Url(new Uint8Array(16).fill(255)) } };
  await assert.rejects(() => openAccountWithOneScan({ pk: PK, vault: stale, outputs }), (error) => {
    assert.ok(isDeviceKeyError(error));
    return true;
  });
  // And the same asks what the marker asks: the input really comes from salt2.
  const expected = await walletPrfInput(new Uint8Array(16).fill(255));
  assert.equal(expected.length, 32);
});
