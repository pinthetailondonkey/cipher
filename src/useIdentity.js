import { useState, useEffect } from 'react'

// Derive 32-byte secret key from BIP39 mnemonic
export async function deriveSkFromMnemonic(mnemonic) {
  const { mnemonicToSeedSync } = await import('@scure/bip39')
  const seed = mnemonicToSeedSync(mnemonic);
  return new Uint8Array(seed.slice(0, 32));
}

async function encryptWithSk(sk, plaintext) {
  const key = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
}

async function decryptWithSk(sk, encrypted) {
  const key = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(encrypted.iv) }, key, new Uint8Array(encrypted.ct)
  );
  return new TextDecoder().decode(pt);
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Vaults created before per-vault salts used a fixed salt + 100k iterations.
// They still decrypt, and are transparently re-encrypted on the next successful unlock.
const LEGACY_SALT = new TextEncoder().encode("cipher_secure_salt")
const LEGACY_ITERATIONS = 100000
const KDF_ITERATIONS = 600000

async function getKey(secret, salt = LEGACY_SALT, iterations = LEGACY_ITERATIONS) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  )
}

export const isLegacyVault = (encryptedObj) => !encryptedObj?.salt

export async function encryptKey(skArray, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await getKey(secret, salt, KDF_ITERATIONS)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(skArray))
  )
  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted)),
    salt: Array.from(salt),
    iter: KDF_ITERATIONS,
  }
}

export async function decryptKey(encryptedObj, secret) {
  const key = isLegacyVault(encryptedObj)
    ? await getKey(secret)
    : await getKey(secret, new Uint8Array(encryptedObj.salt), encryptedObj.iter || KDF_ITERATIONS)
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(encryptedObj.iv) }, key, new Uint8Array(encryptedObj.data)
  )
  const dec = new TextDecoder()
  return JSON.parse(dec.decode(decrypted))
}

const getVaults = () => {
  try {
    return JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
  } catch { return {}; }
};

const saveVaults = (vaults) => {
  localStorage.setItem('cipher_vaults', JSON.stringify(vaults));
};

const getActivePubkey = () => localStorage.getItem('cipher_active_pubkey');

const setActivePubkey = (pk) => localStorage.setItem('cipher_active_pubkey', pk);

