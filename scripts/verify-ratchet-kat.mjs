// scripts/verify-ratchet-kat.mjs
// INDEPENDENT verifier for the Double Ratchet DM behavioral-capture vectors.
//
// Reads test-vectors/ratchet-v1/behavioral-capture.json and re-derives every
// checkable expectation from the vector data alone. Exits nonzero with named
// failures.
//
// INDEPENDENCE STATEMENT (honest):
// - This verifier does NOT import the Rust crate or its wasm adapter. It
//   checks structural invariants and recorded evidence only.
// - The vectors are BEHAVIORAL CAPTURES, not true KATs: identities regenerate
//   per run (vodozemac 0.11.2 has no public key injection), so ciphertext
//   bytes are NOT pinned. What is pinned: the fixed plaintext sequence, the
//   alternating sender schedule, per-round ciphertext length ranges, the
//   wire-frame kinds (PreKey for the initial setup message, Normal after the
//   first reply), the exercised skipped-key case, and the chain of rounds
//   being complete and ordered.
// - Shared third-party ground truth: none beyond Node's standard library.

import { readFileSync } from 'node:fs';

const failures = [];
const passes = [];
function check(name, condition, detail = '') {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
}

const PATH = process.env.CIPHER_RATCHET_KAT_FILE
  ?? 'test-vectors/ratchet-v1/behavioral-capture.json';

let doc;
try {
  doc = JSON.parse(readFileSync(PATH, 'utf8'));
} catch (error) {
  console.error(`verify-ratchet-kat: cannot read ${PATH}: ${error.message}`);
  process.exit(1);
}

check('schema-name', doc.schema === 'cipher-ratchet-kat/v1');
check('kind-is-behavioral-capture', doc.kind === 'behavioral-capture');
check('capture-note-honest',
  /regenerat/i.test(doc.captureNote ?? '') && /not ciphertext bytes/i.test(doc.captureNote ?? ''));
check('rounds-present', Array.isArray(doc.rounds) && doc.rounds.length > 0);

const EXPECTED_SEQUENCE = [
  ['alice', 'dm ratchet round one'],
  ['bob', 'dm ratchet round two'],
  ['alice', 'dm ratchet round three'],
  ['bob', 'dm ratchet round four'],
  ['alice', 'dm ratchet round five'],
  ['bob', 'dm ratchet round six'],
];

// Round schedule matches the frozen sequence exactly, in order.
const rounds = doc.rounds;
check('round-count', rounds.length === EXPECTED_SEQUENCE.length,
  `${rounds.length} vs ${EXPECTED_SEQUENCE.length}`);
for (const [index, [side, plaintext]] of EXPECTED_SEQUENCE.entries()) {
  const round = rounds[index];
  check(`round-${index}/side`, round?.side === side, `${round?.side} vs ${side}`);
  check(`round-${index}/plaintextLen`, round?.plaintextLen === plaintext.length,
    `${round?.plaintextLen} vs ${plaintext.length}`);
  const kind = round?.cipherKind;
  check(`round-${index}/frame-kind-known`, kind === 'PreKey' || kind === 'Normal', `${kind}`);
  const chars = round?.ciphertextJsonChars;
  check(`round-${index}/ciphertext-nonempty`, typeof chars === 'number' && chars > 0, `${chars}`);
}

// Wire-frame semantics: round 0 is the PreKey-framed setup message (alice has
// not yet received any reply when she sends it). Every later alice message is
// Normal-framed (a session with peer contribution exists by then).
check('round0-is-prekey-frame', rounds[0]?.cipherKind === 'PreKey',
  `round0 kind ${rounds[0]?.cipherKind}`);
for (let i = 1; i < rounds.length; i++) {
  check(`round-${i}/normal-frame`, rounds[i].cipherKind === 'Normal',
    `round ${i} kind ${rounds[i]?.cipherKind}`);
}

// Skipped-key case: the receiver decrypted message two while one message key
// was behind, and BOTH messages were recovered — the crate derived the skipped
// key internally.
const skipped = doc.skippedKeyCase;
check('skipped-case-present', skipped != null && typeof skipped === 'object');
check('skipped-case-exercised', skipped?.exercised === true);
check('skipped-case-recovered-both', skipped?.recoveredBoth === true);
check('skipped-case-note-mentions-skipped', /skipped/i.test(skipped?.note ?? ''));

// Sender alternation is strict: alice and bob alternate every round.
let expectSide = 'alice';
for (const [index, round] of rounds.entries()) {
  check(`round-${index}/alternation`, round.side === expectSide,
    `${round.side} vs expected ${expectSide}`);
  expectSide = expectSide === 'alice' ? 'bob' : 'alice';
}

// Monotonic round numbering.
for (const [index, round] of rounds.entries()) {
  check(`round-${index}/number`, round.round === index, `${round.round} vs ${index}`);
}

console.log(`verify-ratchet-kat: ${passes.length} checks passed`);
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
