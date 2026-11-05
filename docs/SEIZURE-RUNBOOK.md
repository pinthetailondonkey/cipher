# Seizure runbook — the box is gone right now

This document answers one question, from evidence that already exists: if
either server died today — provider vanishes, court order, disk loss,
wiped account — what is needed to rebuild the service elsewhere, and
where does each piece live when the dead box cannot answer?

It is a skeleton by design: every row has a place to fill in the exact
off-box location the day it is verified. An empty **Off-box copy** cell
is not a footnote, it is an open item. A recovery chain with an unknown
link is a hope, and this file exists to turn hopes into rows.

The companion documents this one builds on:

- `docs/ONION-DOORS.md` — how doors reach the app, the gate law.
- `docs/BACKUP-PROPOSALS` (off-repo) — the relay data durability proposal
  of 2026-10-28, which measured what the group relay holds and what
  losing it costs. Its findings are summarized here; its owner is the
  founder's own archive.

## The shape of the system, in one paragraph

Cipher's servers hold no user keys, ever. What dies with a box is:
availability (the door stops answering), stored ciphertext (group events),
and continuity markers (onion addresses, TLS names). Every user device
keeps its own copy of what it has seen, so the loss window is "what was
posted while people were away," not "everything." Rebuilding means: new
box, same software, same relay key so clients keep authenticating, either
the old onion key restored or every published address re-pointed.

## Inventory: every secret and datum, and where it must also live

