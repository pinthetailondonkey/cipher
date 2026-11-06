# Membership design — a decision memo, not an implementation

What this is: the surviving conclusions of three design rounds about *who may
hold a group's rotating key*, written down so the argument does not have to be
re-derived. Drafted at `5fbb8ab74251b67f836b7b717f7818411fbc1e7d`; HEAD moved
to `78e0245465d896cfbe92314435cda4afddd79009` while it was being written (three
commits, none touching membership), and every cited line was re-checked at that
second pin. Branch `main`, three ahead of `origin/main`. The worktree was dirty
when this was written; see section 9. Nothing here is built. No test was run.

Labels, same as `docs/PRIVACY-REVIEW.md`:

- `[V]` verified — read out of the source at this pin.
- `[I]` inference — a join of two verified facts, stated as an inference.
- `[A]` assumption — believed, not proven here.
- `[O]` open — needs a decision or a measurement, not more prose.
- `[P]` proposal — designed here, unimplemented.

What this is not: a standard, a NIP, a security proof, or a claim that the
crypto below has been reviewed by anyone but its author. Section 6 lists what is
deferred and who would have to check it.

## 0. The reframing that reordered everything

The first read of this problem treated it as a *membership* problem: the group
relay signs the roster, so the relay controls membership, so membership history
should be made tamper-evident. Two rounds of design went into a per-device-signed
DAG, an op-merge table, a time-free fold, equivocation freeze rules and a relay
protocol change to carry it.

Read against `docs/VISION.md` instead, it is a **key-distribution honesty
problem, not a ledger-design problem**. `[V]` VISION.md section 3 invariant 3:

> Group messages use rotating AES-GCM keys. Removing a member rotates the key so
> they cannot read later messages.

That is the boundary: *who can read after a removal*. Not "what did we agree on
Tuesday". Nothing in the grant path asks about history. `[A]` the DAG was
mechanism for a question the boundary does not ask, bought at the price of a
relay-side protocol requirement.

`[V]` and the repo already says the quiet part out loud, in `README.md:148`:

> Group membership for key hand-off is the relay's kind 39002, not a
> member-signed list. That makes the group relay a confidentiality trust anchor:
> a relay admin who can add a pubkey to the member snapshot will be handed the
> group key by any member who answers a key request. **That is inherent to
> NIP-29.**

