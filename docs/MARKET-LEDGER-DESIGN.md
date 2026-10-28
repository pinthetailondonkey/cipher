# Design: auditable market ledger on deal-engine

Revision 2 (2026-10-28). Changed sections are marked **[REVISED]** or
**[NEW]**: the counterparty accumulator (the old one-elem-per-record design
crashed on the first repeat customer), a new Monero section (the old one was
soft), head gossip added and path (c) re-costed, a new Migration section, the
anchor latency restated against the cadence, a new Incentives section, the
build list gains a standalone verifier. Everything unmarked stands as
delivered — including the witnessRegistry ruling and
"observable and punishable, never enforceable".

Everywhere the engine says vendor, read MARKET. The engine models one key
that owns a log of co-signed deals; a market is exactly that, at larger scale.
The narrow claim: **a market cannot show two users different books without it
being provable.** Not "the books are true" — that needs more, stated below.

## Reuse table — unchanged, and why it survives the shift

| Engine piece | Why it survives vendor → market unchanged |
|---|---|
| `checkpointBody` / `signCheckpoint` / `verifyCheckpoint` | seq, treeSize, root, prevHead, issuedAt, keyId, witnessRegistry, accRoot, accN all ride inside one signature. "The ledger owner signs its own tree" is role-agnostic. |
| `forkEvidence` | Two valid STCs on one prevHead disagreeing is a split book, whoever signs. |
| `standing()` | CURRENT / STALE / FORKED / TRUNCATED / REFUSED computed on the observer's clock against `CADENCE_MS`; adjudication-open is already a resting state. A market going stale reads stale with zero changes. |
| `verifyBlindMembershipIn` | Reads (accRoot, accN) from one signed body — the HEADER RULE. Unchanged. |
| `signRefusal` | A signed, ageing non-accusation. A market refusing audit is the same shape. |
| `log.js` — `blindedLeaf`, `mixedSaltHex`, `commit`, `signedTreeState` | Blinded leaves, salt co-set from both parties, dual-signed-only commits, dealId uniqueness, deep copies at boundaries. A market's ledger is one vendor's log. |
| `record.js` — `recordBody`, `signRecord`, `coSignRecord`, `verifyRecord`, `signVoid` | Dual-signed records, role from key match, buyer ≠ vendor at the byte level, decimal-string amounts via `normalizeAmount` (BTC 8 / XMR 12, half-up). |
| `merkle.js` — `makeTree`, `verifyInclusionProof`, `verifyConsistencyProof` | RFC 6962 hashing; consistency proofs make "extends prior" math. |
| `accumulator.js` — `generateModulus`, `accRootOf`, `accWitnesses`, `elementOf` | Position-blind membership; no trapdoor exposed. Reused twice (below). |
| `rotation.js` — `signRotation`, `signRevocation`, `keyTimelineResolve` | Dual-signed rotation, self-revocation, timeline scoring at each body's own time. Operator keys rotate exactly as vendor keys do. |
| `adjudication.js` — `adjudicateFork`, `signVendorAdmission` | Fork-proved needs a shared witness on both sides; vendor-confirmed is the market naming its own live line. Both roles transfer. |

## Add table [REVISED — rows rewritten or pointed at their sections]

