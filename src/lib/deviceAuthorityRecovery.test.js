import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  prepareOfflineRecoveryBackup, restoreOfflineRecoverySecret, verifyOfflineRecoveryBackup,
} from './deviceAuthorityRecovery.js';

test('offline backup is a 24-word BIP39 recovery phrase with random confirmation positions', () => {
  const recoverySecret = generateSecretKey();
  let next = 0;
  const backup = prepareOfflineRecoveryBackup({
    recoverySecret,
    randomBytes(target) {
      target.fill(255);
      target[0] = next++;
      target[1] = next++;
      target[2] = next++;
      target[3] = next++;
      return target;
    },
  });
  assert.equal(backup.format, 'cipher-device-recovery-v1');
  assert.equal(backup.words.length, 24);
  assert.equal(new Set(backup.confirmationPositions).size, 4);
  const answers = backup.confirmationPositions.map((position) => backup.words[position - 1]);
  assert.equal(verifyOfflineRecoveryBackup({
    recoverySecret, confirmationPositions: backup.confirmationPositions, confirmationAnswers: answers,
  }), true);
  answers[0] = 'not-the-word';
  assert.equal(verifyOfflineRecoveryBackup({
    recoverySecret, confirmationPositions: backup.confirmationPositions, confirmationAnswers: answers,
  }), false);
});

test('restore requires the exact pinned recovery fingerprint and never accepts the account key as a substitute', () => {
  const recoverySecret = generateSecretKey();
  const accountSecret = generateSecretKey();
  const backup = prepareOfflineRecoveryBackup({ recoverySecret, randomBytes: (target) => {
    target.set([0, 1, 2, 3]);
    return target;
  } });
  const phrase = backup.words.join(' ');
  const restored = restoreOfflineRecoverySecret({ phrase, expectedRecoveryPubkey: getPublicKey(recoverySecret) });
  assert.deepEqual(restored, recoverySecret);
  restored.fill(0);
  assert.throws(() => restoreOfflineRecoverySecret({ phrase, expectedRecoveryPubkey: getPublicKey(accountSecret) }), /does not match/i);
  assert.throws(() => restoreOfflineRecoverySecret({ phrase }), /independently pinned/i);
});

test('invalid word count, bad checksum, and wrong random-word confirmations fail closed', () => {
  const recoverySecret = generateSecretKey();
  const backup = prepareOfflineRecoveryBackup({ recoverySecret, randomBytes: (target) => {
    target.set([4, 5, 6, 7]);
    return target;
  } });
  assert.throws(() => restoreOfflineRecoverySecret({
    phrase: backup.words.slice(0, 23).join(' '), expectedRecoveryPubkey: getPublicKey(recoverySecret),
  }), /24 words/i);
  const wrongChecksum = [...backup.words];
  wrongChecksum[0] = wrongChecksum[0] === 'abandon' ? 'ability' : 'abandon';
  assert.throws(() => restoreOfflineRecoverySecret({
    phrase: wrongChecksum.join(' '), expectedRecoveryPubkey: getPublicKey(recoverySecret),
  }), /invalid|checksum|fingerprint/i);
  assert.equal(verifyOfflineRecoveryBackup({
    recoverySecret,
    confirmationPositions: [backup.confirmationPositions[0], ...backup.confirmationPositions.slice(1)],
    confirmationAnswers: ['wrong', ...backup.confirmationPositions.slice(1).map((position) => backup.words[position - 1])],
  }), false);
});

test('backup generation refuses missing randomness and malformed recovery material', () => {
  assert.throws(() => prepareOfflineRecoveryBackup({ recoverySecret: new Uint8Array(32), randomBytes: () => new Uint8Array(16) }), /valid independent recovery/i);
  assert.throws(() => prepareOfflineRecoveryBackup({ recoverySecret: generateSecretKey(), randomBytes: null }), /randomness/i);
});
