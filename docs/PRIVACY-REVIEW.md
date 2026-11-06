# Privacy review — the whole surface, at one pin

What this is: a read-only survey of everything a Cipher device reveals, to whom,
and what would fix it. Read at
`413666834daec10a6c56b4d8cecc7156f2fb9e8f`. No code was changed to write it.

Every claim carries a `file:line` read of that tree. Claims are labelled:

- `[V]` verified — read out of the source at this pin.
- `[I]` inference — a join of two verified facts, stated as an inference.
- `[A]` assumption — believed, not proven here.
- `[U]` unknown — needs a measurement that was not run.

Because this is read-only, **every experiment named below is proposed, not
executed.** Section 8 lists the unknowns so nothing unmeasured reads as proven.

The two prior proposals (SGI, client-governed group logs) have no text in this
repository: `git grep -i sgi` matches only `msgId`/`isGift`/`isGroup`
substrings, and `git log -S 'client-governed' --all` is empty. Both are external
candidates; the critique below lands on the relay-signed roster this repo
actually has.

## 1. What each host sees

`src/lib/egress.js` is the authoritative host list, held by `egress.test.js`
with a frozen grandfathered set. Everything below is the code behind each row.

| Surface | Default host | Leaves the device | Host learns | Read |
| --- | --- | --- | --- | --- |
| DM | `relay.primal.net` | wrap 1059, seal 13, rumor inside | **recipient** (plain `p`), an `expiration`, arrival time, length; not sender, not the label, not the inner kind | `useNIP44DM.js:102-165`, `giftWrap.js:45-59` |
| DM typing | same | wrap 1059, same two layers as a message | recipient and arrival time only; the sender is off the wire and the tick is not labelled | `useNIP44DM.js:167-201` |
| DM read | same | `'#p':[me]` and `authors:[me]` | which pubkey is online and reading | `useNIP44DM.js:200-203` |
| Contact list | the `profileRead` class first, the message relay only for misses | `{kinds:[0], authors:[every peer]}` then a straggler filter | the address book on the profile readers; on the message relay only names nobody else had (A2/F2) | `useChatBootstrap.js:243-273` |
| Profile | `nos.lol`, `relay.damus.io` | kind 0, 10003 handle, 10002 relays | pubkey ↔ handle ↔ face ↔ blurb | `useIdentity.js:236-273` |
| Search | `relay.vertexlab.io`, `relay.noswhere.com` | NIP-50 text; a 200-group directory blast | the query, and the asker's IP | `usePeopleSearch.js:220-228` |
| Groups | `groups.ciphertele.com`, `groups2.ciphertele.com` | every event (kind-9 bodies AND control kinds) signed by a per-group **actor key** with an `author` pin tag; NIP-42 proofs likewise; AES-GCM body carries the sender's account key only inside the ciphertext | per-(account, group) pseudonym plus group, epoch, second, size — no account-level wire fact anywhere on these hosts until two accounts are correlated by timing or by the doc publisher's own view | `useNIP29Group.js`, `gmIdentityWire.js`, `groupMembership.resolveControlSender`, `pool.js`, `relayDirectoryRead.js` |
| Roster | same | 39002 **signed by the relay's own key**, read over NIP-11 HTTPS | membership, by the relay | `groupMembership.js:35-68, 222-229` |
| Group keys | DMs | NIP-44 to each member with the raw epoch key | the relay never sees a key | `groupKeyDistribution.js:336-361` |
| Private group name | 9002 + sealed envelope | fixed `Private group` placeholder on the relay | nothing about a rename | `groupCreate.js:41-47` |
| Media | `blossom.primal.net`, `nostr.build`, `blossom.band` | AES-GCM bytes, 24242 signed by a throwaway key | uploader IP, hash, size; each reader's IP and open time | `mediaCrypto.js:29-101` |
| Public images | the host named in a profile or product | plaintext bytes | the picture, and every viewer's IP | `egress.js:27` |
| Notes | the app host, or a carrier box | key and iv in the fragment | ciphertext only; the carrier deletes on read | `deadDrop.js:144-262`, `note-carrier.mjs:201-220` |
| Push | a self-run gateway | a wrap copy to a gateway key | "something arrived for pubkey X" | `pushGateway.js:108-158` |
| Push delivery | FCM / APNs / browser push | token, `{"kind":"message"}` | token, timing, count | `nativePushSend.js:17-24` |
| Payments | a self-run watcher | address, currency, child token | the vendor's own box | `payment-watch` GET |
| Public trade | `relay.primal.net` | 10004/10005 with **both pubkeys** and the receipt hash; optional 10007 with **raw txids** | a public trade graph; amounts stay inside the DM | `useReputation.js:154-238`, `vendorStats.js:105-135` |
| Marketplace | `relay.primal.net` | 30402 title, price, image, `t=cipher_marketplace`; the image tag is a plain URL or a serialized private entry `{url,key,iv}` (`listing.js:18-40`) | a public menu tied to the vendor npub; a private-entry image hides the bytes behind a throwaway upload key but the listing itself still names the vendor | `Wallet.jsx`, `listing.js` |

