import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { groupTimelinePlans } from '../lib/crypto/groupMembership.js';

// One stored value, one frame shape. The session stores the plan's FILTER
// ARRAY (session.subs.set(subId, plan.filters)) and a NIP-01 REQ frame
// carries those filters spread as top-level elements. The first subscribe
// did that. The post-AUTH flush sent the array nested one level deep
// (['REQ', subId, filter] where filter IS the stored array), so every
// resubscribe-after-auth was a malformed frame on any relay that validates
// frame shape. This walks the hook's own send expressions off the tree and
// executes each one against the SAME stored value: both must stringify to
// the same canonical frame.

const SOURCE = readFileSync(new URL('./useNIP29Group.js', import.meta.url), 'utf8');

// Every REQ frame this hook can put on the wire. The third element's
// expression is captured verbatim from the tree and re-executed below.
const REQ_SEND = /session\.ws\.send\(JSON\.stringify\(\['REQ',\s*subId,\s*(.*?)\]\)\);/g;

function lineOf(index) {
  return SOURCE.slice(0, index).split('\n').length;
}

test('wire control authorization uses only held verified governance standing', () => {
  const start = SOURCE.indexOf('async function controlContext(');
  const end = SOURCE.indexOf('\nasync function actorPinForMember', start);
  assert.ok(start >= 0 && end > start, 'control context is located');
  const block = SOURCE.slice(start, end);
  assert.match(block, /loadVerifiedMemberSnapshot\(groupId\)/);
  assert.match(block, /controlMembersFromDocument\(documentMembers\)/);
  assert.doesNotMatch(block, /state\.groupMembers|group\?\.members|loadMemberSnapshot\(/);
});

test('group AUTH and EVENT websocket sends are fenced by their captured account context', () => {
  const authStart = SOURCE.indexOf('function sendAuthResponse(session, challenge) {');
  const authEnd = SOURCE.indexOf('\n}', authStart) + 2;
  const auth = SOURCE.slice(authStart, authEnd);
  assert.match(auth, /assertSecurityContextOwner\(session\.identity\.securityFence, session\.identity\.pk\)/);
  assert.match(auth, /assertSecurityContextOwner\(session\.identity\?\.securityFence, session\.identity\?\.pk\);[\s\S]*?session\.ws\.send\(JSON\.stringify\(\['AUTH'/);

  const publishStart = SOURCE.indexOf('async function publishAuthedGroupEvent(identity, event) {');
  const publishEnd = SOURCE.indexOf('\n}', publishStart) + 2;
  const publish = SOURCE.slice(publishStart, publishEnd);
  assert.match(publish, /await whenGroupAuthed\(session\);\s*assertSecurityContextOwner\(identity\.securityFence, identity\.pk\)/);
  assert.match(publish, /assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);\s*session\.ws\.send\(JSON\.stringify\(\['EVENT'/);
  assert.match(publish, /\}\);\s*assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);\s*return event/);
});

test('group-key DM publisher rechecks the account fence before and after relay awaits', () => {
  const start = SOURCE.indexOf('async function publishKeyDm(identity, dmEvent) {');
  const end = SOURCE.indexOf('\n}', start) + 2;
  const body = SOURCE.slice(start, end);
  assert.match(body, /assertSecurityContextOwner\(identity\?\.securityFence, identity\?\.pk\);[\s\S]*?await relaysForPeer[\s\S]*?assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);/);
  assert.match(body, /await getAuthenticatedPool\(identity\);\s*assertSecurityContextOwner\(identity\.securityFence, identity\.pk\)/);
  assert.match(body, /await Promise\.allSettled\(pool\.publish\([\s\S]*?\);\s*assertSecurityContextOwner\(identity\.securityFence, identity\.pk\)/);
});

test('stale group sockets drop inbound frames and cannot reconnect after account invalidation', () => {
  const frameStart = SOURCE.indexOf('function handleGroupSocketFrame(session, raw) {');
  const frameEnd = SOURCE.indexOf('\n}', frameStart) + 2;
  assert.match(SOURCE.slice(frameStart, frameEnd), /^function handleGroupSocketFrame\(session, raw\) \{\s*try \{ assertSecurityContextOwner\(session\.identity\?\.securityFence, session\.identity\?\.pk\); \}/);

  const connectStart = SOURCE.indexOf('function connectGroupSocket(session) {');
  const connectEnd = SOURCE.indexOf('\n}', connectStart) + 2;
  const connect = SOURCE.slice(connectStart, connectEnd);
  assert.match(connect, /if \(session\.closed\) return;\s*try \{ assertSecurityContextOwner\(session\.identity\?\.securityFence, session\.identity\?\.pk\); \}/);
  assert.match(connect, /ws\.onopen = \(\) => \{\s*try \{ assertSecurityContextOwner/);
  assert.match(connect, /ws\.onclose = \(event\) => \{[\s\S]*?assertSecurityContextOwner[\s\S]*?if \(!session\.closed\)/);
});

test('queued group sends are fenced before retry and before clearing their durable queue row', () => {
  const start = SOURCE.indexOf('export async function flushSecuringGroupSends(identity, groupId) {');
  const end = SOURCE.indexOf('\n}', start) + 2;
  const body = SOURCE.slice(start, end);
  assert.match(body, /assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);\s*if \(await isGroupRotationPending/);
  assert.match(body, /await resolveActorSigner\([\s\S]*?assertSecurityContextOwner\(identity\.securityFence, identity\.pk\)/);
  assert.match(body, /await encodeGroupPayload\([\s\S]*?assertSecurityContextOwner\(identity\.securityFence, identity\.pk\)/);
  assert.match(body, /await publishAuthedGroupEvent\(identity, event\);\s*assertSecurityContextOwner\(identity\.securityFence, identity\.pk\);\s*dropSecuringSend/);
  assert.match(body, /await getCurrentGroupKey\(groupId, identity\.securityFence\);\s*assertSecurityContextOwner\(identity\.securityFence, identity\.pk\)/);
});

function frameFromExpression(expression, bindings) {
  // Re-executes the captured send expression's array literal with the
  // names the send site itself uses, bound to the stored value.
  const build = new Function(
    'subId',
    'plan',
    'filter',
    'session',
    `'use strict'; return ['REQ', subId, ${expression}];`,
  );
  return JSON.stringify(build(bindings.subId, bindings.plan, bindings.filter, bindings.session));
}

test('the auth flush sends the same REQ frame the first subscribe sends', () => {
  // Name the stored value: this line is what both sends draw from.
  assert.match(
    SOURCE,
    /session\.subs\.set\(subId,\s*plan\.filters\)/,
    'the session stores the plan filter array under the sub id',
  );

  const sites = [...SOURCE.matchAll(REQ_SEND)].map((match) => ({
    expression: match[1],
    line: lineOf(match.index),
    index: match.index,
  }));
  assert.equal(
    sites.length,
    2,
    `expected exactly two REQ sends (first subscribe + auth flush), found ${sites.length}`,
  );

  // Pin each site by WHERE it lives, not by its shape: the flush is the REQ
  // send inside flushGroupSubs, the first subscribe is the REQ send three
  // lines under the store. Pinning by shape would let both sites drift
  // together.
  const flushBodyMatch = SOURCE.match(/function flushGroupSubs\(session\) \{[\s\S]*?\n\}/);
  assert.ok(flushBodyMatch, 'flushGroupSubs is present');
  const flushBodyStart = flushBodyMatch.index;
  const flushBodyEnd = flushBodyMatch.index + flushBodyMatch[0].length;
  const inFlushBody = sites.filter(
    (site) => site.index >= flushBodyStart && site.index < flushBodyEnd,
  );
  assert.equal(inFlushBody.length, 1, 'exactly one REQ send inside flushGroupSubs: the flush');
  const flush = inFlushBody[0];

  const storeMatch = SOURCE.match(/session\.subs\.set\(subId,\s*plan\.filters\);/);
  assert.ok(storeMatch, 'the store statement is present');
  const afterStore = SOURCE.slice(storeMatch.index, storeMatch.index + 400);
  const subscribeMatch = afterStore.match(
    /session\.ws\.send\(JSON\.stringify\(\['REQ',\s*subId,\s*(.*?)\]\)\);/,
  );
  assert.ok(
    subscribeMatch,
    'the first subscribe sends a REQ frame right after storing the plan filters',
  );
  const subscribe = {
    expression: subscribeMatch[1],
    line: lineOf(storeMatch.index + afterStore.indexOf(subscribeMatch[0])),
  };

  // The SAME stored value feeds both expressions, exactly as the hook binds
  // them: the subscribe reads plan.filters, the flush loop destructures the
  // stored map entry into `filter`.
  const plans = groupTimelinePlans(['g:flush-frame'], 123);
  const subId = 'group-sub-g:flush-frame-1a2b3c';
  const bindings = {
    subId,
    plan: plans[0],
    session: { subs: new Map([[subId, plans[0].filters]]) },
  };
  bindings.filter = bindings.session.subs.get(subId);
  const stored = plans[0].filters;
  const canonical = JSON.stringify(['REQ', subId, ...stored]);

  const firstFrame = frameFromExpression(subscribe.expression, bindings);
  const flushFrame = frameFromExpression(flush.expression, bindings);

  assert.equal(
    firstFrame,
    canonical,
    `the first subscribe (useNIP29Group.js:${subscribe.line}, the working path) spreads the stored filters`,
  );
  assert.equal(
    flushFrame,
    firstFrame,
    `the auth flush frame (useNIP29Group.js:${flush.line}) must equal the first-subscribe frame`,
  );
  assert.equal(
    flushFrame,
    canonical,
    `the auth flush frame (useNIP29Group.js:${flush.line}) must carry the stored filters spread, not nested`,
  );
});

test('a live member-doc event reaches the ingest door and only that arm', () => {
  // Step 2 slice 3 live arm: docs have no h tag, so onFrame must strip their
  // prefixed d-tag into a bare gid BEFORE any subscriber gating, then route
  // kind 30079 alone into refreshMemberDocs (which verifies-then-stores);
  // returning there keeps a doc from falling into control/message arms that
  // would read it as something else.
  const groupIdMatch = SOURCE.match(/let groupId = event\.tags\.find\(\(tag\) => tag\[0\] === 'h'\)/);
  assert.ok(groupIdMatch, 'onFrame derives the gid tolerating the h-less doc shape');
  const after = SOURCE.slice(groupIdMatch.index, groupIdMatch.index + 1200);
  assert.match(after, /MEMBER_DOC_D_PREFIX/, 'the doc d-tag prefix is stripped to the bare gid');
  const routeIdx = after.search(new RegExp(`if \\(event\\.kind === MEMBER_DOC_KIND\\)`));
  assert.ok(routeIdx !== -1, 'kind 30079 has its own routing arm');
  const arm = after.slice(routeIdx, routeIdx + 220);
  assert.match(arm, /refreshMemberDocs\(identity, groupId\)/, 'the arm ingests through the verify-then-store door');
  const snapshotIdx = after.indexOf('event.kind === 39002');
  assert.ok(snapshotIdx !== -1 && snapshotIdx > routeIdx,
    'the doc arm returns before the roster-snapshot arm can see a doc event');
});

test('the pinned-slot read never names the account when the actor pin is missing', () => {
  // A missing actor pin widens the read rather than linking account and group
  // in the relay-visible authors filter.
  const idx = SOURCE.search(/ownerAuthorFilter/);
  assert.ok(idx !== -1, 'the dedicated owner-pin filter exists');
  const block = SOURCE.slice(idx, idx + 1800);
  assert.match(block, /actor \? \{ authors: \[actor\] \} : \{\}/,
    'a held pin filters by actor; no pin removes author filtering');
  assert.doesNotMatch(block, /standing\.creator, \.\.\.\(actor/,
    'the both-shapes array is gone');
  // Second leg from the same capture: on the creator's own device the pin
  // is known by construction even when the snapshot still holds plain rows.
  assert.match(block, /readAuthorityPin\(identity\.pk, groupId\)/,
    'the creator device answers from its own out-of-band pin');
});

test('moderation targets group actors and resolves them through the verified roster', () => {
  assert.match(SOURCE, /\['p', targetPin\.slice\(2\)\]/,
    '9000 and 9001 target the actor wire key instead of the account key');
  assert.match(SOURCE, /resolveControlSender\(\{ wirePubkey: rawSubject, members \}\)/,
    'receivers map the p-tag back through a governance-bound actor pin');
  const targetActions = SOURCE.slice(SOURCE.indexOf('const kickMember'), SOURCE.indexOf('const updateGroupSettings'));
  assert.doesNotMatch(targetActions, /\['p',\s*memberPubkey\]/,
    'no moderation action puts an account pubkey in a relay p-tag');
});

test('shared-key message attribution never creates account-to-actor authorization bindings', () => {
  assert.doesNotMatch(SOURCE, /rememberActorBinding\([^\n]*actBy/,
    'a group member cannot turn its shared-key by claim into a governance identity binding');
  assert.match(SOURCE, /openAdmissionRequest\(\{ identity, groupId, event: pending\.requestEvent \}\)/,
    'approval re-verifies the signed encrypted ticket from storage');
  assert.match(SOURCE, /proof\.accountPubkey !== String\(memberPubkey/,
    'the proof account must match the person the owner approved');
});

test('SEC-2: the gkey arm resolves the requester through verified bindings, not the body claim', () => {
  // The arm used to answer `requesterAccount = actBy !== event.pubkey ? actBy : ''`
  // straight off the sealed body's `by` — a claim by the actor key holder, not
  // a binding. It now resolves the wire actor against roster rows exactly as
  // control acts do, and only falls back to a member-naming claim when the
  // actor is unbound. Reverting this drops the resolver call.
  const idx = SOURCE.search(/type === 'gkey_req'/);
  assert.ok(idx !== -1, 'the gkey arm exists');
  const block = SOURCE.slice(idx, idx + 2600);
  assert.match(block, /resolveKeyRequestRequester\(\{/,
    'the arm resolves through the binding helper');
  assert.match(block, /wirePubkey: event\.pubkey/,
    'the wire signer is the resolution input');
  assert.match(block, /bodyBy: actBy/,
    'the body claim is still available, but only as the helper\'s fallback');
  assert.doesNotMatch(block, /const requesterAccount = actBy !== event\.pubkey/,
    'the raw-claim derivation is gone');
  assert.match(SOURCE, /const messageMembers = await loadVerifiedMemberSnapshot\(groupId\)/,
    'only signed governance standing feeds sender and requester resolution');
  assert.match(block, /snapshot: requesterMembers,/,
    'the live grant request does not fall back to relay or cached roster data');
  assert.match(block, /recipients: \[requester\]/,
    'the bundle is addressed to the resolved account, not the actor pin');
});

test('SEC-1: createGroup passes its stored genesis secret to the real document publisher', () => {
  const createStart = SOURCE.indexOf('const createGroup = useCallback');
  assert.ok(createStart >= 0, 'createGroup implementation exists');
  const publishStart = SOURCE.indexOf('buildMemberDocEvent({', createStart);
  assert.ok(publishStart >= 0, 'createGroup builds and publishes its genesis member document');
  const call = SOURCE.slice(publishStart, SOURCE.indexOf('});', publishStart) + 2);
  assert.match(call, /docKey:\s*genesisDocKey/, 'the real genesis caller supplies the held random key');
  const preCreate = SOURCE.slice(createStart, SOURCE.indexOf('const createEv', createStart));
  assert.match(preCreate, /putDocKey\(groupId,\s*1,\s*generatedDocKey,\s*identity\.securityFence\)/,
    'createGroup persists the random secret through its captured account context before publishing');
  assert.match(preCreate, /if \(!genesisDocKey\)\s*\{[\s\S]*?throw new Error/,
    'createGroup stops before publishing if secure key storage fails');
});

test('group mutations recheck the account incarnation before durable, relay, and UI effects', () => {
  const create = SOURCE.slice(SOURCE.indexOf('const createGroup = useCallback'), SOURCE.indexOf('const joinGroupById = useCallback'));
  assert.match(create, /await getAuthenticatedPool\(identity\);\s*assertSecurityContextOwner/);
  assert.match(create, /await Promise\.allSettled\(pool\.publish\(groupRelays, createEv\)\);\s*assertSecurityContextOwner/);
  assert.match(create, /distributeGroupKey\(\{[\s\S]*?securityFence: identity\.securityFence/);
  assert.match(create, /rememberMembers\(groupId, \[identity\.pk\], \{ securityFence:/);

  const send = SOURCE.slice(SOURCE.indexOf('const sendGroupMessage = useCallback'), SOURCE.indexOf('const requestGroupKey = useCallback'));
  assert.match(send, /await encodeGroupPayload\([\s\S]*?\);\s*assertSecurityContextOwner/);
  assert.match(send, /reserveMessageEffect\(\{[\s\S]*?securityFence: identity\.securityFence/);
  assert.match(send, /completeMessageEffect\(\{[\s\S]*?securityFence: identity\.securityFence/);
  assert.match(send, /publishWriteAhead\([\s\S]*?assertCurrent: \(\) => assertSecurityContextOwner/);
  assert.match(send, /SECURITY_CONTEXT_EXPIRED/);

  const memberOps = SOURCE.slice(SOURCE.indexOf('const kickMember = useCallback'), SOURCE.indexOf('const updateGroupSettings = useCallback'));
  assert.match(memberOps, /publishMemberDocUpdate\(groupId, standing, \{ roleChanges: \{ \[account\]: nextRole \}, securityFence:/);
  assert.match(memberOps, /publishMemberDocUpdate\(groupId, nextMembers, \{ pins: observedPins, securityFence:/);
  assert.match(memberOps, /rememberMembers\(groupId, nextMembers, \{[\s\S]*?securityFence:/);
});

test('group frame ingestion and history refresh discard stale-context effects', () => {
  const subscription = SOURCE.slice(SOURCE.indexOf('const subscribeToGroups = useCallback'));
  assert.match(subscription, /const assertCurrent = \(\) => assertSecurityContextOwner\(identity\?\.securityFence, identity\?\.pk\)/);
  assert.match(subscription, /const onFrame = async \(msg\) => \{\s*try \{ assertCurrent\(\); \} catch \{ return; \}/);
  assert.match(subscription, /await rememberMembers\(groupId, members, \{ securityFence: identity\.securityFence, owner: identity\.pk \}\);\s*assertCurrent\(\);/);
  assert.match(subscription, /await saveMessageOnce\(groupId, baseMsg\);\s*assertCurrent\(\);/);
  assert.match(subscription, /await saveMessage\(groupId, baseMsg\);\s*assertCurrent\(\);/);
  assert.match(subscription, /keyHandler = async \(e\) => \{[\s\S]*?try \{ assertCurrent\(\); \} catch \{ return; \}/);
  assert.match(subscription, /await decodeGroupEvent\([\s\S]*?\);\s*assertCurrent\(\);/);
});