export function useIdentity() {
  const [keys, setKeys] = useState({ sk: null, pk: null, npub: null })
  const [hasVault, setHasVault] = useState(false)
  const [hasBiometric, setHasBiometric] = useState(false)
  const [loadingSession, setLoadingSession] = useState(true)

  useEffect(() => {
    const init = async () => {
      const sessionSk = sessionStorage.getItem('cipher_session_sk')
      let restoredSession = false;
      if (sessionSk) {
        try {
          const { getPublicKey, nip19 } = await import('nostr-tools')
          const sk = Uint8Array.from(JSON.parse(sessionSk))
          const pk = getPublicKey(sk)
          setKeys({ sk, pk, npub: nip19.npubEncode(pk) })
          setHasVault(true)
          restoredSession = true;
        } catch (e) { sessionStorage.removeItem('cipher_session_sk') }
      }

      const vault = localStorage.getItem('cipher_vault')
      const vaults = getVaults();
      if (!restoredSession && (vault || Object.keys(vaults).length > 0)) setHasVault(true)

      const biometricPubkey = localStorage.getItem('cipher_biometric_pubkey') || getActivePubkey();
      const storageKey = biometricPubkey ? `cipher_passkey_${biometricPubkey}` : undefined;
      try {
        const { hasStoredPasskeyIdentity, isPRFSupported } = await import('nostr-passkey')
        const supported = await isPRFSupported();
        const stored = hasStoredPasskeyIdentity(storageKey ? { storageKey } : undefined);
        setHasBiometric(supported && stored);
        if (!stored && localStorage.getItem('cipher_biometric_enabled') === 'true') {
          localStorage.removeItem('cipher_biometric_enabled');
        }
      } catch (error) {
        console.warn('[identity] Passkey capability check failed:', error)
        setHasBiometric(false)
      }
      
      setLoadingSession(false)
    }
    init()
  }, [])

  const createVault = async (handle, pin, enableBiometric = false) => {
    const [{ generateMnemonic }, { wordlist }] = await Promise.all([
      import('@scure/bip39'),
      import('@scure/bip39/wordlists/english.js'),
    ]);
    const { getPublicKey, nip19 } = await import('nostr-tools')
    const mnemonic = generateMnemonic(wordlist, 128)
    const sk = await deriveSkFromMnemonic(mnemonic)
    const pk = getPublicKey(sk)
    
    // Use the handle (lowercased) as the lookup ID for restoring
    const lookupId = await sha256(handle.toLowerCase().trim())

    // Encrypt with PIN locally
    const encryptedLocal = await encryptKey(Array.from(sk), pin)
    
    // Multi-account support: store vaults by pubkey
    const vaults = getVaults();
    vaults[pk] = { 
      vault: encryptedLocal, 
      handle: handle.toLowerCase().trim(),
      displayName: handle,
      createdAt: Date.now(),
      mnemonicEnc: await encryptWithSk(sk, mnemonic)
    };
    saveVaults(vaults);
    localStorage.setItem('cipher_active_pubkey', pk);
    
    // Legacy fallback (for backwards compat)
    localStorage.setItem('cipher_vault', JSON.stringify(encryptedLocal))
    localStorage.setItem('cipher_handle', handle.toLowerCase().trim())
    localStorage.setItem('cipher_fails', '0')

    // (relay backup removed for security — recovery is phrase-only)

    let biometricEnabled = false;
    let biometricError = '';
    if (enableBiometric) {
      const storageKey = `cipher_passkey_${pk}`;
      try {
        const { importPasskeyIdentityFromNsec, isPRFSupported } = await import('nostr-passkey');
        if (!(await isPRFSupported())) throw new Error('This device or browser does not support biometric passkeys.');
        const nsec = nip19.nsecEncode(sk);
        const passkey = await importPasskeyIdentityFromNsec(nsec, { rpName: 'Cipher', storageKey });
        if (passkey.pubkey !== pk) throw new Error('The passkey did not match the new account.');
        localStorage.setItem('cipher_biometric_pubkey', pk);
        localStorage.setItem('cipher_biometric_enabled', 'true');
        biometricEnabled = true;
        setHasBiometric(true);
      } catch (error) {
        console.warn('[identity] Could not enable biometric passkey:', error);
        biometricError = error?.message || 'Biometric passkey setup did not complete.';
        try {
          const { clearPasskeyIdentity } = await import('nostr-passkey');
          clearPasskeyIdentity({ storageKey: `cipher_passkey_${pk}` });
        } catch (clearError) {
          console.error('[identity] Could not clear incomplete passkey setup:', clearError);
        }
        localStorage.removeItem('cipher_biometric_pubkey');
        localStorage.removeItem('cipher_biometric_enabled');
      }
    }

    return { sk, pk, npub: nip19.npubEncode(pk), handle, mnemonic, biometricEnabled, biometricError }
  }

  // UPDATED: Accepts a full profile object
  const finalizeLogin = async (sk, pk, npub, profile) => {
    let pool;
    const relays = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.damus.io', 'wss://relay.nostr.band'];
    try {
      const { SimplePool, finalizeEvent } = await import('nostr-tools')
      pool = new SimplePool()

      const profileData = {
        name: profile.username, // @handle (e.g. "alice")
        display_name: profile.displayName || profile.username, // "Alice's Shop"
        about: 'New to Cipher.',
        picture: profile.picture || null
      }

      const ev = finalizeEvent({
        kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [],
        content: JSON.stringify(profileData)
      }, sk)

      // Also publish kind:10003 username registry (critical for search)
      const username = profile?.username;
      let usernameEv = null;
      if (username) {
        usernameEv = finalizeEvent({
          kind: 10003,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', 'username'],
            ['t', 'cipher_username_' + username],
            ['t', 'cipher_username'],
            ['username', username]
          ],
          content: ''
        }, sk)
      }

      const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
      const promises = [Promise.allSettled(pool.publish(relays, ev))]
      if (usernameEv) promises.push(Promise.allSettled(pool.publish(relays, usernameEv)))
      await Promise.race([Promise.all(promises), timeout])
    } catch (e) {
      console.error('Failed to publish initial profile', e);
    } finally {
      pool?.close(relays);
    }

    try {
      const { saveProfile } = await import('./db')
      await saveProfile({
        pubkey: pk,
        name: profile?.username || 'user',
        displayName: profile?.displayName || profile?.username || 'User',
        picture: profile?.picture || null,
        about: 'New to Cipher.'
      })
    } catch (e) { console.error('Profile seed failed:', e) }

    sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
    setKeys({ sk, pk, npub })
    setHasVault(true)
  }

  const unlock = async (pin) => {
    try {
      // Multi-account: use the active account's vault
      const activePk = getActivePubkey();
      const vaults = getVaults();
      let vault;
      
      if (activePk && vaults[activePk]) {
        vault = vaults[activePk].vault;
      } else {
        // Fallback to legacy single vault
        const vaultStr = localStorage.getItem('cipher_vault');
        if (!vaultStr) throw new Error("No local vault found");
        vault = JSON.parse(vaultStr);
      }
      
      const skArray = await decryptKey(vault, pin)
      
      const { getPublicKey, nip19 } = await import('nostr-tools')
      const sk = Uint8Array.from(skArray)
      const pk = getPublicKey(sk)

      if (isLegacyVault(vault)) {
        try {
          const upgraded = await encryptKey(skArray, pin)
          const current = getVaults()
          if (current[pk]) {
            current[pk].vault = upgraded
            saveVaults(current)
          }
          if (!activePk || activePk === pk) {
            localStorage.setItem('cipher_vault', JSON.stringify(upgraded))
          }
        } catch (upgradeErr) { console.warn('Vault upgrade skipped:', upgradeErr) }
      }
      
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
      localStorage.setItem('cipher_fails', '0')
      setKeys({ sk, pk, npub: nip19.npubEncode(pk) })
      return { success: true }
    } catch (e) {
      const fails = parseInt(localStorage.getItem('cipher_fails') || '0') + 1
      localStorage.setItem('cipher_fails', fails.toString())
      if (fails >= 5) {
        // Only wipe THIS account's vault — other accounts stay intact
        const activePk = getActivePubkey();
        try {
          const vaults = getVaults();
          const legacyVault = localStorage.getItem('cipher_vault');
          // Only remove the legacy single-vault if it belongs to the locked-out account
          // (or there is no multi-account entry, i.e. it IS the locked-out account).
          const legacyBelongsToActive = !activePk || !vaults[activePk] ||
            (legacyVault && JSON.stringify(vaults[activePk].vault) === legacyVault);
          if (activePk) delete vaults[activePk];
          saveVaults(vaults);
          if (legacyVault && legacyBelongsToActive) {
            localStorage.removeItem('cipher_vault');
            localStorage.removeItem('cipher_handle');
          }
          localStorage.removeItem('cipher_active_pubkey');
          localStorage.setItem('cipher_fails', '0');
        } catch (wipeErr) { console.error('Lockout wipe failed:', wipeErr) }
        sessionStorage.removeItem('cipher_session_sk');
        window.location.reload();
      }
      return { success: false, remaining: 5 - fails }
    }
  }

  const unlockWithBiometric = async (newPin = '') => {
    try {
      const activePk = getActivePubkey() || localStorage.getItem('cipher_biometric_pubkey');
      const storageKey = activePk ? `cipher_passkey_${activePk}` : undefined;
      const { unlockPasskeyIdentity } = await import('nostr-passkey')
      const { secretKey, pubkey } = await unlockPasskeyIdentity(undefined, storageKey ? { storageKey } : undefined)
      if (activePk && pubkey !== activePk) throw new Error('The saved passkey belongs to a different account.');
      const vaults = getVaults();
      if (!vaults[pubkey]) {
        if (newPin.length < 4) throw new Error('Enter a new PIN (at least 4 digits) to restore this account on this device.');
        const vault = await encryptKey(Array.from(secretKey), newPin);
        const legacyHandle = localStorage.getItem('cipher_handle') || 'restored';
        vaults[pubkey] = {
          vault,
          handle: legacyHandle,
          displayName: legacyHandle,
          createdAt: Date.now(),
        };
        saveVaults(vaults);
        localStorage.setItem('cipher_vault', JSON.stringify(vault));
        localStorage.setItem('cipher_handle', legacyHandle);
        setActivePubkey(pubkey);
        localStorage.setItem('cipher_biometric_pubkey', pubkey);
        localStorage.setItem('cipher_biometric_enabled', 'true');
      }
      const { nip19 } = await import('nostr-tools')
      const sk = Uint8Array.from(secretKey)
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
      setKeys({ sk, pk: pubkey, npub: nip19.npubEncode(pubkey) })
      setHasVault(true)
      setHasBiometric(true)
      return { success: true }
    } catch (e) { return { success: false, error: e.message } }
  }

  const enableBiometric = async () => {
    if (!keys.sk || !keys.pk) return { success: false, error: 'Unlock your account before setting up a passkey.' };
    const storageKey = `cipher_passkey_${keys.pk}`;
    try {
      const { importPasskeyIdentityFromNsec, isPRFSupported } = await import('nostr-passkey');
      if (!(await isPRFSupported())) {
        throw new Error('This device or browser does not support biometric passkeys.');
      }
      const { nip19 } = await import('nostr-tools');
      const nsec = nip19.nsecEncode(keys.sk);
      const passkey = await importPasskeyIdentityFromNsec(nsec, { rpName: 'Cipher', storageKey });
      if (passkey.pubkey !== keys.pk) throw new Error('The passkey did not match the unlocked account.');
      localStorage.setItem('cipher_biometric_pubkey', keys.pk);
      localStorage.setItem('cipher_biometric_enabled', 'true');
      setHasBiometric(true);
      return { success: true };
    } catch (error) {
      console.error('[identity] Could not set up biometric passkey:', error);
      try {
        const { clearPasskeyIdentity } = await import('nostr-passkey');
        clearPasskeyIdentity({ storageKey });
      } catch (clearError) {
        console.error('[identity] Could not clear incomplete passkey setup:', clearError);
      }
      return { success: false, error: error?.message || 'Could not set up a biometric passkey.' };
    }
  };

  const restoreFromRelays = async (handle, pin) => {
    const vaults = getVaults();
    let targetPk = null;
    let targetVault = null;

    // 1. Search in multi-account vaults
    for (const [pk, data] of Object.entries(vaults)) {
      if (data.handle === handle) {
        targetPk = pk;
        targetVault = data.vault;
        break;
      }
    }

    // 2. Fallback to legacy single vault
    if (!targetPk) {
      const legacyVaultStr = localStorage.getItem('cipher_vault');
      const legacyHandle = localStorage.getItem('cipher_handle');
      if (legacyVaultStr && legacyHandle === handle) {
        targetVault = JSON.parse(legacyVaultStr);
      }
    }

    if (!targetVault) {
      return { success: false, error: 'Account not found on this device. Use your 12-word recovery phrase if you are on a new device.' };
    }

    try {
      const skArray = await decryptKey(targetVault, pin);
      const { getPublicKey, nip19 } = await import('nostr-tools');
      const sk = Uint8Array.from(skArray);
      const pk = getPublicKey(sk);

      if (targetPk && pk !== targetPk) throw new Error('Invalid PIN');

      // Update multi-account store just in case it was legacy
      const newVaults = getVaults();
      newVaults[pk] = {
        vault: targetVault,
        handle: handle,
        displayName: newVaults[pk]?.displayName || handle,
        createdAt: newVaults[pk]?.createdAt || Date.now()
      };
      saveVaults(newVaults);

      setActivePubkey(pk);
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)));
      localStorage.setItem('cipher_vault', JSON.stringify(targetVault));
      localStorage.setItem('cipher_handle', handle);
      
      setKeys({ sk, pk, npub: nip19.npubEncode(pk) });
      setHasVault(true);
      return { success: true };
    } catch (e) {
      return { success: false, error: 'Invalid PIN' };
    }
  }


  const restoreFromMnemonic = async (mnemonicInput, newPin) => {
    try {
      const normalizedMnemonic = mnemonicInput.trim().toLowerCase().replace(/\s+/g, ' ')
      const [{ validateMnemonic }, { wordlist }] = await Promise.all([
        import('@scure/bip39'),
        import('@scure/bip39/wordlists/english.js'),
      ]);
      if (!validateMnemonic(normalizedMnemonic, wordlist)) {
        throw new Error('Invalid recovery phrase')
      }
      const sk = await deriveSkFromMnemonic(normalizedMnemonic)
      const { getPublicKey, nip19 } = await import('nostr-tools')
      const pk = getPublicKey(sk)
      const newLocalVault = await encryptKey(Array.from(sk), newPin)
      const vaults = getVaults()
      vaults[pk] = {
        vault: newLocalVault,
        handle: '',
        displayName: 'Restored',
        createdAt: Date.now(),
        mnemonicEnc: await encryptWithSk(sk, normalizedMnemonic)
      }
      saveVaults(vaults)
      setActivePubkey(pk)
      localStorage.setItem('cipher_vault', JSON.stringify(newLocalVault))
      localStorage.setItem('cipher_fails', '0')
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
      setKeys({ sk, pk, npub: nip19.npubEncode(pk) })
      setHasVault(true)
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  const getMnemonic = async () => {
    if (!keys.sk || !keys.pk) return null
    const vaults = getVaults()
    const vault = vaults[keys.pk]
    if (!vault?.mnemonicEnc) return null
    try { return await decryptWithSk(keys.sk, vault.mnemonicEnc) } catch (e) { return null }
  };

  const lockApp = async () => {
    sessionStorage.removeItem('cipher_session_sk')
    setKeys({ sk: null, pk: null, npub: null })
    try {
      const { clearPool } = await import('./lib/pool');
      clearPool();
    } catch (error) {
      console.error('[identity] Could not close relay connections:', error);
    }
    
    // 1. Wipe sensitive chat data from memory
    try {
      const { useChatStore } = await import('./store/chatStore');
      useChatStore.setState({ 
        dms: {}, groups: [], groupMessages: {}, profiles: {}, 
        unreadCounts: {}, reactions: {}, activeDm: null, activeGroup: null, view: 'list' 
      });
    } catch(e) {}

    // 2. Close the Dexie DB connection
    try {
      const { closeDB } = await import('./db');
      closeDB();
    } catch(e) {}
  }

  const panicWipe = async () => {
    try {
      const { clearPool } = await import('./lib/pool');
      clearPool();
      const { closeDB } = await import('./db');
      closeDB();

      if (typeof indexedDB !== 'undefined') {
        const databaseNames = new Set();
        try {
          const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
          databases.forEach((database) => {
            if (database.name) databaseNames.add(database.name);
          });
        } catch (error) {
          console.warn('[panicWipe] Could not enumerate IndexedDB databases:', error);
        }

        const owner = localStorage.getItem('cipher_db_owner');
        if (owner) databaseNames.add(`CipherDB_v7_${owner.slice(0, 16)}`);
        try {
          const vaults = JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
          Object.keys(vaults).forEach((pubkey) => databaseNames.add(`CipherDB_v7_${pubkey.slice(0, 16)}`));
        } catch (error) {
          console.warn('[panicWipe] Could not read account list for database cleanup:', error);
        }

        const deleteOne = (name) => new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve(true);
          request.onerror = () => {
            console.error(`[panicWipe] Failed to delete IndexedDB database ${name}:`, request.error);
            resolve(false);
          };
          request.onblocked = () => {
            console.error(`[panicWipe] IndexedDB deletion was blocked for ${name}`);
            resolve(false);
          };
        });
        const deleted = await Promise.race([
          Promise.all(Array.from(databaseNames, deleteOne)),
          new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (deleted === null || deleted.some((success) => !success)) {
          console.error('[panicWipe] Some IndexedDB databases may not have been deleted.');
        }
      }
      // 2. Unregister service workers (PWA cache)
      if ('serviceWorker' in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.allSettled(regs.map(r => r.unregister()));
        } catch (e) {}
      }
      // 3. Clear caches API
      if ('caches' in window) {
        try {
          const keys = await caches.keys();
          await Promise.allSettled(keys.map(k => caches.delete(k)));
        } catch (e) {}
      }
      // 4. Clear storage
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {
      console.error('[panicWipe]', e);
    } finally {
      window.location.reload();
    }
  }

  const getAccounts = () => {
    const vaults = getVaults();
    const activePk = getActivePubkey() || keys.pk;
    const result = Object.entries(vaults).map(([pk, data]) => ({
      pubkey: pk,
      handle: data.handle,
      displayName: data.displayName,
      isActive: pk === activePk,
      createdAt: data.createdAt
    }));

    // Legacy fallback: user created before multi-account support
    if (result.length === 0 && keys.pk) {
      result.push({
        pubkey: keys.pk,
        handle: localStorage.getItem('cipher_handle') || 'account',
        displayName: localStorage.getItem('cipher_handle') || 'Account',
        isActive: true,
        createdAt: Date.now()
      });
    }

    return result.sort((a, b) => b.createdAt - a.createdAt);
  };

  const switchAccount = async (targetPk, pin) => {
    try {
      const vaults = getVaults();
      if (!vaults[targetPk]) throw new Error('Account not found');
      
      const skArray = await decryptKey(vaults[targetPk].vault, pin);
      const { getPublicKey, nip19 } = await import('nostr-tools');
      const sk = Uint8Array.from(skArray);
      const pk = getPublicKey(sk);
      
      if (pk !== targetPk) throw new Error('Invalid PIN for this account');
      
      setActivePubkey(targetPk);
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)));
      
      // Update legacy vault too
      localStorage.setItem('cipher_vault', JSON.stringify(vaults[targetPk].vault));
      localStorage.setItem('cipher_handle', vaults[targetPk].handle);
      
      // Reload to reset all state cleanly
      window.location.reload();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };

  const addNewAccount = () => {
    // Migrate current vault to cipher_vaults before switching, so it's not lost
    const legacyVault = localStorage.getItem('cipher_vault');
    const sessionSk = sessionStorage.getItem('cipher_session_sk');
    if (legacyVault && sessionSk && keys.pk) {
      try {
        const vaults = getVaults();
        if (!vaults[keys.pk]) {
          vaults[keys.pk] = {
            vault: JSON.parse(legacyVault),
            handle: localStorage.getItem('cipher_handle') || 'account',
            displayName: localStorage.getItem('cipher_handle') || 'Account',
            createdAt: Date.now()
          };
          saveVaults(vaults);
        }
      } catch (e) {}
    }
    sessionStorage.removeItem('cipher_session_sk');
    localStorage.removeItem('cipher_active_pubkey');
    window.location.reload();
  };

  const removeAccount = (targetPk) => {
    const vaults = getVaults();
    delete vaults[targetPk];
    saveVaults(vaults);
    
    if (getActivePubkey() === targetPk) {
      sessionStorage.clear();
      localStorage.removeItem('cipher_active_pubkey');
      window.location.reload();
    }
  };

  return { 
    ...keys, hasVault, hasBiometric, loadingSession,
    getAccounts, switchAccount, addNewAccount, removeAccount, getMnemonic, 
    unlock, unlockWithBiometric, enableBiometric, restoreFromRelays, restoreFromMnemonic, createVault, finalizeLogin, lockApp, panicWipe
  }
}