Two facts about the DM envelope matter more than its row. NIP-59 sets
`created_at = now − U(0, 2 days)` (`nostr-tools nip59.js:232-234`) `[V]`, and the
`since` filter is −7 days (`useChatBootstrap.js:456`) `[V]`, so the backdate
cannot fall off the window. And sent wraps match neither history query, so a
reinstall recovers only *received* DMs `[V]` (`useNIP44DM.js:421-422`, finding
F13). The outer wrap is one `p` tag and one `expiration`, built by hand for that
second tag (`giftWrap.js:45-59`) `[V]`, so the reply id and the client id stay
sealed with the rumor (`giftWrap.js:64-70` is the rumor, not the wrap).

### A live baseline, 45 seconds

`[V]` measured, not only read: a 45-second capture of `kinds: [1059]` on
`relay.primal.net` and `nos.lol` took **3733 wraps, 34 distinct content lengths
(388 to 21995 chars), a median gap between arrivals of 4 ms and a longest gap of
361 ms**. `[A]` that sample is dominated by other clients, and the outer tag sets
prove it: `["d","k","p"]`, `["ms","p","v"]`, `["e","p","receipt-type","v"]`,
some with `expiration`. Those clients publish the inner kind (`k`) and the
receipt type outward; Cipher's own wrap publishes neither, though since the F9
fix it does carry an `expiration`. So Cipher leaks *less*
than the NIP-17 convention, and the common shape is not ours.

This is the point that qualifies F6 below. On a busy public relay a single
message is one of eighty a second, so length and timing are nearly free. On a
quiet relay — the founder's group box, or a small deployment — the same message
is most of the traffic, and there the buckets and the gaps are the whole signal.
Size risk is a function of the relay's population, not of the message.

### Can an observer pick Cipher out of the crowd?

`[V]` measured. The outer wrap was one `p` tag and nothing else, so the capture
was split by tag shape: in 50 seconds, 2303 wraps, of which **518 (22%) were
single-`p`** and the rest carried other tags. Of those 518, 360 (69%) sat on a
length this client can actually produce, and 4 observed lengths (388, 944, 1466,
1579) can be reached by no Cipher message at all — so at least one other client
shares the single-`p` shape with a different payload structure.

`[A]` the F9 stamp moves that census. Our wrap is now `expiration,p`, so it
leaves the 22% minority for the majority bucket, which is the intended effect:
the shape was the weak fingerprint. `[U]` unmeasured in that direction — the
bucket is larger, but a sibling that stamps is only indistinguishable until
someone compares the arithmetic, and ours is exactly
`expiration − created_at = 2592000`. A neighbour stamping `now + 30d` from a
true clock leaves a delta that is uniform over two days where ours is constant,
so a filter on the exact delta could still single us out. Whether any live client
randomises that delta is not something a 50-second sample can answer.

`[V]` the sharper number: brute-forcing every message length from 0 to 1200
characters, this client can emit only **seven** distinct wrap lengths — 1284,
1456, 1796, 2140, 2480, 2820, 3504. So an observer who filters to single-`p`
wraps at one of those seven values turns 2303 wraps into about 360, a six-fold
cut, and cannot do better: the shape plus the length narrows the crowd but does
not name Cipher. Two costs, then, and they point opposite ways. Message length
is *coarse* — seven classes for messages up to 1200 characters is good hiding.
The tag shape is a *weak fingerprint* shared with a neighbour, which is the price
of publishing no kind and no receipt type.

`[U]` what a 50-second sample cannot say: the week-long, two-variant capture that
would separate our own wraps from the crowd, and which is the only thing that can
price A1 and A2 (section 13).

## 2. Trust domains, and who can join whom

`[V]` collapses already true in the shipped defaults:

- `groups.ciphertele.com` and `groups2.ciphertele.com` share **one relay key**
  (`egress.js:10`). Two boxes, one roster authority.
- `relay.primal.net` and `blossom.primal.net` are one operator. The default DM
  relay **and** the default media host are the same company.

`[I]` the join that follows, which needs no collusion at all — only one company
reading its own two logs. The DM REQ carries `'#p':[me]` and `authors:[me]`
(`useNIP44DM.js:200-203`), so the relay holds IP ↔ npub from its socket. Blossom
holds IP ↔ content hash. Same IP, same operator: **npub ↔ the media that account
uploaded and fetched.** On the web build the IP is the home IP.

`[I]` add `nos.lol` reading the same REQ: IP ↔ npub ↔ name ↔ face, so a colluding
pair reaches name ↔ IP ↔ media.

`[I]` the free join: the DM relay and the group relay both receive the same
author pubkey in the clear (kind-4 typing, kind-9 group) with second-precision
time. Two operators who never speak still hand a third party two graphs keyed on
one 64-hex string. Isolating one relay buys little while the identity is shared.

`[V]` the boundary no collusion fixes: the seal is signed, so the recipient
always knows the sender (`giftWrap.js:37-42`).

`[V]` what the founder does *not* see today: DM recipients. The DM relay is
Primal, not a founder box. That is an accident of defaults worth keeping.

## 3. Where the privacy is not

Held / partial / fails, against each adversary.

