import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceAuthorityWebAuthnInternals } from './deviceAuthorityWebAuthn.js';

function assertion(flags) {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = flags;
  return { response: { authenticatorData: authenticatorData.buffer } };
}

test('WebAuthn authority protection requires user presence, UV and a non-backup-eligible credential', () => {
  assert.deepEqual(deviceAuthorityWebAuthnInternals.authenticatorFlags(assertion(0x05)), {
    backupEligible: false, backupState: false, userVerified: true,
  });
  assert.throws(() => deviceAuthorityWebAuthnInternals.authenticatorFlags(assertion(0x01)), /verified user presence/i);
  assert.throws(() => deviceAuthorityWebAuthnInternals.authenticatorFlags(assertion(0x0d)), /backup eligible/i);
  assert.throws(() => deviceAuthorityWebAuthnInternals.authenticatorFlags(assertion(0x15)), /backup eligible/i);
  assert.throws(() => deviceAuthorityWebAuthnInternals.authenticatorFlags({ response: { authenticatorData: new ArrayBuffer(4) } }), /valid assertion/i);
});
