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
const CHECKOUT_SHEET = readFileSync(new URL('../../components/OneTapCheckout.jsx', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ');

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

test('the checkout callback reports failed, queued, or relay-accepted sends from sendOutcome', () => {
  assert.match(SOURCE, /const outcome = sendOutcome\(result\)/,
    'checkout uses the shared send classifier');
  assert.match(SOURCE, /if \(outcome !== 'sent' && outcome !== 'queued'\)/,
    'a refused or malformed write is rolled back');
  assert.match(SOURCE, /return \{ outcome: 'failed', error \}/,
    'the sheet receives a failure instead of mistaking undefined for success');
  assert.match(SOURCE, /return \{ outcome: confirmedMessage\.deliveryStatus === 'queued' \? 'queued' : 'sent' \}/,
    'the sheet receives the persisted delivery state');
  assert.match(SOURCE, /openChat\('dm', vendorPubkey\)/,
    'the thread opens after the write result is known');
  assert.doesNotMatch(SOURCE, /setCheckoutProduct\(null\)/,
    'the shared checkout stays mounted long enough to show the outcome');
});

test('chain checks capture the active incarnation and recheck after the watcher before local effects', () => {
  const branch = SOURCE.slice(SOURCE.indexOf("if (action === 'check_chain')"), SOURCE.indexOf("if (action === 'mark_shipped')"));
  assert.match(branch, /const securityFence = identity\?\.securityFence/);
  assert.match(branch, /const assertCurrent = \(\) => \{ assertSecurityContextOwner\(securityFence, identity\?\.pk\)/);
  assert.match(branch, /const outcome = await runPaymentCheck\([\s\S]*?\); assertCurrent\(\); if \(outcome\.short\)/);
  assert.match(branch, /assertCurrent\(\); if \(!scopedSetVerified\(`receipt_\$\{msg\.id\}`, receipt\)\)/);
  assert.match(branch, /assertCurrent\(\); if \(!scopedSetVerified\('consumed_txids', nextLedger\)\)/);
  assert.match(branch, /await deliverOrderUpdate\([\s\S]*?securityFence,/);
});

test('payment order updates recheck the supplied context after sending and before local persistence', () => {
  assert.match(SOURCE, /const deliverOrderUpdate = async \([\s\S]*?securityFence = identity\?\.securityFence\) => \{ let result; try \{ assertSecurityContextOwner\(securityFence, identity\?\.pk\); result = await sendDM\([\s\S]*?assertSecurityContextOwner\(securityFence, identity\?\.pk\);/);
  // Own-row persistence sits between the post-send recheck and the saved
  // patch; its inner try keeps a fence assert of its own, then control
  // returns to the original before-persist check ahead of updateLocalOrder.
  assert.match(SOURCE, /assertSecurityContextOwner\(securityFence, identity\?\.pk\); \/\/ Persist this device's own sent update row under the rumor id[\s\S]*?await saveMessage\(peer, ownRow\); assertSecurityContextOwner\(securityFence, identity\?\.pk\);[\s\S]*?\} catch \(rowError\)[\s\S]*?\} const saved = await updateLocalOrder\(peer, payload\.orderId, localPatch\); assertSecurityContextOwner\(securityFence, identity\?\.pk\);/);
});

test('order acceptance, delivery-note access, and local order patches retain the action incarnation', () => {
  assert.match(SOURCE, /const updateLocalOrder = async \([\s\S]*?assertSecurityContextOwner\(securityFence, identity\?\.pk\); useChatStore\.getState\(\)\.setDms[\s\S]*?const saved = await patchMessage\(orderId, updateData\); assertSecurityContextOwner\(securityFence, identity\?\.pk\);/);
  const note = SOURCE.slice(SOURCE.indexOf("if (action === 'open_delivery_note')"), SOURCE.indexOf("if (!['accept_order'"));
  assert.match(note, /await getAuthenticatedPool\(identity\); assertSecurityContextOwner\(securityFence, identity\?\.pk\)/);
  assert.match(note, /await openDeadDropNote\([\s\S]*?assertSecurityContextOwner\(securityFence, identity\?\.pk\)/);
  const acceptance = SOURCE.slice(SOURCE.indexOf("if (action === 'accept_order')"), SOURCE.indexOf("if (action === 'decline_order'"));
  assert.match(acceptance, /await loadVendorPaymentConfig\(identity\); assertCurrent\(\)/);
  assert.match(acceptance, /await getOrderPaymentMethods\([\s\S]*?assertCurrent\(\)/);
  assert.match(acceptance, /await sendDM\(msg\.pubkey, payload\); assertCurrent\(\)/);
});

test('checkout and product-send callbacks fence async completion before UI effects', () => {
  const checkout = SOURCE.slice(SOURCE.indexOf('const sendCheckoutOrder = async'), SOURCE.indexOf('// Keep the delivery-note checkout'));
  assert.match(checkout, /securityFence = requireIdentityFence\(\)/);
  assert.match(checkout, /await saveMessage\(vendorPubkey, optimisticMessage\); securityFence\.assertCurrent\(\)/);
  assert.match(checkout, /await sendDM\(vendorPubkey, payload, tempId\); securityFence\.assertCurrent\(\)/);
  assert.match(checkout, /securityFence\.assertCurrent\(\); setDms\([\s\S]*?openChat\('dm', vendorPubkey\)/);
  const edited = SOURCE.slice(SOURCE.indexOf('const handleSaveEditedProduct'), SOURCE.indexOf('const handleBroadcastSubmit'));
  assert.match(edited, /await sendGroupMessage\([\s\S]*?securityFence\.assertCurrent\(\)/);
  assert.match(edited, /await sendDM\(activeDm, payload\); securityFence\.assertCurrent\(\)/);
  const broadcastStart = SOURCE.indexOf('const handleBroadcastSubmit');
  const broadcast = SOURCE.slice(broadcastStart, SOURCE.indexOf('return {', broadcastStart));
  assert.match(broadcast, /await Promise\.allSettled\([\s\S]*?\); securityFence\.assertCurrent\(\)/);
  assert.match(CHECKOUT_SHEET, /const securityFence = identity\?\.securityFence;[\s\S]*?const pool = await getAuthenticatedPool\(identity\); assertSecurityContextOwner\(securityFence, identity\?\.pk\)/);
  assert.match(CHECKOUT_SHEET, /await createDeadDropNote\([\s\S]*?assertSecurityContextOwner\(securityFence, identity\?\.pk\); const result = await onConfirmOrder/);
});