| What | Shape |
|---|---|
| Operator identity | The operator IS the engine's vendor-role key: the checkpoint signer, role `'vendor'` on the observer's key timeline (`standing()` already requires role `'vendor'` for checkpoints, standing.js:55-59). Rotation reuses `signRotation`/`signRevocation`. **Friction, named:** the engine cannot tell "key that owns the books" from "counterparty in a deal". It DOES refuse the operator as its own customer with the same key (`signRecord` refuses buyer === vendor at the byte level, record.js:43-45); it cannot stop self-dealing through a second key. That is priced, not prevented — see the Monero section for how weak the price is. Renaming the role string would break every signed body already on the wire — the wire keeps `'vendor'`; the UI says "market". |
| Leaf cost: txid binding | v2 record bodies gain a required `txid` (Migration section). The leaf is `H(salt ‖ H(record body))` (`blindedLeaf`, log.js:34-38), so txid rides into the leaf and both signatures through the hash — free for **binding**, not for **compatibility**. Pricing, honestly: the anti-mint price is a miner fee, and a self-send can be dust — cents per hundred fake leaves on either rail. The binding's real value is the cross-check it enables: a watcher with a node verifies each record's txid exists and paid the market's address, and sums confirmed incoming payments to the market's published addresses against treeSize deltas between checkpoints. Chain data is already public on BTC, so the watcher learns nothing not already public. That catches minting-without-paying and count inflation beyond real receipts; it never catches self-payment. On XMR the cross-check itself is impossible — Monero section. |
| Counterparty co-sign discipline | `record.js` is half-built in the audit's sense (AUDIT.md M4): the co-sign exists but attests little if it is automatic. The add is a rule, not crypto: the buyer checks txid, amount, currency, address against their own order before `coSignRecord`, and a record with no counterparty signature never enters the log (`commit` already refuses it, log.js:94-96). A deal the buyer won't sign doesn't count — which makes an uncounted deal invisible; see completeness. |
| Distinct-counterparty count | Corrected design in its own section below. Choice (a): the accumulator holds unique counterparties, deduped before the root. |
| Anchoring | Watcher-side, outside the engine: commit the newest witnessed checkpoint head to Bitcoin via OP_RETURN through the watcher's own Core node, at least once per `CADENCE_MS` window. It anchors the head, which binds the whole body — nothing new enters the signature, like cadence itself. No new dependency: the watcher already talks to a node; OpenTimestamps would add a service for what OP_RETURN does directly. Latency restated in the witness-paths section. |
| Observer head-carry + gossip + pay gate | Every client stores its last-seen head, refuses a chain that does not extend it, **posts that head to a public relay on a timer** (REVISED — see witness paths), and runs `standing()` as a precondition of sending money. |
| Termination statement | A signed end-of-audit declaration naming the final head — new tag, same construction pattern as `signVendorAdmission`. |

## The counterparty accumulator, corrected [NEW — replaces the old distinctness row]

The previous draft said "one element per committed record, derived
deterministically from the counterparty's key" and called the engine's
duplicate-throw the proof of no-double-counting. That was a bug wearing a
proof's clothes: `elementOf()` (accumulator.js:175-179) is a pure function of
the bytes handed to it — here, of the buyer's key — so a buyer who buys twice
yields the identical element hex twice, and `accRootOf()` calls `distinct()`
(accumulator.js:195, throw at :188), which refuses duplicates by design.
**The first repeat customer crashes the root.**

Choice (a), argued: **the accumulator holds unique counterparties, deduped
before the root.** The element set is built first-seen-wins: each distinct
buyer key enters once, as `elementOf(H('Deal counterparty v1', buyerPub))`.
The market keeps a private side-list (buyerPub → first inclusion) so it can
serve a repeat buyer their original witness; the element list stops aligning
with the log's leaves — `log.elementsFor()` (log.js:80-82) maps records
one-to-one to leaf-derived elements and is not this list. Consequences:

- The `distinct()` throw can never legitimately fire at root time. If it
  fires, the market's builder failed to dedupe, and it fails at build time,
  not in a customer's hands. The throw demotes from "the mechanism" to a
  build-time guard.
- Inclusion proofs survive intact for the buyer: their element is stable, so
  ONE witness proves "I am a counted counterparty" once, no matter how many
  times they bought. That is exactly what dies under choice (b): per
  (buyer, dealId) elements never trip `distinct()`, but a repeat buyer then
  holds a different element per deal, can no longer prove "one of these is
  me" in one shot, and the set asserts deals, not buyers — distinctness, the
  reason the field exists, needs "some other way" that does not exist without
  revealing buyer fields.