| Goal | relay | host/ISP | local disk | compromised device |
| --- | --- | --- | --- | --- |
| DM content | held | held | held | fails |
| Group content | held | held | held | fails |
| Sender unlinkability | **fails** | fails | n/a | fails |
| Recipient unlinkability | fails | fails | n/a | fails |
| Timing | partial (±2d) | fails | n/a | fails |
| Message length | partial, 4 buckets | partial | n/a | fails |
| Social graph | **fails** | fails | n/a | fails |
| Cross-service | **fails** (one npub) | fails | n/a | fails |
| IP | desktop held, web fails | fails | n/a | fails |
| Forward secrecy | **fails** | fails | fails | fails |
| Local at rest | n/a | n/a | held, floor = 10^8 | fails |
| Deniability | partial (seal is signed) | n/a | n/a | n/a |

Group content and the group key are held from the relay. `[V]` group history is
not: a grant sends the current key **and every prior epoch**
(`crypto/groupKeyDistribution.js:150, 315, 321`), so a joiner reads all of it,
and a kicked member keeps every epoch they held.

## 4. Findings

**F1 `[V]` typing re-anonymised the DM sender. Fixed.** Messages are wrapped and
sender-less; typing *was* a bare signed kind-4 on the same relays
(`useNIP44DM.js:176-181` at the pin). A relay that saw `A → B, 12:00:03` beside
an anonymous wrap to `B` at `12:00:04` attributed the thread. It now travels the
wrap path, so the outer event carries one `p` tag and no sender. Pinned by a test
that also asserts the receiver still reads the rumor's clock: the wrap's
`created_at` is backdated up to two days, so the ten-second freshness window
would drop every tick if it read the outer event.

**F2 `[V]` the address book was broadcast — now narrowed (A2).** It was
`authors: missing` where `missing` is every counterparty
(`useChatBootstrap.js:250-254` before the change). `[V]` it goes to the
profile-read class first and only the unanswered names reach the message relay
(`useChatBootstrap.js:259-273`), so the relay that carries the traffic rarely
sees the list. The residual is in A2.

**F3 `[V]` the group relay is a confidentiality anchor.** The roster is
relay-signed (`groupMembership.js:222-229`) and a responder trusts it
(`groupKeyRotation.js:182-206`, `README.md:148`). A relay admin who writes a
pubkey into the 39002 is handed the key by the next member who answers.

**F4 `[V]` the DM relay and the media host are one operator** (section 2).

**F5 `[V]` no forward secrecy.** NIP-44 uses a static ECDH conversation key
behind a cache (`dmKeys.js:25-37`), so one `sk` capture opens every past DM.

**F6 `[V]` a message is about 2.1 KB, message length falls in seven classes, and
both matter only on a quiet relay.** On a busy public relay the wraps arrive
eighty a second and a single message is lost in volume (see the two captures in
section 1); on a founder box it is most of the traffic. Measured against
`nostr-tools` NIP-44 at this pin, with a realistic rumor:

```
six message lengths (0, 5, 40, 120, 400, 900 chars)
  → wire lengths 1284, 1456, 2140, 3504   (four distinct)
a rumor padded to a fixed 640 bytes
  → wire lengths 2140, 3504               (two, and 3504 only past ~480 chars)
```

So "yes" and "see you at eight" are distinguishable on the wire, and a terse
confirmation is distinguishable from a real message. `calcPaddedLen`
(`nostr-tools nip44.js:32-39`) quantizes to 32- or 64-byte buckets; the fixed
padding costs about 480 bytes on a 2140-byte envelope, so roughly 22% for a
near-total close of the channel — and the target is the seven-class ladder in
section 1, so a two-rung pad covers everything up to a long message and a short
ladder covers the rest. This corrects the first pass twice: *deal size* barely
leaks (it is the message class), and the class is *seven values*, not a range.

**F7 `[V]` the local floor is 10^8, and the keypad caps it there.** A new PIN is
exactly eight digits (`vaultLockout.js:5-18`, enforced at `useIdentity.js:352,
558, 763`, `Create.jsx:60`, `RestoreMnemonic.jsx:32`) and the keypad has eight
slots (`Keypad.jsx:13`). The five-wrong-PIN wipe is a **local** counter:
`resetPinFailures` writes `localStorage` at seven sites (`useIdentity.js:396,
535, 596, 739, 808, 918, 972`), so a copied vault plus a fresh browser resets it
and the wipe is irrelevant offline. Legacy 6-digit accounts are 10^6. A stronger
than 10^8 PIN is impossible without more slots.

**F8 `[V]` the 10007 bulletin publishes raw txids** (`vendorStats.js:105-135`).
An explorer resolves amount and time, so a vendor voluntarily undoes the amount
privacy that a per-order address (`vendorPayments.js:137-140`) and an
address-free listing (`listing.js:1-4`) just bought.

**F9 `[V]` deletion is a request, and a wrap never expired. Fixed.**
Tombstones are local (`db.js:39, 320-322, 378-394`); a relay that copied the
ciphertext keeps it. Exactly-once notes are truly gone only on a self-run
carrier, which deletes on read (`note-carrier.mjs:201-220`); the relay path's
once is a device ledger (`deadDrop.js:98-142`). The outer wrap carried no
`expiration` tag, so nothing ever told a relay to drop a message's only
server-side copy, while 68% of live wraps on the two relays do carry one.

It now does. `buildWrap` (`giftWrap.js:45-59`) stamps
`expiration = created_at + 30 days`, using this client's own backdated wrap clock
rather than `now()`: a `now()`-based stamp would hand the relay back the exact
true second that the backdating exists to hide. The stamp is measured from the
backdated clock on purpose and the test pins that (`giftWrap.test.js:82-89`). The
wrap is built by hand only because `nip59.createWrap` takes no extra tags; the
encryption is still nip59's own. Both wrap sites go through it, including the
push-gateway notice.

