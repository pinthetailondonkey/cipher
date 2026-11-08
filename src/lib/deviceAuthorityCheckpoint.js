// Optional peer-witness checkpoint experiment. A quorum can prove that enough
// explicitly trusted peers have observed a head; it cannot prove that every
// peer has seen the newest head or make relay partitions disappear.
import { nip59 } from 'nostr-tools';
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { rumorTags, sealAndWrap } from './giftWrap.js';
import { unwrapToRumor } from './giftUnwrap.js';
import { verifyDeviceAuthorityPolicy, verifyDeviceAuthorityRegistry } from './deviceAuthority.js';

export const DEVICE_AUTHORITY_CHECKPOINT_KIND = 30091;
export const DEVICE_AUTHORITY_CHECKPOINT_TAG = 'cipher-device-checkpoint-witness-v1';
const PROTOCOL = 'cipher-device-authority-checkpoint-witness';
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{64}$/;

function parse(event) { try { return JSON.parse(event?.content || ''); } catch { return null; } }

function validStoredCheckpoint(checkpoint, now) {
  if (!checkpoint || checkpoint.policyId !== checkpoint.policyEvent?.id
    || checkpoint.registryId !== checkpoint.registryEvent?.id
    || !Array.isArray(checkpoint.registryHistory) || checkpoint.registryHistory.length < 1) return null;
  const policy = verifyDeviceAuthorityPolicy(checkpoint.policyEvent, {
    expectedAccount: checkpoint.accountPubkey, expectedRecovery: checkpoint.recoveryPubkey, now,
  });
  if (!policy) return null;
  let previousEvent = null;
  for (const event of checkpoint.registryHistory) {
    if (!verifyDeviceAuthorityRegistry(event, checkpoint.policyEvent, { previousEvent, now })) return null;
    previousEvent = event;
  }
  if (previousEvent?.id !== checkpoint.registryEvent.id) return null;
  return { policy, registry: parse(checkpoint.registryEvent) };
}

export function createPeerCheckpointChallenge({ accountPubkey, recoveryPubkey, now = Math.floor(Date.now() / 1000),
  randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto) } = {}) {
  if (!HEX64.test(accountPubkey || '') || !HEX64.test(recoveryPubkey || '') || typeof randomBytes !== 'function'
    || !Number.isSafeInteger(now) || now <= 0) {
    throw new Error('An account, pinned recovery fingerprint, and secure randomness are required.');
  }
  const bytes = randomBytes(new Uint8Array(32));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Secure randomness returned an invalid checkpoint challenge.');
  return { protocol: PROTOCOL, version: 1, accountPubkey, recoveryPubkey, issuedAt: now,
    nonce: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('') };
}

// Caller must source `checkpoint` from loadPeerDeviceAuthority() after its
// authenticated local checkpoint has been verified. Witness trust is explicit
// and external; this function does not infer trust from a Nostr profile.
export function createPeerCheckpointAttestation({ checkpoint, challenge, witnessSecret,
  now = Math.floor(Date.now() / 1000) } = {}) {
  const checked = validStoredCheckpoint(checkpoint, now);
  if (!checked || challenge?.protocol !== PROTOCOL || challenge.version !== 1
    || challenge.accountPubkey !== checkpoint.accountPubkey || challenge.recoveryPubkey !== checkpoint.recoveryPubkey
    || !Number.isSafeInteger(challenge.issuedAt) || now < challenge.issuedAt || now - challenge.issuedAt > 60
    || !NONCE.test(challenge.nonce || '') || !(witnessSecret instanceof Uint8Array) || witnessSecret.length !== 32
    || !Number.isSafeInteger(now) || now <= 0) throw new Error('A valid pinned checkpoint and fresh peer challenge are required.');
  const witnessPubkey = getPublicKey(witnessSecret);
  if ([checkpoint.accountPubkey, checkpoint.recoveryPubkey, checked.policy.authorityPubkey].includes(witnessPubkey)) {
    throw new Error('A checkpoint witness must be independent of the account, recovery root, and current authority.');
  }
  return finalizeEvent({ kind: DEVICE_AUTHORITY_CHECKPOINT_KIND, created_at: now,
    tags: [['d', DEVICE_AUTHORITY_CHECKPOINT_TAG]],
    content: JSON.stringify({ protocol: PROTOCOL, version: 1,
      accountPubkey: checkpoint.accountPubkey, recoveryPubkey: checkpoint.recoveryPubkey,
      authorityPubkey: checked.policy.authorityPubkey,
      policyEventId: checkpoint.policyId, authorityEpoch: checked.policy.authorityEpoch,
      registryEventId: checkpoint.registryId, registryGeneration: checked.registry.generation,
      challengeNonce: challenge.nonce, challengeIssuedAt: challenge.issuedAt, createdAt: now }),
  }, witnessSecret);
}

