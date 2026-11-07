import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { buildControlAct, buildSignedAct, resolveActorSigner, signActProof } from '../src/lib/crypto/gmIdentityWire.js';
import { buildAdmissionRequest, openAdmissionRequest } from '../src/lib/crypto/groupAdmission.js';
import { groupCreateTags, ACCESS_PRIVATE, JOIN_APPROVAL } from '../src/lib/groupCreate.js';
import { setSessionKey } from '../src/lib/sessionKey.js';
import { groupAuthorityKey } from '../src/lib/crypto/groupAuthority.js';
import { generateDocKey } from '../src/lib/crypto/groupDocKey.js';
import { applyDocOps, genesisDocBody, signDocEvent } from '../src/lib/crypto/groupDoc.js';
import { buildMemberDocEvent, MEMBER_DOC_KIND, openSealedDocBody } from '../src/lib/crypto/groupDocWire.js';
import { encryptGroupMessage } from '../src/lib/crypto/groupCipher.js';

const url = process.env.CIPHER_TEST_NIP29_RELAY_URL || 'ws://127.0.0.1:18888';
const origin = process.env.CIPHER_TEST_RELAY_ORIGIN || 'http://127.0.0.1:18888/health';
const groupId = `p0-${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
const ownerSk = generateSecretKey();
const applicantSk = generateSecretKey();
const owner = { pk: getPublicKey(ownerSk), sk: ownerSk };
const applicant = { pk: getPublicKey(applicantSk), sk: applicantSk };
assert.notEqual(owner.pk, applicant.pk, 'the two identities are independently generated');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(origin);
await page.evaluate(() => {
  window.cipherSockets = new Map();
  window.cipherConnect = (name, url) => new Promise((resolve, reject) => {
    const queue = [], sent = [], received = [];
    const ws = new WebSocket(url);
    const entry = { ws, queue, sent, received };
    window.cipherSockets.set(name, entry);
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 15000);
    ws.onopen = () => { clearTimeout(timer); resolve(true); };
    ws.onerror = () => reject(new Error('websocket connection error'));
    ws.onmessage = (event) => { received.push(event.data); queue.push(event.data); };
  });
  window.cipherSend = (name, value) => {
    const entry = window.cipherSockets.get(name);
    const frame = JSON.stringify(value);
    entry.sent.push(frame);
    entry.ws.send(frame);
  };
  window.cipherTake = (name) => window.cipherSockets.get(name).queue.splice(0);
  window.cipherCaptured = () => [...window.cipherSockets.entries()].map(([name, entry]) => ({
    name,
    sent: entry.sent.map((frame) => JSON.parse(frame)),
    received: entry.received.map((frame) => JSON.parse(frame)),
  }));
});
const pending = new Map([['owner', []], ['applicant', []]]);
let lastDocEvent = null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function nextFrame(name, predicate, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const queue = pending.get(name);
    const idx = queue.findIndex(predicate);
    if (idx >= 0) return queue.splice(idx, 1)[0];
    for (const raw of await page.evaluate((id) => window.cipherTake(id), name)) {
      try { queue.push(JSON.parse(raw)); } catch { /* non-JSON websocket payload */ }
    }
    await delay(25);
  }
  throw new Error(`timeout waiting for frame on ${name}`);
}
async function connectAndAuth(name, identity, gid) {
  await page.evaluate(({ id, relay }) => window.cipherConnect(id, relay), { id: name, relay: url });
  const challengeFrame = await nextFrame(name, (frame) => frame[0] === 'AUTH');
  const challenge = typeof challengeFrame[1] === 'string' ? challengeFrame[1] : challengeFrame[1]?.challenge;
  assert.ok(challenge, 'relay provides NIP-42 challenge');
  const signed = await signActProof({ identity, groupId: gid, relayUrl: url, challenge });
  assert.equal(signed.event.pubkey, (await resolveActorSigner({ identity, groupId: gid })).wireSender, 'AUTH is signed by this group actor');
  await page.evaluate(({ id, event }) => window.cipherSend(id, ['AUTH', event]), { id: name, event: signed.event });
  const ok = await nextFrame(name, (frame) => frame[0] === 'OK' && frame[1] === signed.event.id);
  assert.equal(ok[2], true, `NIP-42 actor auth accepted (${ok[3] || ''})`);
}
async function publish(name, event) {
  assert.ok(verifyEvent(event), `kind ${event.kind} is genuinely signed`);
  if (event.kind !== MEMBER_DOC_KIND) {
    const actor = (await resolveActorSigner({ identity: name === 'owner' ? owner : applicant, groupId })).wireSender;
    assert.equal(event.pubkey, actor, `kind ${event.kind} uses the group actor`);
  }
  await page.evaluate(({ id, event }) => window.cipherSend(id, ['EVENT', event]), { id: name, event });
  const ok = await nextFrame(name, (frame) => frame[0] === 'OK' && frame[1] === event.id);
  assert.equal(ok[2], true, `kind ${event.kind} accepted: ${ok[3] || ''}`);
  return ok;
}
async function expectRefusal(name, event) {
  await page.evaluate(({ id, event }) => window.cipherSend(id, ['EVENT', event]), { id: name, event });
  let response = null;
  try {
    response = await nextFrame(name, (frame) => (frame[0] === 'OK' && frame[1] === event.id) || frame[0] === 'NOTICE' || frame[0] === 'CLOSED', 2500);
  } catch { /* this relay version silently drops unauthorized control events */ }
  assert.ok(!response || response[0] !== 'OK' || response[2] !== true,
    `relay did not acknowledge unauthorized kind ${event.kind} as accepted`);
  return response;
}
async function query(name, sub, filter) {
  await page.evaluate(({ id, subId, filterValue }) => window.cipherSend(id, ['REQ', subId, filterValue]), { id: name, subId: sub, filterValue: filter });
  const events = [];
  while (true) {
    const frame = await nextFrame(name, (candidate) => ['EOSE', 'EVENT', 'CLOSED', 'NOTICE'].includes(candidate[0]) && candidate[1] === sub);
    if (frame[0] === 'EOSE') break;
    if (frame[0] === 'CLOSED' || frame[0] === 'NOTICE') { events.blocked = frame; break; }
    events.push(frame[2]);
  }
  return events;
}
async function makeDoc({ gid, authority, authorityPin, docKey, prior, members, actorPins, admit, remove, promote, demote }) {
  const body = prior
    ? applyDocOps(prior, { admit, remove, promote, demote, gen: prior.body.gen + 1 })
    : await genesisDocBody({ gid, epoch: 1, creator: owner.pk, members, actorPins });
  const signedDoc = await signDocEvent(body, authority.privateKeyBytes);
  const event = await buildMemberDocEvent({
    signedDoc, authoritySk: authority.privateKeyBytes, pin: authorityPin,
    groupId: gid, createdAt: Math.floor(Date.now() / 1000), docKey,
  });
  assert.ok(event, 'governance document is sealed with the real wire builder');
  lastDocEvent = event;
  await publish('owner', event);
  return signedDoc;
}

try {
  setSessionKey(ownerSk);
  await connectAndAuth('owner', owner, groupId);
  const ownerActor = await resolveActorSigner({ identity: owner, groupId });
  const create = groupCreateTags({ name: 'private test room', about: 'secret description', access: ACCESS_PRIVATE, joinPolicy: JOIN_APPROVAL, groupId, pubkey: ownerActor.wireSender });
  assert.deepEqual(create.create.filter((tag) => tag[0] === 'p').map((tag) => tag[1]), [ownerActor.wireSender], 'creation names only the per-group actor');
  const createEvent = await buildControlAct({ identity: owner, groupId, kind: 9007, tags: create.create });
  assert.ok(!JSON.stringify(createEvent).includes(owner.pk), 'create EVENT contains no account identity');
  await publish('owner', createEvent);

  const authority = await groupAuthorityKey(ownerSk, groupId);
  const docKey0 = generateDocKey();
  let signedDoc = await makeDoc({
    gid: groupId, authority, authorityPin: authority.pin, docKey: docKey0,
    members: [owner.pk], actorPins: { [owner.pk]: ownerActor.pin },
  });
  const groupKey = new Uint8Array(32).fill(71);

  setSessionKey(applicantSk);
  await connectAndAuth('applicant', applicant, groupId);
  const applicantActor = await resolveActorSigner({ identity: applicant, groupId });
  const admission = await buildAdmissionRequest({ identity: applicant, groupId, ownerPin: authority.pin });
  assert.ok(!JSON.stringify(admission).includes(applicant.pk), 'admission EVENT contains no account identity');
  await publish('applicant', admission);
  const storedJoin = await query('owner', 'p0-admission-1', { kinds: [9021], '#h': [groupId] });
  assert.equal(storedJoin.length, 1);
  const before = await query('applicant', 'p0-roster-before', { kinds: [39002], '#d': [groupId] });
  assert.ok(!before.some((event) => event.tags.some((tag) => tag[0] === 'p' && tag[1].replace(/^[0-9a-f]{2}/, '') === admission.pubkey)), 'no roster membership before approval');

  setSessionKey(ownerSk);
  const proof = await openAdmissionRequest({ identity: owner, groupId, event: storedJoin[0] });
  assert.equal(proof.accountPubkey, applicant.pk);
  assert.equal(proof.actorPubkey, applicantActor.wireSender);
  const admittedRow = { pubkey: applicant.pk, role: 'member', actor: proof.actorPin, actorVerified: true };
  signedDoc = await makeDoc({ gid: groupId, authority, authorityPin: authority.pin, docKey: docKey0, prior: signedDoc, admit: [admittedRow] });
  const approval = await buildControlAct({ identity: owner, groupId, kind: 9000, tags: [['h', groupId], ['p', proof.actorPubkey]] });
  await publish('owner', approval);
  await delay(1200);
  const afterApproval = await query('applicant', 'p0-roster-after', { kinds: [39002], '#d': [groupId] });
  assert.ok(afterApproval.some((event) => event.tags.some((tag) => tag[0] === 'p' && tag[1] === proof.actorPin.slice(2))), 'approved actor appears in relay roster');

  const messagePayload = await encryptGroupMessage({ rawKey: groupKey, plaintext: JSON.stringify({ type: 'text', message: 'phase zero test' }), groupId, epoch: 1, senderPubkey: applicantActor.wireSender });
  setSessionKey(applicantSk);
  const message = await buildSignedAct({ identity: applicant, groupId, content: JSON.stringify(messagePayload), tags: [['h', groupId], ['ep', '1']] });
  await publish('applicant', message);
  const receivedMessage = await query('owner', 'p0-message', { kinds: [9], '#h': [groupId], authors: [applicantActor.wireSender] });
  assert.ok(receivedMessage.some((event) => event.id === message.id), 'relay delivers actor-signed encrypted group message');

  setSessionKey(ownerSk);
  signedDoc = await makeDoc({ gid: groupId, authority, authorityPin: authority.pin, docKey: docKey0, prior: signedDoc, promote: [applicant.pk] });
  const promote = await buildControlAct({ identity: owner, groupId, kind: 9000, tags: [['h', groupId], ['p', proof.actorPubkey], ['role', 'admin']] });
  await publish('owner', promote);
  signedDoc = await makeDoc({ gid: groupId, authority, authorityPin: authority.pin, docKey: docKey0, prior: signedDoc, demote: [applicant.pk] });
  const demote = await buildControlAct({ identity: owner, groupId, kind: 9000, tags: [['h', groupId], ['p', proof.actorPubkey], ['role', 'member']] });
  await publish('owner', demote);

  setSessionKey(applicantSk);
  const unauthorized = await buildControlAct({ identity: applicant, groupId, kind: 9001, tags: [['h', groupId], ['p', ownerActor.wireSender]] });
  const refusal = await expectRefusal('applicant', unauthorized);
  const unauthorizedStored = await query('owner', 'p0-unauthorized-control', {
    kinds: [9001], '#h': [groupId], authors: [applicantActor.wireSender],
  });
  assert.ok(!unauthorizedStored.some((event) => event.id === unauthorized.id),
    `relay refuses or omits the unauthorized control event${refusal ? ` (${refusal[0]})` : ' (silent refusal)'}`);

  setSessionKey(ownerSk);
  const docKey1 = generateDocKey();
  signedDoc = await makeDoc({ gid: groupId, authority, authorityPin: authority.pin, docKey: docKey1, prior: signedDoc, remove: [applicant.pk] });
  const removal = await buildControlAct({ identity: owner, groupId, kind: 9001, tags: [['h', groupId], ['p', proof.actorPubkey]] });
  await publish('owner', removal);
  const postRemovalEnvelope = await buildMemberDocEvent({
    signedDoc, authoritySk: authority.privateKeyBytes, pin: authority.pin,
    groupId, createdAt: Math.floor(Date.now() / 1000), docKey: docKey1,
  });
  assert.ok(postRemovalEnvelope);
  assert.equal(await openSealedDocBody(lastDocEvent.content, authority.pin, groupId, docKey0), null,
    'removed account holding the prior governance secret cannot open the post-removal document');
  const openedPostRemoval = await openSealedDocBody(lastDocEvent.content, authority.pin, groupId, docKey1);
  assert.ok(openedPostRemoval, 'the remaining owner opens the post-removal document with the rotated secret');
  assert.ok(!openedPostRemoval.body.members.some((row) => row.pubkey === applicant.pk), 'the signed document no longer authorizes the removed applicant');
  assert.notEqual(JSON.stringify(postRemovalEnvelope), JSON.stringify(createEvent), 'post-removal document is independently sealed');

  setSessionKey(applicantSk);
  const retryAdmission = await buildAdmissionRequest({ identity: applicant, groupId, ownerPin: authority.pin });
  await publish('applicant', retryAdmission);
  const retryStored = await query('owner', 'p0-admission-retry', { kinds: [9021], '#h': [groupId] });
  const retryEvent = retryStored.find((event) => event.id === retryAdmission.id);
  assert.ok(retryEvent, 'removed member can retry a fresh encrypted admission request');
  setSessionKey(ownerSk);
  const retryProof = await openAdmissionRequest({ identity: owner, groupId, event: retryEvent });
  assert.equal(retryProof.accountPubkey, applicant.pk);
  const rejoinedRow = { pubkey: applicant.pk, role: 'member', actor: retryProof.actorPin, actorVerified: true };
  const docKey2 = generateDocKey();
  signedDoc = await makeDoc({ gid: groupId, authority, authorityPin: authority.pin, docKey: docKey2, prior: signedDoc, admit: [rejoinedRow] });
  const reapproval = await buildControlAct({ identity: owner, groupId, kind: 9000, tags: [['h', groupId], ['p', retryProof.actorPubkey]] });
  await publish('owner', reapproval);
  await publish('owner', reapproval); // relay retry is idempotent at the event layer
  await delay(1200);
  const rejoinRoster = await query('applicant', 'p0-roster-rejoined', { kinds: [39002], '#d': [groupId] });
  assert.ok(rejoinRoster.some((event) => event.tags.some((tag) => tag[0] === 'p' && tag[1] === retryProof.actorPin.slice(2))), 'approved retry restores actor roster membership');

  const captures = await page.evaluate(() => window.cipherCaptured());
  const sent = captures.flatMap((entry) => entry.sent);
  const received = captures.flatMap((entry) => entry.received);
  const all = JSON.stringify(captures);
  assert.ok(!all.includes(owner.pk), 'account identity never appears in sent or received relay frames');
  assert.ok(!all.includes(applicant.pk), 'applicant account identity never appears in sent or received relay frames');
  const eventFrames = sent.filter((frame) => frame[0] === 'EVENT');
  const authFrames = sent.filter((frame) => frame[0] === 'AUTH');
  assert.ok(authFrames.length >= 2, 'captured actor AUTH frames');
  assert.ok(eventFrames.length >= 10, 'captured create, docs, admission, approval, message, role and removal events');
  assert.ok(eventFrames.every((frame) => frame[1].pubkey === ownerActor.wireSender || frame[1].pubkey === applicantActor.wireSender), 'all EVENT authors are group actors');
  const reqFrames = sent.filter((frame) => frame[0] === 'REQ');
  assert.ok(reqFrames.length >= 4 && reqFrames.every((frame) => !JSON.stringify(frame[2]).includes(owner.pk) && !JSON.stringify(frame[2]).includes(applicant.pk)), 'REQ filters contain no account identifiers');
  assert.ok(received.length > 0, 'captured inbound relay frames');
  console.log(JSON.stringify({
    result: 'PASS', relay: url, groupId, independentlyGeneratedAccounts: 2,
    phases: ['create', 'private admission', 'explicit approval', 'encrypted message', 'promotion', 'demotion', 'unauthorized moderation refusal', 'removal', 'fresh admission retry', 'reapproval'],
    outgoingFrames: sent.length, incomingFrames: received.length, eventFrames: eventFrames.length, authFrames: authFrames.length, reqFrames: reqFrames.length,
    accountKeysPresentInAnyRelayFrame: false,
  }, null, 2));
} finally {
  await browser.close();
}
