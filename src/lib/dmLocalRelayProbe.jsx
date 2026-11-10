import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { SimplePool } from 'nostr-tools';
import { useIdentity } from '../useIdentity.js';
import { useNIP44DM } from '../hooks/useNIP44DM.js';
import { makeSecretProvider, setDeviceProvider, DeviceKeyMissing } from './vaultEnvelope.js';
import { useChatStore } from '../store/chatStore.js';

const storageKey = (owner) => `test_device_secret_${owner}`;
const provider = makeSecretProvider({ kind: 'test', available: async () => true,
  enroll: async (owner) => {
    if (!localStorage.getItem(storageKey(owner))) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      localStorage.setItem(storageKey(owner), Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
    return { k: 'test', id: owner };
  },
  getSecret: async (owner) => {
    const hex = localStorage.getItem(storageKey(owner));
    if (!hex || !/^(?:[0-9a-f]{2}){32}$/i.test(hex)) throw new DeviceKeyMissing('no-key');
    return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  },
  destroy: async (owner) => localStorage.removeItem(storageKey(owner)),
});

setDeviceProvider(provider);

function DmLocalRelayProbe() {
  const identity = useIdentity();
  const dm = useNIP44DM({ identity });
  useEffect(() => {
    window.__identity = identity;
    window.__dm = dm;
    window.__SimplePool = SimplePool;
    window.__chatStore = useChatStore;
  }, [identity, dm]);
  return null;
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(DmLocalRelayProbe));
