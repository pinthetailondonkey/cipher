import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const port = 8091;
const origin = `http://127.0.0.1:${port}`;
const wasmDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/ratchet/wasm');
const assets = new Map([
  ['/ratchet/cipher_ratchet_wasm.js', ['cipher_ratchet_wasm.js', 'text/javascript; charset=utf-8']],
  ['/ratchet/cipher_ratchet_wasm_bg.wasm', ['cipher_ratchet_wasm_bg.wasm', 'application/wasm']],
]);
const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Ratchet WASM check</title></head><body>Ready</body></html>');
    return;
  }
  const asset = assets.get(request.url);
  if (!asset) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' });
    response.end(await readFile(path.join(wasmDir, asset[0])));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const wasm = await import('/ratchet/cipher_ratchet_wasm.js');
    await wasm.default();
    const alice = new wasm.DeviceAccount();
    const bob = new wasm.DeviceAccount();
    const bobKeys = JSON.parse(bob.generate_one_time_keys_json(4));
    const aliceIdentity = JSON.parse(alice.identity_json());
    const bobIdentity = JSON.parse(bob.identity_json());
    if (aliceIdentity.version !== 2 || bobIdentity.protocol !== 'cipher-olm-ratchet') {
      throw new Error('WASM account did not identify the required v2 protocol.');
    }
    const session = alice.create_outbound_session(bobIdentity.curve25519, bobKeys[0]);
    const firstEnvelope = session.encrypt(JSON.stringify({ text: 'first-secret-message' }));
    let wrongIdentityRejected = false;
    const otherAccount = new wasm.DeviceAccount();
    try {
      otherAccount.accept_initial_message(aliceIdentity.curve25519, firstEnvelope);
    } catch {
      wrongIdentityRejected = true;
    }
    if (!wrongIdentityRejected) throw new Error('The initial message was accepted by an account without its OTK.');
    const initial = bob.accept_initial_message(aliceIdentity.curve25519, firstEnvelope);
    if (initial.plaintext() !== JSON.stringify({ text: 'first-secret-message' })) {
      throw new Error('The recipient did not decrypt the authenticated initial message.');
    }
    const bobSession = initial.into_session();
    const one = session.encrypt('out-of-order-one');
    const two = session.encrypt('out-of-order-two');
    if (bobSession.decrypt(two) !== 'out-of-order-two') throw new Error('The skipped-key receive path failed.');
    if (bobSession.decrypt(one) !== 'out-of-order-one') throw new Error('The earlier skipped message did not decrypt.');
    let duplicateRejected = false;
    try { bobSession.decrypt(one); } catch { duplicateRejected = true; }
    if (!duplicateRejected) throw new Error('A consumed message key accepted a replay.');
    const reply = bobSession.encrypt('reply-secret');
    if (session.decrypt(reply) !== 'reply-secret') throw new Error('The recipient reply failed to decrypt.');
    const next = session.encrypt('next-secret');
    if (bobSession.decrypt(next) !== 'next-secret') throw new Error('The ratcheted follow-up failed to decrypt.');

    // Copy a recipient's current session state, then let its real peer perform
    // a fresh DH step. The stolen copy should decrypt before recovery, but not
    // after it loses the peer's new private ratchet key.
    const recoveryAlice = new wasm.DeviceAccount();
    const recoveryBob = new wasm.DeviceAccount();
    const recoveryIdentity = JSON.parse(recoveryAlice.identity_json());
    const recoveryBobIdentity = JSON.parse(recoveryBob.identity_json());
    const recoveryKeys = JSON.parse(recoveryBob.generate_one_time_keys_json(1));
    const recoverySession = recoveryAlice.create_outbound_session(recoveryBobIdentity.curve25519, recoveryKeys[0]);
    const recoveryInitialMessage = recoverySession.encrypt('recovery-initial');
    const recoveryAccepted = recoveryBob.accept_initial_message(recoveryIdentity.curve25519, recoveryInitialMessage);
    const liveBobSession = recoveryAccepted.into_session();
    const historical = recoverySession.encrypt('before-compromise');
    if (liveBobSession.decrypt(historical) !== 'before-compromise') throw new Error('The live peer failed to read the pre-compromise message.');
    const stolenKey = crypto.getRandomValues(new Uint8Array(32));
    const stolenState = liveBobSession.encrypt_state(stolenKey);
    const attackerSession = wasm.RatchetSession.restore(stolenState, stolenKey);
    let oldMessageRejected = false;
    try { attackerSession.decrypt(historical); } catch { oldMessageRejected = true; }
    if (!oldMessageRejected) throw new Error('The copied current state recovered a consumed historical message key.');
    const exposed = recoverySession.encrypt('during-compromise');
    if (liveBobSession.decrypt(exposed) !== 'during-compromise') throw new Error('The live peer rejected the compromise-window message.');
    if (attackerSession.decrypt(exposed) !== 'during-compromise') throw new Error('The copied current state did not reproduce the compromise window.');
    const peerContribution = liveBobSession.encrypt('fresh-peer-contribution');
    if (recoverySession.decrypt(peerContribution) !== 'fresh-peer-contribution') throw new Error('The sender did not accept the fresh peer DH contribution.');
    const afterRecovery = recoverySession.encrypt('after-compromise-recovery');
    if (liveBobSession.decrypt(afterRecovery) !== 'after-compromise-recovery') throw new Error('The live peer failed after ratchet recovery.');
    let stolenStateRejected = false;
    try { attackerSession.decrypt(afterRecovery); } catch { stolenStateRejected = true; }
    if (!stolenStateRejected) throw new Error('The stolen pre-contribution state decrypted after recovery.');

    const pickleKey = crypto.getRandomValues(new Uint8Array(32));
    const pickle = session.encrypt_state(pickleKey);
    const restored = wasm.RatchetSession.restore(pickle, pickleKey);
    if (restored.session_id() !== session.session_id()) throw new Error('A restored v2 session changed identity.');
    const badKey = crypto.getRandomValues(new Uint8Array(32));
    let wrongPickleKeyRejected = false;
    try { wasm.RatchetSession.restore(pickle, badKey); } catch { wrongPickleKeyRejected = true; }
    if (!wrongPickleKeyRejected) throw new Error('A session pickle opened with the wrong storage key.');
    return { protocol: aliceIdentity.protocol, version: aliceIdentity.version, postCompromiseRecovery: true, sessionId: session.session_id() };
  });
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(`Ratchet WASM browser integration passed: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
