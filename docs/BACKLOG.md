# Backlog
One branch, one done-when per item. Take the top unfinished one.
Read docs/VISION.md before starting any item.

## 1. One-command install for both boxes — DONE (1752f6f)
Done when: from a clean clone, `npm run boxes` prints a watcher URL, and a wrong Node version fails naming it.

## 2. Encrypt message history at rest — DONE (7e2f1d4)
Done when:
- New message rows are stored encrypted using the EXISTING vault key. No new key material, no new dependency. AES-GCM, same family as group messages.
- Rows written before this change stay readable, and a reload shows old plaintext rows and new encrypted rows together in the same thread.
- A test asserts the stored bytes for a new row do not contain the plaintext.
- With the vault locked, history still renders without crashing.

Constraints:
- Do not touch DM crypto (NIP-44), group AAD, or the outbox.
- State in the commit: what happens to history if the vault key is lost.
- State in the commit: whether content search still works.

## 3. Extend the UI harness to every screen — DONE (147ec14)
Done when: the tap-target and clipping assertions run per tab, not just home.

## 4. README Vercel section — DONE (991cdd0)
Done when: the three stale claims are corrected.

## 5. Proof-of-trade v2 — STARTED
Done when: the implementation matches the spec (docs/proof-of-trade.md v2).
The spec is written; implementation is a separate item.
