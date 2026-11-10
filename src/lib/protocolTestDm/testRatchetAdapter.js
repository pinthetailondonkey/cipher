// Test-path ratchet adapter (TEST-ONLY, src/lib/protocolTestDm/).
//
// Loads the existing pinned vodozemac-backed WASM ratchet
// (src/lib/ratchet/wasm/cipher_ratchet_wasm_bg.wasm, build output of
// `npm run build:ratchet`) inside plain Node for the DM test-path slice.
// This module ADDS a Node loader; it does not modify or wrap-change the
// frozen wire modules and touches no production messaging path.
//
// Session semantics (vodozemac =0.11.2, experimental-session-config, v2 mode):
//   outbound:  DeviceAccount.create_outbound_session(peerCurve25519, peerOtk)
//   inbound:   DeviceAccount.accept_initial_message(peerCurve25519, msgJson)
// v1 init messages are rejected at a higher layer (receiver.js step 4); this
// adapter additionally refuses to construct one because SessionConfig is
// always version_2() inside the wasm build.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let cached = null;

export async function loadRatchetWasm() {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const wasmDir = path.resolve(here, '../ratchet/wasm');
  const module = await import(path.toNamespacedPath(path.join(wasmDir, 'cipher_ratchet_wasm.js')));
  const bytes = readFileSync(path.join(wasmDir, 'cipher_ratchet_wasm_bg.wasm'));
  await module.default(bytes);
  cached = module;
  return module;
}

// Small convenience wrapper so callers never juggle free()/restore plumbing.
// The wrapper keeps the account and every session pickled under a key the
// caller supplies (32 bytes), so sealing is the sessionStore's job, not this
// adapter's.
export class TestRatchetAccount {
  constructor(account) {
    this.account = account;
  }

  static async create() {
    const m = await loadRatchetWasm();
    return new TestRatchetAccount(new m.DeviceAccount());
  }

  identity() { return JSON.parse(this.account.identity_json()); }

  generateOneTimeKeys(count) {
    return JSON.parse(this.account.generate_one_time_keys_json(count));
  }

  storedOneTimeKeyCount() { return this.account.stored_one_time_key_count(); }

  createOutboundSession(peerCurve25519, peerOneTimeKey) {
    return new TestRatchetSession(this.account.create_outbound_session(peerCurve25519, peerOneTimeKey));
  }

  acceptInitialMessage(peerCurve25519, messageJson) {
    const received = this.account.accept_initial_message(peerCurve25519, messageJson);
    // wasm-bindgen exposes these as getter functions; unwrap them.
    const plaintext = typeof received.plaintext === 'function' ? received.plaintext() : received.plaintext;
    const usedOneTimeKey = typeof received.used_one_time_key === 'function'
      ? received.used_one_time_key() : received.usedOneTimeKey;
    return {
      plaintext: String(plaintext),
      usedOneTimeKey: String(usedOneTimeKey),
      sessionId: String(typeof received.session_id === 'function' ? received.session_id() : received.sessionId),
      session: new TestRatchetSession(received.into_session()),
    };
  }
}

export class TestRatchetSession {
  constructor(session) {
    this.session = session;
  }

  sessionId() { return this.session.session_id(); }

  encrypt(plaintext) { return this.session.encrypt(plaintext); }

  decrypt(messageJson) { return this.session.decrypt(messageJson); }
}