- What does change: a witness goes stale whenever a new distinct customer
  changes the root. Refresh is one `accWitnesses()` pass on the market's side
  (accumulator.js:232-248); client-side incremental updates are the README's
  stated open item, so buyers re-fetch their witness per checkpoint. And the
  accumulator no longer commits to the same set as the Merkle root — the
  "both surfaces describe one tree" property `signedTreeState` asserts for
  the leaf-accumulator (log.js:161-163) stops holding. treeSize counts deals,
  `cpN` counts distinct counterparties: two sets, one signed body, carried by
  field names.
- Still true, still a limit: burner keys are distinct keys — dedupe refuses
  duplicates of one key, not inventions of new ones — and `cpN`'s cardinality
  is hidden by the root, the README's own honesty about RSA accumulators.
  Both stay in Limits.

Verification surface: the buyer checks their witness through a
`verifyBlindMembershipIn`-style reader that takes both (root, modulus) pairs
from one verified checkpoint body (checkpoint.js:231-244 is the pattern; the
loose-string form is documented-broken, accumulator.js:253-264).

## Monero, said out loud [NEW — replaces the old XMR sentence]

The old draft said the XMR cost "does not hold against the market itself",
then called the distinctness count "the second line", then admitted two
paragraphs later that it does not stop invented keys. Incoherent — and the
honest sentence is worse: **on Monero the headline mechanism is nearly inert.
A market can inflate its books for the price of dust, and no accumulator
fixes it, because burner keys are distinct keys.** Nor is the fee argument
strong on Bitcoin — self-sends can be dust there too. What BTC actually has,
and XMR lacks, is the watcher's cross-check: the Bitcoin chain is public, so
existence, destination and count-versus-receipts are checkable without the
market's help. Monero has no public chain to check.

The payment-proof path, evaluated seriously:

1. **Market publishes its view key.** Monero view keys are all-or-nothing
   per account: the key derives every one-time output the wallet owns, with
   amounts. There is no per-output or per-transaction scoping in the
   protocol. Publishing it publishes every customer's amount and the
   market's balance and timing — it violates the design's first law (no
   public money view, ever, record.js:10) far more completely than it helps.
   Non-starter, not a hardening option.
2. **Buyer-held tx-key proofs** (the `get_tx_proof`/`check_tx_proof` shape):
   the BUYER holds the transaction secret key and can prove to a verifier
   they name that txid T paid the market's address for a stated amount. Real
   and useful — the right shape for dispute and omission windows, where a
   victim proves their deal was real and correctly priced. What it never does
   is price self-minting: the market can be its own buyer on both ends of a
   self-send and produce a perfectly valid proof. Buyer proofs make REAL
   deals provable; they cannot make FAKE deals expensive.
3. **Watcher holds the market's view key.** Then the watcher can do the
   BTC-style cross-check — but it learns every amount and the market's
   balance (a confidentiality collapse the BTC watcher does not have,
   because BTC amounts are already public), and self-sends are
   indistinguishable from customer payments anyway. It catches sloppiness,
   not intent.
4. **A construction where the buyer's proof is the checked thing for
   COUNTING** — a leaf counts only when a counterparty-held proof verifies —
   fails for the same reason as (2): "counterparty-held" is satisfiable by
   the market's own burner keys. The only buyer-proof constructions that
   work are evidence windows, and they are victim-driven by nature.

Verdict: **XMR cannot be priced.** The count claim is per-rail: BTC counts
are chain-cross-checkable by any watcher; XMR counts are witnessed
self-declarations backed by per-deal buyer proofs that surface only when a
victim uses them. A market that settles only in Monero gets
consistency-only auditability — no rewriting, no double books, no
double-counting one key — and nothing about the truth of its totals. The BTC
path is the headline, in the UI wording as well as this doc.

## Migration [NEW]

