import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { useIdentity } from '../useIdentity.js';
import { useNIP44DM } from '../hooks/useNIP44DM.js';
import { SimplePool } from 'nostr-tools';
import { useCommerce } from '../features/chat/useCommerce.js';
import { useComposer } from '../features/chat/useComposer.js';
import { useMessageCommands } from '../features/chat/useMessageCommands.js';
import GroupView from '../components/chat/GroupView.jsx';
import NotificationCenter from '../components/chat/NotificationCenter.jsx';
import Wallet from '../Wallet.jsx';
import { useChatStore } from '../store/chatStore.js';
import { makeSecretProvider, setDeviceProvider, DeviceKeyMissing } from './vaultEnvelope.js';

const storageKey = (pk) => `test_device_secret_${pk}`;
const provider = makeSecretProvider({ kind: 'test', available: async () => true,
  enroll: async (pk) => {
    if (!localStorage.getItem(storageKey(pk))) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      localStorage.setItem(storageKey(pk), Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join(''));
    }
    return { k: 'test', id: pk };
  },
  getSecret: async (pk) => {
    const hex = localStorage.getItem(storageKey(pk));
    if (!hex || !/^(?:[0-9a-f]{2}){32}$/i.test(hex)) throw new DeviceKeyMissing('no-key');
    return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  },
  destroy: async (pk) => localStorage.removeItem(storageKey(pk)),
});

setDeviceProvider(provider);

const trackedStoreActions = ['setDms', 'setGroupMessages', 'setToast', 'setSelectedMessage',
  'setUnreadCounts', 'openChat', 'setIsVendor'];
const initialStoreActions = useChatStore.getState();
const wrappedStoreActions = Object.fromEntries(trackedStoreActions.map((name) => {
  const original = initialStoreActions[name];
  return [name, (...args) => {
    const identity = window.__identity;
    if (window.__trackRetiredEffects && !identity?.securityFence?.isCurrent?.()) {
      window.__retiredUiEffects ||= [];
      window.__retiredUiEffects.push(name);
    }
    return original?.(...args);
  }];
}));
useChatStore.setState(wrappedStoreActions);

async function waitAtLifecycleGate(name, identity) {
  if (!window.__lifecycleHolds?.[name]) return;
  window.__lifecycleEntered ||= {};
  window.__lifecycleEntered[name] = true;
  await new Promise((resolve) => { window[`__release_${name}`] = resolve; });
  identity?.securityFence?.assertCurrent();
}

function Probe() {
  const identity = useIdentity();
  const dm = useNIP44DM({ identity });
  const [surface, setSurface] = useState('none');
  const sendDM = async (...args) => {
    await waitAtLifecycleGate('composer-send', identity);
    identity?.securityFence?.assertCurrent();
    window.__lifecyclePublishes ||= [];
    window.__lifecyclePublishes.push({ type: 'dm', args });
    return { success: true, queued: false, event: { id: `fixture-event-${Date.now()}`, created_at: Math.floor(Date.now() / 1000) } };
  };
  const sendGroupMessage = async (...args) => {
    const send = import.meta.env?.VITE_TEST_HOOKS === '1' && window.__cipherGroupMessage
      ? window.__cipherGroupMessage : async (...sentArgs) => ({ success: true, queued: false,
        event: { id: `fixture-group-event-${Date.now()}`, created_at: Math.floor(Date.now() / 1000) }, sentArgs });
    return send(...args, identity);
  };
  const commerce = useCommerce({ identity,
    sendDM: async (...args) => {
      identity?.securityFence?.assertCurrent();
      window.__orderUpdatePublishes ||= [];
      window.__orderUpdatePublishes.push(args);
      return { success: true, queued: false, event: { id: `fixture-event-${Date.now()}`, created_at: Math.floor(Date.now() / 1000) } };
    },
    sendGroupMessage,
    sendVouch: async () => ({ success: false }),
    openChat: () => {},
  });
  const composer = useComposer({ identity, sendDM, sendGroupMessage });
  const commands = useMessageCommands({ identity, sendReaction: async (...args) => {
    await waitAtLifecycleGate('message-reaction', identity);
    identity?.securityFence?.assertCurrent();
    window.__lifecyclePublishes ||= [];
    window.__lifecyclePublishes.push({ type: 'reaction', args });
    return true;
  }, pinMessage: async () => true, handleOrderAction: commerce.handleOrderAction,
  startOrderWithVendor: commerce.startOrderWithVendor });
  const effectsWrapped = useRef(false);
  useEffect(() => {
    window.__identity = identity;
    window.__dm = dm;
    window.__SimplePool = SimplePool;
    window.__chatStore = useChatStore;
    window.__commerce = commerce;
    window.__composer = composer;
    window.__messageCommands = commands;
    window.__setLifecycleSurface = setSurface;
    if (!effectsWrapped.current) {
      const state = useChatStore.getState();
      const setToast = state.setToast;
      const setSelectedMessage = state.setSelectedMessage;
      state.setToast = (...args) => {
        window.__commerceUiEffects ||= [];
        window.__commerceUiEffects.push({ type: 'toast', value: args[0] });
        return setToast(...args);
      };
      state.setSelectedMessage = (...args) => {
        window.__commerceUiEffects ||= [];
        window.__commerceUiEffects.push({ type: 'selected-message', value: args[0] });
        return setSelectedMessage(...args);
      };
      effectsWrapped.current = true;
    }
  }, [identity, dm, commerce, composer, commands]);
  if (surface === 'notifications') return React.createElement(NotificationCenter, {
    identity, onClose: () => {}, onJump: (...args) => { window.__notificationJumps = (window.__notificationJumps || 0) + 1; window.__notificationJumpArgs = args; },
  });
  if (surface === 'group') return React.createElement(GroupView, {
    identity,
    sendMessage: composer.sendMessage,
    sendDM,
    handleMessageAction: commands.handleMessageAction,
    handleImageUpload: composer.handleImageUpload,
    startRecording: composer.startRecording,
    stopRecording: composer.stopRecording,
    cancelRecording: composer.cancelRecording,
    fetchGroupMembers: async () => [],
    fetchPinnedMessage: async () => null,
    pinMessage: async () => true,
    unpinMessage: async () => true,
  });
  if (surface === 'wallet') return React.createElement(Wallet, {
    identity, onOpenChat: () => {}, startView: 'main',
  });
  return null;
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Probe));
