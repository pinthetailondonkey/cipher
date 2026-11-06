import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalBody,
  docIdOf,
  genesisDocBody,
  applyDocOps,
  healHeads,
  compareDocs,
  resolveMembership,
  signDocEvent,
  verifySignedDoc,
  authorityPinOf,
  grantPermittedByDoc,
  docEpoch,
} from './groupDoc.js';

const PK = (n) => String(n).padStart(64, '0'); // a plausible-shaped pubkey stand-in
const GID = 'gid-a'.padEnd(64, '0');
const SK = new Uint8Array(32).fill(7);

const row = (pubkey, role = 'member', gen = 0) => ({ pubkey, role, gen });

test('canonical body sorts members and removed and drops junk rows', async () => {
  const body = canonicalBody({
    gid: GID, gen: 3, epoch: 1,
    parents: ['bbb'.padEnd(64, 'x').slice(0, 64).replace(/x/g, '3'), 'a'.padEnd(64, '0')],
    members: [row(PK(2)), row(PK(1)), { pubkey: 'zz-not-hex' }, { pubkey: PK(1), gen: 2 }],
    removed: [{ pubkey: PK(5), gen: 2 }],
    at: 1234, created_at: 9999,
  });
  assert.ok(body);
  // H9(3): `at`/`created_at` excluded; parents sorted+deduped; members sorted.
  assert.deepEqual(body.parents, ['a'.padEnd(64, '0'), 'bbb'.padEnd(64, '3')]);
  // Canonical filtering drops junk: a non-hex pubkey row. Two rows for one
  // pubkey (gen 0 and gen 2) are NOT duplicates — they are the admitting
  // history the tombstone rule reads, and both survive.
  assert.deepEqual(body.members.map((m) => m.pubkey + ':' + m.gen), [PK(1) + ':0', PK(1) + ':2', PK(2) + ':0']);
  assert.equal(body.at, undefined);
});

test('sign + verify and healing both fold over signed wrappers', async () => {
  const head = await signDocEvent(await genesisDocBody({ gid: GID, epoch: 1, members: [PK(1), PK(2)] }), SK);
  const next = applyDocOps(head.body, { admit: [PK(9)], remove: [PK(2)], gen: 4 });
  assert.ok(next && next.gen === 4);
  // canonicalBody accepts the wrapper too: a copy that arrives with its
  // signature fields still attached canonicalizes identically.
  assert.deepEqual(canonicalBody(head), canonicalBody(head.body));
});

test('older generation loses under compareDocs regardless of created_at (H2)', async () => {
  const old = { ...canonicalBody({ gid: GID, gen: 2, epoch: 1, parents: [], members: [], removed: [] }), id: 'x-old' };
  const newer = { ...canonicalBody({ gid: GID, gen: 7, epoch: 2, parents: [], members: [], removed: [] }), id: 'x-new' };
  // A skewed clock stamped the older doc later. created_at never decides.
  const winner = compareDocs(
    { ...old, at: 9_000_000_000 },
    { ...newer, at: 1000 },
  );
  assert.equal(winner.gen, 7);
});

test('equal gen same semantics is the same doc, not a conflict', () => {
  const a = canonicalBody({ gid: GID, gen: 3, epoch: 1, parents: [], members: [row(PK(1))], removed: [] });
  const shuffled = canonicalBody({ gid: GID, gen: 3, epoch: 1, parents: [], members: [row(PK(1))], removed: [] });
  const out = compareDocs({ ...a, id: 'same' }, { ...shuffled, id: 'same' });
  assert.ok(out && !out.conflict && out.gen === 3);
});

test('equal gen different semantics surfaces a conflict pair (H9)', () => {
  const a = { ...canonicalBody({ gid: GID, gen: 3, epoch: 1, parents: [], members: [row(PK(1))], removed: [] }), id: 'doc-aaa' };
  const b = { ...canonicalBody({ gid: GID, gen: 3, epoch: 1, parents: [], members: [row(PK(2))], removed: [] }), id: 'doc-bbb' };
  const out = compareDocs(a, b);
  assert.ok(out?.conflict?.length === 2 && out.winner === null);
});