`record.js` is `v: 1` on the wire (`RECORD_TAG`, record.js:12) and every
reader re-derives the body through `recordBody` before comparing the hash
(`signRecord` at :42, `verifyRecord` at :68-70). A required `txid` inside the
body changes the canonical bytes, so every existing signature stops
verifying. "Free because it is in the body" was true for binding and false
for compatibility — both now said.

- **Records: v2 with a version-dispatching reader.** The body gets `v: 2`
  and a required `txid`; the tag bumps to `Deal record v2` so hash domains
  separate cleanly. The verifier dispatches on `v`: v1 verifies today's way,
  forever — personal Deal ledgers already on the wire never break; v2 refuses
  to construct without txid, keeping the README's `*Body()`-constructor
  discipline. `log.commit` accepts v2-only when the log is a market ledger.
- **Checkpoints: optional fields, empty-means-off, no version bump** — the
  accN/accRoot precedent (checkpoint.js:44-45, shape gates :52-54). `cpN` and
  `cpAccRoot` default to `''`, so old bodies re-derive byte-identically and
  every existing checkpoint still verifies. The other direction does break:
  an old reader's `checkpointBody` constructs a fresh object from the field
  names it knows, so a checkpoint carrying `cpN` fails the hash on old
  verifiers. Acceptable, stated: market checkpoints are a new stream with no
  legacy readers; personal logs never emit the field.
- **Refusal to guess:** a v1 record carrying a txid-shaped extra field
  re-derives without it and fails the hash — malformed input never silently
  downgrades. Same for checkpoints with junk in `cpN`: the shape gate throws,
  `verifyCheckpoint` catches to false (checkpoint.js:103-115).

## Problem 1: witness independence and the registry

Verified in the source: `witnessRegistry` is a field of the signed body
(`checkpoint.js:42`), so the market declares its own witness set under its own
signature. It can name only its friends.

What actually constrains the choice: **not the signature — observability.**
Every registry is inside a chained, signed checkpoint, so the witness set's
history is permanent: a market that swaps honest witnesses for friends does so
in a visible, dated regime change, forever. A captured witness still signs
content-bound statements (`signWitnessStatement` binds the stcHead,
checkpoint.js:120-140), so if the market shows two books and the colluding
witness signed both, `adjudicateFork` returns fork-proved — the colluding
witness becomes the proof. Independence is **observable and punishable, never
enforceable**. That is also CT's situation: logs pick their own witnesses, and
the ecosystem compensates by third parties watching logs rather than trusting
them.

**Concrete answer: the field stays where it is.** Moving it outside the
signature buys nothing (a market could still lie about who witnesses it) and
breaks every signed body. What is added is observer-side: the client treats
registry membership as necessary but not sufficient — a witness set that
shrinks, or a witness that resolves against a known-affiliation list, is a
standing detail and a UI warning, not a verdict. The compensating control
that does not depend on the market's friends at all is the Bitcoin anchor: the
chain witnesses regardless of any registry.

## Problem 2: consistency vs completeness

Crawling the market's public checkpoint feed proves it did not rewrite what it
showed: consistency proofs, `forkEvidence`, the chained prevHead — **free and
permissionless**. Only cooperation proves it did not leave deals out, and
cooperation here means a buyer coming forward: a buyer holds a dual-signed
record plus its salt, reveals the leaf, and anyone holding the checkpoints can
show no signed root after the record's `at` contains it. Because the market's
own key is on that record, that is omission evidence as strong as fork
evidence — but it exists only when a victim speaks. Cipher's receipts are
private by design, so no crawler can sweep for omissions uninvited. State it
plainly: **rewriting is caught for free; omitting is caught only by victims.**

## Problem 3: three witness paths, costed and ranked by cooperation needed [REVISED]

