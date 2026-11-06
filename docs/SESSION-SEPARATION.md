# SEC-5 — group relay connection correlation

## Question

What can the group relay, or an observer of that relay host, learn by joining
the requests and authentication made by one reader?

## Verified wire facts

- `[V]` The client keeps one live group session per account public key. Opening
  another group reuses that session (`src/hooks/useNIP29Group.js`,
  `openGroupRelaySession`, lines 596–602). A session opens one WebSocket at
  line 534.
- `[V]` Each group subscription is recorded on that session and sends its own
  `REQ` through the shared socket (`useNIP29Group.js`, lines 1311–1315). The
  filter contains the group id in `#h`.
- `[V]` The session sends at most one `AUTH` response per challenge/session
  because `authSent` gates `sendAuthResponse` (lines 404–426). It signs kind
  22242 with a per-group actor key through `signActProof`
  (`src/lib/crypto/gmIdentityWire.js`, lines 139–165).
- `[V]` The pool auto-auth path only answers for the configured group host and
  adds the actor pin (`src/lib/pool.js`, lines 158–179). Directory reads use
  the group-host-only signer (`src/lib/relayDirectoryRead.js`, lines 80–90).

## What can be joined

- `[I]` The relay correlates all group ids in the subscription filters with one
  WebSocket, source address, and connection lifetime. The source address is
  normally the reader's IP as observed by the relay or its hosting provider.
- `[V]` A subscription id includes the first 12 characters of its group id,
  while the filter already carries the full id in `#h` (`useNIP29Group.js`,
  lines 1311–1315). The prefix adds no new group information to a relay that
  can read the filter.
- `[V]` Governance member documents are dual-published to group relays and
  general relays (`src/lib/crypto/groupDocWire.js`, publish path). `[I]` This
  creates a cross-operator bridge between a group id and its authority pin;
  relay operators may be able to compare those observations if they share data.
- `[I]` The actor pin is one stable group pseudonym for a socket after the
  change. It does not hide the set of groups, timing, reconnects, or the
  relationship between the account's activity and its IP.

## Options and decision

Per-group WebSockets would split `#h` sets across connections, but the same IP
and close timing can still link them. They also multiply connection setup,
reconnects, AUTH challenges, and delivery failure points. Per-group AUTH on the
existing socket cannot authenticate independently per subscription: NIP-42
AUTH is relay-connection scoped, and sending several proofs would expose more
actor pins while not separating the shared requests.

The implementation keeps one socket and chooses one stable actor pin for its
life. It uses the group already proven on that socket; otherwise it chooses the
lowest id among readable groups, falling back to the lowest known group. If no
group is known, it leaves the challenge unanswered. This avoids making the
proof follow the screen while preserving the existing shared delivery path.

## Residual leakage and falsifiers

1. **Group set + IP + timing — `[I]`.** The relay sees every `#h` filter on the
   connection. A capture showing separate sockets per group or filters without
   group ids would falsify the corresponding code claim.
2. **Cross-relay document correlation — `[V]` publication, `[I]` operator
   join.** The document is sent to group and general relays. A wire capture
   showing otherwise would falsify the publication claim; proving operators do
   not share logs would be required to rule out the inferred join.
3. **Stable actor pin — `[V]` selection rule, `[I]` linkability.** A reconnect
   may select a different group if the previously held group is no longer
   known. Tests establish the selection behavior, not an operator's ability to
   correlate pseudonyms across IP changes.
4. **Host operator visibility — `[A]`.** This assumes the operator or a passive
   observer can access the relay's connection and request logs. Independent
   packet/relay capture is needed to establish which infrastructure parties
   actually retain them.

## Evidence

`src/lib/groupSocketProof.test.js` covers held-pin stability, deterministic
selection, empty state, shared connection exposure, AUTH gating, group-host
scope, and both pool paths. `src/hooks/useNIP29Group.test.js`,
`src/lib/pool.test.js`, and `src/lib/relayDirectoryRead.test.js` cover adjacent
session and signer behavior. These are client-side tests; they do not measure
what a live relay or hosting provider retains.
