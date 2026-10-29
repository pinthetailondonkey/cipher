import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The UI-word, layer and color guards (MASTER-PROMPT §0 + §15). Words only —
// these tests never look at how the copy is styled.
const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const codeFiles = walk(SRC).filter((file) => /\.(js|jsx)$/.test(file));
const rel = (file) => path.relative(SRC, file);

// Strings owned by the §0 read-only contracts, plus the hosts registry and
// the identity/passkey hook (§10 keeps identity.* untouched). Their internal
// protocol words — relay tags, kind names, wire headers — are not UI copy;
// the scan skips the whole file rather than freeze stepping on rewrites of
// logic that must never leak into user-facing text.
const PROTOCOL_FILES = new Set([
  'lib/egress.js', // hosts registry: sanctioned uses of the words by contract
  'hooks/useNIP44DM.js',
  'hooks/useNIP29Group.js',
  'lib/crypto/groupCipher.js',
  'lib/crypto/groupKeyGrant.js',
  'lib/crypto/groupKeyMember.js',
  'lib/crypto/memberBaseline.js',
  'lib/crypto/groupKeyRequest.js',
  'lib/crypto/groupMembership.js',
  'lib/crypto/groupKeyInstall.js',
  'lib/crypto/groupKeyDistribution.js',
  'lib/escrowFsm.js',
  'lib/escrowScript.js',
  'lib/escrowPsbt.js',
  'lib/escrowActions.js',
  'features/chat/useCommerce.js',
  'lib/orderMembrane.js',
  'lib/paymentState.js',
  'lib/vendorPayments.js',
  'lib/paymentWatch.js',
  'lib/proofOfTrade.js',
  'lib/orderActions.js',
  'store/chatStore.js',
  'lib/haptics.js',
  'lib/privacy.js',
  'useIdentity.js', // identity/restore contract layer: event tags and passkey wire strings, never rendered
]);

// A line can also mark itself exempt when the string is wire format, not
// words a person sees. Two strings today: the Blossom upload header and the
// scanned-code scheme strip in lib/npub.js.
const LINE_WAIVER = 'not UI copy';

