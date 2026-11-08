// Experimental local protection for the primary authority secret. This is an
// opt-in WebAuthn PRF wrapper, not an identity credential or hardware-isolation
// claim. Unsupported PRF or backup-eligible authenticators fail closed.
const encoder = new TextEncoder();

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function bytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value || []);
}

function authenticatorFlags(assertion) {
  const data = bytes(assertion?.response?.authenticatorData);
  if (data.length < 37) throw new Error('The authenticator did not return valid assertion data.');
  const flags = data[32];
  const backupEligible = Boolean(flags & 0x08);
  const backupState = Boolean(flags & 0x10);
  const userVerified = Boolean(flags & 0x04);
  if (!(flags & 0x01) || !userVerified) throw new Error('Primary authority unlock requires verified user presence.');
  if (backupEligible || backupState) throw new Error('This credential is backup eligible or backed up; it cannot protect the primary authority key.');
  return { backupEligible, backupState, userVerified };
}

function prfOutput(credential) {
  const output = credential?.getClientExtensionResults?.()?.prf?.results?.first;
  if (!(output instanceof ArrayBuffer) || output.byteLength !== 32) {
    throw new Error('This authenticator or browser does not provide the WebAuthn PRF extension.');
  }
  return new Uint8Array(output);
}

function requireWebAuthn() {
  if (!globalThis.isSecureContext || !globalThis.navigator?.credentials || !globalThis.PublicKeyCredential
    || !globalThis.crypto?.subtle) throw new Error('Secure-context WebAuthn PRF support is required.');
}

async function deriveAesKey(assertion) {
  authenticatorFlags(assertion);
  const output = prfOutput(assertion);
  try { return await crypto.subtle.importKey('raw', output, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { output.fill(0); }
}

async function assertCredential(credentialId, salt) {
  requireWebAuthn();
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: randomBytes(32),
    allowCredentials: [{ type: 'public-key', id: Uint8Array.from(credentialId) }],
    userVerification: 'required',
    extensions: { prf: { eval: { first: Uint8Array.from(salt) } } },
  } });
  if (!assertion) throw new Error('Primary authority unlock was cancelled.');
  return assertion;
}

function aad({ accountPubkey, policyId }) {
  if (!/^[0-9a-f]{64}$/.test(accountPubkey || '') || !/^[0-9a-f]{64}$/.test(policyId || '')) {
    throw new Error('Authority wrapping requires the exact account and policy checkpoint.');
  }
  return encoder.encode(`cipher-device-authority-webauthn-v1|${accountPubkey}|${policyId}`);
}

// Creates a resident platform credential, then requires an assertion that
// proves PRF operation and reports BE=BS=0 before wrapping the secret.
export async function wrapPrimaryAuthorityWithWebAuthn({ authoritySecret, accountPubkey, policyId, rpId } = {}) {
  requireWebAuthn();
  if (!(authoritySecret instanceof Uint8Array) || authoritySecret.length !== 32
    || !/^[0-9a-f]{64}$/.test(accountPubkey || '') || !/^[0-9a-f]{64}$/.test(policyId || '')
    || typeof rpId !== 'string' || !rpId) throw new Error('A valid authority key, account, policy, and relying-party id are required.');
  const userId = randomBytes(32);
  const salt = randomBytes(32);
  const creation = await navigator.credentials.create({ publicKey: {
    challenge: randomBytes(32),
    rp: { id: rpId, name: 'Cipher primary authority' },
    user: { id: userId, name: 'Cipher primary', displayName: 'Cipher primary authority' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    timeout: 60_000,
    extensions: { prf: { eval: { first: salt } } },
  } });
  userId.fill(0);
  if (!creation?.rawId) throw new Error('Primary authority credential creation was cancelled.');
  const credentialId = Array.from(new Uint8Array(creation.rawId));
  const assertion = await assertCredential(credentialId, salt);
  const key = await deriveAesKey(assertion);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad({ accountPubkey, policyId }) },
    key, authoritySecret);
  return { format: 'cipher-authority-webauthn-prf-v1', credentialId, salt: Array.from(salt),
    iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)), backupEligible: false, backupState: false };
}

export async function unlockPrimaryAuthorityWithWebAuthn({ wrapped, accountPubkey, policyId } = {}) {
  if (wrapped?.format !== 'cipher-authority-webauthn-prf-v1' || wrapped.backupEligible !== false || wrapped.backupState !== false
    || !Array.isArray(wrapped.credentialId) || !Array.isArray(wrapped.salt) || wrapped.salt.length !== 32
    || !Array.isArray(wrapped.iv) || wrapped.iv.length !== 12 || !Array.isArray(wrapped.ciphertext)) {
    throw new Error('The stored WebAuthn authority envelope is malformed or not device-bound.');
  }
  const assertion = await assertCredential(wrapped.credentialId, wrapped.salt);
  const key = await deriveAesKey(assertion);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(wrapped.iv),
    additionalData: aad({ accountPubkey, policyId }) }, key, Uint8Array.from(wrapped.ciphertext));
  const secret = new Uint8Array(plaintext);
  if (secret.length !== 32) { secret.fill(0); throw new Error('The wrapped authority secret has an invalid length.'); }
  return secret;
}

export const deviceAuthorityWebAuthnInternals = Object.freeze({ authenticatorFlags });
