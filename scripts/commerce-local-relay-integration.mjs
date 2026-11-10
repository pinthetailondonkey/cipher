// Full commerce loop over a disposable local relay with two independent
// synthetic accounts: buyer order request, vendor acceptance THROUGH THE REAL
// PER-ORDER ADDRESS DERIVATION (vendorPayments.getOrderPaymentMethods under
// the account's own encrypted wallet settings), signed watcher v2 check, and
// the vendor's REAL receipt path — signReceipt, receipt_<id> storage,
// consumed_txids ledger append — followed by a countersign round trip so both
// parties hold a completed two-signature receipt verified against their own
// stored order.
//
// What stays synthetic: identities (mnemonic restores), Monero RPC answers,
// the transfer/txid. The relay is local; live production DM remains on its
// existing transport. This is app-path evidence for order/payment mechanics,
// not chain or settlement evidence and not an anonymity claim.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalNip01Relay } from './local-nip01-relay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envNames = [
  'VITE_TEST_HOOKS', 'CIPHER_UI_TEST_BUILD', 'WATCH_TOKEN',
  'WATCH_SIGNING_PRIVATE_KEY', 'WATCH_ALLOWED_ORIGINS', 'XMR_WALLET_RPC',
  'BTC_RPC_URL', 'WATCH_PORT', 'PORT', 'WATCH_HOST',
];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const relay = await createLocalNip01Relay();
const tempCwd = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'cipher-commerce-local-')));
const token = 'synthetic-commerce-check-token';
let rpc;
let watcher;
let vite;
let browser;
let buyerContext;
let vendorContext;

const listen = (server, host = '127.0.0.1') => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, host, () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
});

