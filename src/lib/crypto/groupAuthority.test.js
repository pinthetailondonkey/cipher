import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupAuthorityKey,
  validPin,
  inviteLinkWithPin,
  authorityPinFromLink,
  GROUP_AUTHORITY_HKDF_INFO,
} from './groupAuthority.js';
import { signDocEvent, verifySignedDoc, genesisDocBody } from './groupDoc.js';

const SK = new Uint8Array(32).fill(11);
const GID = 'group-abc';
const GID_HEXPAD = GID.padEnd(64, '0');

test('authority key derives deterministically and the pin verifies a doc', async () => {
  const first = await groupAuthorityKey(SK, GID);
  const again = await groupAuthorityKey(SK, GID);
  assert.deepEqual(first.privateKeyBytes, again.privateKeyBytes);
  assert.equal(first.pin, again.pin);
  assert.ok(validPin(first.pin));
  // The pin is NOT the account pubkey: it is a fresh key, else H5's whole
  // point (the account pubkey riding every governance artifact) is lost.
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  assert.notEqual(first.pin, bytesToHex(secp256k1.getPublicKey(SK, true)));

  // End to end: derive -> sign doc -> verify against the pin (Step 0 chain).
  const body = await genesisDocBody({ gid: GID_HEXPAD, epoch: 1, members: ['f'.padStart(64, '0')] });
  const signed = await signDocEvent(body, first.privateKeyBytes);
  assert.ok(signed);
  const opened = await verifySignedDoc({ signed, pin: first.pin });
  assert.equal(opened.gid, GID_HEXPAD);
});

test('different groups derive different authority keys', async () => {
  const a = await groupAuthorityKey(SK, 'group-a');
  const b = await groupAuthorityKey(SK, 'group-b');
  assert.notDeepEqual(a.privateKeyBytes, b.privateKeyBytes);
  assert.notEqual(a.pin, b.pin);
});

test('derivation refuses a non-32-byte secret or an unusable gid', async () => {
  await assert.rejects(() => groupAuthorityKey(new Uint8Array(16), GID), /32-byte secret/);
  await assert.rejects(() => groupAuthorityKey(SK, ''), /Bad group id/);
  await assert.rejects(() => groupAuthorityKey(SK, 'g'.repeat(200)), /Bad group id/);
});

const PIN = 'ab'.repeat(33);

test('invite link carries the pin as `a`, separate from `g`', () => {
  const link = inviteLinkWithPin('https://x/app?tab=chat', GID, PIN);
  assert.match(link, /g=group-abc&u?a=/); // g then a appended with &
  assert.match(link, /a=ab%3Fab|a=ab/); // pin present
  const url = new URL(link);
  assert.equal(url.searchParams.get('g'), GID);
  assert.equal(url.searchParams.get('a'), PIN.toLowerCase());
});

test('link parsing degrades to no pin, never to a fetched value (H5)', () => {
  const url = new URL(inviteLinkWithPin('https://x/app', GID, PIN));
  assert.equal(authorityPinFromLink(url.searchParams), PIN);
  // Malformed pins vanish rather than half-parse.
  assert.equal(authorityPinFromLink(new URLSearchParams({ a: 'zz' })), '');
  assert.equal(authorityPinFromLink(new URLSearchParams({})), '');
  assert.equal(authorityPinFromLink(new URLSearchParams({ a: 'AB'.repeat(33) })), PIN); // case-normalized
});

test('builder refuses to emit a link without both halves', () => {
  assert.equal(inviteLinkWithPin('https://x', '', PIN), '');
  assert.equal(inviteLinkWithPin('https://x', GID, 'nothex'), '');
});

void GROUP_AUTHORITY_HKDF_INFO;