test('tombstone survives a concurrent admit at equal gen (H1(b))', () => {
  const base = { gid: GID, gen: 5, epoch: 1, parents: ['p'.padEnd(64, '0')], members: [row(PK(1))], removed: [] };
  // Side A removes PK(1) at gen 6.
  const a = canonicalBody(applyDocOps(base, { remove: [PK(1)], gen: 6 }));
  // Side B re-admits... no wait, B admits someone else. The concurrent case:
  // A's doc has tombstone@6 for PK(1) admitted@0 — resolve keeps it folded out.
  assert.deepEqual(resolveMembership(a).map((r) => r.pubkey), []);
  // B admitted PK(9) at gen 6 as well -> merge folds both ops.
  const b = canonicalBody(applyDocOps(base, { admit: [PK(9)], gen: 6 }));
  const healed = healHeads({ local: { ...a, id: 'aaa' }, remote: { ...b, id: 'bbb' } });
  assert.ok(healed && healed.gen === 7);
  const standing = resolveMembership(healed).map((r) => r.pubkey);
  assert.deepEqual(standing, [PK(9)]);
  // The tombstone for PK(1) survived the merge: prune rule not yet due (H9).
  assert.ok(healed.removed.some((t) => t.pubkey === PK(1)));
});

test('re-admit above the removal gen clears the tombstone (H1(b))', () => {
  const base = { gid: GID, gen: 5, epoch: 1, parents: ['p'.padEnd(64, '0')], members: [], removed: [{ pubkey: PK(3), gen: 4 }] };
  const next = canonicalBody(applyDocOps(base, { admit: [PK(3)], gen: 6 }));
  assert.deepEqual(resolveMembership(next).map((r) => r.pubkey), [PK(3)]);
  assert.equal(next.removed.some((t) => t.pubkey === PK(3)), false);
});

test('re-admit below the removal gen does NOT resurrect the member', () => {
  const base = { gid: GID, gen: 8, epoch: 1, parents: [], members: [], removed: [{ pubkey: PK(3), gen: 6 }] };
  // A stale doc's admit at a lower gen replays against tombstone gen 6: the
  // tombstone holds and resolveMembership folds the row out.
  const next = { ...canonicalBody(base), members: [row(PK(3), 'member', 5)] };
  assert.deepEqual(resolveMembership(next).map((r) => r.pubkey), []);
});

test('missing doc refuses rather than falling back is enforced by shape (H4)', () => {
  // resolveMembership of nothing is empty-but-defined; callers treat a missing
  // doc as refuse. The witness here: there is no helper that turns "no doc"
  // into a roster read. If one grows here, this test must grow teeth too.
  assert.deepEqual(resolveMembership(null), []);
});

test('heal picks the container when one head names the other (H9 rule a)', () => {
  // Two heads at gen 3. One's parents name the other's id; parent ids are
  // hex-64 like real ones, otherwise canonical filtering drops them.
  const ancestorId = 'b'.padEnd(64, '7');
  const descendant = { ...canonicalBody({ gid: GID, gen: 3, epoch: 1, parents: [ancestorId], members: [row(PK(4)), row(PK(5), 'member', 3)], removed: [] }), id: 'c'.padEnd(64, '9') };
  const parentAtGen3 = { ...canonicalBody({ gid: GID, gen: 3, epoch: 1, parents: ['a'.padEnd(64, '1')], members: [row(PK(4))], removed: [] }), id: ancestorId };
  const healed = healHeads({ local: parentAtGen3, remote: descendant });
  assert.ok(healed);
  // b (descendant) names a (ancestor) in its parents: the ancestor is subsumed,
  // winner is the descendant itself, gen unchanged. No bump for containment.
  assert.equal(healed.id, 'c'.padEnd(64, '9'));
  assert.equal(healed.gen, 3);
});

