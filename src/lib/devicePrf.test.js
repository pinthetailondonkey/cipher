import assert from 'node:assert/strict';
import test from 'node:test';
import { prfEnvironmentProblem, prfProvider, prfStorageKey } from './devicePrf.js';

const goodEnv = () => ({
  window: { PublicKeyCredential: function PublicKeyCredential() {}, isSecureContext: true },
  navigator: { credentials: { create() {} } },
  location: { hostname: 'ciphermessenger.org' },
});

test('the passkey device lock is offered only where WebAuthn can really work', () => {
  assert.equal(prfEnvironmentProblem(goodEnv()), '');
  // Tor Browser and Tails: WebAuthn is switched off.
  const tor = goodEnv();
  delete tor.window.PublicKeyCredential;
  assert.equal(prfEnvironmentProblem(tor), 'no-webauthn');
  const noCreds = goodEnv();
  noCreds.navigator = {};
  assert.equal(prfEnvironmentProblem(noCreds), 'no-webauthn');
  const http = goodEnv();
  http.window.isSecureContext = false;
  assert.equal(prfEnvironmentProblem(http), 'insecure-context');
  // The desktop app serves from 127.0.0.1 and an IP address is not a valid relying party id.
  for (const hostname of ['127.0.0.1', '10.1.2.3', '[::1]', '']) {
    const ip = goodEnv();
    ip.location.hostname = hostname;
    assert.equal(prfEnvironmentProblem(ip), 'bad-rp-id', hostname);
  }
});

test('the stored passkey record is per account and the provider names itself prf', () => {
  assert.equal(prfStorageKey('abc'), 'cipher_devkey_abc');
  assert.equal(prfProvider.kind, 'prf');
});