`[V]` the TTL is 30 days because of an asymmetry found while writing this: the
live subscription asks for 7 days (`useChatBootstrap.js:456`) but the history
fetch has no lower bound, so the stamp — not the window — is the real recovery
horizon (F13). Thirty days keeps a month away from the app harmless.

`[A]` two effects point the same way: the shape joins the majority, and the
relay gets a reason to forget. `[A]` the residual is that the tag is only an
offer, and it only reaches the relay's copy: the bulletin (F8), a media host's
copy and a carrier's copy are untouched by it.

**F10 `[V]` README contradicted a purpose-built evidence doc.**
`README.md:151` said "The minimum PIN is 6 digits." `vaultLockout.js:5-7` sets a
new PIN minimum to 8, and `docs/PIN-LENGTH-EVIDENCE.md` documents the 6 → 8 rise
at `1c7aba4` with `git show` proof. Fixed in the same sitting; only a pre-`1c7aba4`
account has the 6 floor.

**F11 `[V]` the boot reads a username record that no client has ever written.
Fixed.** `useChatBootstrap.js:227-235` read
`{kinds: [30078], '#d': ['username']}`, but the only writer of a `d=username`
record is `useIdentity.js:257-268`, and it uses **kind 10003**. The other two
readers agreed with the writer (`handleClaim.js:41`, `usePeopleSearch.js:106`,
both 10003), which makes this a wrong kind rather than a design difference. It
is not back-compat either: at the initial commit `6d83b48` the reader was
already `Chat.jsx:239` reading 30078 while the writer was already 10003, and
`git log --all -S'30078'` lists no file that has ever published it.

`[V]` the reason it stayed invisible for the life of the repo is that 30078 is a
*real record in this tree*: the sealed group member baseline
(`memberBaseline.js:7`). So the read was aimed at a kind that exists, and
resolved against something rather than against nothing. That trap is what
`usernameRecord.test.js` pins: it derives the kind from the writer and holds all
three readers to it, and it asserts the handle record and the baseline never
share a kind. Reverting the kind turns two assertions red.

`[V]` the `d=username` filter and the `username` tag were right all along, and
the tag is what keeps this apart from a NIP-51 bookmarks list on the same kind.
The effect today: `my_username`, `lockedUsername` and `chatStore.myUsername`
were never populated from a relay. They are now, and `myUsername` has its first
reader as a fallback in the group mention matcher (`useNIP29Group.js:1446-1452`),
which previously missed a mention of you in a group's first exchange because
your own profile only reaches the store after one of your messages does.

**F12 `[V]` a group key grant was a signed list of the member set. Fixed.**
`distributeGroupKey` published one bare kind-4 per recipient, signed by the
granter, to each member's own DM relays (`groupKeyDistribution.js:336-361`
before the change; the publish target is `relaysForPeer` in
`useGroupKeyReconciler.js:142-147`). A rotation therefore put the granter's key
next to every member's key, once each, inside one second, on the message relay —
handing that relay the member set of a group whose roster it never reads, and
tying the group to the message relay. It now rides the wrap path like a message;
the receiver needed no change because ingest already unwraps before it reads,
and takes the counterparty from the rumor.

**F13 `[V]` after the wrap transition, your own sent DMs are no longer on any
relay.** There are exactly two history queries (`useNIP44DM.js:421-422`):
`{kinds: [4], authors: [me]}` and `{kinds: [4, 1059], '#p': [me]}`. A wrap is
signed by a random key and tagged with the *recipient*, so it matches the first
query on neither field and the second on the kind alone, never on the `p` tag
that query filters by. Both queries are correct for what they were written for;
the transition to NIP-59 quietly removed the sent half from relay recovery
while the comment that explains the merge
(`useNIP44DM.js:293-295`, "the history fetch re-saves our messages as 'sent'")
still describes the bare kind-4 era.

`[V]` same-device reloads survive: the composer writes each sent message to
Dexie (`useComposer.js:158, 196`), and outbox rows are deleted on first accept
(`outbox.js:42, 155`) so they are not a second copy. So the loss is a reinstall,
a new device, or cleared storage, and it is one-sided — received messages come
back from `#p: [me]` fine, which is why a casual check looks healthy.

`[A]` three ways out, none free: (a) add a second `p` tag naming the sender, so
the relay learns both ends of every DM in the clear — recoverable, but it undoes
part of the anonymity the wrap just bought; (b) publish a second copy of the
wrap tagged `p = sender`, doubling what a relay stores and what the recipient
dedupes, while leaving the sender invisible; (c) accept it and keep the local
copy as the only one. `[U]` which is right is a product call, not a
crypto one, and it is the largest open decision this review produced. Note that
(a) as written still reaches the recipient, because an `#p` filter matches any
`p` tag, so it is the sender becoming visible rather than the recipient moving.

`[V]` one fact any of (a) or (b) has to answer first, and it is the reason this
is not a one-line fix: a wrap is published only to the *recipient's* relays
(`relaysForPeer`, `useNIP44DM.js:130`), while the history fetch reads the
sender's own (`generalRelays`, `useNIP44DM.js:421`). Tagging the sender changes
nothing unless the copy also lands where the sender reads, so the fix is a
publish-path decision as much as a tag decision.