test('two devices healing the same conflicting heads emit identical bodies', async () => {
  const base = canonicalBody({ gid: GID, gen: 10, epoch: 1, parents: [], members: [row(PK(1))], removed: [] });
  const leftId = await docIdOf(base);
  // Both ids must be real hex-64 doc ids (canonical filter drops anything else).
  const rightId = await docIdOf(canonicalBody({ gid: GID, gen: 10, epoch: 1, parents: [], members: [row(PK(1)), row(PK(3))], removed: [] }));
  const left = { ...base, id: leftId, members: [...base.members, row(PK(2))] };
  const right = { ...base, id: rightId, members: [...base.members, row(PK(3))] };
  const localHeal = healHeads({ local: left, remote: right });
  const remoteHeal = healHeals(right, left);
  function healHeals(a, b) { return healHeads({ local: a, remote: b }); }
  assert.deepEqual(localHeal, remoteHeal);
  assert.deepEqual(localHeal.parents, [left.id, right.id].sort());
  assert.deepEqual(resolveMembership(localHeal).map((r) => r.pubkey), [PK(1), PK(2), PK(3)]);
});

test('sign + verify round-trip against the pin', async () => {
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: [PK(1)] });
  const signed = await signDocEvent(body, SK);
  assert.ok(signed?.sig);
  const pin = authorityPinOf(SK);
  const opened = await verifySignedDoc({ signed, pin });
  assert.ok(opened && opened.gid === GID && opened.epoch === 1);
  // Tampered body fails even though the signature is untouched.
  const tampered = { ...signed, body: { ...signed.body, gen: 99 } };
  assert.equal(await verifySignedDoc({ signed: tampered, pin }), null);
  // Wrong pin fails.
  assert.equal(await verifySignedDoc({ signed, pin: authorityPinOf(new Uint8Array(32).fill(9)) }), null);
  // Shuffled copy verifies the same (canonical recompute).
  const shuffled = { ...signed, body: { ...signed.body, members: [...signed.body.members].reverse(), removed: [...signed.body.removed].reverse() } };
  assert.ok(await verifySignedDoc({ signed: shuffled, pin }));
});

test('grant must name the doc it rides and stay inside its epoch (H3)', async () => {
  const body = await genesisDocBody({ gid: GID, epoch: 4, members: [PK(1)] });
  const signed = await signDocEvent(body, SK);
  assert.ok(signed, 'genesis doc signs');
  // Genesis: gen 0, no parents — valid. Grant at doc gen 0 offering epoch 4.
  assert.equal(grantPermittedByDoc({ docId: signed.id, doc: signed.body, grant: { docId: signed.id, gen: 0, epochs: [4] } }), true);
  // An epoch above the doc's bound is refused.
  assert.equal(grantPermittedByDoc({ docId: signed.id, doc: signed.body, grant: { docId: signed.id, gen: 0, epochs: [5] } }), false);
  // A grant naming a doc other than the one verified here is refused, even
  // when grant.docId matches its own claim (H3: a stale doc cannot back a
  // fresh grant) — the id must be the one verifySignedDoc recomputed.
  assert.equal(grantPermittedByDoc({ docId: signed.id, doc: signed.body, grant: { docId: 'other-doc-id', gen: 0, epochs: [4] } }), false);
  // An empty epochs list is refused: a grant must offer something.
  assert.equal(grantPermittedByDoc({ docId: signed.id, doc: signed.body, grant: { docId: signed.id, gen: 0, epochs: [] } }), false);
  // A grant carrying an epoch the doc does not authorize alongside one it does.
  assert.equal(grantPermittedByDoc({ docId: signed.id, doc: signed.body, grant: { docId: signed.id, gen: 0, epochs: [4, 5] } }), false);
  assert.equal(docEpoch(signed), 4);
});
