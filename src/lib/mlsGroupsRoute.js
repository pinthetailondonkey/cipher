// Routing shim between the group codec (src/lib/crypto/groupMessageCodec.js)
// and the MLS engine (src/lib/mlsGroups.js). Keeps the codec free of any
// wasm knowledge and answers one question per call: does THIS device's
// engine hold MLS state for THIS group right now?
//
// Group identity is the caller's groupId string; the engine is single-group,
// so a match means groupId === the held group's registered ref. Registration
// happens through mlsRegisterGroupRef() when a group is created or joined.
import { ensureEngine, seal as engineSeal, openWire, members, persistEngine, groupCreate } from './mlsGroups';
import { scopedGet, scopedSet } from './storage';
import { currentOwner } from '../db.js';

const MLS_GROUP_REF_KEY = 'mls_group_ref_v1';
const MLS_ACTIVE_KEY = 'mls_group_active_v1';

export async function ready(groupId) {
  if (!groupId) return false;
  const active = scopedGet(MLS_ACTIVE_KEY, false) === true;
  if (!active) return false;
  const ref = scopedGet(MLS_GROUP_REF_KEY, null);
  try {
    const parsed = typeof ref === 'string' ? JSON.parse(ref) : ref;
    return Boolean(parsed && parsed.groupId === groupId);
  } catch {
    return false;
  }
}

// Seal returns null when MLS could not run for this body; the codec then
// falls back to the group-cipher path instead of failing the send.
export async function seal(groupId, payload, by) {
  try {
    const label = currentOwner();
    if (!label) return null;
    await ensureEngine(label);
    const body = (by && payload && typeof payload === 'object' && !Array.isArray(payload))
      ? { ...payload, by }
      : payload;
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const wire = await engineSeal(bytes);
    // btoa-free transport into event.content: store base64 of the wire.
    return bytesToB64(wire);
  } catch (error) {
    console.warn('[mls-route] Seal fell back:', error?.message ?? String(error));
    return null;
  }
}

// Open a fmt=mls1 content string ({ mls: <b64 wire> }) into the parsed body.
// Fail closed: any failure returns { error } and never falls back to showing
// undecryptable content as text.
export async function open(contentString) {
  let envelope;
  try {
    envelope = JSON.parse(contentString);
  } catch {
    return { error: 'decrypt-failed', reason: 'mls envelope not json' };
  }
  const wireB64 = envelope?.mls;
  if (typeof wireB64 !== 'string' || !wireB64) {
    return { error: 'decrypt-failed', reason: 'mls envelope missing wire bytes' };
  }
  try {
    const label = currentOwner();
    if (!label) return { error: 'decrypt-failed', reason: 'no account unlocked for mls open' };
    await ensureEngine(label);
    const out = await openWire(b64ToBytes(wireB64));
    if (out.kind === 'application') {
      const text = new TextDecoder().decode(out.plaintext);
      let body;
      try { body = JSON.parse(text); } catch { body = { type: 'text', message: text }; }
      return { plaintext: text, parsed: body };
    }
    if (out.kind === 'commit-merged') {
      await persistEngine();
      return { control: 'mls-commit-merged' };
    }
    return { control: `mls-${out.kind}` };
  } catch (error) {
    return { error: 'decrypt-failed', reason: error?.message ?? String(error) };
  }
}

export async function roster() {
  try {
    const label = currentOwner();
    if (!label) return [];
    await ensureEngine(label);
    const out = await members();
    return Array.isArray(out?.members) ? out.members : [];
  } catch (error) {
    console.warn('[mls-route] Roster unavailable:', error?.message ?? String(error));
    return [];
  }
}

export function registerGroupRef(groupId, groupRefJson) {
  scopedSet(MLS_GROUP_REF_KEY, JSON.stringify({ groupId, groupRef: groupRefJson }));
  scopedSet(MLS_ACTIVE_KEY, true);
}

export function clearGroupRef() {
  scopedSet(MLS_ACTIVE_KEY, false);
}

function bytesToB64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64ToBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}


// Named exports used by src/lib/crypto/groupMessageCodec.js; same functions,
// codec-facing names so the call sites read plainly.
export const mlsSealBody = { ready, seal };
export const mlsOpenWire = open;

// Creator-side setup: create the engine's MLS group and bind the caller's
// groupId to it. Throws on hard failures so the caller records them; returns
// the group ref JSON for logging.
export async function mlsCreatorSetup(groupId, accountPubkey) {
  await ensureEngine(accountPubkey);
  const created = await groupCreate();
  if (!created?.group_ref) throw new Error('ERR:creator-setup-no-ref');
  registerGroupRef(groupId, created.group_ref);
  await persistEngine();
  return created.group_ref;
}