`[V]` VISION.md section 3 invariant 7 ("no central server required: the app works
against more than one relay") is the second box's reason to exist, which the
current design does not use for anything.

## 1. Where relay authority actually sits

`[V]` `authorizeMemberSnapshot` (`groupMembership.js:222-229`) accepts a 39002
only if it is signed by the relay's own key, and `rememberMembers` stores the
authorized frame. `loadMemberSnapshot` / `loadMemberSnapshotRecord`
(`groupKeyRotation.js:91-97`) then hand that stored list to at least seven
consumers:

| # | Consumer | Read |
| --- | --- | --- |
| 1 | `senderAuthorizedForGroupKey` — who may hand out keys | `groupKeyDistribution.js:153-168` |
| 2 | `senderMayInstallGroupKey` — who may install | `groupKeyDistribution.js:186-195` |
| 3 | `senderMaySetGroupLabel` — rename authority, a phishing surface | `groupKeyDistribution.js:47-57` |
| 4 | `keyRequestDecision` / `requesterMayReceiveKey` — who gets a key | `groupKeyRotation.js:112-170`, `:254` |
| 5 | `trustedGroupCreator` — who counts as the creator | `groupMembership.js:129-139` |
| 6 | `authorizeGroupControl` / `authorizeGroupPin` | `groupMembership.js:147-171`, `useNIP29Group.js:70-77`, `:1537-1587` |
| 7 | the displayed member list and the key reconciler | `useNIP29Group.js:1145, 1157`, `useGroupKeyReconciler.js:9` |

`[V]` the design is in the comments: "The stored snapshot is the relay-signed
39002 list (rememberMembers only stores authorized frames). No snapshot, no
install" (`groupKeyDistribution.js:112-113`).

`[V]` one honest continuity note: the code already distrusts the roster in one
place. `authorizeGroupControl` requires the creator's own key for control
actions *against* the creator, with the comment "a relay row cannot dethrone the
identity that created the group" (`groupMembership.js:151-164`). The proposal
below is that instinct generalized from the creator to the whole set.

## 2. The decision

**Replace the relay-signed roster as the *normative* source for key hand-off with
an owner-signed member-set document carrying a monotonically increasing
generation counter, published to both group boxes, and checked by every consumer
that today reads the snapshot.** Demote 39002 to display fallback.

Why a state document and not the log:

- `[I]` the question is "may S hold epoch E", which is current state. For a
  small bounded set, a signed state doc beats an append-only log; that is the
  ordinary replication trade, not a novelty.
- `[P]` the doc needs no relay support. It rides the normal replaceable-event
  write path, so no new kinds, no unauthenticated-write carve-out, no CLOSED
  reason protocol negotiation, and no migration story in which the relay has to
  change its authority semantics.
- `[P]` rollback protection without a log: a stale doc loses to a higher
  generation, so `gen` is the replay defence that ancestry was doing.

The DAG is kept as v2 (section 8, step 3), gated on per-device revocation or
attribution actually mattering, and on equal-gen conflicts proving frequent.

## 3. What this closes, and what it does not

`[P]` closes: a relay admin writing a pubkey into 39002 no longer gets that
pubkey handed the key by itself, **provided** (a) the doc is held, (b) the client
refuses the roster fallback when it is not, and (c) the signer is a key the
relay cannot produce. It also gives both boxes a reason to exist: each becomes a
copy location for a signed artifact, so a copy that disagrees is meaningful.

`[I]` does not close: the relay keeps availability and ordering, can withhold the
doc, can serve a stale doc, can serve different docs to different readers, and
stays the thing that answers "is this gid alive". It cannot *forge* an addition.

`[I]` does not close, and would not under any design here: a device holding the
account key retains authority while the account key is not rotated (section 6,
B4); and a removed member can read until their removal lands *and* the rotation
completes, which `[V]` `README.md:150` already says is today's behaviour ("a kick
is eventual, not instant").

## 4. Holes found in the state-doc design, and the fixes taken

Rounds two and three were adversarial against the doc, not against the DAG.
H1-H8 were found in round two; H9 in round three. Each survived only after the
fix, and two of the fixes changed the doc's shape.

**H1 `[I]` a bare `(members, gen)` doc cannot express a merge.** A state doc
cannot distinguish "S was removed" from "S was never there", so
"removals beat admissions" is undecidable from two conflicting docs. *Fix, taken:*
carry a bounded `removed[]` with the generation that set it; an `admit`
clears the tombstone; tombstone beats a concurrent `admit` at equal generation.
The doc contains a small log and says so.

**H2 `[V]`/`[A]` `gen` and the relay's replaceable rule disagree.** `[V]` the
client merges a parameterized replaceable record **by `created_at`**, not by any
counter: `memberBaseline.js:79-80` keeps "best by `at`" inside the reader at
`:69`. `[A]` a relay that applies replaceable semantics does the same by
definition, and no relay was contacted this session to confirm its own copy rule
against a counter bearing field. Either way the fix is the same: publishing
stamps `created_at = max(previous.created_at + 1, now)`, and `gen` is
authoritative over `created_at` at every read and at rest. A skewed clock can
otherwise make the relay drop gen+1 in favour of gen.

**H3 `[I]` the doc must name the epoch, and the grant must name the doc.**
Otherwise a responder holding a current key but a stale doc hands the newer epoch
to a just-removed member. *Fix, taken:* doc carries `epoch`; a grant carries
`{docId, gen, epochs[]}`; the recipient installs only what the named doc permits.

**H4 `[I]` "refuse, do not fall back" is load-bearing.** If a client falls back
to 39002 when no doc is found, a withholding relay causes the fallback and
silently reacquires authority. *Fix, taken:* no doc, no answer — refuse the key
request and say so; keep the last-seen doc sealed at rest, per generation; a
lower generation never overwrites a higher one at rest.

**H5 `[I]` signer ambiguity fights the pseudonym plan.** A doc signed by the
account key puts that key on the group box on a governance artifact, so a later
pseudonymity migration cannot drop it without re-pinning out of band per member.
*Fix, taken:* sign with a per-group authority key derived from the account key,
pinned at creation, carried in the invite link. `[I]` residual: a member cannot
compute the authority pubkey from the account's *public* key, so it must be
learned out of band, and a derived signer cannot be revoked while the account key
is not rotated.

**H6 `[I]` "cross-box comparison for free" was wrong.** Both boxes share the
relay key, so an operator can withhold on both at once. Signatures buy
forge-protection, not operator independence. *Fix, taken:* real independence
comes from member caches (free: members already store what they read) and an
optional mirror on the DM relay — `[V]` acceptable because the analogous
`cipher-members:<gid>` baseline already puts similar data there
(`memberBaseline.js:11-12, 64`).

**H7 `[O]` who may sign.** Owner-only makes equal-generation handling trivial but
defers an admin's kick until the owner's device is on, whereas `[V]` a roster
admin can kick today (`groupMembership.js:147-171`). *Fix, taken:* owner-only at
v1, with the owner's device republishing when it sees a 9001, and the deferral
disclosed to admins. A signer set reopens H1 across signers and is deferred.

**H8 `[O]` reactions are not free and not in this path.** `[V]` VISION.md
section 4 lists "reactions (withdrawal via a kind-5 delete)" as built, so moving
them into encrypted payloads is a visible contract change; `[V]`
`useNIP29Group.js:1383` special-cases only `typing` before everything else
becomes a message row, and `:1480` skips it again on the other path; `[V]` DM reactions inherit the
sent-wrap hole (`docs/PRIVACY-REVIEW.md`, F13). *Fix, taken:* keep out of the
critical path, own migration note.

**H9 `[I]` the equal-generation rule had a repair dead-end.** "Name and surface
a conflict, never silently resolve" leaves both devices believing they are
current; nobody republishes, and the split-brain waits for a human who cannot
compare two digests side by side. *Fix, taken, and this is the part of H9 that
needed correcting:* a link field is mandatory after genesis, and the healing is a
rule over a pair of heads, in this order: (a) if one head's ancestry contains the
other head, that one wins; (b) otherwise merge both by union and bump, so that
merging is what a pair with no containment gets instead of arbitration. Three
corrections to the fix as first proposed:

1. `[I]` **The field must be a *set*, not a single `prev`.** A merge doc that
   names only one of two conflicting docs erases the other from the chain, so a
   later reader cannot reconstruct that both were seen. A set of ids (normally
   one) is both the merge order and the observed frontier, so the separate
   `seen[]` field collapses into it.
2. `[I]` **Therefore the frontier is not optional if the healing is to be
   mechanical.** With the frontier absent, "has seen more" degenerates to a
   heuristic and the human step stays.
3. `[P]` **The doc id must hash a canonical semantic core, excluding `at` and
   `created_at`.** Then two devices that merge the same two conflicting docs
   produce byte-identical docs at the same generation, `[I]` and the conflict
   evaporates without anyone arbitrating. Canonical ordering of `members[]` and
   `removed[]` is required for this, and it is harmless anyway.

`[P]` **resolution on `seen[]`:** it is not a separate optional field. `parents`
carries that job, mandatory after genesis, normally one id. Leaving it optional
would make the healing heuristic at exactly the moment a conflict happens, which
is the moment it is too late to add a field. One always-present field does both,
and the cost is that past genesis no doc is valid without a parent.

`[I]` **how a device learns it is in a conflict:** not from ancestry, since two
equal-generation docs descend from the same parent and neither is the other's
ancestor. It learns from *the doc set*, on the next read, when two docs at the
same generation come back. That is why the healing is a merge and not a race:
nothing is resolved until someone can see both.

`[I]` **the merge is deterministic because the ops are:** union of `members`,
union of `removed` minus a re-admit, and H1(b) settles a member the other side
killed (the tombstone carries gen, the membership entry carries a lower gen,
removal wins). `[P]` a device that has both heads signs gen+1 naming both, so
`[I]` two devices doing it simultaneously emit the same document (H9.3).

`[I]` **termination is not one round in general; it is one round once the doc set
is common.** If A saw a third conflicting doc that B did not, the two merges
disagree again at gen+1 and the process repeats. It converges because each round
strictly grows what each side has folded, and `gen` strictly increases, but the
number of rounds is bounded by the disagreement, not by one.

`[I]` **an unfetchable parent is a real case, and it is the gap problem the DAG
had too.** A merge doc can name a parent nobody can fetch (dropped by the relay,
or by the 30-day TTL, B7). `[P]` tolerate it: accept the doc, hold the branch in
`[O]` "incomplete" until the parent arrives or a bounded timeout passes, and name
it in the UI. Do not silently accept, and do not block the group.

`[I]` **pruning is bounded by the tombstones.** A tombstone may only be pruned
once no doc that could still name that member is servable, otherwise a later
union resurrects the member. `[P]` keep tombstones at least as long as the
oldest doc generation the client is willing to accept.

`[I]` bounded nuisance, not forgery: a device can name parent ids it has not
fetched to look better-informed. The other side can fetch and check, and a
missing parent lands in the incomplete branch above.

`[P]` cheap mitigation that narrows but does not close the window: re-read the
doc set immediately before signing, and if a doc at the same generation is
already there, sign gen+1 instead. Still TOCTOU.

`[O]` **alternative not taken, recorded:** a single-writer rule (one primary
device signs, the others submit intents) removes equal-generation conflicts
entirely. Cost: the primary must be online for any membership change, and it is
one availability point. Worth revisiting if conflicts are frequent, because it
trades the merge machinery for an operational constraint rather than for
linkage.

## 5. Why there is no section 5

`[I]` Section 4's alternative-not-taken note (single-writer rule) is where a
group-keying-by-relay proposal would have gone; the reframing in section 0 made
it moot before it was written. Numbered gap kept so cross-references stay stable.

## 6. The minimum spec

`[P]` Document, published to both boxes under a parameterized replaceable kind,
`d` derived from the gid:

```
{ "v": 1,
  "gid": "...",
  "gen": 7,                      // strictly increasing
  "epoch": 4,                    // the key generation this doc authorizes
  "parents": ["<docId>", ...],   // mandatory after genesis; sorted
  "members": [ { "pk": "...", "role": "member|admin", "gen": 5 } ],
  "removed": [ { "pk": "...", "gen": 6 } ],
  "at": 1762... }
```

- Signed by the per-group authority key; `docId` = hash of the canonical body
  excluding `at` / `created_at`.
- `gen` strictly increases and is authoritative over `created_at` everywhere,
  including at rest. Publishing stamps `created_at` monotonically (H2).
- Higher `gen` wins. Equal `gen` with different semantics is surfaced, then
  healed by the ancestry rule (H9). Equal `gen` after canonical hashing is the
  same doc, not a conflict.
- A doc whose `parents` cannot all be fetched is held incomplete, not rejected
  and not silently accepted (H9).
- `removed` is bounded and pruned only once no servable doc could still name the
  member (H9).
- `parents`: the observed heads, sorted, mandatory after genesis; normally one
  id. It is the merge order and the frontier at once (H9).
- A grant carries `{docId, gen, epochs[]}` and must be a subset of the grantor's
  held epochs (H3).
- No doc ⇒ refuse the key request, never answer from 39002 (H4).
- The doc is normative for the grant path, the install path, the label authority
  path and the control authority path — all seven consumers in section 1, not
  just the first.

`[P]` retaining the log as v2 means: if per-device revocation or attribution is
ever required, entries signed per device, an explicit op set, and the op-pair
matrix from round one are already written down. The two things worth carrying
over regardless are the **time-free validity principle** (validity is a property
of the referenced set, never of `now`) and the **narrowed equivocation
definition** (same signer, same references, different content).

### Provenance of the Step-0 decision (added at `917793e`+)

`[A]` The signer question had two live answers and one dead one. Dead: the relay
as signer is what the whole design removes, so it cannot be trusted to produce
the artifact that removes its own authority. Live candidates:

1. **The account key signs directly** (`[I]` simplest). Defeated in H5: it puts
   the account pubkey on the group box on every governance artifact, which
   Step 2's pseudonymity plan then cannot unwind without re-pinning out of band
   per member.
2. **A per-group authority key derived from the account key** (H5's fix), pinned
   at group creation, carried in the invite link so every member learns it out
   of band rather than from a relay row. Members verify doc signatures against
   a pin they learned when they joined, never against something fetched fresh.

**Decision: answer 2, taken.** `[P]` it is one decision for two artifacts: this
authority key is *also* the per-group GM signing key for AUTH and kind-9 messages
(Step 2). One derivation, one pin, one re-learn cost if ever rotated. B5 (per-
account vs per-device pseudonym) stays open because it changes the derivation,
and any change to the derivation after members have pinned invalidates every
existing pin - the reason this page precedes all code.

`[I]` Residuals accepted by taking answer 2, restated as the contract Steps 1-2
must honor: (a) an authority key cannot be revoked while the account key is not
rotated - compromise means rotating both; (b) the pin travels only through the
invite link or another out-of-band path, never from a fetchable source; (c)
per-device derivation is deferred with B5 and changes nothing until decided.

`[I]` Generation rule carried to Step 1 unchanged from sections 4 and 6: `gen`
strictly increases, is stamped monotonically into `created_at` on publish (H2),
authoritative over `created_at` everywhere including at rest; higher `gen` wins;
equal-`gen` distinct docs heal by H9's parents-as-frontier union-and-bump.
Nothing else needs deciding here.

## 7. Deferred questions

- **B1 `[O]`** the derivation and the signature scheme have no external review;
  the cost is not a sign-off pass but real artifacts: canonical encodings and
  test vectors for every hashed structure (doc body, doc id, pin forms, gid
  salt), a written threat model that says which adversary each primitive is
  assumed to stop, and an adversarial read of the HKDF info-string choices
  (`cipher-group-authority-key-v1`, `cipher-gmemdoc-key-v1`) for cross-domain
  derivation collisions. B5 decides before any of it starts.
- **B2 `[O]`** whether any relay support is needed at all (the argument above is
  that it is not, which is the design's main selling point and therefore the
  first thing to falsify).
- **B3 `[O]`** rollback of more than one generation is caught; a fresh install
  has no memory, so detecting an old-but-consistent doc on a device needs an
  out-of-band comparison that is not designed.
- **B4 `[O]`** device revocation while the device holds the account key (H5
  residual).
- **B5 `[O]`** per-account vs per-device pseudonym for AUTH and messages; changes
  the derivation, so decide before the crypto review.
- **B6 `[O]`** the lost-history decision for your own sent DMs (F13), which also
  decides DM reactions.
- **B7 `[O]`** retention of doc generations against the new 30-day wrap TTL
  (`giftWrap.js:32, 52`).
- **B8 `[O]`** who signs when the owner is not the only admin (H7).
- **B9 `[O]`** the relay's own copy rule for a replaceable kind has never been
  read, because no relay was contacted in these rounds (H2). Confirm before
  relying on `gen` over the wire rather than only at rest.

## 8. Sequence

- **Step 0 — decide, one page.** Done. The signer is a per-group authority key
  derived from the account key, pinned at creation, carried in the invite link
  (decision recorded after section 6). Nothing ships before this was decided,
  because a re-pin later is an out-of-band re-learn per member, not a code
  change.
- **Step 1 — the doc.** Dual-published, cross-box compared, sealed per
  generation at rest. Acceptance criteria: H1(b) tombstones, H2 monotonic
  `created_at` plus gen-authoritative reads, H3 doc/epoch binding in grants, H4
  refuse-not-fallback with higher-gen-wins at rest, H9 parents-as-set plus
  has-seen-more healing, H7 deferral disclosed. `[I]` this is the only step that
  touches the boundary, and it needs no relay support.
- **Step 2 — pseudonymous identity for AUTH and messages.** Independent of
  Step 1 in mechanism, dependent on Step 0 for the signer choice. The per-group
  GM key and the doc authority key are one key (H5): same derivation, pinned at
  creation, learned out of band through the invite link. Step 2 closes N3's
  passive-observer graph the moment both cut over, because after it the identity
  key signs nothing on a group box.
  **Landed (slice 1).** Every kind-9 send site (messages, queued Securing sends,
  key requests including the inline one on a pending encode, typing) signs with
  `gmIdentity.actorForGroup`, and the NIP-42 AUTH proof does too
  (`gmIdentityWire.signActProof`). One derivation per kind-9 encrypts (`AAD`)
  and signs: `resolveActorSigner` returns the byte secret, the canonical
  AAD-sender (`wireSender`, the x-only form event.pubkey will carry) and the
  compressed pin for the `author` tag. The sealed body carries the sender's
  account pubkey in a `by` field (`groupMessageCodec.encodeGroupPayload`), so
  blocking, roster standing, own-message cleanup and grant routing read an
  account-level fact from inside ciphertext while the relay sees only the pin.
  Witnessed by `gmIdentity.test.js` / `gmIdentityWire.test.js`: actor-key-is-
  authority-key pin equality, distinct pins per group, refusal without a session
  secret, x-only/compressed pin matching on receive, the full round trip under
  a receiver whose session secret differs, pre-Step-2 bodies without `by`
  still opening, and the AUTH proof shape.
  **Landed (slice 2).** All twelve control-kind send sites sign with the same
  derived actor key via `buildControlAct`; both pool-level AUTH answers
  (`pool.js getAuthenticatedPool`, `relayDirectoryRead defaultPool`) resolve
  their signer at challenge time — active group first, newest known otherwise —
  and append the compressed pin as an `author` tag, matching every other act's
  wire shape. No group-host event this app publishes names the account key.
  Receivers resolve an actor-shaped sender back to its account through
  `resolveControlSender` against standing rows' `actor` field; legacy
  account-key events match directly and anything else answers '', which
  authorizeGroupControl refuses.
  **Landed (slice 3 core).** The member-set doc (DOC_V 2) carries each
  member's actor pin beside their account: creator stamped at genesis,
  members stamped from VERIFIED observations — a decoded kind-9 binds
  event.pubkey (= their pin) to the sealed body's `by` (= their account), and
  publishDocOp folds captured pairs into its next admit. Members receive docs
  through `ingestMemberDocEvent` (relay author checked against the held pin's
  x-only form before any AES work) at join, on every roster read, and live
  (the group subscription carries a kind-30079 filter keyed by the doc's
  prefixed d-tag, so a gen bump published while a member sits in the group
  reaches them without their next read); H4's
  null path stands while nothing verifies.
  **Open: B5** stays deliberate; pin rotation rides account-key rotation (H5
  residual). The kick-wall's own add-back receipt now travels actor-signed and
  resolves identically.
- **Step 3 — gated.** The log, only if B4 or attribution starts to bind, or if
  equal-generation conflicts show up often enough to justify causality per
  *operation* rather than per *document*.

`[P]` fixtures to carry from the start, all doc-shaped and cheap: shuffled arrival
folds to the same doc; older generation loses; equal-generation conflict
surfaces and then heals to a single doc; missing doc refuses rather than falling
back; a tombstone survives a concurrent admit; a grant naming a doc the recipient
does not hold is deferred, not installed; an unknown gid does not resolve against
a plausible-looking doc.

## 9. Claims

Safe: "a client can check who the owner says may hold the current key, so a
relay-written roster entry no longer buys the key by itself"; "the doc rides the
existing write path, so no relay change is required"; "removing a member rotates
the key, and a stale member eventually heals" (which is `[V]` true today).

Avoid:

- "history tamper-evident" — the doc has no per-entry history.
- "the relay cannot add a member" — it cannot *forge* an add, but it can withhold
  the doc, and the hole is only closed if the client refuses the fallback.
- "cross-box comparison is independent" — shared relay key.
- "recovery-complete" — losing every copy needs the invite/repair flow.
- "attribution-preserving" — the doc does not record which device acted; an
  optional `by` field would, later.
- "the doc is just a set" — H1(b) gives it tombstones and H9 gives it links.
- "reactions are private now" (H8).
- "unlinkable" — a derived signer still recomputes from the same account key.
- "member-governed" — the authority is the owner, not the members.
- "production-ready crypto" — no external review (B1).

## 10. Provenance

Three rounds, two sessions, all read-only. Round one: whole-surface privacy
review against `d607a27`, then a DAG protocol draft, then R1-R10 after the claim
was narrowed. Round two: adversarial review of R1-R10 (five critical findings),
then a revision to five decisions. Round three: the VISION.md reframing that
killed the DAG at v1, and H1-H9 against the doc. Step 0 decided after `917793e`
in a fourth pass, committed with it: signer = per-group authority key derived
from the account key, doubled as the Step-2 GM key; residuals (a)-(c) above.

Revision drift across the writing: `d607a27` → `0789d44` → `9a9734b` → `3f4a854`
→ `645a878` → `5fbb8ab` → **`78e0245`**. The first rounds' `[V]` findings were
re-checked at each later pin where they are cited here. Committed during the
writing, and no longer `[worktree]`: the wrap `expiration` (`giftWrap.js:32, 52`),
the address-book read moving off the group boxes, and the handle-record kind fix.

Worktree at the final pin: ` M AGENTS.md` (this doc added to the read order),
` M docs/PRIVACY-REVIEW.md` (uncommitted, so citations to it are to its worktree
text), `?? docs/MEMBERSHIP-DESIGN.md`. Nobody committed this file; it is the
only new artifact three rounds of design produced.
