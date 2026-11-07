import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useNIP29Group } from '../src/hooks/useNIP29Group.js';
import { useNIP44DM } from '../src/hooks/useNIP44DM.js';
import { useChatStore } from '../src/store/chatStore.js';
import { setSessionKey } from '../src/lib/sessionKey.js';
import { getSessionKey } from '../src/lib/sessionKey.js';
import { openDBFor } from '../src/db.js';
import { currentOwner } from '../src/db.js';
import { getCurrentGroupKey, getDocKey, putDocKey } from '../src/lib/crypto/groupKeyStore.js';
import { isJoinDenied, pendingJoinsFor } from '../src/lib/groupJoinQueue.js';
import { readAuthorityPin, rememberAuthorityPin } from '../src/lib/crypto/authorityPins.js';
import { authorityPinGetterFor } from '../src/lib/crypto/authorityPins.js';
import { bindMemberDocPins } from '../src/lib/crypto/memberDocStanding.js';
import { joinGroup } from '../src/lib/groupJoin.js';

const identityData = window.__cipherPhase0Identity;
if (!identityData?.pk || !Array.isArray(identityData.sk)) {
  throw new Error('Phase 0 hook harness requires an in-memory test identity.');
}
const identity = { pk: identityData.pk, sk: Uint8Array.from(identityData.sk) };
setSessionKey(identity.sk);
await openDBFor(identity.pk);
bindMemberDocPins(authorityPinGetterFor(identity.pk));

function Harness() {
  const [, setGroups] = useState([]);
  const api = useNIP29Group({ identity });
  const dm = useNIP44DM({ identity });
  const subscribeToDMs = dm.subscribeToDMs;
  useEffect(() => {
    window.__cipherPhase0 = {
      identity,
      api,
      unlocked: Boolean(getSessionKey()),
      databaseOwner: currentOwner(),
      setGroups,
      pendingJoinsFor,
      isDenied: (groupId, account) => isJoinDenied(groupId, account),
      joinGroup,
      readAuthorityPin,
      rememberAuthorityPin,
      getDocKey,
      putDocKey,
      getCurrentGroupKey,
      readMemberStanding: async (groupId) => {
        const { loadVerifiedMemberSnapshot } = await import('../src/lib/crypto/groupKeyRotation.js');
        return loadVerifiedMemberSnapshot(groupId);
      },
      debugGrantDecision: async (groupId, requester) => {
        const { grantKeyRequest, loadMemberSnapshotRecord, isGroupRotationPending } = await import('../src/lib/crypto/groupKeyRotation.js');
        const snapshot = await window.__cipherPhase0.readMemberStanding(groupId);
        const record = await loadMemberSnapshotRecord(groupId);
        const current = await getCurrentGroupKey(groupId);
        return {
          rotationPending: await isGroupRotationPending(groupId),
          denied: isJoinDenied(groupId, requester),
          pendingJoin: pendingJoinsFor(groupId).some((row) => row.pubkey === requester),
          snapshotIncludesRequester: Array.isArray(snapshot) && snapshot.some((row) => row.pubkey === requester),
          recordUpdatedAt: record?.updatedAt ?? null,
          keyObtainedAt: current?.obtainedAt ?? null,
          decision: await grantKeyRequest({
            groupId, requester, creator: identity.pk, snapshot, updatedAt: record?.updatedAt,
            keyObtainedAt: current?.obtainedAt, selfCreated: true, fetchMembers: async () => snapshot,
          }),
        };
      },
      readGroupKeyState: async (groupId) => {
        const { loadMemberDocHeads } = await import('../src/lib/crypto/groupDocWire.js');
        const heads = await loadMemberDocHeads(groupId);
        const current = await getCurrentGroupKey(groupId);
        const body = heads[0]?.body;
        return { headCount: heads.length, head: body ? { gid: body.gid, epoch: body.epoch, gen: body.gen } : null, keyEpoch: current?.epoch ?? null };
      },
      readGroupMessages: (groupId) => useChatStore.getState().groupMessages?.[groupId] || [],
    };
  }, [api, setGroups]);
  useEffect(() => subscribeToDMs(), [subscribeToDMs]);
  return <p>Phase 0 application hook ready</p>;
}

function HarnessRoot() {
  useEffect(() => {
    return useChatStore.subscribe((state) => { window.__cipherPhase0Store = state; });
  }, []);
  return <Harness />;
}

createRoot(document.getElementById('root')).render(<HarnessRoot />);

export default HarnessRoot;
