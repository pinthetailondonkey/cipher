import { useState, useEffect } from 'react'
import { LOCKED_OUT_MESSAGE, MIN_PIN_LENGTH, PIN_TOO_SHORT_MESSAGE, isPlausiblePin, deviceKeyFailureMessage, deviceLockUpgradeMessage, failUnlockAttempt, isAcceptableNewPin, isDamagedVault, pinFailureMessage, removeAccountKeys, resetPinFailures } from './lib/vaultLockout'
import { profileRelays as PROFILE_RELAYS } from './lib/relays'
import { DeviceKeyMissing, getDeviceProvider, isDeviceKeyError, isDeviceVault, unwrapDeviceVault } from './lib/vaultEnvelope'
import { destroyDeviceKeys, sealNewVault, upgradeStoredVault } from './lib/deviceLock'
import { ensureDeviceProvider } from './lib/deviceProvider'
import { confirmDraftAccount, isDraftEntry, pickUnlockAccount } from './lib/accountPick'
import { runPanicWipe } from './lib/panicWipe'
import { mergeRestoredEntry } from './lib/vaultEntry'
import { PASSKEY_WRONG_ACCOUNT, passkeyFailureCode } from './lib/passkeyMessages'

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

// A device vault (v3) has no salt of its own: the PIN vault sits inside it.
// It must never be taken for a no-salt legacy vault.
export const isLegacyVault = (encryptedObj) => !encryptedObj?.salt && !isDeviceVault(encryptedObj)

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

// opts.pk and opts.provider matter only for a device vault (v3): the device
// layer opens first (a failure there is a DeviceKeyError, never a wrong PIN),
// then the PIN vault inside opens exactly as a v2 or legacy vault always did.
export async function decryptKey(encryptedObj, secret, opts = {}) {
  if (isDeviceVault(encryptedObj)) {
    const provider = opts.provider || getDeviceProvider()
    if (!provider) throw new DeviceKeyMissing('no-provider')
    const inner = await unwrapDeviceVault(encryptedObj, opts.pk, provider)
    return decryptKey(inner, secret)
  }
  const key = isLegacyVault(encryptedObj)
    ? await getKey(secret)
    : await getKey(secret, new Uint8Array(encryptedObj.salt), encryptedObj.iter || KDF_ITERATIONS)
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(encryptedObj.iv) }, key, new Uint8Array(encryptedObj.data)
  )
  const dec = new TextDecoder()
  return JSON.parse(dec.decode(decrypted))
}

// The one way every unlock path opens a stored vault. pk names the account
// the vault belongs to (the device layer is bound to it); a vault from the
// older single-vault slot has no pk until it is opened, and only a device
// vault needs one.
export async function openVault(vault, pin, pk) {
  await ensureDeviceProvider()
  return decryptKey(vault, pin, { pk })
}

// Every vault this device keeps is locked to the device. A new account's PIN
// vault is born inside the device envelope (no device key, no account); an old
// PIN vault is wrapped in place at its next unlock. pin === null means the
// account was opened by its passkey and the PIN is not known.
const deviceLockDeps = async () => ({
  provider: await ensureDeviceProvider(),
  encrypt: encryptKey,
  open: (vault, pin, pk) => decryptKey(vault, pin, { pk }),
  isLegacy: isLegacyVault,
})

async function sealNewAccountVault(pk, pin, skArray) {
  return sealNewVault({ ...(await deviceLockDeps()), pk, pin, skArray })
}

