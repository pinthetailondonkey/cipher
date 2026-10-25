# Cipher

Nostr messenger and direct-deal shop. Vite + React. See AGENTS.md if present.

## Rules for every change
- Do not touch DM crypto (NIP-44), group AAD, or the outbox without saying why.
- One change per commit. Message says what and why.
- npm run build, npm run lint and npm test must be green before a commit.
- No new dependencies without a reason.
- Push each commit. Pin every read to the SHA, never to /main.

## Facts
- Bitcoin 8 decimals, Monero 12. Round half up, never drop.
- Confirmations: BTC 3, XMR 10, overridable.
- Payment path: created, address_issued, seen, confirmed. Skips nothing.
- On Bitcoin seen means mined. scantxoutset cannot see the mempool. No 0-conf.
- A receipt names one transaction.
- Push tags: t=msg, t=order, t=call. Typing, read, pin and key bundles do not buzz.
- The vendor's own wallet is not a chain confirmation. Only a watcher is.
- No public block explorer is ever called.

## How to report back
The SHA and whether it is pushed. Exact file paths, one line each. Raw
build, lint and test output. A note on anything touched outside those files.
