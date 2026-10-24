import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeGroupControl, isGroupAdmin } from './groupMembership.js';
import { requesterMayReceiveKey } from './groupKeyRotation.js';

const creator = 'c'.repeat(64);
const admin = 'a'.repeat(64);
const member = 'm'.repeat(64);
const stranger = 's'.repeat(64);
const members = [
  { pubkey: creator, role: 'admin' },
  { pubkey: admin, role: 'admin' },
  { pubkey: member, role: 'member' },
];

test('forged membership events from a non-admin are rejected, including when membership is unknown', () => {
  assert.equal(isGroupAdmin(members, stranger, creator), false);
  assert.equal(isGroupAdmin(members, admin, creator), true);
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: stranger, subject: member, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9000, sender: member, subject: stranger, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9002, sender: stranger, subject: stranger, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 39002, sender: stranger, subject: stranger, members: [], creator: '',
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: '', subject: member, members, creator,
  }), false);
});

test('admins may kick or edit, and join or leave is only the signer acting as themselves', () => {
  assert.equal(authorizeGroupControl({
    kind: 9001, sender: admin, subject: member, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9022, sender: member, subject: member, members, creator,
  }), true);
  assert.equal(authorizeGroupControl({
    kind: 9022, sender: stranger, subject: member, members, creator,
  }), false);
  assert.equal(authorizeGroupControl({
    kind: 9021, sender: stranger, subject: stranger, members, creator,
  }), true);
  assert.equal(requesterMayReceiveKey(null, member), false);
  assert.equal(requesterMayReceiveKey([creator, member], member), true);
  assert.equal(requesterMayReceiveKey([creator], member), false);
});