1. **Bitcoin anchor (OP_RETURN).** Needs nothing from anyone — the chain
   doesn't care about registries. Cost: a few hundred sats a week plus the
   watcher's existing node. **Latency, restated:** an anchor is at most one
   cadence old. It timestamps the newest witnessed head at anchor time;
   between anchors nothing is anchored, so the backdating window for a
   stolen market key collapses from "bounded only by the revocation tick"
   (rotation.js:24-34) to at most one `CADENCE_MS`. The 1-3 confirmations
   figure is when the anchor becomes reorg-proof, not how fast a break is
   noticed — anchors buy permanence and backdating closure; speed comes from
   gossip. Does not cover: contents — an anchor proves a head existed, never
   that the tree is honest or complete.
2. **Third-party crawler.** Uninvited; rebuilds the log from the public
   checkpoint feed and anchors heads itself. **[REVISED] It is also the
   comparator:** the crawler subscribes to the gossip feed (below). When two
   gossip tips disagree, it fetches both chains from the market, verifies
   both with `verifyCheckpoint`, runs `forkEvidence` (checkpoint.js:212-218),
   and if genuine publishes the evidence object itself — both STCs are
   self-contained, so any client re-verifies without trusting the crawler.
   If the market serves the crawler one line and refuses the other, the
   engine's honest rule holds: a partition is not a verdict, and it stays
   adjudication-open (adjudication.js) — but the refusal is visible, and
   `signRefusal` exists for exactly the market that wants to sign its own
   refusal. Cost: one small always-on service. Latency: near-real-time, plus
   the gossip interval. Does not cover: completeness (records are private)
   and markets that publish nothing.
3. **User gossip + head-carry.** **[REVISED]** The old draft gave clients a
   local stored head and no publication path — head-carry without gossip is a
   local log file, and a market can serve the crawler the honest feed while
   forking only real user sessions. Fixed: every client posts its last-seen
   head to a public relay on a timer and on change — a replaceable event
   tagged with the market key, carrying head hash, seq and treeSize.
   **The gossip post needs no trusted identity.** It is a tip, not a proof:
   the STC it names is self-authenticating, and the crawler verifies before
   believing, so spam raises load, never risk. Post over Tor (the app is
   all-Tor already); the residual leak, stated: posting publicly ties a
   relay-visible presence to "watches this market" — no identity, no
   amounts, but it is a metadata row, not nothing. Re-cost: with gossip this
   is a real mechanism — a targeted fork is detectable within the gossip
   interval (hours, not weeks), at one small public event per client per
   interval. Coverage limits: a fork shown only to clients that never gossip
   stays undetected; gossip proves nothing about completeness. Without
   gossip this path would be deleted — the local pin survives only as the
   input that makes the post meaningful.

## Problem 4: the first witness and the alarm

The first witness is the existing Cipher watcher, extended: it already runs
always-on, already refuses explorers, already carries an operator token. It
fetches the market's checkpoint feed, runs `standing()` on schedule, anchors
heads, and watches the gossip feed. What makes a fork alarm get **read**
rather than logged: the same check runs on the client as a precondition of
paying, and on a break the pay button is gone — not a toast, a block. The
check is automatic; the user does nothing until it fails. This is the
safety-number pattern: verification lives in the money path, not in a
dashboard.

## Problem 5: opt-out mid-history

Checkpoints simply stop. Within `CADENCE_MS` every observer reads STALE —
which is exactly an attack's first phase, and observers are right to treat
them identically. Distinguishable? Only if the market signs a termination
statement naming the final head: then the opt-out is honest, visible forever,
and the market's signed history stays verifiable behind it (the TRUNCATED
pattern: recorded, never edited). A silent opt-out is indistinguishable from
an attack **because there is nothing to distinguish** — the market's
signature is the only thing that could say "this was deliberate", and it
withheld it.

## What a user actually sees

- Stale: "This market's books haven't been checked in N days. The last
  verified book covers M deals, from <date>. We can't confirm anything it
  shows you now — sending money is blocked until it's checked again."
- Forked: "This market showed two different sets of books and it is proven.
  Paying here is blocked."