export function verifyPeerCheckpointAttestation(event, { accountPubkey, recoveryPubkey,
  challengeNonce, challengeIssuedAt, trustedWitnessPubkeys = [], now = Math.floor(Date.now() / 1000), maxAgeSeconds = 60,
  minimumAuthorityEpoch = 1, minimumRegistryGeneration = 1 } = {}) {
  try {
    if (!event || getEventHash(event) !== event.id || !verifyEvent(event)
      || event.kind !== DEVICE_AUTHORITY_CHECKPOINT_KIND || !Number.isSafeInteger(event.created_at)
      || event.created_at > now || now - event.created_at > maxAgeSeconds
      || !Number.isSafeInteger(challengeIssuedAt) || event.created_at < challengeIssuedAt
      || now - challengeIssuedAt > maxAgeSeconds
      || !Array.isArray(trustedWitnessPubkeys) || !trustedWitnessPubkeys.includes(event.pubkey)
      || !HEX64.test(accountPubkey || '') || !HEX64.test(recoveryPubkey || '') || !NONCE.test(challengeNonce || '')) return null;
    const tags = event.tags.filter((tag) => tag[0] === 'd');
    const body = parse(event);
    if (tags.length !== 1 || tags[0][1] !== DEVICE_AUTHORITY_CHECKPOINT_TAG
      || body?.protocol !== PROTOCOL || body.version !== 1
      || body.accountPubkey !== accountPubkey || body.recoveryPubkey !== recoveryPubkey
      || !HEX64.test(body.authorityPubkey || '')
      || [body.accountPubkey, body.recoveryPubkey, body.authorityPubkey].includes(event.pubkey)
      || body.challengeNonce !== challengeNonce || body.challengeIssuedAt !== challengeIssuedAt
      || body.createdAt !== event.created_at
      || !HEX64.test(body.policyEventId || '') || !HEX64.test(body.registryEventId || '')
      || !Number.isSafeInteger(body.authorityEpoch) || body.authorityEpoch < minimumAuthorityEpoch
      || !Number.isSafeInteger(body.registryGeneration) || body.registryGeneration < minimumRegistryGeneration) return null;
    return { witnessPubkey: event.pubkey, policyEventId: body.policyEventId,
      authorityEpoch: body.authorityEpoch, registryEventId: body.registryEventId,
      registryGeneration: body.registryGeneration, createdAt: event.created_at };
  } catch { return null; }
}

export function verifyPeerCheckpointQuorum(events, options = {}) {
  const requiredWitnesses = options.requiredWitnesses;
  if (!Array.isArray(events) || !Number.isSafeInteger(requiredWitnesses) || requiredWitnesses < 1) return null;
  const verified = events.map((event) => verifyPeerCheckpointAttestation(event, options)).filter(Boolean);
  const grouped = new Map();
  for (const item of verified) {
    const key = `${item.policyEventId}:${item.registryEventId}:${item.authorityEpoch}:${item.registryGeneration}`;
    if (!grouped.has(key)) grouped.set(key, new Map());
    grouped.get(key).set(item.witnessPubkey, item);
  }
  const quorum = [...grouped.values()].filter((witnesses) => witnesses.size >= requiredWitnesses);
  if (quorum.length !== 1) return null;
  const witnesses = [...quorum[0].values()];
  return { policyEventId: witnesses[0].policyEventId, authorityEpoch: witnesses[0].authorityEpoch,
    registryEventId: witnesses[0].registryEventId, registryGeneration: witnesses[0].registryGeneration,
    witnessPubkeys: witnesses.map((item) => item.witnessPubkey) };
}

