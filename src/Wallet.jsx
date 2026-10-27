import { lazy, Suspense, useState, useEffect, useLayoutEffect } from 'react'
import {
  User, Plus, AlertCircle, RefreshCw,
  Lock, ChevronRight, ArrowLeft, Copy, CreditCard, Camera,
  BarChart3, Package, KeyRound, Menu, ShieldAlert, Users, SlidersHorizontal, Shield, BookOpen, Moon
} from 'lucide-react'
import { uploadToBlossom } from '@nostr-wot/blossom'
import { useProfiles, updateProfileCache } from './useProfiles'
import { useChatStore } from './store/chatStore';
import AccountSwitcher from './components/chat/AccountSwitcher';
import IdentityBackup from './components/chat/IdentityBackup';
import MyOrders from './components/chat/MyOrders';
import MessageRequests from './components/chat/MessageRequests';
import { db } from './db';
import Logo from './components/Logo';
import { compressImage } from './lib/imageCompression';
import { loadVendorPaymentConfig, readPaymentAddresses, saveVendorPaymentConfig, savePaymentAddresses } from './lib/vendorPayments';
import PrivacySettings from './components/chat/PrivacySettings';
import Connections from './components/chat/Connections';
import Avatar from './components/ui/Avatar';
import Picture from './components/ui/Picture';
import ScreenHeader from './components/ui/ScreenHeader';
import { pressable } from './components/ui/Button';
import { pushToast } from './components/ui/toast';
import { copyText } from './lib/copyText';
import { scopedGet, scopedSet } from './lib/storage';
import { productRelays } from './lib/relays';
import { blossomServers } from './lib/egress';

const VendorDashboard = lazy(() => import('./components/chat/VendorDashboard'));
const ProfileEditor = lazy(() => import('./components/chat/ProfileEditor'));

// Two modes, one switch. The key is cipher_theme — the same key the old
// theme registry wrote — but with exactly two values now: 'dark' (default)
// and 'light'. Old registry values still saved on existing installs are
// orphaned and coerced here: 'paper' meant the light skin, everything else
// ('vault', 'lobby', 'chromerooms') meant dark.
const THEME_KEY = 'cipher_theme';

function readTheme() {
  try {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    if (saved === 'paper') return 'light';
    return 'dark';
  } catch {
    return 'dark';
  }
}

function writeTheme(mode) {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, mode);
  } catch { /* private mode */ }
  return mode;
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode === 'light' ? 'light' : '';
  return mode;
}

