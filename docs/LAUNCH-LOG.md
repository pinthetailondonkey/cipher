# Launch log

Findings as they happen, pinned to the SHA they were read at. Newest phase last.
A finding without a file:line is not a finding.

## Phase 0 — truth, at `e1e70da`

### Gates

`npm run build` **pass**, `npm run lint` **pass — 0 errors, 94 warning lines**, `npm test` **pass — 400/400, 0 fail, 52.5s**.
Run in the founder's working tree, so the uncommitted `src/lib/egress.js` edits are inside the result.

### Test files no command runs

22 test files are absent from `npm test`. 7 are the browser suite (`npm run test:ui`), 5 are the desktop suite (`desktop/` → `node --test test/`). **10 have no runner anywhere in the repo:**

- `src/lib/escrowActions.test.js`
- `src/lib/escrowFsm.test.js`
- `src/lib/escrowMembrane.test.js`
- `src/lib/escrowPsbt.test.js`
- `src/lib/escrowScript.test.js`
- `src/lib/orderMembrane.test.js`
- `src/lib/npub.test.js`
- `src/components/ui/smoke.test.jsx`
- `scripts/preview.test.mjs`
- `scripts/with-app-env.test.mjs`

The five escrow files are the whole escrow suite — the FSM, the script, the PSBT, the membrane. No CI workflow exists (`.github/workflows` absent), so nothing else picks them up. The "gates green" law does not reach the money machine.

### Live host

Fetched `https://sonic-cobalt-4m6q5vj.vercel.app/`: 200, `<title>Cipher</title>` present.

- Live bundle `/assets/index-Cu7vDotz.js`, last-modified 2026-10-24 19:29:29 GMT.
- Build of `e1e70da` produces `/assets/index-2aTOTYUz.js`. Different bundle, so the live page is not built from HEAD.
- Newest commit at or before the live build time: `e3936ce` (2026-10-24 15:22 EDT).
- `git rev-list --count e3936ce..e1e70da` = **887 commits**, 346 files, +43,189 / −8,001. The public site predates the rebuild, group security, state survival and money-edges.

### VISION §4

Still blank. Survey in progress.
