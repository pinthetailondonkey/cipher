import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicKey } from 'nostr-tools';
import { __setDocOpEnvForTests, __setMembershipDbForTests, publishMemberDocUpdate } from './groupKeyRotation.js';
// publishDocOp runs through rememberMembers; drive it end to end here.
import { rememberMembers } from './groupKeyRotation.js';
import { setAtRestKeyProvider } from '../messageAtRest.js';
import { __setGroupKeyStoreForTests, putDocKey } from './groupKeyStore.js';

const ACCOUNT_SK = new Uint8Array(32).fill(41);
const OWNER = getPublicKey(ACCOUNT_SK);
const GID = 'pubop-test'.padEnd(64, '0');

const PK = (n) => String(n).padStart(64, '0');

async function setup() {
  const accountSk = ACCOUNT_SK;
  const { groupAuthorityKey } = await import('./groupAuthority.js');
  const w = await import('./groupDocWire.js');
  const g = await import('./groupDoc.js');
  const pins = await import('./authorityPins.js');
  const sess = await import('../sessionKey.js');
  const mem = await import('./memberDocStanding.js');

  const rows = [];
  const docsTable = {
    async get() { return undefined; },
    async put(row) { rows.push({ ...row }); },
    where(field) {
      return {
        equals: (value) => ({
          toArray: async () => rows.filter((row) => row[field] === value),
        }),
      };
    },
  };
  w.__setDocsDbForTests({ groupMemberDocs: docsTable });

  // Pin under the test's localStorage door so authorityPins exercises real code.
  class FakeStorage {
    constructor() { this.map = new Map(); }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
  }
  globalThis.localStorage = new FakeStorage();

  const { privateKeyBytes, pin } = await groupAuthorityKey(accountSk, GID);
  pins.rememberAuthorityPin(OWNER, GID, pin);
  sess.setSessionKey(accountSk);
  mem.bindMemberDocPins(pins.authorityPinGetterFor(OWNER));
  setAtRestKeyProvider(() => accountSk);
  const docKeyRows = new Map();
  const publishedDocs = [];
  __setGroupKeyStoreForTests({
    owner: () => OWNER,
    db: {
      groupDocKeys: {
        async get(key) { return docKeyRows.get(Array.isArray(key) ? key[0] : key); },
        async delete(key) { docKeyRows.delete(Array.isArray(key) ? key[0] : key); },
        async put(row) { docKeyRows.set(row.groupId, { ...row }); },
      },
      async transaction(_mode, _table, fn) { return fn(); },
    },
  });
  assert.ok(await putDocKey(GID, 0, new Uint8Array(32).fill(88)));

  __setDocOpEnvForTests({
    owner: OWNER,
    // Mirrors SimplePool.publish(relays, event): relays first.
    publish: async (relays, event) => {
      if (!event || !event.id) throw new Error('bad event');
      publishedDocs.push(event);
      return [Promise.resolve([null, 'ok'])];
    },
  });
  // Membership table seam: simple in-memory row.
  let memberRow = null;
  __setMembershipDbForTests({
    groupMemberSigs: {
      async get() { return memberRow ? { ...memberRow } : undefined; },
      async put(row) { memberRow = { ...row }; },
    },
  });
  return { privateKeyBytes, pin, docsTable, docKeyRows, publishedDocs, g, w };
}

