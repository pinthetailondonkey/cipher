// The shipped MLS group crypto seam. Group messages route through OpenMLS
// (wasm) by DEFAULT for founder testing: this module owns one engine handle
// per unlocked account, persists snapshots through account-scoped scoped
// storage (the same discipline as every other account fact), and exposes
// exactly these doors:
//
//   ensureEngine()   lazily create or restore this account's engine
//   persistEngine()  snapshot the engine and store it (call after any op)
//   forgetEngine()   drop runtime handle; next use restores from storage
//   groupCreate()    new MLS group -> { groupRef }
//   exportKeyPackage()  invite material to hand to a peer's invite flow
//   addFromKeyPackage() consume a peer key package -> commit+welcome
//   joinFromWelcome()   consume my welcome -> this device joins the group
//   seal()           plaintext bytes -> opaque MLS wire bytes
//   openWire()       wire bytes from a peer -> { kind, ... }
//   members()        roster with each member's identity label
//
// Failures surface as ERR:-prefixed machine reasons from the Rust core,
// matching the fail-closed style of src/lib/mlsTest/relayEnvelope.js.
import { scopedGet, scopedSet } from './storage.js';

const SNAPSHOT_KEY = 'mls_engine_snapshot_v1';
let modulePromise = null;
let engineHandle = null;
let engineLabel = null;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = import(/* @vite-ignore */ '../crypto/mls-wasm/target/browser-bindings/cipher_mls_eval.js')
      .then(async (mod) => {
        await mod.default();
        return mod;
      });
  }
  return modulePromise;
}

// Bindgen Result<String,String> marshals Ok as a JSON string; Err arrives as
// an exception carrying the reason (wasm-bindgen throws Result errors).
function bridgeCall(fn, args) {
  let raw;
  try {
    raw = fn(...args);
  } catch (error) {
    const text = String(error?.message ?? error);
    throw new Error(text.startsWith('ERR:') ? text : `ERR:bridge:${text}`);
  }
  if (typeof raw !== 'string') throw new Error(`ERR:bridge-shape:${typeof raw}`);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`ERR:bridge-json:${String(error?.message ?? error)}`);
  }
}

export const MLS_WIRE_VERSION = 'cipher-mls-seam-v1';

export async function ensureEngine(identityLabel) {
  if (!identityLabel || typeof identityLabel !== 'string' || !identityLabel.trim()) {
    throw new Error('ERR:js-bad-identity-label');
  }
  if (engineHandle !== null && engineLabel === identityLabel) return engineHandle;
  const mod = await loadModule();
  let parsed;
  if (engineHandle !== null && engineLabel !== identityLabel) {
    // Account switch: drop the in-memory engine; restore below from THIS
    // account's scope after the caller rotates scoped storage.
    mod.mls_engine_drop(engineHandle);
    engineHandle = null;
  }
  const storedSnapshot = scopedGet(SNAPSHOT_KEY, null);
  if (storedSnapshot && typeof storedSnapshot === 'string') {
    parsed = bridgeCall(mod.mls_engine_restore.bind(mod), [storedSnapshot]);
  } else {
    parsed = bridgeCall(mod.mls_engine_create.bind(mod), [identityLabel]);
  }
  const handle = Number(parsed?.handle);
  if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error('ERR:bad-handle');
  engineHandle = handle;
  engineLabel = identityLabel;
  return engineHandle;
}

export async function persistEngine() {
  if (engineHandle === null) throw new Error('ERR:no-engine');
  const mod = await loadModule();
  const snapshot = bridgeCall(mod.mls_engine_snapshot.bind(mod), [engineHandle]);
  if (!snapshot || typeof snapshot.storage !== 'string' || snapshot.v !== 1) {
    throw new Error('ERR:snapshot-shape');
  }
  scopedSet(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return true;
}

export function currentEngineHandle() {
  return engineHandle;
}

export function forgetRuntimeEngine() {
  if (engineHandle !== null) {
    loadModule()
      .then((mod) => mod.mls_engine_drop(engineHandle))
      .catch(() => {});
    engineHandle = null;
    engineLabel = null;
  }
}

async function op(name, ...args) {
  const handle = await ensureEngineRequirements();
  const mod = await loadModule();
  const fn = mod[name];
  if (typeof fn !== 'function') throw new Error(`ERR:missing-op:${name}`);
  const out = bridgeCall(fn.bind(mod), [BigInt(handle), ...args]);
  await persistEngine();
  return out;
}

async function ensureEngineRequirements() {
  if (engineHandle === null) throw new Error('ERR:no-engine-call-ensure-first');
  return engineHandle;
}

export async function groupCreate() {
  return op('mls_group_create');
}

export async function exportKeyPackage() {
  return op('mls_engine_key_package');
}

export async function addFromKeyPackage(keyPackageB64) {
  if (typeof keyPackageB64 !== 'string' || !keyPackageB64.trim()) throw new Error('ERR:js-bad-key-package');
  return op('mls_group_add', keyPackageB64);
}

export async function joinFromWelcome(welcomeB64) {
  if (typeof welcomeB64 !== 'string' || !welcomeB64.trim()) throw new Error('ERR:js-bad-welcome');
  return op('mls_group_join', welcomeB64);
}

export async function processWire(messageB64) {
  if (typeof messageB64 !== 'string' || !messageB64.trim()) throw new Error('ERR:js-bad-message');
  return op('mls_process', messageB64);
}

export async function seal(plaintextBytes) {
  if (!(plaintextBytes instanceof Uint8Array) || plaintextBytes.length === 0) {
    throw new Error('ERR:js-bad-plaintext');
  }
  const b64 = bytesToB64(plaintextBytes);
  const out = await op('mls_encrypt', b64);
  if (typeof out?.message !== 'string' || !out.message) throw new Error('ERR:empty-seal');
  return b64ToBytes(out.message);
}

export async function openWire(wireBytes) {
  if (!(wireBytes instanceof Uint8Array) || wireBytes.length === 0) {
    throw new Error('ERR:js-empty-wire');
  }
  const out = await op('mls_process', bytesToB64(wireBytes));
  if (out.kind === 'application' && typeof out.plaintext === 'string') {
    return { kind: 'application', plaintext: b64ToBytes(out.plaintext) };
  }
  return out;
}

export async function members() {
  return op('mls_members');
}

function bytesToB64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
