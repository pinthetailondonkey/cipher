# Owner product/security decisions recorded 2026-11-10

Status: OWNER DECISIONS as given verbatim-in-summary on 2026-11-10. These
resolve the previously flagged REVIEWER-OPEN product choices at the
decision level. Implementation-level review questions attached to each
remain open where stated (independent protocol review still required
before any production wire use). Recorded from the coordinator session;
each entry cites what changed.

## Resolved

| # | Decision | Owner answer | Effect |
|---|---|---|---|
| 1 | Commit authorization | **Approved commit** of the staged remediation tree (~268 paths) | Staged tree committed this date; single branch, no push requested |
| 2 | D1 revocation grace | **Five minutes** confirmed as the chosen default | DM-TEST-PROFILE-V1 section 2: REVOKE_GRACE_SECONDS=300 becomes owner-selected default (review may still challenge the value; it is no longer owner-pending) |
| 3 | D3 registry-head max age | **24 hours** confirmed as the chosen default | REGISTRY_MAX_AGE_SECONDS=86400 owner-selected; same review caveat |
| 4 | Refreshed envelope / rewrap after expiry | **Yes** - rewrap permitted, canonical shape accepted as candidate | FreshnessEnvelope shape stays frozen and proceeds to independent review with owner support; DMV1-016 hold-only behavior superseded by sections 8-9 retry path |
| 5 | First contact discovery | **Both @ name lookup AND QR code** | Amends DM-TEST-PROFILE-V1 section 7 (was verified-pin QR only); adds searchable/bundle-based discovery requirement. IMPLEMENTATION DETAILS remain REVIEWER-OPEN: exact bundle publication format, which relays, spam-resistance, and how an @ name maps to a route without publishing account-to-route directories (Gate B conflict noted below) |
| 6 | Recovery backup availability (F-O1) | **Keep account available during recovery/restore** | RECOVERY-CEREMONY-SPEC-V1 F-O1 resolved: no partial lockout during ceremony; race-window tradeoff accepted and recorded |
| 7 | Dedupe retention | **Forever** (as long as local history retention) | Confirms the frozen equivalence dedupe-lifetime == journal-lifetime == history-retention; removal requires explicit policy change |
| 8 | Group history backfill on join | **Per-member choice**: the JOINING member decides whether to receive prior history | Amends MLS-TEST-PROFILE past-epoch/backfill rule from do-not-backfill-by-default to joiner-opt-in; sender-side consent + re-key cost mechanics remain REVIEWER-OPEN |
| 9 | UX copy (F-O4) | **Wording approved as written** | Recovery-ceremony custody warning / competing-root disclosure / fencing notice strings cleared pending the user-study pass already required by R5-C/D |

## Still open (not answered this round)

- F-O2 contact rotation during a pending ceremony (unanswered).
- F-O3 hold-window parameters (hold timeout default, contact ack grace,
  extension allowance) (unanswered).
- Independent protocol review itself remains REQUIRED before any test-account
  wire integration; these owner answers are inputs to it, not a substitute.

## Gate B interaction warning (recorded honestly)

Decision 5 (@ name discovery) intersects Gate B ("never publish an
account-to-route directory"). Searchable-name discovery must be implemented
without linking the shared account key into any ordinary private route tag;
the mechanism design has to resolve this tension explicitly. Until that
mechanism exists and is reviewed, @ name discovery is a REQUIREMENT TARGET,
not an implemented behavior; the test-profile continues on the verified-pin
path for everything else.
