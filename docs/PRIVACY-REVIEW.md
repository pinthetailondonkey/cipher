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
| DM | `relay.primal.net` | wrap 1059, seal 13, rumor inside | **recipient** (plain `p`), arrival time, length; not sender, not the label | `useNIP44DM.js:102-165`, `giftWrap.js:37-42` |
| DM typing | same | **bare kind-4 signed by the real sender** | sender, recipient, exact second | `useNIP44DM.js:168-189` |
| DM read | same | `'#p':[me]` and `authors:[me]` | which pubkey is online and reading | `useNIP44DM.js:200-203` |
| Contact list | DM + group | `{kinds:[0], authors:[every peer]}` | the address book, in one REQ | `useChatBootstrap.js:250-254` |
| Profile | `nos.lol`, `relay.damus.io` | kind 0, 10003 handle, 10002 relays | pubkey ↔ handle ↔ face ↔ blurb | `useIdentity.js:236-273` |
| Search | `relay.vertexlab.io`, `relay.noswhere.com` | NIP-50 text; a 200-group directory blast | the query, and the asker's IP | `usePeopleSearch.js:220-228` |
| Groups | `groups.ciphertele.com`, `groups2.ciphertele.com` | kind-9 signed by the author, `h`, `ep`, AES-GCM body; 9021/9022/9000/9001/9002/7/9005 | the whole social graph: author, group, epoch, second, size | `useNIP29Group.js:811-851`, `groupCipher.js:10-16` |
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
| Marketplace | `relay.primal.net` | 30402 title, price, image, `t=cipher_marketplace` | a public menu tied to the vendor npub | `Wallet.jsx:229-262` |

Two facts about the DM envelope matter more than its row. NIP-59 sets
`created_at = now − U(0, 2 days)` (`nostr-tools nip59.js:232-234`) `[V]`, and the
`since` filter is −7 days (`useChatBootstrap.js:456`) `[V]`, so the backdate
cannot fall off the window. And sent wraps are unqueryable, so a reinstall
recovers only *received* DMs `[V]` (`useNIP44DM.js:404-407`).

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

**F1 `[V]` typing re-anonymises the DM sender.** Messages are wrapped and
sender-less; typing is a bare signed kind-4 on the same relays
(`useNIP44DM.js:176-181`). A relay that sees `A → B, 12:00:03` beside an
anonymous wrap to `B` at `12:00:04` attributes the thread. Cheapest real fix.

**F2 `[V]` the address book is broadcast.** `authors: missing` where `missing` is
every counterparty (`useChatBootstrap.js:250-254`).

**F3 `[V]` the group relay is a confidentiality anchor.** The roster is
relay-signed (`groupMembership.js:222-229`) and a responder trusts it
(`groupKeyRotation.js:182-206`, `README.md:148`). A relay admin who writes a
pubkey into the 39002 is handed the key by the next member who answers.

**F4 `[V]` the DM relay and the media host are one operator** (section 2).

**F5 `[V]` no forward secrecy.** NIP-44 uses a static ECDH conversation key
behind a cache (`dmKeys.js:25-37`), so one `sk` capture opens every past DM.

**F6 `[V]` every DM is about 2.1 KB, and message length leaks in four buckets.**
Measured against `nostr-tools` NIP-44 at this pin, with a realistic rumor:

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
near-total close of the channel. This corrects the worry that *deal size* leaks:
it barely does, it is the message class that leaks.

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

**F9 `[V]` deletion is a request.** Tombstones are local (`db.js:39, 320-322,
378-394`); a relay that copied the ciphertext keeps it. Exactly-once notes are
truly gone only on a self-run carrier, which deletes on read
(`note-carrier.mjs:201-220`); the relay path's once is a device ledger
(`deadDrop.js:98-142`).

**F10 `[V]` README contradicted a purpose-built evidence doc.**
`README.md:151` said "The minimum PIN is 6 digits." `vaultLockout.js:5-7` sets a
new PIN minimum to 8, and `docs/PIN-LENGTH-EVIDENCE.md` documents the 6 → 8 rise
at `1c7aba4` with `git show` proof. Fixed in the same sitting; only a pre-`1c7aba4`
account has the 6 floor.

**F11 `[V]` the boot reads a username record nothing writes.**
`useChatBootstrap.js:226-235` reads `{kinds: [30078], '#d': ['username']}`, but
the only writer of a `d=username` record is `useIdentity.js:259-262`, and it uses
**kind 10003**. The other two handle readers agree with the writer
(`handleClaim.js:41`, `usePeopleSearch.js:106`, both 10003), so the 30078 read
matches no writer in this tree. Effect: `lockedUsername`, `my_username` and
`chatStore.myUsername` are never populated from the relay, and `myUsername` has
no reader at all (`chatStore.js:445`). `[U]` whether an older client published
30078, which would make the read deliberate back-compat.

## 5. The catalogue

Each entry: what it hides from whom / what it still reveals / assumptions and
failure modes / product impact / maturity / a falsifying observation / a proving
experiment. Maturity is `established`, `novel-but-plausible`, `speculative`, or
`unsupported`.

### A. Finish what is half-built

**A1 Wrap the signing leftovers.** Hides the sender of typing (and any future
bare kind-4) from the relay. Reveals recipient, arrival, length, connection. The
code already filters typing on ingest (`useNIP44DM.js:265-271`). Product impact:
none. Established. Falsifier: a signed kind-4 carrying `me` during a
conversation. Experiment: assert the wire event for typing has no `authors` link
to the sender.

**A2 Stop the address-book broadcast.** Hides which peers share an account.
Reveals the account's own pubkey, so a patient relay still learns the set;
batching raises the cost, not the ceiling. Product impact: slightly slower name
resolution. Established. Falsifier: a relay operator trivially recovering the
list from REQs anyway. Experiment: count distinct `authors` filters per login.

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
Tor does not hide an identity asserted in-protocol (the group relay's 22242 names
the account by design, `pool.js:139-141`). Failure: a stale door after a box
moves. Product impact: desktop only; a web page cannot set its own proxy
(`README.md:52-54`). Established. Falsifier: an exit log still showing the
clearnet hostname for the message path. **Today `dm-relay`, both search relays
and `dead-drop` are dark** (`egress.js:105-113`).

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
queried. Nothing publishes a vault: the only `30078` uses are the group baseline
and the dead username read (F11), so a relay never sees a vault blob.

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

1. **A1 + A2.** Certain, cheap, and they close the two joins that hurt today. No
   new protocol. Do these whatever else is chosen.
2. **F6's fixed-size rumor.** About 480 bytes a message to cut the length channel
   from four buckets to one. Cheaper and more effective than cover traffic for
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
Argon2id is **not** adopted, the vault is PBKDF2-600k (`useIdentity.js:43-58`).

## 16. Corrections this review carries

- The PIN floor is 10^8 for any account made since `1c7aba4`, not 10^6; 10^6 is
  legacy only (F7, F10).
- `db.js` is `src/db.js`; group crypto is `src/lib/crypto/`.
- The size channel is the *message class*, not the deal size (F6).
- NIP-42 group-relay-only auto-auth was **designed**, with a comment saying a
  clearnet host must not harvest a 22242 (`pool.js:139-141`).
- `restoreFromRelays` restores from local storage, not relays (section 7).

## 17. Common sense to carry

Ship every claim with its falsifier. If no test can fail a claim, the claim is
copy, not engineering.