export default function Wallet({ identity, onOpenChat, startView = 'main' }) {
  const isVendor = useChatStore((state) => state.isVendor);
  const setIsVendor = useChatStore((state) => state.setIsVendor);
  const dms = useChatStore((state) => state.dms);
  const chatProfiles = useChatStore((state) => state.profiles);
  const [showPanicConfirm, setShowPanicConfirm] = useState(false);
  const profiles = useProfiles([identity.pk])
  const defaultName = identity.npub ? identity.npub.slice(0, 10) : 'User'
  
  const myProfile = profiles[identity.pk] || { name: defaultName, displayName: defaultName, picture: null, about: '' }

  // startView lets the phone drawer deep-link here (Orders, Connections);
  // AuthenticatedApp remounts this component when it changes.
  const [view, setView] = useState(startView)

  // Profile state
  const [username, setUsername] = useState('') 
  const [displayName, setDisplayName] = useState('')
  const [picture, setPicture] = useState('')
  const [about, setAbout] = useState('')
  
  // Product state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [image, setImage] = useState('')

  const [btcAddress, setBtcAddress] = useState(() => readPaymentAddresses().btc)
  const [xmrAddress, setXmrAddress] = useState(() => readPaymentAddresses().xmr)
  const [btcXpub, setBtcXpub] = useState('')
  const [btcNetwork, setBtcNetwork] = useState('bc')
  const [xmrPrivateViewKey, setXmrPrivateViewKey] = useState('')
  const [status, setStatus] = useState('')

  // Order settings: the buyer-side defaults the engines already read.
  // preferred_payment_method seeds new order requests (useCommerce);
  // confirmations overrides the watcher's paid threshold (paymentWatch);
  // auto_vouch_on_delivery gates the vendor vouch after a delivery.
  const [preferredMethod, setPreferredMethod] = useState(() => scopedGet('preferred_payment_method', 'btc'));
  const savedConf = scopedGet('confirmations', {}) || {};
  const [confBtc, setConfBtc] = useState(savedConf.btc != null ? String(savedConf.btc) : '');
  const [confXmr, setConfXmr] = useState(savedConf.xmr != null ? String(savedConf.xmr) : '');
  const [autoVouch, setAutoVouch] = useState(() => scopedGet('auto_vouch_on_delivery', true) !== false);

  const saveConfirmations = (event) => {
    event.preventDefault();
    const overrides = {};
    const btc = Number.parseInt(confBtc, 10);
    const xmr = Number.parseInt(confXmr, 10);
    if (Number.isInteger(btc) && btc >= 1) overrides.btc = btc;
    if (Number.isInteger(xmr) && xmr >= 1) overrides.xmr = xmr;
    // An empty save returns to the defaults: Bitcoin 3, Monero 10.
    scopedSet('confirmations', overrides);
    setStatus('Confirmation counts saved on this device.');
  };

  const toggleAutoVouch = () => {
    const next = !autoVouch;
    setAutoVouch(next);
    scopedSet('auto_vouch_on_delivery', next);
  };
  const [isPublishing, setIsPublishing] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savingAdvanced, setSavingAdvanced] = useState(false)

  // The look starts before first paint of this screen: read the persisted
  // mode and pin the attribute in a layout effect so no themed surface
  // flashes. Old registry values coerce on read (paper -> light, rest dark).
  const [theme, setTheme] = useState(readTheme)
  useLayoutEffect(() => { applyTheme(theme) }, [theme])
  const toggleTheme = () => setTheme((current) => writeTheme(current === 'light' ? 'dark' : 'light'))

  useEffect(() => {
    if (myProfile.name) setUsername(myProfile.name)
    if (myProfile.displayName) setDisplayName(myProfile.displayName)
    if (myProfile.picture) setPicture(myProfile.picture)
    if (myProfile.about) setAbout(myProfile.about)
  }, [myProfile.name, myProfile.displayName, myProfile.picture, myProfile.about])

  // Status pills are toasts, not signs: every message dismisses itself, so no
  // error state (including a mount-time unlock failure) can stick around and
  // bounce over the screen indefinitely. The banner itself is the shared
  // ui/Toast queue — this screen only feeds it.
  useEffect(() => {
    if (!status) return undefined;
    pushToast({ type: status.startsWith('Error') || status.startsWith('Could not') ? 'error' : 'info', message: status });
    const timer = window.setTimeout(() => setStatus(''), 6000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    let active = true;
    loadVendorPaymentConfig(identity)
      .then((config) => {
        if (active) {
          setBtcXpub(config.btcXpub);
          setXmrPrivateViewKey(config.xmrPrivateViewKey);
          setBtcNetwork(config.btcNetwork || 'bc');
        }
      })
      .catch((error) => {
        console.error('[Wallet] Could not load encrypted vendor settings:', error);
        if (active) setStatus('Could not unlock encrypted vendor settings.');
      });
    return () => { active = false; };
  }, [identity?.pk, identity?.sk]);

  const saveAdvancedSettings = async (event) => {
    event.preventDefault();
    setSavingAdvanced(true);
    setStatus('');
    try {
      await saveVendorPaymentConfig(identity, { btcXpub, xmrPrivateViewKey, btcNetwork });
      savePaymentAddresses({ btc: btcAddress, xmr: xmrAddress });
      setStatus('Advanced vendor settings saved on this device.');
    } catch (error) {
      console.error('[Wallet] Could not save advanced vendor settings:', error);
      setStatus(error?.message || 'Could not save advanced vendor settings.');
    } finally {
      setSavingAdvanced(false);
    }
  };

  const handleImageUpload = async (e, type) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploadingImage(true)
    setStatus('Uploading via Blossom...')

    try {
      const compressedFile = await compressImage(file, 800, 0.78);
      const blob = await uploadToBlossom(compressedFile, {
        servers: blossomServers(),
        signer: {
          getPublicKey: async () => identity.pk,
          signEvent: async (event) => {
            const { finalizeEvent } = await import('nostr-tools')
            return finalizeEvent(event, identity.sk)
          }
        },
      })

      if (type === 'profile') {
        setPicture(blob.url)
        if (view === 'main') await saveProfile(null, blob.url)
      }
      if (type === 'product') setImage(blob.url)
      setStatus('Image uploaded!')
    } catch (err) {
      console.error(err)
      useChatStore.getState().setToast({ type: 'info', message: `Upload failed: ${err.message}` });
    } finally {
      setUploadingImage(false)
      setTimeout(() => setStatus(''), 3000)
    }
  }

  const copyNpub = () => {
    if (identity.npub) {
      copyText(identity.npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const saveProfile = async (e, overridePicture = null) => {
    if (e) e.preventDefault()
    savePaymentAddresses({ btc: btcAddress, xmr: xmrAddress });
    if (!displayName) return useChatStore.getState().setToast({ type: 'info', message: "Display Name is required" });
    
    setIsPublishing(true); setStatus('Saving Profile...')
    const picToSave = overridePicture || picture
    try {
      const { publishCipherProfile } = await import('./useIdentity')
      const published = await publishCipherProfile(identity.sk, {
        username,
        displayName,
        about,
        picture: picToSave,
      })
      if (!published.profilePublished) throw new Error('No relay accepted the profile')

      updateProfileCache(identity.pk, { name: username, displayName, picture: picToSave, about })
      setStatus('Profile Saved!')
      setView('main')
    } catch (err) { setStatus('Error: ' + err.message) }
    finally { setIsPublishing(false); setTimeout(() => setStatus(''), 3000) }
  }

  const publishProduct = async () => {
    if (!title || !price) return useChatStore.getState().setToast({ type: 'info', message: "Title and Price required" });
    setIsPublishing(true); setStatus('Publishing...')
    let pool;
    const relays = productRelays;
    try {
      const { SimplePool, finalizeEvent } = await import('nostr-tools')
      pool = new SimplePool()
      const dTag = Date.now().toString()
      
      const tags = [
        ['d', dTag], ['title', title], ['price', price, currency],
        ['image', image || '/app-icon-512.png'], ['stock', '1'],
        ['status', 'active'], ['published_at', Math.floor(Date.now() / 1000).toString()],
        ['t', 'cipher_marketplace']
      ]
      // A listing never carries a payment address: the account's shared
      // address on a public event tells the world where every order's money
      // lands. The only address a buyer sees arrives on the accepted order,
      // derived fresh for that order. (security S2)
      
      const content = JSON.stringify({ name: title, description, price, currency, image })
      const ev = finalizeEvent({ kind: 30402, created_at: Math.floor(Date.now() / 1000), tags, content }, identity.sk)
      
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
      await Promise.race([Promise.allSettled(pool.publish(relays, ev)), timeout])
      
      // `d` is kept beside the event id because store orders name the menus by
      // the d tag, not by the event id. (security F5)
      const newProduct = { id: ev.id, d: dTag, name: title, description, price, currency, image: image || '/app-icon-512.png', stock: '1', vendorPubkey: identity.pk, created_at: ev.created_at }
      const cached = JSON.parse(localStorage.getItem('cipher_cached_products') || '[]')
      localStorage.setItem('cipher_cached_products', JSON.stringify([newProduct, ...cached.filter(p => p.id !== ev.id)]))

      setStatus('Product Published!')
      setTitle(''); setDescription(''); setPrice(''); setImage('')
      setView('main')
    } catch (err) { setStatus('Error: ' + err.message) } 
    finally { pool?.close(relays); setIsPublishing(false); setTimeout(() => setStatus(''), 3000) }
  }

  const saveVendorSetup = (event) => {
    event.preventDefault();
    if (!btcAddress.trim() && !xmrAddress.trim()) {
      setStatus('Add at least one BTC or XMR receiving address to enable Vendor mode.');
      return;
    }
    savePaymentAddresses({ btc: btcAddress, xmr: xmrAddress });
    setIsVendor(true);
    setStatus('Vendor mode is active. Payment addresses are saved on this device.');
    setView('main');
  }

  if (view === 'order_settings') {
    return (
      <div className="h-full overflow-y-auto bg-transparent pb-safe">
        <ScreenHeader title="Order settings" onBack={() => setView('main')} />
        <div className="space-y-4 p-4">
          <p className="text-[13px] text-inkMuted">Defaults for new orders and chain checks. Everything stays on this device.</p>
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            <div className="p-4">
              <p className="text-[15px] font-semibold text-ink">Preferred payment</p>
              <p className="mt-0.5 text-[13px] text-inkMuted">The coin a new order asks for first.</p>
              <div className="mt-3 grid grid-cols-2 rounded-xl border border-line p-1">
                <button type="button" onClick={() => { setPreferredMethod('btc'); scopedSet('preferred_payment_method', 'btc'); }} className={`min-h-[40px] rounded-lg py-2 text-[13px] font-bold ${preferredMethod === 'btc' ? 'bg-accent text-accentInk' : 'text-inkMuted'}`}>Bitcoin</button>
                <button type="button" onClick={() => { setPreferredMethod('xmr'); scopedSet('preferred_payment_method', 'xmr'); }} className={`min-h-[40px] rounded-lg py-2 text-[13px] font-bold ${preferredMethod === 'xmr' ? 'bg-accent text-accentInk' : 'text-inkMuted'}`}>Monero</button>
              </div>
            </div>
          </div>
          <form onSubmit={saveConfirmations} className="overflow-hidden rounded-2xl border border-line bg-panel">
            <div className="p-4">
              <p className="text-[15px] font-semibold text-ink">Confirmation count</p>
              <p className="mt-0.5 text-[13px] text-inkMuted">How many mined blocks before an order reads paid. Leave a count empty to keep its default: Bitcoin 3, Monero 10.</p>
            </div>
            <div className="grid grid-cols-2 border-t border-line">
              <label className="border-r border-line p-4">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-inkSubtle">Bitcoin blocks</span>
                <input type="number" min="1" inputMode="numeric" autoComplete="off" value={confBtc} onChange={(event) => setConfBtc(event.target.value)} placeholder="3" className="mt-1 w-full bg-transparent text-[17px] font-bold text-ink outline-none placeholder:text-inkSubtle" />
              </label>
              <label className="p-4">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-inkSubtle">Monero blocks</span>
                <input type="number" min="1" inputMode="numeric" autoComplete="off" value={confXmr} onChange={(event) => setConfXmr(event.target.value)} placeholder="10" className="mt-1 w-full bg-transparent text-[17px] font-bold text-ink outline-none placeholder:text-inkSubtle" />
              </label>
            </div>
            <button type="submit" className="w-full border-t border-line bg-transparent py-3 text-[14px] font-bold text-accentText active:bg-ink/5">Save counts</button>
          </form>
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            <button type="button" onClick={toggleAutoVouch} aria-pressed={autoVouch} className="flex w-full items-center gap-3 p-4 text-left">
              <Shield size={24} className="shrink-0 text-inkSubtle" />
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Auto-vouch on delivery</span><span className="block text-[13px] text-inkMuted">After you deliver, vouch the trade automatically.</span></span>
              <span aria-hidden="true" className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${autoVouch ? 'bg-accent' : 'bg-ink/15'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-accentInk transition-all ${autoVouch ? 'left-[18px]' : 'left-0.5'}`} />
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'account_switcher') {
    return <AccountSwitcher identity={identity} onClose={() => setView('main')} />;
  }

  if (view === 'orders') {
    return <MyOrders dms={dms} profiles={chatProfiles} onBack={() => setView('main')} onOpenChat={onOpenChat} identity={identity} />;
  }

  if (view === 'message_requests') {
    return <MessageRequests dms={dms} profiles={chatProfiles} onBack={() => setView('main')} onOpenChat={onOpenChat} />;
  }

  if (view === 'identity_backup') {
    return <IdentityBackup identity={identity} onClose={() => setView('main')} />;
  }

  if (view === 'privacy') return <PrivacySettings onBack={() => setView('main')} />;
  if (view === 'connections') return <Connections onBack={() => setView('main')} />;

  if (view === 'profile_editor') {
    return <Suspense fallback={<div className="flex h-full items-center justify-center bg-scrim"><div className="h-7 w-7 animate-spin rounded-full border-2 border-ink/20 border-t-accentText" /></div>}><ProfileEditor identity={identity} onClose={() => setView('main')} /></Suspense>;
  }

  if (view === 'vendor') {
    return <Suspense fallback={<div className="flex h-full items-center justify-center bg-scrim"><div className="h-7 w-7 animate-spin rounded-full border-2 border-ink/20 border-t-accentText" /></div>}><VendorDashboard identity={identity} products={JSON.parse(localStorage.getItem('cipher_my_products') || '[]')} onBack={() => setView('main')} onCreate={() => setView('product')} /></Suspense>;
  }

  if (view === 'vendor_setup') {
    return (
      <div className="h-full overflow-y-auto bg-transparent pb-safe">
        <ScreenHeader title="Start selling" onBack={() => setView('main')} />
        <form onSubmit={saveVendorSetup} className="space-y-4 p-4">
          <p className="text-[13px] text-inkMuted">Add at least one address. It stays on this device. Never enter a seed phrase or spending key.</p>
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            <input value={btcAddress} onChange={(event) => setBtcAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Bitcoin address" className="w-full border-b border-line bg-transparent px-4 py-4 text-[15px] text-ink outline-none placeholder:text-inkSubtle" />
            <input value={xmrAddress} onChange={(event) => setXmrAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Monero address" className="w-full bg-transparent px-4 py-4 text-[15px] text-ink outline-none placeholder:text-inkSubtle" />
          </div>
          {/* status renders through the shared ui/Toast queue; no local sign */}
          <button type="submit" className="w-full rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent">Save and turn on selling</button>
        </form>
      </div>
    );
  }

  if (view === 'advanced') {
    if (!isVendor) {
      return (
        <div className="h-full p-4">
          <button type="button" onClick={() => setView('main')} className="mb-5 -ml-2 touch-target p-2 text-inkMuted hover:text-ink"><ArrowLeft size={20} /></button>
          <h2 className="text-xl font-bold text-ink">Vendor settings only</h2>
          <p className="mt-2 text-sm text-inkMuted">Advanced payment settings are available after completing Vendor setup.</p>
        </div>
      );
    }
    return (
      <div className="h-full overflow-y-auto bg-transparent pb-8">
        <ScreenHeader title="Payment settings" onBack={() => setView('main')} />
        <form onSubmit={saveAdvancedSettings} className="space-y-4 p-4">
          <p className="text-[13px] text-inkMuted">A view key and an xpub only let you watch payments. They stay on this device. Never enter a seed or a spend key.</p>
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            <input value={xmrAddress} onChange={(event) => setXmrAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Monero address" className="w-full border-b border-line bg-panelStrong px-4 py-4 text-[15px] text-ink outline-none placeholder:text-inkSubtle" />
            <input type="password" value={xmrPrivateViewKey} onChange={(event) => setXmrPrivateViewKey(event.target.value)} autoComplete="new-password" spellCheck="false" placeholder="Monero view key" className="w-full border-b border-line bg-panelStrong px-4 py-4 text-[15px] text-ink outline-none placeholder:text-inkSubtle" />
            <input type="password" value={btcXpub} onChange={(event) => setBtcXpub(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Bitcoin xpub" className="w-full border-b border-line bg-panelStrong px-4 py-4 text-[15px] text-ink outline-none placeholder:text-inkSubtle" />
            <select value={btcNetwork} onChange={(event) => setBtcNetwork(event.target.value)} className="w-full bg-panelStrong px-4 py-4 text-[15px] text-ink outline-none">
              <option value="bc">Bitcoin mainnet</option>
              <option value="bcrt">Bitcoin regtest</option>
            </select>
          </div>
          <button type="submit" disabled={savingAdvanced} className="w-full rounded-2xl bg-accent py-3.5 font-bold text-accentInk disabled:opacity-40">
            {savingAdvanced ? 'Saving…' : 'Save'}
          </button>
          {/* status renders through the shared ui/Toast queue; no local sign */}
        </form>
      </div>
    );
  }

  // --- SUB-SCREEN: ADD PRODUCT ---
  if (view === 'product') {
    return (
      <div className="h-full overflow-y-auto bg-transparent pb-8">
        <ScreenHeader title="New listing" onBack={() => setView('main')} />
        <div className="space-y-4 p-4">
          <input placeholder="Product Title" value={title} onChange={e => setTitle(e.target.value)} className="w-full border border-line bg-panelStrong shadow-lg rounded-2xl p-4 text-sm focus:border-accent outline-none" />
          <textarea placeholder="Description" value={description} onChange={e => setDescription(e.target.value)} className="w-full border border-line bg-panelStrong shadow-lg rounded-2xl p-4 text-sm focus:border-accent outline-none resize-none h-24" />
          
          <div className="flex items-center gap-4 p-4 border border-line bg-panelStrong shadow-lg rounded-2xl">
            <Picture src={image} alt="product" className="w-16 h-16 rounded-xl object-cover" fallback={<div className="flex h-16 w-16 items-center justify-center rounded-xl border border-ink/10 bg-ink/5"><Camera size={24} className="text-ink/20" /></div>} />
            <div className="flex-1">
              <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'product')} className="hidden" id="product-upload" />
              <label htmlFor="product-upload" className="py-2 px-4 bg-ink/10 rounded-xl text-sm font-semibold cursor-pointer hover:bg-ink/20 transition-colors inline-block">
                {uploadingImage ? 'Uploading...' : 'Choose Photo'}
              </label>
            </div>
          </div>

          <div className="flex gap-3">
            <input placeholder="Price" type="number" value={price} onChange={e => setPrice(e.target.value)} className="flex-1 border border-line bg-panelStrong shadow-lg rounded-2xl p-4 text-sm focus:border-accent outline-none" />
            <select value={currency} onChange={e => setCurrency(e.target.value)} className="border border-line bg-panelStrong shadow-lg rounded-2xl px-4 text-sm focus:border-accent outline-none">
              <option value="USD">USD</option><option value="BTC">BTC</option><option value="XMR">XMR</option>
            </select>
          </div>
          
          <button onClick={publishProduct} disabled={isPublishing || uploadingImage} className="w-full py-4 bg-accent text-accentInk rounded-2xl font-bold text-sm mt-4 flex justify-center items-center gap-2 hover:bg-accent transition-colors">
            {isPublishing ? <RefreshCw size={16} className="animate-spin"/> : 'Publish to Store'}
          </button>
        </div>
      </div>
    )
  }

  // --- MAIN PROFILE TAB ---
  return (
    <div className="animate-fade-in overflow-y-auto h-full pb-4 pb-[env(safe-area-inset-bottom)]">
      {/* status renders through the shared ui/Toast queue; no local pill */}

      {/* HEADER PROFILE CARD */}
      <div className="flex flex-col items-center px-4 pb-2 pt-3 md:pt-8">
        <div className="mb-2 flex w-full items-center px-1 md:hidden">
          <button type="button" onClick={() => useChatStore.getState().setShowDrawer(true)} aria-label="Open menu" className="-ml-1 touch-target p-2 text-inkMuted hover:text-ink"><Menu size={20} /></button>
        </div>
        <div className="relative mb-4">
          <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'profile')} className="hidden" id="main-avatar-upload" />
          <label htmlFor="main-avatar-upload" className="relative block cursor-pointer">
            <Picture src={myProfile.picture} alt="" className="h-20 w-20 rounded-full border border-line object-cover" fallback={<Avatar name={myProfile.displayName || myProfile.name} className="!h-20 !w-20 text-2xl" />} />
          </label>
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">{myProfile.displayName}</h2>
        <p className="mb-3 text-[13px] text-inkMuted">@{myProfile.name}</p>
        {myProfile.about && <p className="mb-3 px-6 text-center text-[13px] text-inkMuted">{myProfile.about}</p>}
        <button onClick={copyNpub} className="flex min-h-[44px] items-center gap-2 rounded-full border border-line bg-panel px-4 py-2 text-[12px] text-inkMuted">
          {copied ? 'Copied!' : `${identity.npub?.slice(0, 12)}...${identity.npub?.slice(-4)}`}
          <Copy size={12} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <button onClick={() => setView('orders')} className={`flex w-full items-center gap-3 border-b border-line p-4 text-left ${pressable}`}>
            <Package size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">My Orders</span><span className="block text-[13px] text-inkMuted">Purchases and shipping</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
          <button onClick={() => setView('profile_editor')} className={`flex w-full items-center gap-3 border-b border-line p-4 text-left ${pressable}`}>
            <User size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Edit Profile</span><span className="block text-[13px] text-inkMuted">Name, bio, and photo</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
          <button onClick={() => useChatStore.getState().setShowTutorial(true)} className={`flex w-full items-center gap-3 border-b border-line p-4 text-left ${pressable}`}>
            <BookOpen size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">How to use</span><span className="block text-[13px] text-inkMuted">A walkthrough of the app</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
          <button onClick={() => setView('privacy')} className="flex w-full items-center gap-3 p-4 text-left">
            <Shield size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Privacy</span><span className="block text-[13px] text-inkMuted">Calls, last seen, blocked</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          {!isVendor ? (
            <button type="button" onClick={() => { setStatus(''); setView('vendor_setup'); }} className="flex w-full items-center gap-3 p-4 text-left">
              <CreditCard size={24} className="shrink-0 text-inkSubtle" />
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Start selling</span><span className="block text-[13px] text-inkMuted">Take payment directly</span></span>
              <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
            </button>
          ) : (
            <>
              <button type="button" onClick={() => setView('vendor')} className="flex w-full items-center gap-3 border-b border-line p-4 text-left">
                <BarChart3 size={24} className="shrink-0 text-inkSubtle" />
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Vendor</span><span className="block text-[13px] text-inkMuted">Orders and listings</span></span>
                <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
              </button>
              <button type="button" onClick={() => setView('advanced')} className="flex w-full items-center gap-3 p-4 text-left">
                <SlidersHorizontal size={24} className="shrink-0 text-inkSubtle" />
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Payment settings</span><span className="block text-[13px] text-inkMuted">Addresses for each order</span></span>
                <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
              </button>
            </>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <button onClick={() => setView('order_settings')} className="flex w-full items-center gap-3 p-4 text-left">
            <Package size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Order settings</span><span className="block text-[13px] text-inkMuted">Preferred coin, confirmation count, auto-vouch</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <button type="button" role="switch" aria-checked={theme === 'light'} aria-label="Light mode" onClick={toggleTheme} className={`flex w-full items-center gap-3 p-4 text-left ${pressable}`}>
            <Moon size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Light mode</span><span className="block text-[13px] text-inkMuted">Warm paper instead of dark. Remembered on this device.</span></span>
            <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${theme === 'light' ? 'bg-accent' : 'bg-ink/15'}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-ink transition-transform ${theme === 'light' ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </span>
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <button onClick={() => setView('message_requests')} className="flex w-full items-center gap-3 border-b border-line p-4 text-left">
            <Users size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Message requests</span><span className="block text-[13px] text-inkMuted">People you have not answered</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
          <button onClick={() => setView('identity_backup')} className="flex w-full items-center gap-3 border-b border-line p-4 text-left">
            <KeyRound size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Backup</span><span className="block text-[13px] text-inkMuted">Secret key and recovery phrase</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
          <button onClick={() => setView('account_switcher')} className="flex w-full items-center gap-3 border-b border-line p-4 text-left">
            <RefreshCw size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">Accounts</span><span className="block text-[13px] text-inkMuted">Switch on this device</span></span>
            <ChevronRight size={18} className="shrink-0 text-inkSubtle" />
          </button>
          <button onClick={identity.lockApp} className="flex w-full items-center gap-3 p-4 text-left">
            <Lock size={24} className="shrink-0 text-inkSubtle" />
            <span className="min-w-0 flex-1 text-[15px] font-semibold text-ink">Lock</span>
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          {isVendor && (
            <button onClick={async () => {
              setIsVendor(false);
              // Leaving vendor mode clears what the mode saved: the leftover
              // receiving addresses were the bug — they stuck around on this
              // device and made the app bounce like a stuck error.
              setBtcAddress('');
              setXmrAddress('');
              // The advanced-payment form state would otherwise still hold the
              // old keys and save them right back on the next Save.
              setBtcXpub('');
              setXmrPrivateViewKey('');
              setBtcNetwork('bc');
              savePaymentAddresses({ btc: '', xmr: '' });
              try {
                await saveVendorPaymentConfig(identity, { btcXpub: '', xmrPrivateViewKey: '', btcNetwork: 'bc' });
              } catch (wipeError) {
                useChatStore.getState().setToast({ type: 'error', message: `Could not clear vendor payment settings. ${wipeError?.message || ''}`.trim() });
              }
              useChatStore.getState().setToast({ type: 'success', message: 'Switched to buyer mode. Payment details were cleared from this device.' });
            }} className="flex w-full items-center gap-3 border-b border-line p-4 text-left">
              <span className="text-[15px] font-semibold text-accentText">Switch to buyer mode</span>
            </button>
          )}
          <button onClick={() => setShowPanicConfirm(true)} className="flex w-full items-center gap-3 p-4 text-left">
            <AlertCircle size={24} className="shrink-0 text-danger" />
            <span><span className="block text-[15px] font-semibold text-danger">Panic wipe</span><span className="block text-[13px] text-inkSubtle">Erase this device</span></span>
          </button>
        </div>
      </div>

      {/* PANIC CONFIRM MODAL */}
      {showPanicConfirm && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-scrim/80 p-4 animate-fade-in">
          <div className="bg-panel border border-line rounded-2xl w-full max-w-sm p-6">
            <h2 className="text-xl font-bold text-ink mb-2">Panic Wipe</h2>
            <p className="text-sm text-ink/70 mb-6">This will instantly destroy all local data on this device. Make sure you have saved your 12-word recovery phrase!</p>
            <div className="flex gap-3">
              <button onClick={() => setShowPanicConfirm(false)} className="flex-1 py-3 border border-line bg-panelStrong rounded-xl font-bold text-ink transition-colors">Cancel</button>
              <button onClick={async () => {
                setShowPanicConfirm(false);
                try {
                  await db.messages.clear();
                } catch (error) {
                  console.error('[Wallet] Could not clear active message table before full wipe:', error);
                }
                await identity.panicWipe();
              }} className="flex-1 py-3 bg-danger text-accentInk rounded-xl font-bold transition-colors">Wipe It</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
