import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Row 6b. The shared-address gate in the chain check asked this device's rails
// with the order's own currency, and the rails are a fresh { btc, xmr } literal,
// so a coin name like 'constructor' or '__proto__' reached the prototype and
// answered with something that is not an address. The fix is one line, and it
// lives inside a React hook that has no unit seam: this test therefore checks
// the SHAPE of that line in the source, not its behaviour. It is not evidence
// that a hostile currency is refused; the browser spec
// (tests/ui/row6b-shared-address.spec.js) reads the screen for that. What this
// test does prove is revert-identity: putting the bare index back reddens it.
//
// The source is whitespace-normalised before matching, so a reformat, a line
// wrap or a quote change does not fail it — only a change in the lookup does.

const SOURCE = readFileSync(new URL('./useCommerce.js', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ')
  .replace(/\(\s+/g, '(')
  .replace(/\s+\)/g, ')')
  .replace(/\[\s+/g, '[')
  .replace(/\s+\]/g, ']');

test('row 6b: the shared-address lookup is guarded by Object.hasOwn, not a bare index', () => {
  assert.match(
    SOURCE,
    /const rails = readPaymentAddresses\(\); const shared = Object\.hasOwn\(rails, currency\) \?/,
    // The compare below is quote-tolerant on purpose: '' and "" are the same
    // line, and a quote change is not a revert. This is why the guarded-form
    // match allows either.
    'row 6b: the shared-address lookup no longer reads the rails through Object.hasOwn — a bare index hands a prototype member back for a coin name like "constructor"',
  );
  assert.match(
    SOURCE,
    /String\(rails\[currency\] \|\| (?:''|""|null|undefined)\)/,
    'row 6b: the guarded lookup no longer reads the rails value as a string with an empty fallback',
    'row 6b: the shared-address lookup no longer reads the rails through Object.hasOwn — a bare index hands a prototype member back for a coin name like "constructor"',
  );
});

test('row 6b: no bare readPaymentAddresses()[currency] indexing survives in the file', () => {
  assert.equal(
    /readPaymentAddresses\(\)\s*\[/.test(SOURCE),
    false,
    'row 6b: a bare readPaymentAddresses()[…] index is back in useCommerce.js — the rails are a { btc, xmr } literal and any other key reaches the prototype',
  );
});

// Row 19c-s. The confirm-payment catch used to hand the error's own message
// straight to the toast, with no fallback sentence: `message: error.message`
// can render nothing at all, and the string can name a value the card's
// sender authored (orderState interpolates the order status). Shape, not
// behaviour — what a person sees there is the screen's, not this file's.
test('row 19c-s: the payment-state refusal speaks this device\'s words, never the error\'s', () => {
  assert.equal(
    /message: error\.message/.test(SOURCE),
    false,
    'row 19c-s: a toast is back to printing the error\'s own message — on the money path that can be empty text, or a string naming a value the card\'s sender authored',
  );
  assert.match(
    SOURCE,
    /message: 'The payment was not marked seen\. This device could not read the order\. Try again; if it keeps failing, reload and try once more\.'/,
    'row 19c-s: the payment-state refusal no longer says what did not happen in this device\'s own words',
  );
});