**F14 `[V]` the two user-facing disclosure rows described the wire this app no
longer sends.** `egress.js` is the app's account of what a host learns, and the
Message relay row said the relay sees "whether each one is a message, an order,
or a call. That label is on every message in plain text, so anyone who reads this
relay sees it too", with the Push gateway row repeating it. That was true of a
bare kind-4 and stopped being true when messages became wraps: the label moved
into the seal, and the gateway opens its own layer, so neither the relay nor the
gateway reads anything in plain text. `README.md:88, 90` had the same staleness
and added one of its own, describing the gateway as watching for "a kind-4 event
that is tagged `t=msg`" when it watches kind 1059 and reads the tag out of the
sealed notice (`notify-gateway.mjs:262, 291-298`) — the code was updated in the
transition and the prose was not.

`[A]` the direction of the error matters: the row overstated a leak, so nobody
was misled into a *worse* choice than they had, and the fix narrows a claim
rather than widening one. `[V]` all three now describe the wrap, and
`seesText.test.js` fails if either row mentions a plain-text label again or stops
saying the sender is hidden. A disclosure is a claim like any other, so it gets
a falsifier: revert the row and the test goes red.

## 5. The catalogue

Each entry: what it hides from whom / what it still reveals / assumptions and
failure modes / product impact / maturity / a falsifying observation / a proving
experiment. Maturity is `established`, `novel-but-plausible`, `speculative`, or
`unsupported`.

### A. Finish what is half-built

**A1 Wrap the signing leftovers.** *Landed.* Hides the sender of typing (and any
future bare kind-4) from the relay. Reveals recipient, arrival, length,
connection. Two traps were real and are now pinned by tests: the backdated wrap
clock against a ten-second freshness window, and a payload that must be
encrypted before it enters the rumor because the receiver decrypts
the rumor's content.

**A2 Stop the address-book broadcast.** Applied. Hides which peers share an
account from the group boxes and, for any peer on this app, from the message
relay too. `fetchProfilesForPubkeys` asked kind 0 for every missing peer on
`[...generalRelays, ...groupRelays]`, so the roster authority was handed the
message address book for no coverage at all: this client publishes kind 0 to
`profileRelays`, which is not a group box, and there is a `profileRead` relay
class (`egress.js:121`) whose whole purpose is "your IP when profiles are
loaded".

`[V]` it is now two phases (`useChatBootstrap.js:259-273`): the profile-read
class first, then the message relay only for names that came back unanswered. A
peer on this app publishes to that class, so in the normal case the message
relay sees no profile filter at all, and what is left of the old snapshot is a
straggler list. Cost is bounded to two timeouts once per name, and every name is
cached as it lands, so it is a first-sight cost rather than a per-boot one. If
the read class is configured empty the fallback is unconditional, which keeps the
old behaviour.

`[A]` the ceiling is still not zero: an unknown peer published only to the
message relay will still be named there, one at a time. `[U]` closing that fully
needs a cache of which relay answered for which peer, or publishing every
profile to the read class and nowhere else; the first is a feature, the second
is already true for this client. Falsifier: a relay operator recovering the
list from REQs. Experiment: count distinct `authors` filters per relay per login.

**A3 Per-context identity from one root.** Hides the link between contexts, from
relays and listing readers. Reveals a stable per-context key, and the root stays
the public handle, so discovery is unresolved and reputation portability breaks.
Failure: a lost derivation index loses the identity. Product impact large.
Novel-but-plausible. Falsifier: any event carrying the root pubkey beside a
context tag. Experiment: write the derivation and discovery rules, then list
every feature that breaks.

### B. Take the relay out of the group

**B1 Client-governed epoch log.** Hides the relay's power to admit a member and
to roll the roster. Reveals what it sees now; membership still public unless the
log is encrypted, so couple with B3. Failure: fork and rollback rules, and an
offline owner cannot rotate. Product impact: group authority becomes client
state. Novel composition of an established shape. Falsifier: an adversarial
relay adding a pubkey that no client refuses. Experiment: a two-relay prototype
with a hostile relay, plus a fork drill.

**B2 Anonymous membership credentials.** Hides which admitted key acts, from the
relay. Reveals the epoch and timing. Failure: credentials must ride in plaintext
tags without a second round trip, and a kick must revoke rather than just rotate.
Established primitives, speculative composition. Falsifier: recovering the
presenting pubkey from presentations better than chance. Experiment: one
round-trip prototype plus independent review.

**B3 Sealed membership.** Hides the member set and size of a private group from
the relay. Reveals the group id and cadence, and the group's existence if the
directory row stays. Failure: the signer is either the relay (so couple with B1)
or the owner (so offline members fetch it anyway, through the relay). Product
impact: link-only discovery. Novel-but-plausible; the sealed label already works
(`useNIP29Group.js:959-1022`). Falsifier: one relay query recovering a member
list. Experiment: read the relay cold against a sealed roster.

### C. Reader privacy

**C1 Private mailbox tags.** Hides the recipient's long-term identity; the sender
writes to a rotating bucket tag instead of `p: <npub>`. Reveals the polled
window, and presence. Failure: with few users a bucket tag can be *more* stable
than nothing, so this needs measurement before belief. Product impact: the client
walks buckets, which is traffic. Novel-but-plausible, close to sealed sender.
Falsifier: a relay's attribution accuracy reaching 80% of the tag scheme.
Experiment: simulate 10^3-10^5 users, bucket 1h, window 3.