// publishDocOp runs fire-and-forget beside the roster write; the tests wait
// for its row to land rather than racing it.
async function waitForDocHeads(min, tries = 40) {
  const { loadMemberDocHeads } = await import('./groupDocWire.js');
  let heads = [];
  for (let i = 0; i < tries; i += 1) {
    heads = await loadMemberDocHeads(GID);
    if (heads.length >= min) return heads;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heads;
}

test('a membership change folds onto the held doc and publishes gen+1', async () => {
  const env = await setup();
  try {
    // Genesis: owner only.
    const genesis = await env.g.signDocEvent(
      await env.g.genesisDocBody({ gid: GID, epoch: 1, members: [OWNER] }),
      env.privateKeyBytes,
    );
    await env.w.rememberVerifiedDoc({ groupId: GID, pin: env.pin, signed: genesis });
    await rememberMembers(GID, [OWNER, PK(7)]);
    const heads = await waitForDocHeads(2);
    assert.equal(heads[0]._gen, 1); // gen rolled forward
    // Rows store the signed wrapper; the body carries members.
    const standing = heads[0].body.members.map((row) => row.pubkey).sort();
    assert.deepEqual(standing, [PK(7), OWNER].sort());
  } finally {
    __setDocOpEnvForTests(null);
    __setMembershipDbForTests(null);
    __setGroupKeyStoreForTests(null);
  }
});

test('a signed migration from v2 binds the current owner actor by derivation', async () => {
  const env = await setup();
  try {
    // Historical v2 actor fields did not prove the account-to-actor link.
    const legacy = await env.g.signDocEvent({
      v: 2, t: 'gmemdoc', gid: GID, gen: 0, epoch: 1, parents: [],
      members: [{ pubkey: OWNER, role: 'admin', gen: 0, actor: env.pin }],
      removed: [],
    }, env.privateKeyBytes);
    await env.w.rememberVerifiedDoc({ groupId: GID, pin: env.pin, signed: legacy });

    await publishMemberDocUpdate(GID, [OWNER, PK(7)], {
      pins: { [PK(7)]: `02${'ab'.repeat(32)}` },
    });
    const heads = await waitForDocHeads(2);
    const owner = heads[0].body.members.find((row) => row.pubkey === OWNER);
    const admitted = heads[0].body.members.find((row) => row.pubkey === PK(7));
    assert.equal(heads[0].body.v, 3);
    assert.equal(owner?.actor, env.pin);
    assert.equal(owner?.actorVerified, true);
    assert.equal(admitted?.actorVerified, true);
  } finally {
    __setDocOpEnvForTests(null);
    __setMembershipDbForTests(null);
    __setGroupKeyStoreForTests(null);
  }
});

test('removal rides the same publisher and lands as a tombstone', async () => {
  const env = await setup();
  try {
    const genesis = await env.g.signDocEvent(
      await env.g.genesisDocBody({ gid: GID, epoch: 1, members: [OWNER, PK(3)] }),
      env.privateKeyBytes,
    );
    await env.w.rememberVerifiedDoc({ groupId: GID, pin: env.pin, signed: genesis });
    await rememberMembers(GID, [OWNER]); // PK(3) kicked
    const heads = await waitForDocHeads(2);
    const top = heads[0];
    assert.equal(top._gen, 1);
    assert.ok(top.body.removed.some((t) => t.pubkey === PK(3)));
    assert.ok(!top.body.members.some((m) => m.pubkey === PK(3)));
  } finally {
    __setDocOpEnvForTests(null);
    __setMembershipDbForTests(null);
    __setGroupKeyStoreForTests(null);
  }
});

test('no signing parity refuses rather than improvises (member device)', async () => {
  const env = await setup();
  try {
    // A DIFFERENT account derives a different key; its pin does not match.
    const strangerSk = new Uint8Array(32).fill(9);
    const sess = await import('../sessionKey.js');
    sess.setSessionKey(strangerSk);
    const genesis = await env.g.signDocEvent(
      await env.g.genesisDocBody({ gid: GID, epoch: 1, members: [OWNER] }),
      env.privateKeyBytes,
    );
    await env.w.rememberVerifiedDoc({ groupId: GID, pin: env.pin, signed: genesis });
    // Doc update deferred (publishDocOp threw into the catch): head stays gen 0.
    await assert.doesNotReject(() => rememberMembers(GID, [OWNER]));
    const heads = await env.w.loadMemberDocHeads(GID);
    assert.equal(heads.length, 1); // no phantom gen 1 from the wrong signer
  } finally {
    __setDocOpEnvForTests(null);
    __setMembershipDbForTests(null);
    __setGroupKeyStoreForTests(null);
  }
});

test('the real membership publisher refuses a missing key without advancing its held doc', async () => {
  const env = await setup();
  try {
    const genesis = await env.g.signDocEvent(
      await env.g.genesisDocBody({ gid: GID, epoch: 1, members: [OWNER] }),
      env.privateKeyBytes,
    );
    await env.w.rememberVerifiedDoc({ groupId: GID, pin: env.pin, signed: genesis });
    env.docKeyRows.clear(); // simulate a legacy group or unreadable local row
    await assert.rejects(publishMemberDocUpdate(GID, [OWNER, PK(8)]), /No readable governance-doc key/);
    assert.equal((await env.w.loadMemberDocHeads(GID)).length, 1, 'no unpublishable generation was stored');
    assert.equal(env.publishedDocs.length, 0, 'no v1 downgrade reached a relay');
  } finally {
    __setDocOpEnvForTests(null);
    __setMembershipDbForTests(null);
    __setGroupKeyStoreForTests(null);
  }
});
