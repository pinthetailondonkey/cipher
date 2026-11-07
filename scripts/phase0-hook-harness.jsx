import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useNIP29Group } from '../src/hooks/useNIP29Group.js';
import { setSessionKey } from '../src/lib/sessionKey.js';
import { getSessionKey } from '../src/lib/sessionKey.js';
import { openDBFor } from '../src/db.js';
import { currentOwner } from '../src/db.js';
import { getDocKey, putDocKey } from '../src/lib/crypto/groupKeyStore.js';
import { pendingJoinsFor } from '../src/lib/groupJoinQueue.js';
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
  useEffect(() => {
    window.__cipherPhase0 = {
      identity,
      api,
      unlocked: Boolean(getSessionKey()),
      databaseOwner: currentOwner(),
      setGroups,
      pendingJoinsFor,
      joinGroup,
      readAuthorityPin,
      rememberAuthorityPin,
      getDocKey,
      putDocKey,
    };
  }, [api, setGroups]);
  return <p>Phase 0 application hook ready</p>;
}

createRoot(document.getElementById('root')).render(<Harness />);

export default Harness;