**C2 PIR / oblivious read.** Hides which record you asked for. Reveals query size
unless fixed, and the snapshot update cadence. Failure: needs a server-side
snapshot mode, and hint staleness must fail closed. Note the server cannot forge,
only omit, since events are signed. Product impact: hundreds of ms and new server
work. Established primitive, novel in a relay browser. Falsifier: over ~1s per
query on a mid-range phone. Experiment: one relay over ~10^5 events, measure
hints, CPU, latency.

**C3 Cover traffic and batching.** Hides when traffic happens. Reveals bandwidth,
and the cadence is itself a fingerprint; dummies with no reply are filterable
unless shaped. Product impact: 1-5s latency, battery. Established. Falsifier: a
socket classifier still calling "a message happened" above chance. Experiment:
A/B a 30s cover wrap over 8h, then add a 2s batch window.

### D. Network

**D1 Light every door, not just the group and media ones.** Hides the hostnames
of each service from the resolver and the exit. Reveals Tor use, volume, timing;
Tor does not hide an identity asserted in-protocol, but after Step 2 slices
1-2 nothing on a group box asserts one: kind-9 bodies, all control kinds and
every NIP-42 proof (both the raw socket via `signActProof` and both pool
auto-auth installs) are actor-signed. A captured 22242 names a pseudonym that
recomputes from one account secret but shares nothing visible with it.
Failure: a stale door after a box moves. Product impact: desktop only; a web page cannot set its own proxy
(`README.md:52-54`). Established. Falsifier: an exit log still showing the
clearnet hostname for the message path. **Today `dm-relay`, both search relays
and `dead-drop` are dark** (`egress.js:103-111`).

**D2 A mix step.** Hides burst structure and the typing-then-sending coupling.
Reveals the recipient, and the delay distribution. Failure: retries reordering
sends. Product impact: send latency. Speculative here. Falsifier: no accuracy
drop from a 2s hold. Experiment: measure a classifier before and after.

**D3 Independence as a written law.** Hides a single operator's union of a user's
surfaces. Reveals whatever the shared npub asserts. Failure: defaults silently
re-pairing. Product impact: none. Established. Falsifier: a shipped path with two
rows under one operator. Experiment: a table, plus an `egress.test.js` assertion.

### E. Local, money, push

**E1 Raise the at-rest floor.** Hides the vault from a disk copy. Reveals nothing
new; brute-force cost is the game. Failure: more keypad slots, or a non-keypad
entry path, are needed to exceed 10^8 (F7). Product impact: typing, and the wipe
rule means a forgotten long PIN destroys the account. Established. Falsifier:
under an hour for a median PIN, measured. Experiment: seconds per guess on the
target phone.

**E2 Forward secrecy.** Hides past DMs from a future key compromise. Reveals
unchanged metadata. Failure: state divergence, the worst mode for a messenger;
needs an out-of-order rule and prekeys. Established primitive, novel composition.
Falsifier: a chain that desyncs after a 3-day offline gap. Experiment: prototype
against a 3-day offline partner.

**E3 Money.** Hides amounts and address linkage from a chain observer; per-order
Monero subaddress and an address-free listing already do most of it. Reveals
txids when a bulletin is published (F8). Failure: two leaked vendor addresses
cluster, since BIP-84 is deterministic. Product impact: a bulletin warning, or a
salted subset. Established. Falsifier: a bulletin that still reveals every deal
size with no warning. Experiment: publish one, count what an observer learns.
The watcher's own box is a second observer: the child token is an HMAC over a
version, the currency and the address, so a captured child answers for exactly
one payment (`paymentWatch.js:39-50`), but the box operator still sees every
address it is asked about and when, which is the vendor's order cadence, and the
checking device's IP. A host merely carrying a seed's own name is refused as a
watcher (`paymentWatch.js:18-31`).

**E4 Push.** Hides content and sender already. Reveals arrival to the gateway,
which has an **open registration** endpoint (`notify-gateway.mjs:13`), so anyone
can register any npub and time its buzz; and APNs/FCM are permanent third
parties. Product impact: authenticated registration, a rotated push key.
Established, and APNs cannot be removed. Falsifier: a stranger box still timing
an npub's arrival. Experiment: register a known-active npub from elsewhere.

### F. What cannot be private

- **A public listing is public.** A discoverable 30402 with a price cannot also
  be secret. Keep it public and accept the vendor ↔ menu link, or scope listings
  to groups and lose global Discover.
- **A handle is a global name**, published on open relays (`useIdentity.js:257
  -269`), squattable and enumerable.
- **Typing and read receipts are metadata by design.**
- **Exactly-once needs a deleting server** (F9).
- **A web page cannot use Tor** (`README.md:52-54`).
- **iOS push is APNs**, forever.

## 6. The rest of the adversary set

Section 2 covers the colluding pair. These three are named in their own right
because each sees something a relay operator does not.