| # | Item | Lives on | Off-box copy | If lost |
| --- | --- | --- | --- | --- |
| 1 | Relay identity keypair (NIP-11 self-description + AUTH identity; both relays share one pubkey by design) | `/etc/groups_relay/secrets/`, mode 600, both boxes | same path on the surviving box (mirrored at Phase 0); verify before trusting | Clients fail AUTH against a new key. Restoring the mirrored key preserves client trust unchanged. |
| 2 | Group event store (LMDB, kinds 9/39000/39002/9002/9007/9022/0 per the durability proposal) | relay data dir on each box | nightly encrypted snapshot shipped cross-box (aegis → aivps), 14-day rotation; plus any relay-level export id list kept as the backup receipt | Last snapshot bounds the loss to hours. Events older than the newest snapshot survive only on member devices. |
| 3 | Tor hidden-service keys (per onion door: group relay 1, group relay 2, note page, site mirror) | tor HiddenServiceDir on each box | TO VERIFY — named here as an open item; the address of a door dies with its key, and every installed copy that carries it would orphan | Onion addresses change permanently; every Connections paste re-done. Copying the whole directory (`hostname` + keys) before any change is the law. |
| 4 | TLS certificate material (Let's Encrypt for `groups.ciphertele.com`, `groups2.ciphertele.com`) | `/etc/letsencrypt/` on each box | TO VERIFY — a cert can be reissued anytime, so this is convenience, not treasure; the renewal timer must be re-proven after restore (REV4 section 8) | Reissue; nothing permanent lost. Domain ownership is the real asset — see row 7. |
| 5 | WireGuard admin plane (both peers' keys; SSH allowlists derive from it) | WG config on both boxes + laptop peer | founder keeps the laptop peer config; TO VERIFY written down somewhere off both boxes | Lose both boxes' WG keys = re-key the plane; lose the laptop key too = locked out of a closed-22 posture until console access is used once. |
| 6 | Firewall posture (ufw/nft rules: closed 22, loopback-only binds, canary reopen rule) | both boxes | recorded procedurally in REV4 rollback sections; re-derivable | Re-derive from the docs; no secret involved. Verify zero public plain-text binds after any restore. |
| 7 | Domain control (registrar accounts for ciphertele.com and related names, XMR-paid registrar posture) | registrar | founder-only knowledge, deliberately out of all chat and repos | DNS seizure without registrar access is unrecoverable remotely. This row is the founder's personal custody; the runbook only records THAT it matters. |
| 8 | Push gateway credentials (APNs key/id/team/topic, Firebase service account) | push box env (untracked `.env`) | TO VERIFY — these live wherever `npm run boxes` was first run; a fresh gateway regenerates NOTHING for APNs/Firebase, they are Apple/Google-side assets downloadable again from their consoles | Re-download from the vendor consoles with their account access. No phone behavior changes if the topic stays identical. |
| 9 | Payment watcher token (`WATCH_TOKEN`) and wallet RPC endpoint(s) | watcher `.env` on its host | regenerated freely; but the URL pasted into every buyer's Connections dies with the token — changing it breaks pasted URLs | Keep the same token across restores where possible; a changed token needs every pasted URL refreshed. Confirmations threshold setting lives on-device. |
| 10 | Burn-note carrier state (one-read blobs in flight, scripts/note-carrier.mjs host) | carrier host storage | holder burns by design; losing the host loses only unopened notes in flight | Acceptable loss, stated honestly: notes not yet opened are gone; opened ones were never recoverable anyway. |
| 11 | Media blobs (Blossom uploads, encrypted for DM media, public for profiles/products) | blossom hosts (primal.net, nostr.build, blossom.band today) | third-party; not on our boxes | Outages degrade images; Cipher holds no copy and owes none — the hosts' durability is theirs. |

## The two failure modes this runbook separates

**Box dies quietly.** Traffic black-holes. Recovery is unilateral: stand up
the replacement from rows 1–4, point DNS, verify with `npm run verify:live`
for the site and the probe discipline from REV4 (same-backend evidence,
never a status code) for the relays. Users see continuity except the loss
window of row 2.

**Box is seized intact.** Assume everything on it is now readable by the
taker — including snapshots, logs, and timing patterns. Nothing there can
deanonymize users (keys never touch the boxes; messages are sealed;
payments carry no identity beyond pubkeys). The recovery difference vs.
quiet death: rotate anything the taker could replay — WG keys, the
watcher token, and treat row 3's onion keys as compromised, issuing new
doors and re-publishing addresses. Rotate AFTER the new box is serving.

## Rebuild order, both modes

1. New box. Install the relay exactly as REV4 section 1 discovers it —
   read before changing, record RELAY_UNIT / RELAY_CONFIG / RELAY_PORT.
2. Restore row 1's key before first start; the relay answers with the
   identity clients already trust.
3. Restore row 2 from the newest cross-box snapshot; decrypt OFF the box
   being rebuilt when the source key allows.
4. Row 3 decision: restore onion keys (addresses unchanged, nothing for
   users to do) or accept new addresses (paste campaign required).
   Quiet death → restore preferred. Seizure → new addresses.
5. TLS per REV4 sections 2–3; validate with the hostname-verifying checks,
   never `-k`.
6. Prove before announcing: REV4's validation rules — identical NON-EMPTY
   id lists between old export receipts and the restored door, then the
   person drill (members, history, round-trip visible in the app).
7. Only then DNS. Low TTL beforehand if the move was planned.
8. Post-restore walk: rows 5–9 rotated or re-proven per the mode above;
   update the Off-box copy column with whatever was learned.

## Open items (the skeleton's purpose)

- [ ] Row 3: confirm tor HiddenServiceDir copies exist OFF each box and
      name where.
- [ ] Row 8: confirm APNs/Firebase credential custody and where they are
      re-downloadable from.
- [ ] Row 9: confirm whether the live watcher token was generated by
      `npm run boxes` (regenerable) and where its `.env` actually sits.
- [ ] Restore drill on real bytes, quarterly, per the durability
      proposal's section 4: decrypt, second port, probe, person check,
      write down what surprised.
- [ ] After the next verified drill, replace every MEASURED-shaped claim
      in this file with the drill's date and outcome.

## Voice notes

Words follow the repo's plain register: no "asset", no "threat vector",
no legal framing. A seized box is "seized"; secrets are "secrets"; the
drill proves with what a person sees, never with exit codes alone.