// Module specifiers are imports, not prose: `nostr-tools` is a package name.
const MODULE_SPECIFIER = /(?:from|import)\s*\(?\s*['"]nostr/;

// UI copy starts after a quote or a JSX text boundary; mid-string matches
// (comments, identifiers, tag arrays) stay out of scope on purpose so the
// guard stays honest instead of noisy. Seams this leaves open are recorded
// in docs/UI-NOTES.md.
const WORD_BAN = /(?:>|`|"|')\s*(?:nostr:|nostr|private key|seed|relay)\b/i;

test('no banned word opens a UI string, anywhere in src', () => {
  const hits = [];
  for (const file of codeFiles) {
    const fileRel = rel(file);
    if (file.endsWith('.test.js') || file.endsWith('.test.jsx')) continue;
    if (PROTOCOL_FILES.has(fileRel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i, lines) => {
      if (!WORD_BAN.test(line)) return;
      if (MODULE_SPECIFIER.test(line)) return;
      if (line.includes(LINE_WAIVER) || lines[i - 1]?.includes(LINE_WAIVER)) return;
      hits.push(`${fileRel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

// Reaction emoji are content — the seven choices a message can carry — not
// labels; the REACTION choices list in MessageBubble stays. Everything else
// in components must stay emoji-free: the voice rules ban emoji in labels.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const EMOJI_IN_STRING = /(['"`])(?:(?!\1)[^\n\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

test('no emoji sits inside a component or screen string', () => {
  const scan = codeFiles.filter((file) => {
    const fileRel = rel(file);
    const isTopScreen = /^[A-Z][a-zA-Z]*\.jsx$/.test(fileRel);
    return fileRel.startsWith('components/') || isTopScreen;
  });
  const hits = [];
  for (const file of scan) {
    if (file.endsWith('.test.js') || file.endsWith('.test.jsx')) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!EMOJI.test(line)) return;
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) return; // comments allowed: no label spoken
      if (/REACTION_CHOICES/.test(line)) return; // reaction emoji are content, not labels
      if (line.includes(LINE_WAIVER)) return;
      if (!EMOJI_IN_STRING.test(line)) return; // bare tick glyphs outside strings stay readable
      hits.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

// Layers: only the four tokens from §1 — z-fab, z-sheet, z-call, z-toast —
// may appear in JSX. No numeric utilities, no bracketed numerals; PR1 rides
// on the same rule, so parallel lanes compose instead of colliding.
const Z_LITERAL = /(?:^|[\s"'`:])z-(?:\[\d+\]|\d+)\b/;

test('no zIndex literal or utility in JSX — only z-fab / z-sheet / z-call / z-toast', () => {
  const hits = [];
  for (const file of codeFiles) {
    if (!file.endsWith('.jsx')) continue;
    if (file.endsWith('.test.jsx')) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!Z_LITERAL.test(line)) return;
      if (line.includes(LINE_WAIVER)) return;
      hits.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

// Color: zero hex in JSX. Tokens live in index.css; the one sanctioned
// helper is the group-name palette (PR5), which must carry the marker line
// "sanctioned name-color palette" to be exempt.
const HEX = /#[0-9a-fA-F]{6}\b/;

test('no hex color literal in JSX — tokens live in index.css', () => {
  const hits = [];
  for (const file of codeFiles) {
    if (!file.endsWith('.jsx')) continue;
    if (file.endsWith('.test.jsx')) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('sanctioned name-color palette')) continue;
    source.split('\n').forEach((line, i) => {
      if (!HEX.test(line)) return;
      if (line.includes(LINE_WAIVER)) return;
      hits.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

// The payment-record refusal. Two laws, because both failed once:
//   1. It leads with what the vendor needs — "Nothing was confirmed." — so the
//      first words are the true fact, not the diagnosis.
//   2. It never sends anyone to a destructive repair. The string it replaced
//      said "Reinstall or clear this app's storage", which destroys the
//      receipts the refusal exists to protect. A sentence that BEGINS with
//      "Reinstall" is the instruction shape; the warning tells people NOT to.
// The surface that shows this string on a phone currently truncates it to one
// line; that is a separate item and does not change the words.

// Two other refusals (taken, undated) also end with the same four words, so
// the selector is the whole opening phrase, not the fragment.
const UNREADABLE_REFUSAL_LINE = /'Nothing was confirmed\. This device could not read its payment record/;

test('the payment-record refusal leads with the fact and names what a wipe costs', () => {
  const source = fs.readFileSync(path.join(SRC, 'features/chat/useCommerce.js'), 'utf8');
  const lines = source.split('\n').filter((line) => UNREADABLE_REFUSAL_LINE.test(line));
  assert.equal(lines.length, 1, 'exactly one refusal carries this opening');
  const quoted = lines[0].match(/'((?:[^'\\]|\\.)*)'/);
  assert.ok(quoted, 'the refusal is a plain string literal');
  const message = quoted[1].replace(/\\'/g, "'");

  assert.ok(message.startsWith('Nothing was confirmed.'), `the fact opens it: ${message}`);
  assert.match(message, /could not read its payment record/, 'it says reading failed, not that the record is damaged');
  assert.match(message, /don't reinstall or clear the app's data/i, 'it names the destructive action and refuses it');
  assert.match(message, /12-word recovery phrase restores the account only/, 'it says what the phrase does and does not bring back');
  assert.doesNotMatch(message, /\bbalance\b/i, 'it promises nothing about a wallet balance');
  assert.doesNotMatch(message, /\b(damaged|corrupt)\b/i, 'a failed read does not prove damage');
});

// The persistent half. The toast is one line and four seconds, so the refusal
// also lives on the order card. That block must say the fact, refuse the wipe,
// name no repair that does not exist, and leave nothing to press. Words only:
// this law never looks at the block's styling.
test('the order-card refusal states the dead end and offers no repair', () => {
  const source = fs.readFileSync(path.join(SRC, 'components/MessageBubble.jsx'), 'utf8');
  const start = source.indexOf('The check could not run');
  assert.ok(start !== -1, 'the block is on the card');
  const block = source.slice(start, start + 1200);
  assert.match(block, /Nothing was confirmed\./, 'it opens with the true fact');
  assert.match(block, /could not read its payment record/, 'it says reading failed');
  assert.match(block, /Nothing on this screen repairs that record/, 'it states the dead end plainly');
  assert.match(block, /restores the account only/, 'it keeps the phrase limit and does not promise the receipts back');
  assert.match(block, /clearing or reinstalling the app would take those receipts/, 'it warns about the wipe instead of ordering one');
  assert.doesNotMatch(block, /<button/i, 'a dead end dressed as a button is not a dead end');
  assert.doesNotMatch(block, /\bbalance\b/i, 'it promises nothing about a wallet balance');
  assert.doesNotMatch(block, /\b(damaged|corrupt)\b/i, 'a failed read does not prove damage');
});

// What this catches, measured rather than assumed: "Reinstall or clear the app
// to fix it." is caught; "You should reinstall or clear the app to fix it." and
// "If this persists, reinstall the app." are NOT, because the banned phrase
// must open a sentence or a quoted string. It is the instruction shape, not
// the whole class — the name says exactly that much and no more. Widening it
// is a separate decision, not something a rename should quietly do.
test('no UI string opens by ordering a person to reinstall or clear the app', () => {
  const hits = [];
  for (const file of codeFiles) {
    const fileRel = rel(file);
    if (file.endsWith('.test.js') || file.endsWith('.test.jsx')) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // The instruction shape: a sentence that starts with "Reinstall".
      if (!/(?:^|[.!?]\s+|['"`]\s*)Reinstall or clear\b/.test(line)) return;
      if (line.includes(LINE_WAIVER)) return;
      hits.push(`${fileRel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