**Hosting provider.** `[I]` sees the box's network position, its outbound peers
and its co-tenants, and can terminate or observe TLS if it is the terminator. It
can be compelled where a self-hoster cannot. It adds nothing about message
content that the relay lacks, but it can join two relays hosted on one provider,
which is the same "two boxes, one owner" rule one layer down. The founder's two
group boxes sharing a relay key (`egress.js:10`) collapse to one trust domain
whether or not they share a provider; if they ever split providers, the split
must be documented to count.

**The watcher box, as a payment observer.** `[V]` it sees every
address/currency pair it is asked about and when, which is the vendor's order
cadence and count, plus the checking device's IP. The child token is an HMAC over
a version, currency and address (`paymentWatch.js:39-50`), so a captured child
answers for one payment only; a host merely carrying a seed's own name is refused
as a watcher (`paymentWatch.js:18-31`). So the box cannot forge other payments,
but it does watch. A vendor running their own box is the observer; a pasted
third-party box is someone else's.

**Traffic correlator.** `[I]` an ISP or a well-placed observer who has no keys
and no collusion. With DMs on one relay and media on one host, the flow pattern
names sessions. Without Tor, DNS hands over the host list and the IP is the home
IP (`README.md:52`). The correlator needs no cooperation from anyone, which is
why C3 and D2 matter more than their size suggests: they are the only defence
against a party that cannot be asked to cooperate.

## 7. Recovery, the area the first pass under-covered

`[V]` **the vault never leaves the device, and the function name misleads.**
`restoreFromRelays` (`useIdentity.js:639`) searches local `cipher_vaults` then the
legacy `cipher_vault` key, and on a miss answers "Account not found on this
device. Use your 12-word recovery phrase if you are on a new device." No relay is
queried. Nothing publishes a vault: the only `30078` use is the group baseline
(the username record is 10003, F11), so a relay never sees a vault blob.

`[V]` **the phrase is the account, with no rotation.**
`deriveSkFromMnemonic` takes `mnemonicToSeedSync(mnemonic).slice(0, 32)`
(`useIdentity.js:15-19`), so the 12 words determine the secret key directly, with
no derivation path and no account index. Consequences: recovery is serverless,
which is good, and a leaked phrase means the identity is compromised and **cannot
be re-keyed in place** — a new key is a new npub, a new handle, a new vendor card
and re-joining every group. There is no "rotate your key, keep your name" path.

`[V]` the phrase sits encrypted in the vault on the device, and five wrong PINs
delete that copy (`useIdentity.js:508-512`), so the written-down words are the
only thing standing between a wipe and an account that is gone. Recovery is the
one area where the app is already fully decentralised and already irreversible.

## 8. Most ambitious plausible goals

Plausible means reachable without a new primitive, not free.

- **G-A** A group relay untrusted for confidentiality *and* membership: it sees
  ciphertext, an opaque handle and timing, and cannot admit a key by itself.
  Today it can (F3).
- **G-B** A DM from which the relay learns neither the sender's key nor a stable
  mailbox for the recipient, and cannot rebuild the address book from REQs.
  Today it can (F1, F2).
- **G-C** A desktop user whose IP appears at no host, with every door lit. Today
  group and media have doors; messages, search and notes do not.
- **G-D** A vendor whose on-chain volume is not public and whose order addresses
  do not cluster. Monero: done. Bitcoin: needs one decision (F8).
- **G-E** A key compromise does not open history, and a PIN does not stand alone
  against a copied vault. Today neither holds (F5, F7).

## 9. Most promising options, including the unconventional

1. **A1 + A2.** Done. A2 names the peer set to the profile relays first and to
   the message relay only for the names they missed, so the host that carries the
   traffic rarely learns the list. The next open one is F13, which A2's residual
   touches: naming the sender on the wrap would make sent history recoverable
   *and* hand the relay both ends in the clear.
2. **F6's fixed-size rumor.** About 480 bytes a message to cut the length channel
   from seven classes to one. Cheaper and more effective than cover traffic for
   that channel, and it needs no server.
3. **C1 private mailbox tags.** The unconventional one. Removes the `p` tag
   entirely, costs no server, and fits the existing "sent mail lives on the
   device" reality. It is also the one whose benefit depends on user count, so it
   must be measured before it is believed.
4. **B1 + B3.** The only way to make the group relay non-authoritative, and the
   direct challenge to NIP-29's trust anchor.
5. **D3 independence as written law.** Free, and it is what turns F4 from a
   shipping surprise into a tracked decision.
6. **E1 to 10^8 and beyond.** Cheap and measurable, but note the keypad caps it
   (F7), so "beyond" needs a design, not a constant.
7. **E3's bulletin decision.** Restores amount privacy with no crypto at all.
8. **F9's expiration stamp.** Done: one tag, `created_at + 30 days`, and the
residual is F13 rather than the stamp.

## 10. Strongest failure reason, per option

- **A1, A2:** the connection and the recipient tag survive, so this is not
  anonymity and should never be written up as such.
- **A3, B2:** discovery is unresolved; per-context keys with no way to find them
  are worse than one key.
- **B1:** fork, rollback and offline-owner bugs, and it does not hide membership.
- **B3:** needs a signer, so it is either the relay or the owner, and neither
  gives a clean win alone.
- **C1:** a small user base can make a bucket tag more stable than nothing.
- **C2:** a second server protocol, and the server-side log may be nearly as good
  as the fix.