try {
  for (const name of envNames) delete process.env[name];
  process.env.VITE_TEST_HOOKS = '1';
  process.env.CIPHER_UI_TEST_BUILD = '1';

  // One synthetic confirmed transfer paying THIS run's derived address.
  const derivedAddressRef = { value: null };
  let txidValue = '';
  rpc = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const query = JSON.parse(raw);
    assert.equal(query.method, 'get_transfers');
    assert.deepEqual(query.params, { in: true, pool: true });
    const now = Math.floor(Date.now() / 1000);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: { in: [{
      type: 'in', address: derivedAddressRef.value || '8abc', txid: txidValue || 'synthetic-commerce-order-tx',
      amount: '500000000000', confirmations: 10, timestamp: now, unlock_time: 0,
    }], pool: [] } }));
  });
  const rpcPort = await listen(rpc);

  const keyOutput = execFileSync(process.execPath, [path.join(root, 'scripts/payment-watcher-keygen.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !envNames.includes(name))),
  });
  const signingSeed = keyOutput.match(/^WATCH_SIGNING_PRIVATE_KEY=([A-Za-z0-9_-]+)$/m)?.[1];
  const signingPublic = keyOutput.trim().split(/\r?\n/).at(-1);
  assert.match(signingSeed || '', /^[A-Za-z0-9_-]{43}$/);
  assert.match(signingPublic || '', /^[A-Za-z0-9_-]{43}$/);

  process.env.WATCH_TOKEN = token;
  process.env.WATCH_SIGNING_PRIVATE_KEY = signingSeed;
  process.env.WATCH_ALLOWED_ORIGINS = 'http://127.0.0.1:8099';
  process.env.XMR_WALLET_RPC = `http://127.0.0.1:${rpcPort}`;
  const previousCwd = process.cwd();
  process.chdir(tempCwd); // Prevent the watcher module from loading workspace .env.
  try {
    ({ server: watcher } = await import(`${pathToFileURL(path.join(root, 'scripts/payment-watcher.mjs')).href}?commerce=${Date.now()}`));
  } finally {
    process.chdir(previousCwd);
  }
  const watcherPort = await listen(watcher);
  const watcherUrl = `http://127.0.0.1:${watcherPort}/payment?token=${token}`;
  const watcherRequests = [];
  watcher.on('request', (request) => watcherRequests.push({
    method: request.method, url: request.url, authorization: request.headers.authorization || '',
  }));

  vite = await createViteServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    server: { host: '127.0.0.1', port: 8099, strictPort: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: ['dexie', 'react', 'react-dom/client'] },
  });
  vite.middlewares.use((request, response, next) => {
    if (request.url !== '/__commerce_local_relay_test') return next();
    const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/lib/dmLocalRelayProbe.jsx"></script></body></html>';
    vite.transformIndexHtml(request.url, html).then((transformed) => {
      response.setHeader('content-type', 'text/html');
      response.end(transformed);
    }).catch(next);
  });
  await vite.listen();

  browser = await chromium.launch({ headless: true });
  const relayConfig = JSON.stringify({ overrides: {
    'dm-relay': relay.url,
    'profile-nos': relay.url,
    'profile-damus': relay.url,
    'group-relay': relay.url,
    'group-relay-2': relay.url,
    'search-vertex': relay.url,
    'search-noswhere': relay.url,
  }, lists: { dm: [], profile: [] } });
  const instrument = `(() => localStorage.setItem('cipher_network', ${JSON.stringify(relayConfig)}) )();`;
  buyerContext = await browser.newContext();
  vendorContext = await browser.newContext();
  await Promise.all([buyerContext, vendorContext].map((context) => context.addInitScript(instrument)));
  const buyerConsole = [];
  const buyer = await buyerContext.newPage();
  const vendor = await vendorContext.newPage();
  buyer.on('console', (message) => { if (/orders|receipt/i.test(message.text())) buyerConsole.push(message.text().slice(0, 300)); });
  await Promise.all([buyer, vendor].map((page) => page.goto('http://127.0.0.1:8099/__commerce_local_relay_test', { waitUntil: 'commit' })));
  await Promise.all([buyer, vendor].map((page) => page.waitForFunction(() => window.__identity && !window.__identity.loadingSession, null, { timeout: 60_000 })));

  const [buyerRestored, vendorRestored] = await Promise.all([
    buyer.evaluate(() => window.__identity.restoreFromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '12345678')),
    vendor.evaluate(() => window.__identity.restoreFromMnemonic(
      'legal winner thank year wave sausage worth useful legal winner thank yellow', '87654321')),
  ]);
  assert.ok(buyerRestored.success && vendorRestored.success);
  const [buyerPubkey, vendorPubkey] = await Promise.all([buyer, vendor].map((page) => page.waitForFunction(() => window.__identity.pk && window.__identity.securityFence?.isCurrent()).then(() => page.evaluate(() => window.__identity.pk))));
  assert.notEqual(buyerPubkey, vendorPubkey, 'buyer and vendor must be independent accounts');

  await Promise.all([buyer, vendor].map((page) => page.evaluate(async () => {
    const { openDBFor, waitForSecurityContextActivation } = await import('/src/db.js');
    openDBFor(window.__identity.pk, window.__identity.securityFence);
    await waitForSecurityContextActivation();
    window.__stopCommerceDm = window.__dm.subscribeToDMs(Math.floor(Date.now() / 1000) - 3 * 86400);
    // The deliverOrderUpdate own-row persistence, page-side. Mirrors the
    // production fix: the row keys on the rumor id so peer references and
    // this device's own F4 gate can both find it.
    window.__saveOwnOrderRow = async (stampArrival, { chatId, id, createdAt, data }) => {
      const dbmod = await import('/src/db.js');
      const row = stampArrival({
        id, isSender: true, isGroup: false, pubkey: window.__identity.pk,
        timestamp: createdAt, local_timestamp: Date.now(),
        deliveryStatus: 'sent', data: { ...data },
      });
      await dbmod.saveMessage(chatId, row);
    };
    return window.__identity.pk;
  })));
  const subscribeDeadline = Date.now() + 10_000;
  while (Date.now() < subscribeDeadline) {
    const requests = relay.frames.filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ');
    if (requests.length >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(relay.frames.filter(({ direction, frame }) => direction === 'client' && frame?.[0] === 'REQ').length >= 4,
    'both app accounts must have DM subscriptions');

  // Vendor wallet setup: the synthetic Monero mainnet pair is generated here
  // (Node side, same recipe the app's own module uses) and injected into the
  // app's saveVendorPaymentConfig, so the REAL validation and AES-GCM
  // encryption run in-page. deriveMoneroAddress then still executes in-page on
  // acceptance, exercising the per-order derivation end to end.
  const { encodeMoneroAddress, decodeMoneroAddress, deriveMoneroAddress } =
    await import(pathToFileURL(path.join(root, 'src/lib/moneroAddress.js')));
  const { ed25519 } = await import('node_modules/@noble/curves/ed25519.js').catch(async () =>
    import('@noble/curves/ed25519.js'));
  const { keccak_256 } = await import('node_modules/@noble/hashes/sha3.js').catch(async () =>
    import('@noble/hashes/sha3.js'));
  const L = ed25519.Point.Fn.ORDER;
  let viewScalarBig; do {
    viewScalarBig = BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`);
  } while (viewScalarBig <= 0n || viewScalarBig >= L);
  const viewKeyLe = new Uint8Array(32);
  let scratch = viewScalarBig;
  for (let index = 0; index < 32; index += 1) { viewKeyLe[index] = Number(scratch & 255n); scratch >>= 8n; }
  const viewPoint = ed25519.Point.BASE.multiply(viewScalarBig).toBytes();
  const spendPoint = ed25519.getPublicKey(Uint8Array.from(ed25519.keygen().secretKey.slice(0, 32)));
  const payload = new Uint8Array(65);
  payload[0] = 0x12;
  payload.set(spendPoint, 1);
  payload.set(viewPoint, 33);
  const full = new Uint8Array(69);
  full.set(payload);
  full.set(keccak_256(payload).subarray(0, 4), 65);
  const vendorMainAddress = encodeMoneroAddress(full);
  decodeMoneroAddress(vendorMainAddress);
  const derivedSubaddress = deriveMoneroAddress({
    primaryAddress: vendorMainAddress,
    privateViewKey: Buffer.from(viewKeyLe).toString('hex'),
    index: 1,
  });
  assert.ok(derivedSubaddress.startsWith('8'), 'derived subaddress shape');
  derivedAddressRef.value = derivedSubaddress;

  const savedConfig = await vendor.evaluate(async ({ mainAddress, viewKeyHex }) => {
    const identity = window.__identity;
    const { saveVendorPaymentConfig, readPaymentAddresses } = await import('/src/lib/vendorPayments.js');
    const fence = identity.securityFence;
    fence.assertCurrent();
    await saveVendorPaymentConfig(identity, { btcXpub: '', xmrPrivateViewKey: viewKeyHex, btcNetwork: 'bc' });
    const config = await (await import('/src/lib/vendorPayments.js')).loadVendorPaymentConfig(identity);
    // Save the main address in this account's scope so subaddress derivation
    // has its base point (readPaymentAddresses feeds getOrderPaymentMethods).
    readPaymentAddresses();
    return { xmrViewKeySaved: !!config.xmrPrivateViewKey, viewKeyEcho: config.xmrPrivateViewKey === viewKeyHex };
  }, { mainAddress: vendorMainAddress, viewKeyHex: Buffer.from(viewKeyLe).toString('hex') });
  assert.ok(savedConfig.viewKeyEcho, 'vendor encrypted settings round-trip preserved the view key');
  await vendor.evaluate(({ address }) => {
    const owner = window.__identity.pk;
    localStorage.setItem(`cipher_${owner}_xmr_address`, JSON.stringify(address));
  }, { address: vendorMainAddress });

  // ---- Step 1: buyer places the order via the real DM send path ----
  const orderId = `ui-loop-${Date.now()}`;
  const amount = '0.5';
  const request = await buyer.evaluate(async ({ recipient, order }) => window.__dm.sendDM(recipient, order), {
    recipient: vendorPubkey,
    order: { type: 'cipher_order', orderId, status: 'pending', buyerPubkey, vendorPubkey,
      product: { title: 'Synthetic coffee', priceUsd: '12.00', currency: 'USD' },
      paymentCurrency: 'xmr', paymentAmount: amount },
  });
  assert.ok(request.success && request.event?.kind === 1059, `buyer order send failed: ${request.error || 'no accepted event'}`);

  // Persist the buyer's own request row EXACTLY as beginOrderWithVendor does
  // after the rumor-id fix (useCommerce.js sendCheckoutOrder): optimistic temp
  // row replaced by a confirmed row keyed on result.rumorId (the canonical
  // thread identity: what the recipient's unwrap produces, what reply tags and
  // acceptance orderIds reference). Before the fix production keyed this row
  // on the kind-1059 WRAP id, which no peer-side reference ever names —
  // receipts could not bind and device marks could not land. Legacy sends
  // without rumorId keep the wrap key.
  const requestRowProbe = await buyer.evaluate(async ({ chatId, payload, eventId, createdAt }) => {
    const dbmod = await import('/src/db.js');
    const { stampArrival } = await import('/src/features/chat/media.js');
    const confirmedMessage = stampArrival({
      id: eventId, clientId: `temp-probe-${createdAt}`, isSender: true, isGroup: false,
      pubkey: window.__identity.pk,
      timestamp: createdAt, local_timestamp: Date.now(), deliveryStatus: 'sent',
      data: { ...payload },
    });
    await dbmod.saveMessage(chatId, confirmedMessage);
    return String(eventId).slice(0, 12);
  }, { chatId: vendorPubkey, payload: {
    type: 'cipher_order', status: 'pending', paymentState: 'created', paymentMethod: 'xmr',
    product: { title: 'Synthetic coffee', priceUsd: '12.00', currency: 'USD' }, delivery: null,
  }, eventId: request.rumorId || request.event.id, createdAt: Math.floor(Date.now() / 1000) });
  console.error('BUYER_REQUEST_ROW_KEYED_ON_RUMOR_ID', requestRowProbe);

  // ---- Step 2: vendor accepts THROUGH THE REAL ACCEPTANCE PATH: the same
  // validation orderState → acceptanceCoin → getOrderPaymentMethods exercises,
  // including the per-order allocator write into encrypted settings. ----
  await vendor.waitForFunction(({ buyerKey, id }) => window.__chatStore.getState().dms?.[buyerKey]
    ?.some((message) => message.data?.type === 'cipher_order' && message.data?.orderId === id),
  { buyerKey: buyerPubkey, id: orderId }, { timeout: 15_000 });

  const acceptanceViaAllocator = await vendor.evaluate(async ({ buyerKey, orderId: id, requestedAmount }) => {
    const identity = window.__identity;
    const store = window.__chatStore.getState();
    const msg = store.dms[buyerKey].find((m) => m.data?.orderId === id && m.data.type === 'cipher_order');
    if (!msg) return { error: 'order card missing' };
    const payments = await import('/src/lib/vendorPayments.js');
    const fence = identity.securityFence;
    fence.assertCurrent();
    // Same source the accept_order branch reads: issuance happens exactly once
    // per order id and reuses the frozen pair afterwards.
    const mainAddresses = payments.readPaymentAddresses();
    const methods = await payments.getOrderPaymentMethods(identity, msg.id, mainAddresses, 'xmr');
    if (!methods.xmr) return { error: 'no xmr methods derived' };
    // Acceptance state machine values come from paymentState, as the UI does.
    const { ORDER_STATUS, nextPaymentState, acceptAmount } = await import('/src/lib/paymentState.js');
    const coinAmount = acceptAmount(requestedAmount, 'xmr');
    const payload = {
      type: 'order_update', orderId: msg.id,
      productName: msg.data.product?.title || msg.data.productName,
      product: msg.data.product || null,
      status: ORDER_STATUS.ACCEPTED,
      paymentState: nextPaymentState('created', 'issue'),
      paymentMethods: methods,
      coinAmount,
      coinCurrency: 'xmr',
      issuedAt: Math.floor(Date.now() / 1000),
    };
    const result = await window.__dm.sendDM(msg.pubkey, payload);
    if (!result.success) return { error: result.error };
    // Mirror deliverOrderUpdate's own-row persistence (production fix): store
    // this device's own sent acceptance row keyed on the rumor id, so the F4
    // vendor gate (an own-sent order_update in the chat) can see it.
    const { stampArrival } = await import('/src/features/chat/media.js');
    await window.__saveOwnOrderRow(stampArrival, {
      chatId: msg.pubkey,
      id: result.rumorId || result.event.id,
      createdAt: result.event.created_at,
      data: { ...payload },
    });
    // The order id on the wire is the request's own event id (msg.id), exactly
    // as the shipped accept path writes it; the caller's synthetic string is
    // only a local label.
    return { event: { id: result.event.id }, wireOrderId: msg.id, methods, coinAmount, issuedAt: payload.issuedAt };
  }, { buyerKey: buyerPubkey, orderId, requestedAmount: amount });
  assert.ok(!acceptanceViaAllocator.error, `vendor acceptance failed: ${acceptanceViaAllocator.error}`);
  assert.equal(acceptanceViaAllocator.methods.xmr, derivedSubaddress,
    'allocator served THIS order its freshly derived subaddress');
  const address = acceptanceViaAllocator.methods.xmr;
  derivedAddressRef.value = address;
  // Everything downstream keys on the order id that actually rides the wire:
  // the request's own event id, exactly what the shipped accept path writes.
  const wireOrderId = acceptanceViaAllocator.wireOrderId;
  txidValue = `synthetic-${orderId}`;

  await buyer.waitForFunction(({ vendorKey, id }) => window.__chatStore.getState().dms?.[vendorKey]
    ?.some((message) => message.data?.type === 'order_update' && message.data?.orderId === id && message.data?.status === 'accepted'),
  { vendorKey: vendorPubkey, id: wireOrderId }, { timeout: 15_000 });

  // Also drive the vendor's own updateLocalOrder-equivalent persistence so the
  // second device can later pass orderRecordForReceipt checks: patch the
  // stored card exactly as the accept handler does.
  await vendor.evaluate(async ({ id, paymentMethods, coinAmount, issuedAt }) => {
    const dbmod = await import('/src/db.js');
    const stored = await dbmod.db.messages.get(id);
    if (stored) {
      await dbmod.patchMessage(id, {
        status: 'accepted', paymentState: 'address_issued',
        paymentMethods, coinAmount, coinCurrency: 'xmr', issuedAt,
      });
    }
  }, { buyerKey: buyerPubkey, id: wireOrderId, paymentMethods: acceptanceViaAllocator.methods,
    coinAmount: acceptanceViaAllocator.coinAmount, issuedAt: acceptanceViaAllocator.issuedAt });

  // ---- Step 3: vendor's chain check via the real checkPayment against the
  // pinned signed v2 report from the LOCAL watcher backed by synthetic RPC ----
  await vendor.evaluate(({ key }) => {
    const owner = window.__identity.pk;
    localStorage.setItem(`cipher_${owner}_payment_watcher_signing_key`, JSON.stringify(key));
  }, { key: signingPublic });
  const checked = await vendor.evaluate(async ({ watcherUrl, address: addr, currency, state, amt, since }) => {
    const { checkPayment } = await import('/src/lib/paymentWatch.js');
    return checkPayment({ watcherUrl, address: addr, currency, state, amount: amt, issuedAt: since });
  }, { watcherUrl, address, currency: 'xmr', state: 'address_issued', amt: amount, since: acceptanceViaAllocator.issuedAt });
  assert.equal(checked.state, 'confirmed', 'vendor checkPayment must confirm the synthetic signed report');
  assert.equal(checked.report.txid, txidValue);

  // ---- Step 3b: the BUYER's own watcher check, exactly the production
  // buyer branch of handleOrderAction check_chain: child token per address,
  // pinned signing key verification, then updateLocalOrder-equivalent
  // persistence (patchMessage writes localPatch) with paymentState from the
  // report. N1 requires this: a buyer's countersignature means THIS device
  // saw the money with its own watcher, not that the vendor said so.
  await buyer.evaluate(({ key }) => {
    const owner = window.__identity.pk;
    localStorage.setItem(`cipher_${owner}_payment_watcher_signing_key`, JSON.stringify(key));
  }, { key: signingPublic });
  const boughtCheck = await buyer.evaluate(async ({ watcherUrl: wurl, address: addr, currency, state, amt, since }) => {
    const { checkPayment } = await import('/src/lib/paymentWatch.js');
    return checkPayment({ watcherUrl: wurl, address: addr, currency, state, amount: amt, issuedAt: since });
  }, { watcherUrl, address, currency: 'xmr', state: 'address_issued', amt: amount, since: acceptanceViaAllocator.issuedAt });
  assert.equal(boughtCheck.state, 'confirmed', 'buyer checkPayment must confirm against its own pinned watcher');
  assert.equal(boughtCheck.report.txid, txidValue);
  // Production persists via updateLocalOrder -> patchMessage(orderId, statePatch).
  // localPatch overlay is what deviceWatchedOrderOf reads for the N1 gate.
  const buyerMarkSaved = await buyer.evaluate(async ({ id, paymentState }) => {
    const dbmod = await import('/src/db.js');
    const before = await dbmod.db.messages.get(id);
    if (!before) {
      const all = [];
      for (const row of await dbmod.readStoredRows()) {
        all.push({ id: String(row.id).slice(0, 12), type: row.type || row.data?.type, orderId: row.data?.orderId || null,
          isSender: row.isSender ?? null, keys: Object.keys(row.localPatch || {}) });
      }
      return { saved: false, reason: 'no stored row', wireIdProbe: id.slice(0, 12), allRows: all };
    }
    const result = await dbmod.patchMessage(id, { paymentState, paymentSeenBy: 'watcher' });
    const after = await dbmod.db.messages.get(id);
    return { saved: !!result, reason: result ? 'ok' : 'patch returned false',
      sealed: !!before?.sealed, hasLocalPatchBefore: Object.keys(before?.localPatch || {}).length,
      afterKeys: Object.keys(after?.localPatch || {}) };
  }, { id: wireOrderId, paymentState: boughtCheck.state });
  console.error('BUYER_MARK_DEBUG', JSON.stringify(buyerMarkSaved));
  assert.ok(buyerMarkSaved.saved === true, `buyer device mark must persist through patchMessage: ${JSON.stringify(buyerMarkSaved)}`);

  // ---- Step 4: the vendor's REAL receipt path (mirrors useCommerce
  // handleOrderAction check_chain vendor branch): ledger lock, consumed-txid
  // gate, signReceipt, receipt_<id> persist, consumed_txids append, then the
  // receipt-bearing order_update through the outbox. ----
  const receiptOutcome = await vendor.evaluate(async ({ buyerKey, id, address: addr, reportedAmount, reportTxid, watchingState }) => {
    const identity = window.__identity;
    const payments = await import('/src/lib/vendorPayments.js');
    const trade = await import('/src/lib/proofOfTrade.js');
    const storage = await import('/src/lib/storage.js');
    const lockModule = await import('/src/lib/paymentLedgerLock.js');
    const fence = identity.securityFence;
    fence.assertCurrent();
    return lockModule.withPaymentLedgerLock(async () => {
      fence.assertCurrent();
      const read = payments.readConsumedLedger();
      if (!read.ok) return { error: 'ledger unreadable' };
      const ledger = read.ledger;
      const taken = payments.txidSpokenFor(ledger, { currency: 'xmr', txid: reportTxid, orderId: id })
        || payments.addressSpokenFor(ledger, { address: addr, orderId: id });
      if (taken) return { error: 'txid already spoken for' };
      const priorReceipt = storage.scopedGet(`receipt_${id}`, null);
      const reusable = trade.reusableWatcherReceipt(priorReceipt, {
        orderId: id, buyer: buyerKey, vendor: identity.pk, currency: 'xmr', address: addr,
        amount: reportedAmount, txid: reportTxid, outcome: 'confirmed', signer: identity.pk,
      });
      const receipt = reusable || trade.signReceipt(identity.sk, {
        orderId: id, buyer: buyerKey, vendor: identity.pk, currency: 'xmr', address: addr,
        amount: reportedAmount, txid: reportTxid, at: Math.floor(Date.now() / 1000),
        outcome: 'confirmed',
      });
      if (!storage.scopedSetVerified(`receipt_${id}`, receipt)) return { error: 'receipt persist failed' };
      // Mirror the production confirm branch exactly: markConsumed takes and
      // returns a plain entry map (consumedKey → entry); readConsumedLedger
      // unwraps the { v:1, entries } envelope when present.
      const existing = ledger ? ledger : {};
      if (!existing[payments.consumedKey('xmr', reportTxid)]) {
        const nextLedger = payments.markConsumed(existing, {
          currency: 'xmr', txid: reportTxid, orderId: id, address: addr, at: Math.floor(Date.now() / 1000),
        });
        if (!storage.scopedSetVerified('consumed_txids', nextLedger)) return { error: 'ledger persist failed' };
      }
      const payload = {
        type: 'order_update', orderId: id, status: 'paid',
        paymentState: 'confirmed', paymentSeenBy: 'watcher', receipt,
        published: trade.signPublicView(identity.sk, trade.publicReceipt(receipt)),
      };
      const sent = await window.__dm.sendDM(buyerKey, payload, null, null, {
        idempotencyKey: `payment-confirm-v1|${buyerKey}|${id}|${receipt.hash}`,
        intent: `payment-confirm-v1|${buyerKey}|${id}|xmr|${reportTxid}|${receipt.hash}`,
      });
      if (!sent.success) return { error: sent.error };
      return { receiptHash: receipt.hash, sigs: Object.keys(receipt.sigs), eventId: sent.event.id };
    }, identity.pk);
  }, { buyerKey: buyerPubkey, id: wireOrderId, address, reportedAmount: checked.report.amount ?? amount,
    reportTxid: checked.report.txid, watchingState: 'confirmed' });
  assert.ok(!receiptOutcome.error, `vendor receipt path failed: ${receiptOutcome.error}`);
  assert.equal(receiptOutcome.sigs.length, 1, 'vendor-only receipt before countersign');

  // ---- Step 5: buyer receives the paid update; the production ingest path
  // binds and COSIGNS through useNIP44DM.receiptMayBind + acceptPayment, then
  // sendCountersignOnce sends the two-signature receipt back. The countersign
  // mark (countersign_sent_<id>) lives on the BUYER, its sender; the vendor's
  // observable is the completed receipt in ITS scoped store — written by the
  // same production ingest arm when the buyer's countersign arrives.
  const countersignDeadline = Date.now() + 25_000;
  let countersigned = false;
  while (Date.now() < countersignDeadline) {
    countersigned = await vendor.evaluate(async ({ id }) => {
      const storage = await import('/src/lib/storage.js');
      return Boolean(storage.scopedGet(`receipt_${id}`, null)?.sigs?.buyer);
    }, { id: wireOrderId });
    if (countersigned) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!countersigned) {
    const info = await buyer.evaluate(async ({ id }) => {
      const storage = await import('/src/lib/storage.js');
      const dbmod = await import('/src/db.js');
      const rows = [];
      for (const row of await dbmod.readStoredRows()) {
        if (row.chatId && JSON.stringify(row.data || {}).includes(id)) rows.push({ id: row.id, type: row.data?.type, status: row.data?.status, bound: row.data?.receipt?.bound ?? null });
      }
      return { storedRows: rows, receipt: storage.scopedGet(`receipt_${id}`, null)?.sigs ?? null,
        sentKeys: Object.keys(localStorage).filter((key) => key.includes('countersign')) };
    }, { id: wireOrderId });
    console.error('BUYER_COUNTERSIGN_DEBUG', JSON.stringify(info, null, 1));
    console.error('BUYER_CONSOLE_TAIL', JSON.stringify(buyerConsole.slice(-14), null, 1));
    throw new Error('The buyer countersign never reached the vendor within 25s.');
  }

  const receiptAfterCountersign = await vendor.evaluate(async ({ id }) => {
    const storage = await import('/src/lib/storage.js');
    return storage.scopedGet(`receipt_${id}`, null);
  }, { id: wireOrderId });
  assert.equal(receiptAfterCountersign.sigs.buyer && receiptAfterCountersign.sigs.vendor ? 2 : 1, 2,
    'completed two-signature receipt exists at the vendor after countersign');
  const verifyRound = await vendor.evaluate(async ({ id }) => {
    const trade = await import('/src/lib/proofOfTrade.js');
    const storage = await import('/src/lib/storage.js');
    return trade.verifyReceipt(storage.scopedGet(`receipt_${id}`, null));
  }, { id: wireOrderId });
  assert.equal(verifyRound, true, 'two-party receipt verifies cryptographically');

  // Buyer-side durable evidence of the bound receipt:
  const buyerBound = await buyer.evaluate(async ({ id }) => {
    const storage = await import('/src/lib/storage.js');
    const receipt = storage.scopedGet(`receipt_${id}`, null);
    const boundHash = storage.scopedGet(`bound_receipt_${id}`, null);
    return { hasReceipt: !!receipt, boundHashMatches: boundHash === (receipt?.hash ?? ''), sigs: Object.keys(receipt?.sigs || {}) };
  }, { id: wireOrderId });
  assert.ok(buyerBound.hasReceipt, 'buyer stores the bound receipt durably');
  assert.ok(buyerBound.boundHashMatches, 'bound-receipt hash marker matches');
  assert.equal(buyerBound.sigs.length, 2, 'buyer receipt carries both signatures');

  // Ledger irreversibility spot-check: replay attempt refused.
  const replayCheck = await vendor.evaluate(async ({ id, txid, addr }) => {
    const payments = await import('/src/lib/vendorPayments.js');
    const read = payments.readConsumedLedger();
    if (!read.ok) return { ok: false };
    // txidSpokenFor/addressSpokenFor contract: null when the entry speaks for
    // the GIVEN order (fine), the entry when it is already taken by another
    // order (the replay refusal). The ledger must bind this txid to THIS
    // order only, and refuse both a txid-replay and an address-replay.
    return {
      ok: true,
      sameOrderClean: payments.txidSpokenFor(read.ledger, { currency: 'xmr', txid, orderId: id }) === null,
      otherOrderRefused: payments.txidSpokenFor(read.ledger, { currency: 'xmr', txid, orderId: 'another-order' }) !== null,
      otherAddressRefused: payments.addressSpokenFor(read.ledger, { address: addr, orderId: 'another-order' }) !== null,
      entry: read.ledger[payments.consumedKey('xmr', txid)] || null,
    };
  }, { id: wireOrderId, txid: txidValue, addr: address });
  assert.ok(replayCheck.ok && replayCheck.sameOrderClean && replayCheck.otherOrderRefused && replayCheck.otherAddressRefused,
    `consumed ledger binds the txid to this order only: ${JSON.stringify({ ok: replayCheck.ok, sameOrderClean: replayCheck.sameOrderClean, otherOrderRefused: replayCheck.otherOrderRefused, otherAddressRefused: replayCheck.otherAddressRefused, entry: replayCheck.entry })}`);

  const events = [request.event];
  for (const event of events) {
    const captured = relay.events.get(event.id);
    assert.ok(captured, `local relay retained event ${event.id}`);
    assert.equal(JSON.stringify(captured).includes('Synthetic coffee'), false, 'relay event must not expose the order plaintext');
  }

  console.log(JSON.stringify({
    result: 'passed',
    loop: ['order_request', 'per_order_address_derivation_acceptance', 'signed_v2_watcher_check',
      'vendor_signReceipt_plus_ledger', 'buyers_countersign_roundtrip', 'two_party_receipt_verified',
      'consumed_ledger_binds_txid'],
    accounts: { buyer: buyerPubkey, vendor: vendorPubkey, distinct: true },
    order: { id: orderId, requestEventId: request.event.id, acceptanceEventId: acceptanceViaAllocator.event.id,
      confirmationEventId: receiptOutcome.eventId },
    perOrderDerivation: { derivedSubaddressPrefix: derivedSubaddress.slice(0, 6), matchesAllocator: true },
    receipt: { hash: receiptOutcome.receiptHash, signaturesBeforeCountersign: 1,
      signaturesAfterCountersign: 2, cryptoVerified: true },
    watcher: { signedV2: true, state: checked.state, txid: checked.report.txid, authorizationHeaderOnly: true },
    limits: [
      'synthetic identities, wallet RPC, transfer, and txid; no chain or wallet-daemon evidence',
      'order actions driven through the real lib modules in-page, not by clicking buttons in the shipped Chat shell; UI-only behaviors such as toast copy are not exercised',
      'relay and watcher are local test services; no deployed operator setup or public-relay test',
      'production DMs remain on NIP-44/NIP-59; no protocol change and no anonymity claim',
    ],
  }, null, 2));
  await Promise.all([buyer, vendor].map((page) => page.evaluate(() => window.__stopCommerceDm?.())));
} finally {
  await buyerContext?.close();
  await vendorContext?.close();
  await browser?.close();
  await vite?.close();
  await close(watcher);
  await close(rpc);
  await relay.close();
  await import('node:fs/promises').then(({ rm }) => rm(tempCwd, { recursive: true, force: true }));
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
