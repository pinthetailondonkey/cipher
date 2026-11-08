import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { sealDeviceRecoveryPackage, openDeviceRecoveryPackage } from './deviceAuthorityRecoveryPackage.js';

const passphrase = 'violet lantern cedar river amber';

test('optional Argon2id package round-trips only the pinned recovery root and binds the existing account', async () => {
  const recoverySecret = generateSecretKey();
  const accountPubkey = getPublicKey(generateSecretKey());
  const recoveryPubkey = getPublicKey(recoverySecret);
  const backup = await sealDeviceRecoveryPackage({ recoverySecret, accountPubkey, recoveryPubkey, passphrase });
  assert.equal(backup.format, 'cipher-device-recovery-package-v1');
  assert.equal(backup.kdf, 'argon2id');
  assert.equal(backup.ciphertext.length, 48);
  assert.equal(JSON.stringify(backup).includes(Array.from(recoverySecret).join(',')), false);
  const restored = await openDeviceRecoveryPackage({ package: backup, accountPubkey, recoveryPubkey, passphrase });
  assert.deepEqual(restored, recoverySecret);
  restored.fill(0);
});

test('wrong passphrases, identities, and modified ciphertext cannot restore a package', async () => {
  const recoverySecret = generateSecretKey();
  const accountPubkey = getPublicKey(generateSecretKey());
  const recoveryPubkey = getPublicKey(recoverySecret);
  const backup = await sealDeviceRecoveryPackage({ recoverySecret, accountPubkey, recoveryPubkey, passphrase });
  await assert.rejects(openDeviceRecoveryPackage({ package: backup, accountPubkey, recoveryPubkey,
    passphrase: 'wrong violet lantern cedar river' }), /could not be opened/i);
  await assert.rejects(openDeviceRecoveryPackage({ package: backup, accountPubkey: getPublicKey(generateSecretKey()),
    recoveryPubkey, passphrase }), /does not match/i);
  const changed = { ...backup, ciphertext: [...backup.ciphertext] };
  changed.ciphertext[0] ^= 1;
  await assert.rejects(openDeviceRecoveryPackage({ package: changed, accountPubkey, recoveryPubkey, passphrase }), /could not be opened/i);
  await assert.rejects(openDeviceRecoveryPackage({ package: { ...backup, memoryKiB: 1 },
    accountPubkey, recoveryPubkey, passphrase }), /does not match/i, 'an attacker cannot lower the stored KDF work factor');
  await assert.rejects(openDeviceRecoveryPackage({ package: { ...backup, salt: [...backup.salt.slice(0, 15), 256] },
    accountPubkey, recoveryPubkey, passphrase }), /does not match/i, 'serialized KDF bytes must be canonical octets');
});

test('passphrase creation rejects empty or short guesses and does not replace the paper recovery phrase', async () => {
  const recoverySecret = generateSecretKey();
  const input = { recoverySecret, accountPubkey: getPublicKey(generateSecretKey()),
    recoveryPubkey: getPublicKey(recoverySecret) };
  await assert.rejects(sealDeviceRecoveryPackage({ ...input, passphrase: 'short' }), /at least 12 characters/i);
  await assert.rejects(sealDeviceRecoveryPackage({ ...input, passphrase: '            ' }), /at least 12 characters/i);
  assert.equal(recoverySecret.length, 32, 'the optional encrypted-copy format leaves the 24-word root format intact');
});