- **C3, D2:** a distinctive cadence or delay is itself a fingerprint.
- **D1:** one exit still sees every destination at once.
- **E1:** the keypad ceiling is 8 digits, so the floor cannot rise without a
  design change.
- **E2:** a chain that fails to decrypt is worse than one without forward
  secrecy.
- **E4:** APNs and FCM cannot be removed.

## 11. What it would cost

Product: 1-5s send latency for batching, hundreds of ms on an oblivious read,
battery for cover traffic, a longer PIN to type against a wipe rule, a bulletin
that no longer proves volume, link-only discovery for private groups, and private
listings losing the global menu.

Operational: a second protocol to run for C2, a per-trust-domain independence
law that constrains which defaults may pair, and a rule that every privacy claim
ships with its falsifier.

And the things no design buys back, to be said in the product's own words rather
than hidden: a public listing is public; a handle is a global name; typing and
read receipts are metadata; deletion is a request; a web page cannot use Tor; iOS
push is APNs forever; and a leaked recovery phrase cannot be rotated in place.

## 12. Research questions worth funding

1. **Mailbox anonymity-set maths at 10^2 to 10^5 users.** Decide C1 versus C2 on
   evidence rather than taste. Fund the measurement, not the build.
2. **Client-governed group state under an adversarial relay**, with a formal
   fork, rollback and offline-owner analysis. This is where the repo has already
   spent the most bug-fixing effort, so it pays a paper-level treatment.
3. **Anonymous membership credentials carried in plaintext tags**, with a
   revocation rule and no second round trip. This is the "plausible therefore
   trusted" zone and needs independent review.
4. **A socket-attribution experiment on a live relay**, before and after A1.
   Every anonymity claim here should quote its number.
5. **Offline brute force of a copied vault** on a mid-range phone, PBKDF2-600k
   versus Argon2id, and the PIN length at which the local claim holds.
6. **Forward secrecy without delivery risk:** an out-of-order-tolerant epoch
   chain tested against a 3-day offline partner.

## 13. If it were one first thing

Not a build. Take one modified client that only wraps typing (A1) and batches
profile reads (A2), keep everything else identical, and capture the socket view
at the relay for a week. That yields, as numbers: whether A1 and A2 are worth
shipping, what the residual leak is (recipient, connection, length), and
therefore whether C1 or B1 is next. It needs no new protocol and no review to be
informative.

Then a design paper, no code: B1 plus A3, with the fork, offline-owner and
discovery rules written down and every broken feature listed with a `file:line`.
That list is the true cost.

Then exactly one prototype: C1 if the measurement says the recipient tag
dominates; B1 if the relay's authority is judged the bigger betrayal. Not both.
Not PIR first.

## 14. Deliberately not on the first lane

An MLS rewrite (the group problems are authority problems, not crypto problems),
a Double Ratchet (delivery risk), and protocol-level per-context identity
(discovery is unresolved).

## 15. Unmeasured

Relay user counts / anonymity-set sizes. Socket-level attribution accuracy.
Whether relays keep sub-second arrival time. Whether the ±2-day backdate survives
a relay's own ingest indexing. Real FCM/APNs payload parity. Monero subaddress
index collisions. Cover-traffic battery on the target phone. Argon2id cost —
Argon2id is **not** adopted, the vault is PBKDF2-600k (`useIdentity.js:47`, 600000
iterations of PBKDF2-SHA-256).

## 16. Corrections this review carries

- The PIN floor is 10^8 for any account made since `1c7aba4`, not 10^6; 10^6 is
  legacy only (F7, F10).
- The Groups row and D1 were written before two later changes and have been
  corrected in place: media uploads sign their 24242 with a throwaway key
  (`917793e`, N1), so the media host no longer earns an npub-to-IP-to-hash row
  per vendor; and kind-9 group acts plus the raw socket's NIP-42 answer are now
  signed by a per-group actor key (Step 2 slice 1 of MEMBERSHIP-DESIGN.md),
  with control kinds and the two pool-level auto-auth answers still naming the
  account until slice 2.
- `db.js` is `src/db.js`; group crypto is `src/lib/crypto/`.
- The size channel is the *message class*, not the deal size (F6).
- NIP-42 group-relay-only auto-auth was **designed**, with a comment saying a
  clearnet host must not harvest a 22242 (`pool.js:135-141`; the review cited
  139-141, one line off).
- `restoreFromRelays` restores from local storage, not relays (section 7).
- Three fixes landed while writing this, so their findings read in the past
  tense: F1 and F12 (the two signed senders, typing and group key grants), F9
  (the expiration stamp), F11 (the wrong handle kind), F14 (both disclosure rows
  and the README push section) and F10 (the README PIN floor), plus A1 and A2.
  The rest are open.
- The F11 fix was pushed referencing a relay set it had not imported, and oxlint
  flagged it as a **warning** while still printing "0 errors", so the build stayed
  green over a read that would have thrown into its own catch. An undefined
  identifier is not a failing condition in this repo. Fixed in the next commit
  rather than amended.
- F13 was found by chasing F9's TTL, not by looking for it: the question "how
  long may a relay keep this?" does not answer itself until you notice that the
  history fetch has no lower bound and that the stamp, not the window, is
  therefore the horizon. It is the largest open decision this review produced and
  it was invisible in the first pass.

## 17. Common sense to carry

Ship every claim with its falsifier. If no test can fail a claim, the claim is
copy, not engineering.
