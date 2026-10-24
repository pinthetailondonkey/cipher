import { lazy, Suspense, useState, useEffect } from 'react'
import {  
  User, Plus, AlertCircle, RefreshCw, 
  Lock, ChevronRight, ArrowLeft, Copy, CreditCard, Camera,
  BarChart3, Package, KeyRound, ShieldAlert, Users, SlidersHorizontal
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
import { scopedGet, scopedSet } from './lib/storage';
import { loadVendorPaymentConfig, saveVendorPaymentConfig } from './lib/vendorPayments';

const VendorDashboard = lazy(() => import('./components/chat/VendorDashboard'));
const ProfileEditor = lazy(() => import('./components/chat/ProfileEditor'));

export default function Wallet({ identity, onOpenChat }) {
  const isVendor = useChatStore((state) => state.isVendor);
  const setIsVendor = useChatStore((state) => state.setIsVendor);
  const dms = useChatStore((state) => state.dms);
  const chatProfiles = useChatStore((state) => state.profiles);
  const [showPanicConfirm, setShowPanicConfirm] = useState(false);
  const panicWipeEnabled = useChatStore((s) => s.panicWipeEnabled);
  const setPanicWipeEnabled = useChatStore((s) => s.setPanicWipeEnabled);
  const profiles = useProfiles([identity.pk])
  const defaultName = identity.npub ? identity.npub.slice(0, 10) : 'User'
  
  const myProfile = profiles[identity.pk] || { name: defaultName, displayName: defaultName, picture: null, about: '' }

  const [view, setView] = useState('main') 

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

  const [btcAddress, setBtcAddress] = useState(() => scopedGet('btc_address', localStorage.getItem('cipher_btc_address') || localStorage.getItem('cipher_btc') || ''))
  const [xmrAddress, setXmrAddress] = useState(() => scopedGet('xmr_address', localStorage.getItem('cipher_xmr_address') || localStorage.getItem('cipher_xmr') || ''))
  const [btcXpub, setBtcXpub] = useState('')
  const [xmrPrivateViewKey, setXmrPrivateViewKey] = useState('')
  const [status, setStatus] = useState('')
  const [isPublishing, setIsPublishing] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savingAdvanced, setSavingAdvanced] = useState(false)

  useEffect(() => {
    if (myProfile.name) setUsername(myProfile.name)
    if (myProfile.displayName) setDisplayName(myProfile.displayName)
    if (myProfile.picture) setPicture(myProfile.picture)
    if (myProfile.about) setAbout(myProfile.about)
  }, [myProfile.name, myProfile.displayName, myProfile.picture, myProfile.about])

  useEffect(() => {
    let active = true;
    loadVendorPaymentConfig(identity)
      .then((config) => {
        if (active) {
          setBtcXpub(config.btcXpub);
          setXmrPrivateViewKey(config.xmrPrivateViewKey);
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
      await saveVendorPaymentConfig(identity, { btcXpub, xmrPrivateViewKey });
      scopedSet('btc_address', btcAddress);
      scopedSet('xmr_address', xmrAddress);
      localStorage.setItem('cipher_btc_address', btcAddress);
      localStorage.setItem('cipher_xmr_address', xmrAddress);
      localStorage.setItem('cipher_btc', btcAddress);
      localStorage.setItem('cipher_xmr', xmrAddress);
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
      navigator.clipboard.writeText(identity.npub)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    }
  }

  const saveProfile = async (e, overridePicture = null) => {
    if (e) e.preventDefault()
    scopedSet('btc_address', btcAddress);
    scopedSet('xmr_address', xmrAddress);
    localStorage.setItem('cipher_btc_address', btcAddress);
    localStorage.setItem('cipher_xmr_address', xmrAddress);
    if (!displayName) return useChatStore.getState().setToast({ type: 'info', message: "Display Name is required" });
    
    setIsPublishing(true); setStatus('Saving Profile...')
    const picToSave = overridePicture || picture
    let pool;
    const relays = ['wss://relay.primal.net'];
    try {
      const { SimplePool, finalizeEvent } = await import('nostr-tools')
      pool = new SimplePool()

      const ev = finalizeEvent({
        kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [],
        content: JSON.stringify({ name: username, display_name: displayName, about, picture: picToSave })
      }, identity.sk)

      const publishPromises = pool.publish(relays, ev)
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
      await Promise.race([Promise.allSettled(publishPromises), timeout])
      
      if (username) {
        try {
          const usernameEv = finalizeEvent({
            kind: 10003, created_at: Math.floor(Date.now() / 1000),
            tags: [['d', 'username'], ['t', 'cipher_username_' + username], ['t', 'cipher_username'], ['username', username]],
            content: ''
          }, identity.sk)
          const usernameRelays = ['wss://relay.primal.net', 'wss://groups.aegispayhq.com']
          await Promise.race([Promise.allSettled(pool.publish(usernameRelays, usernameEv)), timeout])
        } catch (e) { console.error(e) }
      }

      updateProfileCache(identity.pk, { name: username, displayName, picture: picToSave, about })
      setStatus('Profile Saved!')
      setView('main')
    } catch (err) { setStatus('Error: ' + err.message) } 
    finally { pool?.close([...new Set([...relays, 'wss://groups.aegispayhq.com'])]); setIsPublishing(false); setTimeout(() => setStatus(''), 3000) }
  }

  const publishProduct = async () => {
    if (!title || !price) return useChatStore.getState().setToast({ type: 'info', message: "Title and Price required" });
    setIsPublishing(true); setStatus('Publishing...')
    let pool;
    const relays = ['wss://relay.primal.net'];
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
      if (btcAddress) tags.push(['payment', `btc:${btcAddress}`])
      if (xmrAddress) tags.push(['payment', `xmr:${xmrAddress}`])
      
      const content = JSON.stringify({ name: title, description, price, currency, image })
      const ev = finalizeEvent({ kind: 30402, created_at: Math.floor(Date.now() / 1000), tags, content }, identity.sk)
      
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
      await Promise.race([Promise.allSettled(pool.publish(relays, ev)), timeout])
      
      const newProduct = { id: ev.id, name: title, description, price, currency, image: image || '/app-icon-512.png', stock: '1', vendorPubkey: identity.pk, created_at: ev.created_at }
      const cached = JSON.parse(localStorage.getItem('cipher_cached_products') || '[]')
      localStorage.setItem('cipher_cached_products', JSON.stringify([newProduct, ...cached.filter(p => p.id !== ev.id)]))

      setStatus('Product Published!')
      setTitle(''); setDescription(''); setPrice(''); setImage('')
      setView('main')
    } catch (err) { setStatus('Error: ' + err.message) } 
    finally { pool?.close(relays); setIsPublishing(false); setTimeout(() => setStatus(''), 3000) }
  }

  const savePayments = () => {
    scopedSet('btc_address', btcAddress);
    scopedSet('xmr_address', xmrAddress);
    localStorage.setItem('cipher_btc', btcAddress)
    localStorage.setItem('cipher_xmr', xmrAddress)
    setStatus('Addresses saved!'); setTimeout(() => setStatus(''), 2000)
    setView('main')
  }

  const saveVendorSetup = (event) => {
    event.preventDefault();
    if (!btcAddress.trim() && !xmrAddress.trim()) {
      setStatus('Add at least one BTC or XMR receiving address to enable Vendor mode.');
      return;
    }
    scopedSet('btc_address', btcAddress.trim());
    scopedSet('xmr_address', xmrAddress.trim());
    localStorage.setItem('cipher_btc_address', btcAddress.trim());
    localStorage.setItem('cipher_xmr_address', xmrAddress.trim());
    localStorage.setItem('cipher_btc', btcAddress.trim());
    localStorage.setItem('cipher_xmr', xmrAddress.trim());
    setIsVendor(true);
    setStatus('Vendor mode is active. Payment addresses are saved on this device.');
    setView('main');
  }

  if (view === 'account_switcher') {
    return <AccountSwitcher identity={identity} onClose={() => setView('main')} />;
  }

  if (view === 'orders') {
    return <MyOrders dms={dms} profiles={chatProfiles} onBack={() => setView('main')} onOpenChat={onOpenChat} />;
  }

  if (view === 'message_requests') {
    return <MessageRequests dms={dms} profiles={chatProfiles} onBack={() => setView('main')} onOpenChat={onOpenChat} />;
  }

  if (view === 'identity_backup') {
    return <IdentityBackup identity={identity} onClose={() => setView('main')} />;
  }

  if (view === 'profile_editor') {
    return <Suspense fallback={<div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>}><ProfileEditor identity={identity} onClose={() => setView('main')} /></Suspense>;
  }

  if (view === 'vendor') {
    return <Suspense fallback={<div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>}><VendorDashboard identity={identity} products={JSON.parse(localStorage.getItem('cipher_my_products') || '[]')} onBack={() => setView('main')} /></Suspense>;
  }

  if (view === 'vendor_setup') {
    return (
      <div className="h-full overflow-y-auto p-4 pb-safe">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={() => setView('main')} className="-ml-2 touch-target p-2 text-white/50 hover:text-white"><ArrowLeft size={20} /></button>
          <h2 className="text-xl font-bold text-white">Set up Vendor mode</h2>
        </div>
        <p className="mb-5 text-sm leading-relaxed text-white/50">Add at least one receiving address before enabling vendor tools. You can update these any time from Profile.</p>
        <form onSubmit={saveVendorSetup} className="space-y-4">
          <label className="block text-sm text-white/65">Bitcoin receiving address
            <input value={btcAddress} onChange={(event) => setBtcAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="bc1…" className="mt-2 w-full rounded-xl border border-white/10 bg-[#111] p-4 text-sm text-white outline-none focus:border-blue-500" />
          </label>
          <label className="block text-sm text-white/65">Monero receiving address
            <input value={xmrAddress} onChange={(event) => setXmrAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Monero mainnet address" className="mt-2 w-full rounded-xl border border-white/10 bg-[#111] p-4 text-sm text-white outline-none focus:border-blue-500" />
          </label>
          <p className="text-xs leading-relaxed text-white/35">Addresses are stored on this device. Never enter a seed phrase, private key, or spending key here.</p>
          {status && <p role="status" className="text-sm text-amber-300">{status}</p>}
          <button type="submit" className="min-h-12 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white hover:bg-blue-500">Save addresses and enable Vendor mode</button>
        </form>
      </div>
    );
  }

  if (view === 'advanced') {
    if (!isVendor) {
      return (
        <div className="h-full p-4">
          <button type="button" onClick={() => setView('main')} className="mb-5 -ml-2 touch-target p-2 text-white/50 hover:text-white"><ArrowLeft size={20} /></button>
          <h2 className="text-xl font-bold text-white">Vendor settings only</h2>
          <p className="mt-2 text-sm text-white/45">Advanced payment settings are available after completing Vendor setup.</p>
        </div>
      );
    }
    return (
      <div className="h-full overflow-y-auto p-4 pb-24">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={() => setView('main')} className="-ml-2 p-2 text-white/50 hover:text-white"><ArrowLeft size={20} /></button>
          <h2 className="text-xl font-bold text-white">Advanced Settings</h2>
        </div>
        <form onSubmit={saveAdvancedSettings} className="space-y-4">
            <section className="space-y-3 rounded-2xl border border-white/10 bg-[#111] p-4">
              <h3 className="text-sm font-semibold text-white">Per-order payment addresses</h3>
              <p className="text-xs leading-relaxed text-white/45">Optional. Configure an account-level Bitcoin xpub and a Monero private view key to generate a fresh receiving address for each accepted order.</p>
              <div>
                <label className="mb-1 block text-xs text-white/60">Main Monero address</label>
                <input value={xmrAddress} onChange={(event) => setXmrAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Monero mainnet address" className="w-full rounded-xl border border-white/10 bg-black p-3 font-mono text-xs text-white outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-white/60">Monero private view key</label>
                <input type="password" value={xmrPrivateViewKey} onChange={(event) => setXmrPrivateViewKey(event.target.value)} autoComplete="new-password" spellCheck="false" placeholder="64-character hexadecimal key" className="w-full rounded-xl border border-white/10 bg-black p-3 font-mono text-xs text-white outline-none focus:border-blue-500" />
                <p className="mt-1 text-[10px] leading-relaxed text-white/35">Kept on this device and encrypted using your unlocked account key. Never enter your Monero spend key or seed phrase.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs text-white/60">Bitcoin account xpub (optional)</label>
                <input type="password" value={btcXpub} onChange={(event) => setBtcXpub(event.target.value)} autoComplete="off" spellCheck="false" placeholder="xpub… (public key only)" className="w-full rounded-xl border border-white/10 bg-black p-3 font-mono text-xs text-white outline-none focus:border-blue-500" />
                <p className="mt-1 text-[10px] leading-relaxed text-white/35">Use an account-level mainnet xpub. Never enter an xprv, seed phrase, or spending key.</p>
              </div>
            </section>
            <button type="submit" disabled={savingAdvanced} className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
              {savingAdvanced ? 'Saving…' : 'Save vendor payment settings'}
            </button>
        </form>
        {status && <p role="status" className={`mt-4 text-center text-sm ${status.startsWith('Could not') || status.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>{status}</p>}
      </div>
    );
  }

  // --- SUB-SCREEN: EDIT PROFILE ---
  if (view === 'edit_profile') {
    return (
      <div className="p-4 animate-slide-up pb-24 overflow-y-auto h-full">
        <div className="flex items-center gap-2 mb-6">
          <button onClick={() => setView('main')} className="p-2 -ml-2 text-white/50 hover:text-white transition-colors">
            <ArrowLeft size={20}/>
          </button>
          <h2 className="text-xl font-bold">Edit Profile</h2>
        </div>
        
        <div className="flex flex-col items-center mb-8">
          <div className="relative">
            {picture ? (
              <img src={picture} alt="avatar" className="w-24 h-24 rounded-full object-cover border-2 border-white/10 shadow-lg" />
            ) : (
              <div className="w-24 h-24 rounded-full bg-[#111] flex items-center justify-center border-2 border-white/10 shadow-lg">
                <User size={32} className="text-white/30" />
              </div>
            )}
            <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'profile')} className="hidden" id="profile-upload" />
            <label htmlFor="profile-upload" className="absolute bottom-0 right-0 p-2 bg-blue-600 text-white rounded-full border-4 border-black cursor-pointer hover:bg-blue-500 transition-transform active:scale-95">
              {uploadingImage ? <RefreshCw size={14} className="animate-spin"/> : <Camera size={14} />}
            </label>
          </div>
        </div>

        <form onSubmit={saveProfile} className="space-y-5">
          <div className="bg-[#111] border border-white/10 rounded-2xl p-4">
            <h3 className="text-xs font-bold text-white/50 uppercase tracking-wider mb-3">Payment Addresses</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-white/60 mb-1">Bitcoin (BTC)</label>
                <input type="text" placeholder="bc1q..." value={btcAddress} onChange={(e) => setBtcAddress(e.target.value)} className="w-full bg-black border border-white/10 rounded-xl p-3 text-sm text-white placeholder-white/20 focus:border-blue-500 outline-none transition-colors" />
              </div>
              <div>
                <label className="block text-xs text-white/60 mb-1">Monero (XMR)</label>
                <input type="text" placeholder="4..." value={xmrAddress} onChange={(e) => setXmrAddress(e.target.value)} className="w-full bg-black border border-white/10 rounded-xl p-3 text-sm text-white placeholder-white/20 focus:border-blue-500 outline-none transition-colors" />
              </div>
            </div>
          </div>

          <div>
            <div className="w-full bg-[#111] border border-white/10 rounded-2xl p-4 flex items-center gap-3">
              <span className="text-white/30 text-lg">@</span>
              <span className="text-sm text-white/50 font-mono tracking-wide">{username}</span>
            </div>
            <p className="text-[10px] text-white/30 mt-1.5 ml-1">Usernames are permanent and cannot be changed.</p>
          </div>

          <div>
            <label className="text-xs text-white/50 ml-1 mb-1.5 block">Display Name</label>
            <input placeholder="e.g. Alice's Shop" value={displayName} onChange={e => setDisplayName(e.target.value)} className="w-full bg-[#111] border border-white/10 rounded-2xl p-4 text-sm text-white placeholder-white/20 focus:border-blue-500 outline-none transition-colors" />
          </div>
          
          <div>
            <label className="text-xs text-white/50 ml-1 mb-1.5 block">Bio</label>
            <textarea placeholder="Tell buyers about your shop..." value={about} onChange={e => setAbout(e.target.value)} className="w-full bg-[#111] border border-white/10 rounded-2xl p-4 text-sm text-white placeholder-white/20 focus:border-blue-500 outline-none resize-none h-24 transition-colors" />
          </div>
          
          <button type="submit" disabled={isPublishing || uploadingImage} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-sm mt-2 flex justify-center items-center gap-2 transition-transform active:scale-95 disabled:opacity-50 hover:bg-blue-500">
            {isPublishing ? <RefreshCw size={16} className="animate-spin"/> : 'Save Profile'}
          </button>
        </form>
      </div>
    )
  }

  // --- SUB-SCREEN: ADD PRODUCT ---
  if (view === 'product') {
    return (
      <div className="p-4 animate-slide-up overflow-y-auto h-full">
        <button onClick={() => setView('main')} className="flex items-center gap-1 text-white/50 text-sm mb-6 hover:text-white transition-colors"><ArrowLeft size={16}/> Back</button>
        <h2 className="text-xl font-bold mb-6">List New Product</h2>
        
        <div className="space-y-4">
          <input placeholder="Product Title" value={title} onChange={e => setTitle(e.target.value)} className="w-full bg-[#111] border border-white/10 rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
          <textarea placeholder="Description" value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-[#111] border border-white/10 rounded-2xl p-4 text-sm focus:border-blue-500 outline-none resize-none h-24" />
          
          <div className="flex items-center gap-4 p-4 bg-[#111] border border-white/10 rounded-2xl">
            {image ? (
              <img src={image} alt="product" className="w-16 h-16 rounded-xl object-cover" />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-black flex items-center justify-center">
                <Camera size={24} className="text-white/20" />
              </div>
            )}
            <div className="flex-1">
              <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'product')} className="hidden" id="product-upload" />
              <label htmlFor="product-upload" className="py-2 px-4 bg-white/10 rounded-xl text-sm font-semibold cursor-pointer hover:bg-white/20 transition-colors inline-block">
                {uploadingImage ? 'Uploading...' : 'Choose Photo'}
              </label>
            </div>
          </div>

          <div className="flex gap-3">
            <input placeholder="Price" type="number" value={price} onChange={e => setPrice(e.target.value)} className="flex-1 bg-[#111] border border-white/10 rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
            <select value={currency} onChange={e => setCurrency(e.target.value)} className="bg-[#111] border border-white/10 rounded-2xl px-4 text-sm focus:border-blue-500 outline-none">
              <option value="USD">USD</option><option value="BTC">BTC</option><option value="XMR">XMR</option>
            </select>
          </div>
          
          <button onClick={publishProduct} disabled={isPublishing || uploadingImage} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-sm mt-4 flex justify-center items-center gap-2 hover:bg-blue-500 transition-colors">
            {isPublishing ? <RefreshCw size={16} className="animate-spin"/> : 'Publish to Store'}
          </button>
        </div>
      </div>
    )
  }

  // --- SUB-SCREEN: PAYMENTS ---
  if (view === 'payments') {
    return (
      <div className="p-4 animate-slide-up overflow-y-auto h-full">
        <button onClick={() => setView('main')} className="flex items-center gap-1 text-white/50 text-sm mb-6 hover:text-white transition-colors"><ArrowLeft size={16}/> Back</button>
        <h2 className="text-xl font-bold mb-6">Payment Addresses</h2>
        <div className="space-y-4">
          <input placeholder="Bitcoin (BTC)" value={btcAddress} onChange={e => setBtcAddress(e.target.value)} className="w-full bg-[#111] border border-white/10 rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
          <input placeholder="Monero (XMR)" value={xmrAddress} onChange={e => setXmrAddress(e.target.value)} className="w-full bg-[#111] border border-white/10 rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
          <button onClick={savePayments} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-sm mt-4 hover:bg-blue-500 transition-colors">Save Addresses</button>
        </div>
      </div>
    )
  }

  // --- MAIN PROFILE TAB ---
  return (
    <div className="animate-fade-in overflow-y-auto h-full pb-24">
      {status && <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-lg z-50 animate-bounce">{status}</div>}

      {/* HEADER PROFILE CARD */}
      <div className="flex flex-col items-center justify-center py-8">
        <div className="relative mb-4">
          <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'profile')} className="hidden" id="main-avatar-upload" />
          <label htmlFor="main-avatar-upload" className="cursor-pointer group relative block">
            {myProfile.picture ? (
              <img src={myProfile.picture} alt="avatar" className="w-24 h-24 rounded-full object-cover border-2 border-white/10 group-hover:opacity-80 transition-opacity" />
            ) : (
              <div className="w-24 h-24 rounded-full bg-[#111] flex items-center justify-center border-2 border-white/10 group-hover:opacity-80 transition-opacity">
                <Logo size={48} className="opacity-60" />
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
              {uploadingImage ? <RefreshCw size={24} className="text-white animate-spin" /> : <Camera size={24} className="text-white" />}
            </div>
          </label>
        </div>
        
        <h2 className="text-[20px] font-bold text-white">{myProfile.displayName}</h2>
        <p className="text-[14px] text-white/40 mb-3">@{myProfile.name}</p>
        
        {myProfile.about && <p className="text-[13px] text-white/50 mb-3 px-8 text-center">{myProfile.about}</p>}
        
        <button onClick={copyNpub} className="flex items-center gap-2 px-4 py-2 bg-[#111] border border-white/10 rounded-full text-[12px] text-white/60 hover:text-white transition-colors">
          {copied ? 'Copied!' : `${identity.npub?.slice(0, 12)}...${identity.npub?.slice(-4)}`}
          <Copy size={12} />
        </button>
      </div>

      {/* MENU LIST */}
      <div className="w-full">
        {/* Group 1 */}
        <div className="mb-6">
          <button onClick={() => setView('orders')} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors border-b border-white/5">
            <Package size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-white">My Orders</p>
              <p className="text-[13px] text-white/40">Track your purchases and shipping</p>
            </div>
            <ChevronRight size={20} className="text-white/60" />
          </button>

          <button onClick={() => setView('profile_editor')} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors">
            <User size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-white">Edit Profile</p>
              <p className="text-[13px] text-white/40">Change your display name and bio</p>
            </div>
            <ChevronRight size={20} className="text-white/60" />
          </button>

          {isVendor && <button onClick={() => setView('advanced')} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors border-t border-white/5">
            <SlidersHorizontal size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-white">Advanced Vendor Settings</p>
              <p className="text-[13px] text-white/40">Order-specific BTC and XMR payment derivation</p>
            </div>
            <ChevronRight size={20} className="text-white/60" />
          </button>}
        </div>

        {/* VENDOR BANNER */}
        {!isVendor ? (
          <div className="mx-4 mb-6 p-5 rounded-2xl bg-[#0f0f0f] border border-blue-500/20 shadow-[0_0_20px_rgba(37,99,235,0.05)]">
            <h3 className="text-[17px] font-bold text-white mb-1">Start Selling</h3>
            <p className="text-[13px] text-white/50 leading-relaxed mb-4">
              Unlock your storefront, post product cards in groups, and accept BTC/XMR payments.
            </p>
            <button 
              onClick={() => { setStatus(''); setView('vendor_setup'); }}
              className="bg-white text-black px-5 py-2.5 rounded-full text-[13px] font-bold hover:bg-gray-200 transition-colors"
            >
              Set up Vendor mode
            </button>
          </div>
        ) : (
          <div className="mx-4 mb-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[17px] font-bold text-white">Vendor mode is on</h3>
                <p className="mt-1 text-[13px] text-emerald-300/70">Your storefront tools are ready.</p>
              </div>
              <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">ACTIVE</span>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setView('vendor')} className="min-h-11 flex-1 rounded-xl bg-blue-600 text-sm font-semibold text-white hover:bg-blue-500">Dashboard</button>
              <button type="button" onClick={() => setView('advanced')} className="min-h-11 flex-1 rounded-xl border border-white/10 bg-white/5 text-sm font-semibold text-white/80 hover:bg-white/10">Payment settings</button>
            </div>
          </div>
        )}

        {/* Group 2 */}
        <div className="mb-6">
          <button onClick={() => setView('message_requests')} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors border-b border-white/5">
            <Users size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-white">Message Requests</p>
              <p className="text-[13px] text-white/40">Review DMs from strangers</p>
            </div>
            <ChevronRight size={20} className="text-white/60" />
          </button>

          <button onClick={() => setView('identity_backup')} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors border-b border-white/5">
            <KeyRound size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-white">Identity & Backup</p>
              <p className="text-[13px] text-white/40">Export key, QR code, or restore account</p>
            </div>
            <ChevronRight size={20} className="text-white/60" />
          </button>

          <button onClick={() => setView('account_switcher')} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors border-b border-white/5">
            <RefreshCw size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-white">Switch Account</p>
              <p className="text-[13px] text-white/40">Manage multiple accounts on this device</p>
            </div>
            <ChevronRight size={20} className="text-white/20" />
          </button>

          <button onClick={identity.lockApp} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors">
            <Lock size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-white">Lock App</p>
              <p className="text-[13px] text-white/40">Securely lock Cipher</p>
            </div>
          </button>
        </div>

        {/* Group 3 (Danger) */}
        <div className="mb-8">
          {isVendor && (
            <button 
              onClick={() => {
                setIsVendor(false);
                useChatStore.getState().setToast({ type: 'success', message: 'Switched to Buyer mode.' });
              }}
              className="w-full flex items-center gap-4 px-4 py-4 hover:bg-white/5 transition-colors border-b border-white/5"
            >
              <BarChart3 size={22} className="text-white/60" />
              <div className="flex-1 text-left">
                <p className="text-[15px] font-semibold text-blue-500">Switch to Buyer Mode</p>
                <p className="text-[13px] text-white/40">Hide store, dashboard, and payment settings</p>
              </div>
            </button>
          )}

          <button onClick={() => setShowPanicConfirm(true)} className="w-full flex items-center gap-4 px-4 py-4 hover:bg-red-500/10 transition-colors">
            <AlertCircle size={22} className="text-white/60" />
            <div className="flex-1 text-left">
              <p className="text-[15px] font-semibold text-red-500">Panic Wipe</p>
              <p className="text-[13px] text-red-500/60">Destroy all local data instantly</p>
            </div>
          </button>
        </div>
      </div>

      
      {/* POWERED BY NOSTR FOOTER */}
      <div className="flex flex-col items-center justify-center mt-8 mb-12 opacity-40 hover:opacity-100 transition-opacity">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-white tracking-wide">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          Powered by Nostr
        </div>
        <p className="text-[10px] text-white/50 mt-1">Decentralized. Censorship-Resistant.</p>
      </div>

      {/* PANIC CONFIRM MODAL */}
      {showPanicConfirm && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-[#111] border border-red-500/30 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
            <h2 className="text-xl font-bold text-red-500 mb-2">Panic Wipe</h2>
            <p className="text-sm text-white/70 mb-6">This will instantly destroy all local data on this device. Make sure you have saved your 12-word recovery phrase!</p>
            <div className="flex gap-3">
              <button onClick={() => setShowPanicConfirm(false)} className="flex-1 py-3 bg-white/5 hover:bg-white/10 rounded-xl font-bold transition-colors">Cancel</button>
              <button onClick={async () => {
                setShowPanicConfirm(false);
                try {
                  await db.messages.clear();
                } catch (error) {
                  console.error('[Wallet] Could not clear active message table before full wipe:', error);
                }
                await identity.panicWipe();
              }} className="flex-1 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold transition-colors">Wipe It</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