// A witness signing two heads at the same account/policy epoch/registry
// generation is detectable equivocation. Distinct event signatures do not
// prove which head is globally current.
export function findPeerCheckpointEquivocations(events) {
  const groups = new Map();
  for (const event of events || []) {
    if (!event || getEventHash(event) !== event.id || !verifyEvent(event) || event.kind !== DEVICE_AUTHORITY_CHECKPOINT_KIND) continue;
    const body = parse(event);
    if (body?.protocol !== PROTOCOL || body.version !== 1 || event.created_at !== body.createdAt
      || !event.tags.some((tag) => tag[0] === 'd' && tag[1] === DEVICE_AUTHORITY_CHECKPOINT_TAG)
      || !HEX64.test(body.accountPubkey || '')
      || !HEX64.test(body.recoveryPubkey || '') || !HEX64.test(body.authorityPubkey || '')
      || [body.accountPubkey, body.recoveryPubkey, body.authorityPubkey].includes(event.pubkey)
      || !HEX64.test(body.policyEventId || '')
      || !HEX64.test(body.registryEventId || '') || !Number.isSafeInteger(body.authorityEpoch)
      || !Number.isSafeInteger(body.registryGeneration)) continue;
    const sequence = `${event.pubkey}:${body.accountPubkey}:${body.recoveryPubkey}:${body.authorityEpoch}:${body.registryGeneration}`;
    if (!groups.has(sequence)) groups.set(sequence, new Map());
    const heads = groups.get(sequence);
    const headId = `${body.policyEventId}:${body.registryEventId}`;
    if (!heads.has(headId)) heads.set(headId, []);
    heads.get(headId).push(event);
  }
  return [...groups.entries()].filter(([, heads]) => heads.size > 1).map(([sequence, heads]) => ({
    sequence, heads: [...heads.keys()], events: [...heads.values()].flat(),
  }));
}

export function buildPeerCheckpointAttestationWrap({ attestationEvent, witnessSecret, recipientPubkey, now } = {}) {
  if (getPublicKey(witnessSecret) !== attestationEvent?.pubkey || !HEX64.test(recipientPubkey || '')
    || getEventHash(attestationEvent) !== attestationEvent.id || !verifyEvent(attestationEvent)) {
    throw new Error('A signed peer checkpoint and its witness credential are required.');
  }
  const rumor = nip59.createRumor({ kind: 4, created_at: now,
    tags: rumorTags({ recipient: recipientPubkey }), content: JSON.stringify({ protocol: `${PROTOCOL}-delivery`, version: 1, attestationEvent }) }, witnessSecret);
  return sealAndWrap(rumor, { senderSk: witnessSecret, recipientPubkey }).wrap;
}

export function openPeerCheckpointAttestationWrap({ wrap, recipientSecret, expectedWitnessPubkey } = {}) {
  try {
    const opened = unwrapToRumor(wrap, recipientSecret);
    const rumor = opened?.rumor;
    const recipient = getPublicKey(recipientSecret);
    if (rumor?.kind !== 4 || rumor.pubkey !== expectedWitnessPubkey
      || rumor.tags.filter((tag) => tag[0] === 'p').length !== 1
      || rumor.tags.find((tag) => tag[0] === 'p')?.[1] !== recipient) return null;
    const body = parse(rumor);
    const event = body?.attestationEvent;
    if (body?.protocol !== `${PROTOCOL}-delivery` || body.version !== 1
      || event?.pubkey !== expectedWitnessPubkey || getEventHash(event) !== event.id || !verifyEvent(event)) return null;
    return event;
  } catch { return null; }
}