async function lockStoredVault({ pk, vault, pin, skArray, activePk }) {
  return upgradeStoredVault({ ...(await deviceLockDeps()), storage: localStorage, pk, vault, pin, skArray, activePk })
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

// Publish one signed event and only close the socket after that relay
// acknowledges it (OK) or the attempt has actually failed. A timeout that
// resolves early, followed by pool.close(), drops kind 0 / 10003 on the floor.
function publishToRelay(url, signedEvent, sk, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let socket
    let authAttempted = false
    const finish = (ok, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (socket && socket.readyState === WebSocket.OPEN) socket.close()
      } catch (_) {}
      if (ok) resolve(value)
      else reject(value instanceof Error ? value : new Error(String(value)))
    }
    const timer = setTimeout(() => {
      finish(false, new Error(`No OK from ${url} for kind ${signedEvent.kind} within ${timeoutMs}ms`))
    }, timeoutMs)

    const sendEvent = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify(['EVENT', signedEvent]))
    }

    const sendAuth = async (challenge) => {
      const { finalizeEvent } = await import('nostr-tools')
      const authEvent = finalizeEvent({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['relay', url], ['challenge', challenge]],
        content: '',
      }, sk)
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify(['AUTH', authEvent]))
    }

    try {
      socket = new WebSocket(url)
    } catch (error) {
      finish(false, error)
      return
    }

    socket.onopen = () => {
      sendEvent()
    }
    socket.onmessage = (message) => {
      let frame
      try { frame = JSON.parse(message.data) } catch { return }
      if (!Array.isArray(frame)) return
      if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
        authAttempted = true
        sendAuth(frame[1]).then(() => sendEvent()).catch((error) => finish(false, error))
        return
      }
      if (frame[0] === 'NOTICE') {
        console.warn(`[identity] ${url} NOTICE:`, frame[1])
        return
      }
      if (frame[0] === 'OK' && frame[1] === signedEvent.id) {
        if (frame[2] === true) {
          finish(true, url)
          return
        }
        const reason = typeof frame[3] === 'string' ? frame[3] : `Relay rejected kind ${signedEvent.kind}`
        if (!authAttempted && /auth/i.test(reason)) return
        finish(false, new Error(`${url}: ${reason}`))
      }
    }
    socket.onerror = () => {
      finish(false, new Error(`WebSocket error talking to ${url}`))
    }
    socket.onclose = () => {
      if (!settled) finish(false, new Error(`${url} closed before acknowledging kind ${signedEvent.kind}`))
    }
  })
}

async function publishSignedEvent(signedEvent, sk, relays = PROFILE_RELAYS) {
  const settled = await Promise.allSettled(relays.map((url) => publishToRelay(url, signedEvent, sk)))
  settled.forEach((result, index) => {
    const url = relays[index]
    if (result.status === 'fulfilled') {
      console.log(`[identity] kind ${signedEvent.kind} accepted by ${result.value}`)
    } else {
      console.error(`[identity] kind ${signedEvent.kind} failed on ${url}:`, result.reason?.message || result.reason)
    }
  })
  return settled.some((result) => result.status === 'fulfilled')
}

export async function publishCipherProfile(sk, profile = {}, relays = PROFILE_RELAYS) {
  const username = (profile?.username || profile?.name || '').replace(/^@/, '').trim().toLowerCase()
  const displayName = (profile?.displayName || profile?.display_name || username || 'User').trim()
  const about = profile?.about || 'New to Cipher.'
  const profileData = {
    name: username || displayName,
    display_name: displayName,
    about,
  }
  if (profile?.picture) profileData.picture = profile.picture

  const { finalizeEvent } = await import('nostr-tools')
  const now = Math.floor(Date.now() / 1000)
  const events = [
    finalizeEvent({
      kind: 0,
      created_at: now,
      tags: [],
      content: JSON.stringify(profileData),
    }, sk),
  ]
  if (username) {
    events.push(finalizeEvent({
      kind: 10003,
      created_at: now,
      tags: [
        ['d', 'username'],
        ['t', 'cipher_username_' + username],
        ['t', 'cipher_username'],
        ['username', username],
      ],
      content: JSON.stringify({ username, display_name: displayName }),
    }, sk))
  }

  const results = await Promise.all(events.map((event) => publishSignedEvent(event, sk, relays)))
  return { profilePublished: results[0] === true, usernamePublished: username ? results[1] === true : false }
}

export async function getMnemonicFromVault(sk, pk) {
  if (!sk || !pk) return null
  const vault = getVaults()[pk]
  if (!vault?.mnemonicEnc) return null
  try {
    const secret = sk instanceof Uint8Array ? sk : Uint8Array.from(sk)
    return await decryptWithSk(secret, vault.mnemonicEnc)
  } catch (e) {
    console.error('[identity] Could not decrypt recovery phrase:', e)
    return null
  }
}

