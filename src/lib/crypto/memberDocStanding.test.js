import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindMemberDocPins,
  loadDocStanding,
} from './memberDocStanding.js';
import { signDocEvent, genesisDocBody, applyDocOps, authorityPinOf } from './groupDoc.js';

const GID = 'standing-test'.padEnd(64, '0');
const SK = new Uint8Array(32).fill(31);
const PIN = authorityPinOf(SK);
const PK = (n) => String(n).padStart(64, '0');

function tableFor() {
  // Rows accumulate here: rememberVerifiedDoc writes through put(), reads
  // come back through where().equals(groupId).toArray(). A table whose put
  // discards rows would silently answer "no docs held" forever.
  const docsRows = [];
  return {
    async get() { return undefined; },
    async put(row) { docsRows.push({ ...row }); },
    where(field) {
      return {
        equals: (value) => ({
          toArray: async () => docsRows.filter((row) => row[field] === value),
        }),
      };
    },
  };
}

async function storeDocs(signeds) {
  for (const signed of signeds) {
    // Writes go through the real door: rememberVerifiedDoc verifies against
    // the pin before storing, exactly as production will.
    const { rememberVerifiedDoc } = await import('./groupDocWire.js');
    await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed });
  }
}

test('no pin bound or no docs held answers null: the refuse contract', async () => {
  const table = tableFor([]);
  const wire = await import('./groupDocWire.js');
  const { __setDocsDbForTests } = wire;
  __setDocsDbForTests({ groupMemberDocs: table });

  bindMemberDocPins(null);
  assert.equal(await loadDocStanding(GID), null);

  bindMemberDocPins(async () => PIN);
  assert.equal(await loadDocStanding(GID), null); // pin but no doc

  bindMemberDocPins(async () => ''); // no stored pin
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: [PK(1)] });
  const signed = await signDocEvent(body, SK);
  await storeDocs([signed]);
  assert.equal(await loadDocStanding(GID), null); // doc but no pin to read it with
});

test('doc standing resolves roles and folds tombstones into snapshot shape', async () => {
  const table = tableFor([]);
  const { __setDocsDbForTests } = await import('./groupDocWire.js');
  __setDocsDbForTests({ groupMemberDocs: table });
  bindMemberDocPins(async () => PIN);

  const base = await signDocEvent(
    await genesisDocBody({
      gid: GID, epoch: 1,
      members: [PK(1), PK(2)],
    }).then((b) => ({ ...b, members: b.members.map((m, i) => ({ ...m, role: i === 0 ? 'admin' : 'member' })) })),
    SK,
  );
  void base;
  // Simpler: build the role variant directly.
  const withRoles = await signDocEvent({
    gid: GID, gen: 0, epoch: 1, parents: [],
    members: [{ pubkey: PK(1), role: 'admin', gen: 0 }, { pubkey: PK(2), role: 'member', gen: 0 }],
    removed: [],
  }, SK);
  await storeDocs([withRoles]);
  let standing = await loadDocStanding(GID);
  assert.deepEqual(standing, [
    { pubkey: PK(1), role: 'admin' },
    { pubkey: PK(2), role: 'member' },
  ]);

  // Remove PK(2): a kick is folded out of every future answer.
  const next = await signDocEvent(applyDocOps(withRoles.body, { remove: [PK(2)], gen: 1 }), SK);
  await storeDocs([next]);
  standing = await loadDocStanding(GID);
  assert.deepEqual(standing, [{ pubkey: PK(1), role: 'admin' }]);
});

test('conflict pair at top gen folds fail-closed: removal wins ties', async () => {
  const { __setDocsDbForTests } = await import('./groupDocWire.js');
  const base = await signDocEvent(
    await genesisDocBody({ gid: GID, epoch: 1, members: [] }), SK,
  );
  // Device A kicks PK(4) at gen 1 while device B admits PK(5) at gen 1.
  const leftHead = await signDocEvent(applyDocOps(base.body, {
    remove: [PK(4)], admit: [], gen: 1,
    // include both members in parents chain context via prior state
  }), SK).catch(() => null);
  void leftHead;

  // Build the pair directly at gen 1 off a common genesis naming both.
  const g2 = await signDocEvent({
    gid: GID, gen: 0, epoch: 1, parents: [],
    members: [
      { pubkey: PK(4), role: 'member', gen: 0 },
      { pubkey: PK(5), role: 'member', gen: 0 },
    ],
    removed: [],
  }, SK);
  const headA = await signDocEvent(applyDocOps(g2.body, { remove: [PK(4)], gen: 1 }), SK);
  const headB = await signDocEvent(applyDocOps(g2.body, { admit: [PK(6)], gen: 1 }), SK);
  assert.notEqual(headA.id, headB.id);

  const rowsAsTable = [];
  const stubTable = {
    async get() { return undefined; },
    async put(row) { rowsAsTable.push(row); },
    where(field) {
      return {
        equals: (value) => ({
          toArray: async () => rowsAsTable.filter((row) => row[field] === value),
        }),
      };
    },
  };
  __setDocsDbForTests({ groupMemberDocs: stubTable });
  bindMemberDocPins(async () => PIN);
  await storeDocs([headA, headB]);

  const standing = await loadDocStanding(GID);
  // Fail-closed fold: PK(4)'s tombstone (gen 1) >= its membership row (gen 0)
  // removes it even though only head A saw the kick; PK(6)'s admit rides in.
  assert.deepEqual(standing.map((r) => r.pubkey), [PK(5), PK(6)]);
});