- Suspected: "This market may be showing different books to different
  people. It isn't proven yet. Paying here is blocked until it is."

## Honest limits — limits, not future work [REVISED]

- **On Monero the count mechanism is nearly inert: inflation costs dust and
  no accumulator refuses invented keys. BTC is the only rail where counts
  are cross-checkable, and even there self-payment passes the cross-check
  as a real receipt.**
- Witness independence is observable, never enforceable. A registry of
  friends functions until the market splits — then it convicts.
- Completeness is victim-driven. Omitted deals are invisible until a buyer
  reveals one. Private receipts make this structural, not fixable.
- `cpN` and treeSize remain self-declared, signed numbers — witnessed
  claims, which is all the engine ever promised. The deduped accumulator
  stops double-counting one key; it cannot stop invented keys.
- Anchors timestamp heads; they validate nothing inside the tree.
- Head-carry protects the carrier; gossip protects gossipers. A fork shown
  only to a silent client is still invisible.
- Registry capture is detectable, not preventable.

## Build first — and it is not the anchoring [REVISED]

Build the client observer gate: pinned head, gossip post, `standing()` on the
observer's clock, pay button that disappears on any break. Every other path —
witnesses, crawlers, anchors — produces evidence, and evidence protects no
one until a money path refuses to move on it. The gate needs zero cooperation
from any market, reuses `standing()` byte-for-byte, and is the whole narrow
claim on its own. Anchoring strengthens the timeline later; the gate is the
thing that makes a break hurt the market instead of the user.

**The gate is only a gate if the market cannot serve it.** The check ships
in the Cipher client deployed from ciphermessenger.org — the installed PWA
is pinned to Cipher's own deploy, and markets are counterparties inside the
app, never hosts of it. Added to the build list: a standalone verifier (the
crawler's public check surface — paste a market key, get its standing) for
anyone outside the app. Residual edge, stated: a user who buys through the
market's own website, outside the app, is outside every gate; the standalone
verifier is the only help there.

## Incentives — why a market would volunteer [NEW]

- **Placement.** Cipher's discovery surface can list auditable markets, and
  the gate UI makes the state visible: "books open" beside "no one can check
  this market's books". Auditability becomes a default users can see.
- **The anti-rug claim.** Verifiable books are worth something precisely
  because exit scams are the market history; a market that cannot rewrite its
  books can prove its volume was never faked — something no incumbent
  screenshot can.
- **It is cheap for the market.** Checkpoints and disclosure windows are
  publish-only; the machinery is already this design's reuse column.

Honest answer to "why would they": **an incumbent whose displayed volume is
inflated cannot opt in without exposing the lie, so the first honest adopters
are new markets with nothing to lose.** That is not fatal only because the
demand side can ratchet: the gate UI and discovery listing make unaudited
books a visible downgrade, which converts auditability from charity into
competition. And nothing here forces a market to put its side business on
the ledger — that hole is the completeness limit, closed only by victims.

## Three assumptions, and what falsifies each [REVISED]

1. **Buyers keep their records and salts.** Omission evidence and their own
   membership proofs die without them. Falsified if the client does not hand
   the salt to the buyer at commit and keep both on the buyer's device.
2. **Every settled deal passes through the log.** A market that settles a real
   order off-log leaves no trace unless that buyer speaks. Falsified — made
   structural — the moment any real order flow bypasses `commit`.
3. **The gate code is never served by the market.** The check lives in the
   Cipher client from ciphermessenger.org and in the standalone verifier.
   Falsified if any in-app payment path skips the standing check, or if users
   are steered to market-hosted frontends that have no gate at all — for that
   edge, the standalone verifier and plain words ("only the app checks") are
   the partial answer, and they stay partial.

Dependencies: none added. OP_RETURN rides the watcher's existing node.
No new npm package; the second accumulator, txid field and cp fields are
engine-local. Gossip is a Nostr event on relays the app already uses.