// The account's device key is destroyed wherever it lives (a passkey record,
// the OS store, the Keystore). With the key gone, any old copy of the vault
// is dead ciphertext: a wipe is then an erasure, not a deleted file.
async function destroyDeviceKey(pubkey) {
  if (!pubkey) return
  try {
    const failed = await destroyDeviceKeys(await ensureDeviceProvider(), [pubkey])
    if (failed.length) console.error('[identity] The device key may remain on this device.')
  } catch (error) {
    console.error('[identity] Could not destroy the device key:', error)
  }
}

// Storage cleanup happens inside failUnlockAttempt. The database needs IndexedDB.
// Every path that removes an account (lockout, remove) also ends its device key.
async function deleteLockedOutDatabase(pubkey) {
  if (!pubkey) return
  await destroyDeviceKey(pubkey)
  try {
    const { deleteAccountDatabase } = await import('./db')
    if (!(await deleteAccountDatabase(pubkey))) {
      console.error('[identity] The locked-out account database may remain on this device.')
    }
  } catch (error) {
    console.error('[identity] Could not delete the locked-out account database:', error)
  }
}

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
          // A stored session is one account's key, but the storage scope
          // follows the device-wide active account, which a second tab can
          // switch while this tab's credential is saved. A tab whose key and
          // scope disagree would write its own receipts and orders into
          // another account's drawers, so the session restores only when
          // they match; a stale session is thrown out and the tab locks.
          // An unset pointer claims the session's account.
          // (security re-attack)
          const pointer = getActivePubkey()
          if (pointer && pointer !== 'guest' && pointer !== pk) {
            sessionStorage.removeItem('cipher_session_sk')
          } else if (!isDeviceVault(getVaults()[pk]?.vault)) {
            // A session saved before the device-lock law can outlive it: a
            // tab carries its sessionStorage across the reload that swaps in
            // this build, and the vault it sits on was never wrapped. That
            // session is not let in — the wrap happens at the next unlock,
            // which asks for the PIN. A vault already locked to this device
            // is the one case that restores with no prompt at all.
            sessionStorage.removeItem('cipher_session_sk')
          } else {
            if (!pointer || pointer === 'guest') localStorage.setItem('cipher_active_pubkey', pk)
            setKeys({ sk, pk, npub: nip19.npubEncode(pk) })
            setHasVault(true)
            restoredSession = true;
          }
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
    if (!isAcceptableNewPin(pin)) throw new Error(`PIN must be exactly ${MIN_PIN_LENGTH} digits`)
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

    // PIN vault inside the device envelope. Without a device key the account
    // is not created: nothing has been written to storage yet.
    const encryptedLocal = await sealNewAccountVault(pk, pin, Array.from(sk))
    
    // Multi-account support: store vaults by pubkey
    const vaults = getVaults();
    // Earlier abandoned drafts are not accounts: drop them so they never
    // pile up in the switcher or the counters that read this table.
    for (const key of Object.keys(vaults)) {
      if (vaults[key]?.confirmed === false) {
        delete vaults[key];
        // The abandoned draft's device key goes with it.
        await destroyDeviceKey(key);
      }
    }
    vaults[pk] = {
      vault: encryptedLocal,
      handle: handle.toLowerCase().trim(),
      displayName: handle,
      createdAt: Date.now(),
      mnemonicEnc: await encryptWithSk(sk, mnemonic),
      // Draft until the 12 words are confirmed: boot must not read this
      // entry as a finished account, and an abandon here must leave no
      // unlockable PIN gate behind (founder break 2026-10-27).
      confirmed: false,
    };
    saveVaults(vaults);
    // A draft does not take the device. The active pointer, the single-vault
    // mirror and the handle are set by confirmVault once the 12 words are
    // confirmed; until then an abandoned creation leaves every other account
    // and the Unlock screen exactly as they were.
    resetPinFailures(localStorage, pk)

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
        // The passkey exists; the flags that make Unlock offer it are set by
        // confirmVault, so an abandoned creation never offers a way in.
        biometricEnabled = true;
      } catch (error) {
        console.warn('[identity] Could not enable biometric passkey:', error);
        biometricError = error?.message || 'Biometric passkey setup did not complete.';
        try {
          const { clearPasskeyIdentity } = await import('nostr-passkey');
          clearPasskeyIdentity({ storageKey: `cipher_passkey_${pk}` });
        } catch (clearError) {
          console.error('[identity] Could not clear incomplete passkey setup:', clearError);
        }
      }
    }

    return { sk, pk, npub: nip19.npubEncode(pk), handle, mnemonic, biometricEnabled, biometricError }
  }

  // The 12-word confirm passed: this draft vault is a real account now, and
  // only now does it become the device's active account, its single-vault
  // mirror, and (with a passkey) the account Unlock offers the passkey for.
  const confirmVault = async () => {
    const confirmed = confirmDraftAccount(localStorage);
    if (!confirmed) return;
    const { pk } = confirmed;
    try {
      const { hasStoredPasskeyIdentity } = await import('nostr-passkey');
      if (hasStoredPasskeyIdentity({ storageKey: `cipher_passkey_${pk}` })) {
        localStorage.setItem('cipher_biometric_pubkey', pk);
        localStorage.setItem('cipher_biometric_enabled', 'true');
        setHasBiometric(true);
      }
    } catch (error) {
      console.warn('[identity] Could not check the new passkey:', error);
    }
  };

  const finalizeLogin = async (sk, pk, npub, profile) => {
    const username = (profile?.username || '').replace(/^@/, '').trim().toLowerCase()
    const displayName = (profile?.displayName || username || 'User').trim()
    try {
      const published = await publishCipherProfile(sk, {
        username,
        displayName,
        about: 'New to Cipher.',
        picture: profile?.picture || null,
      })
      if (!published.profilePublished || (username && !published.usernamePublished)) {
        console.error('[identity] One or more account events were not accepted by any relay', published)
      }
    } catch (e) {
      console.error('Failed to publish initial profile', e)
    }

    try {
      const { saveProfile } = await import('./db')
      await saveProfile({
        pubkey: pk,
        name: username || 'user',
        displayName,
        picture: profile?.picture || null,
        about: 'New to Cipher.'
      })
    } catch (e) { console.error('Profile seed failed:', e) }

    sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
    setKeys({ sk, pk, npub })
    setHasVault(true)
  }

  const unlock = async (pin) => {
    if (!isPlausiblePin(pin)) return { success: false, error: PIN_TOO_SHORT_MESSAGE, notCounted: true }
    // The account Unlock opens, and the one a wrong PIN counts against, is a
    // finished account: a draft is never it (see lib/accountPick.js).
    const picked = pickUnlockAccount(getVaults(), getActivePubkey(), localStorage.getItem('cipher_vault'))
    // Reading the vault is not a PIN attempt. Five wrong PINs delete an
    // account here, so only a PIN that actually failed to decrypt may spend
    // one: a missing vault or a damaged envelope answers on its own.
    if (!picked) return { success: false, error: 'No local vault found' }
    if (isDamagedVault(picked.vault)) {
      return { success: false, error: 'This device holds a damaged copy of the account. Use your 12 words.' }
    }
    const failureAccount = picked.pk || null
    const activePk = picked.pk || getActivePubkey()
    // The PIN's own failure is counted here and nowhere else: only a PIN
    // that failed to decrypt may spend one of the five attempts.
    let skArray
    try {
      skArray = await openVault(picked.vault, pin, picked.pk)
    } catch (e) {
      if (isDeviceKeyError(e)) {
        const left = failUnlockAttempt(localStorage, failureAccount, e)
        return { success: false, error: deviceKeyFailureMessage(e), remaining: left.remaining, deviceKey: e.code }
      }
      let failure = { lockedOut: false, remaining: 0 }
      try {
        failure = failUnlockAttempt(localStorage, failureAccount, e)
      } catch (wipeErr) { console.error('Lockout wipe failed:', wipeErr) }
      if (failure.lockedOut) {
        sessionStorage.removeItem('cipher_session_sk')
        await deleteLockedOutDatabase(failureAccount)
        window.location.reload()
      }
      return { success: false, error: pinFailureMessage(failure.remaining), remaining: failure.remaining }
    }

    // The vault is open. Nothing below may consume an attempt.
    try {
      const vault = picked.vault
      const { getPublicKey, nip19 } = await import('nostr-tools')
      const sk = Uint8Array.from(skArray)
      const pk = getPublicKey(sk)

      // The PIN was right. A vault that is not locked to this device is not
      // let in as it is: it is wrapped now, or the person is told why not.
      if (!isDeviceVault(vault)) {
        try {
          await lockStoredVault({ pk, vault, pin, skArray, activePk })
        } catch (upgradeErr) {
          if (!isDeviceKeyError(upgradeErr)) throw upgradeErr
          return { success: false, needsDeviceLock: true, error: deviceLockUpgradeMessage(upgradeErr), remaining: undefined, deviceKey: upgradeErr.code }
        }
      }

      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
      resetPinFailures(localStorage, pk)
      setKeys({ sk, pk, npub: nip19.npubEncode(pk) })
      return { success: true }
    } catch (e) {
      // The vault opened but the account would not load. Plain words only:
      // this is our failure, not a sentence for the person locked out.
      console.error('[identity] Could not load the opened account:', e)
      return { success: false, error: 'Could not open this account on this device.' }
    }
  }

  const unlockWithBiometric = async (newPin = '') => {
    try {
      const activePk = getActivePubkey() || localStorage.getItem('cipher_biometric_pubkey');
      const storageKey = activePk ? `cipher_passkey_${activePk}` : undefined;
      const { unlockPasskeyIdentity } = await import('nostr-passkey')
      const { secretKey, pubkey } = await unlockPasskeyIdentity(undefined, storageKey ? { storageKey } : undefined)
      if (activePk && pubkey !== activePk) throw Object.assign(new Error(PASSKEY_WRONG_ACCOUNT), { passkeyCode: 'wrong-account' });
      const vaults = getVaults();
      // An account whose 12 words were never confirmed is a draft, not an
      // account: a passkey must not let anyone into it.
      if (isDraftEntry(vaults[pubkey])) throw new Error('This account was never finished. Restore it with its 12 words, or create a new one.');
      if (!vaults[pubkey]) {
        if (!isAcceptableNewPin(newPin)) throw Object.assign(new Error(`Enter a new PIN (exactly ${MIN_PIN_LENGTH} digits) to restore this account on this device.`), { passkeyCode: 'new-pin' });
        const vault = await sealNewAccountVault(pubkey, newPin, Array.from(secretKey));
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
      // An old PIN vault on disk is wrapped even though the PIN was not typed:
      // left alone it would stay openable by a stolen copy and a PIN guess.
      if (vaults[pubkey] && !isDeviceVault(vaults[pubkey].vault)) {
        await lockStoredVault({ pk: pubkey, vault: vaults[pubkey].vault, pin: null, skArray: Array.from(secretKey), activePk: getActivePubkey() })
      }
      // A passkey-bound account that unlocks with no device pointer claims
      // it — otherwise its writes land in the guest scope.
      // (security re-attack)
      if (!getActivePubkey()) setActivePubkey(pubkey)
      const { nip19 } = await import('nostr-tools')
      const sk = Uint8Array.from(secretKey)
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
      resetPinFailures(localStorage, pubkey)
      setKeys({ sk, pk: pubkey, npub: nip19.npubEncode(pubkey) })
      setHasVault(true)
      setHasBiometric(true)
      return { success: true }
    } catch (e) {
      // A device key that is cancelled or unavailable is not the person's
      // PIN being wrong; it is said plainly and nothing is counted.
      if (isDeviceKeyError(e)) return { success: false, error: deviceLockUpgradeMessage(e), code: e?.code }
      // A code travels with the failure, so the screen can say a plain
      // sentence instead of the browser's or the library's own words.
      return { success: false, error: e.message, code: e?.passkeyCode || passkeyFailureCode(e) }
    }
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
    if (!isPlausiblePin(pin)) return { success: false, error: PIN_TOO_SHORT_MESSAGE };
    const vaults = getVaults();
    let targetPk = null;
    let targetVault = null;

    // 1. Search in multi-account vaults
    for (const [pk, data] of Object.entries(vaults)) {
      if (data.handle === handle && !isDraftEntry(data)) {
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

    // Same damaged-copy answer as unlock(): a vault no PIN could open is not
    // a wrong PIN, and this path charges attempts exactly like unlock does.
    if (isDamagedVault(targetVault)) {
      return { success: false, error: 'This device holds a damaged copy of the account. Use your 12 words.' };
    }

    let skArray;
    try {
      skArray = await openVault(targetVault, pin, targetPk);
    } catch (error) {
      if (isDeviceKeyError(error)) {
        failUnlockAttempt(localStorage, targetPk, error);
        return { success: false, error: deviceKeyFailureMessage(error) };
      }
      const { lockedOut, remaining } = failUnlockAttempt(localStorage, targetPk, error);
      if (lockedOut) await deleteLockedOutDatabase(targetPk);
      return { success: false, error: lockedOut ? LOCKED_OUT_MESSAGE : pinFailureMessage(remaining) };
    }

    try {
      const { getPublicKey, nip19 } = await import('nostr-tools');
      const sk = Uint8Array.from(skArray);
      const pk = getPublicKey(sk);

      if (targetPk && pk !== targetPk) throw new Error('Invalid PIN');

      // Locked to this device before it is re-admitted (see unlock).
      if (!isDeviceVault(targetVault)) {
        try {
          targetVault = await lockStoredVault({ pk, vault: targetVault, pin, skArray, activePk: getActivePubkey() });
        } catch (upgradeErr) {
          if (isDeviceKeyError(upgradeErr)) return { success: false, error: deviceLockUpgradeMessage(upgradeErr) };
          throw upgradeErr;
        }
      }

      // Update multi-account store just in case it was legacy. The entry keeps
      // everything it already held — the encrypted 12 words above all — so a
      // restore never leaves an account this device can open but cannot
      // recover from.
      const newVaults = getVaults();
      newVaults[pk] = mergeRestoredEntry(newVaults[pk], {
        vault: targetVault,
        handle,
        now: Date.now(),
      });
      saveVaults(newVaults);

      setActivePubkey(pk);
      resetPinFailures(localStorage, pk);
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
      // Copy-paste picks up sentence punctuation; a trailing period must not
      // kill an otherwise correct restore. Words only — case and whitespace
      // were already handled here.
      const normalizedMnemonic = mnemonicInput
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .split(' ')
        .map((w) => w.replace(/^[^a-z]+|[^a-z]+$/g, ''))
        .filter(Boolean)
        .join(' ')
      if (!isAcceptableNewPin(newPin)) throw new Error(`PIN must be exactly ${MIN_PIN_LENGTH} digits`)
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
      const newLocalVault = await sealNewAccountVault(pk, newPin, Array.from(sk))
      const vaults = getVaults()
      vaults[pk] = {
        vault: newLocalVault,
        handle: '',
        displayName: 'Restored',
        createdAt: Date.now(),
        mnemonicEnc: await encryptWithSk(sk, normalizedMnemonic),
        // Typing the 12 words IS the confirmation here — this entry is born
        // finished, never a draft (a draft flag would re-offer creation on
        // relaunch and threaten the restored account with a second flow).
        confirmed: true,
      }
      saveVaults(vaults)
      setActivePubkey(pk)
      localStorage.setItem('cipher_vault', JSON.stringify(newLocalVault))
      resetPinFailures(localStorage, pk)
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)))
      setKeys({ sk, pk, npub: nip19.npubEncode(pk) })
      setHasVault(true)
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  const getMnemonic = async () => getMnemonicFromVault(keys.sk, keys.pk)

  // The at-rest layer (src/lib/messageAtRest.js) seals message history with
  // the vault key while the app is unlocked. The session copy in sessionStorage
  // is set and cleared together with keys.sk by unlock/lock paths, so the
  // provider sees the key exactly when the vault is open; no effect wiring and
  // no new key material needed.

  const lockApp = async () => {
    sessionStorage.removeItem('cipher_session_sk')
    setKeys({ sk: null, pk: null, npub: null })
    try {
      const { clearPool } = await import('./lib/pool');
      const { clearConversationKeyCache } = await import('./lib/dmKeys');
      clearConversationKeyCache();
      clearPool();
      const { closeGroupSessions } = await import('./hooks/useNIP29Group');
      closeGroupSessions();
    } catch (error) {
      console.error('[identity] Could not close relay connections:', error);
    }
    
    // 1. Wipe sensitive chat data from memory
    try {
      const { useChatStore } = await import('./store/chatStore');
      useChatStore.setState({
        dms: {}, groups: [], groupMessages: {}, profiles: {},
        reactions: {}, activeDm: null, activeGroup: null, view: 'list',
      });
      useChatStore.getState().setUnreadCounts({});
      useChatStore.getState().clearNotificationAck();
    } catch(e) {}

    // 2. Close the Dexie DB connection
    try {
      const { closeDB } = await import('./db');
      closeDB();
    } catch(e) {}
  }

  // Every step runs on its own (src/lib/panicWipe.js): a dynamic import that
  // fails or hangs here can no longer skip the deletions or the storage clear.
  const panicWipe = async () => {
    return runPanicWipe({
      stop: [
        async () => { const { clearPool } = await import('./lib/pool'); clearPool(); },
        async () => { const { closeGroupSessions } = await import('./hooks/useNIP29Group'); closeGroupSessions(); },
        async () => { const { closeDB } = await import('./db'); closeDB(); },
      ],
      localStorage,
      sessionStorage,
      indexedDB: typeof indexedDB !== 'undefined' ? indexedDB : undefined,
      serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
      caches: 'caches' in window ? window.caches : undefined,
      destroyKeys: async (pubkeys) => destroyDeviceKeys(await ensureDeviceProvider(), pubkeys),
      reload: () => window.location.reload(),
    });
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

  // Removes a saved account from this device. The active account is refused;
  // switch away first, so removing never strands the account the app boots
  // into. Everything the device holds for that account goes with it: the
  // encrypted vault, its lockout counters, its scoped messages and settings.
  const removeAccount = async (targetPk) => {
    try {
      if (targetPk === (getActivePubkey() || keys.pk)) {
        return { success: false, error: 'Switch to another account first.' };
      }
      const vaults = getVaults();
      if (!vaults[targetPk]) return { success: false, error: 'Account not found' };
      delete vaults[targetPk];
      saveVaults(vaults);
      resetPinFailures(localStorage, targetPk);
      await deleteLockedOutDatabase(targetPk);
      // Scoped per-account keys, in both the legacy first-8-hex drawer and
      // the full-pubkey drawer this build reads. removeAccountKeys leaves a
      // drawer a saved account shares untouched. (security A2)
      removeAccountKeys(localStorage, targetPk);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };

  const switchAccount = async (targetPk, pin) => {
    if (!isPlausiblePin(pin)) return { success: false, error: PIN_TOO_SHORT_MESSAGE };
    try {
      const vaults = getVaults();
      if (!vaults[targetPk] || isDraftEntry(vaults[targetPk])) throw new Error('Account not found');

      let skArray;
      try {
        skArray = await openVault(vaults[targetPk].vault, pin, targetPk);
      } catch (error) {
        if (isDeviceKeyError(error)) {
          failUnlockAttempt(localStorage, targetPk, error);
          return { success: false, error: deviceKeyFailureMessage(error) };
        }
        const { lockedOut, remaining } = failUnlockAttempt(localStorage, targetPk, error);
        if (lockedOut) await deleteLockedOutDatabase(targetPk);
        return { success: false, error: lockedOut ? LOCKED_OUT_MESSAGE : pinFailureMessage(remaining) };
      }
      const { getPublicKey, nip19 } = await import('nostr-tools');
      const sk = Uint8Array.from(skArray);
      const pk = getPublicKey(sk);

      if (pk !== targetPk) throw new Error('Invalid PIN for this account');

      let targetVault = vaults[targetPk].vault;
      if (!isDeviceVault(targetVault)) {
        try {
          targetVault = await lockStoredVault({ pk, vault: targetVault, pin, skArray, activePk: getActivePubkey() });
        } catch (upgradeErr) {
          if (isDeviceKeyError(upgradeErr)) return { success: false, error: deviceLockUpgradeMessage(upgradeErr) };
          throw upgradeErr;
        }
      }

      setActivePubkey(targetPk);
      resetPinFailures(localStorage, targetPk);
      sessionStorage.setItem('cipher_session_sk', JSON.stringify(Array.from(sk)));
      
      // Update legacy vault too
      localStorage.setItem('cipher_vault', JSON.stringify(targetVault));
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

  return {
    ...keys, hasVault, hasBiometric, loadingSession,
    getAccounts, switchAccount, removeAccount, addNewAccount, getMnemonic,
    unlock, unlockWithBiometric, enableBiometric, restoreFromRelays, restoreFromMnemonic, createVault, confirmVault, finalizeLogin, lockApp, panicWipe
  }
}
