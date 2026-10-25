import { lazy, Suspense, useState, useEffect } from 'react'
import {  
  User, Plus, AlertCircle, RefreshCw, 
  Lock, ChevronRight, ArrowLeft, Copy, CreditCard, Camera,
  BarChart3, Package, KeyRound, ShieldAlert, Users, SlidersHorizontal, Shield, Globe
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
import PrivacySettings from './components/chat/PrivacySettings';
import Connections from './components/chat/Connections';
import Avatar from './components/ui/Avatar';
import Picture from './components/ui/Picture';
import ScreenHeader from './components/ui/ScreenHeader';
import { pressable } from './components/ui/Button';
import { copyText } from './lib/copyText';
import { productRelays } from './lib/relays';
import { blossomServers } from './lib/egress';

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
    scopedSet('btc_address', btcAddress);
    scopedSet('xmr_address', xmrAddress);
    localStorage.setItem('cipher_btc_address', btcAddress);
    localStorage.setItem('cipher_xmr_address', xmrAddress);
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

  if (view === 'privacy') return <PrivacySettings onBack={() => setView('main')} />;
  if (view === 'connections') return <Connections onBack={() => setView('main')} />;

  if (view === 'profile_editor') {
    return <Suspense fallback={<div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>}><ProfileEditor identity={identity} onClose={() => setView('main')} /></Suspense>;
  }

  if (view === 'vendor') {
    return <Suspense fallback={<div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>}><VendorDashboard identity={identity} products={JSON.parse(localStorage.getItem('cipher_my_products') || '[]')} onBack={() => setView('main')} onCreate={() => setView('product')} /></Suspense>;
  }

  if (view === 'vendor_setup') {
    return (
      <div className="h-full overflow-y-auto bg-transparent pb-safe">
        <ScreenHeader title="Start selling" onBack={() => setView('main')} />
        <form onSubmit={saveVendorSetup} className="space-y-4 p-4">
          <p className="text-[13px] text-white/40">Add at least one address. It stays on this device. Never enter a seed phrase or spending key.</p>
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
            <input value={btcAddress} onChange={(event) => setBtcAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Bitcoin address" className="w-full border-b border-white/5 bg-transparent px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30" />
            <input value={xmrAddress} onChange={(event) => setXmrAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Monero address" className="w-full bg-transparent px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30" />
          </div>
          {status && <p role="status" className="text-[13px] text-amber-300">{status}</p>}
          <button type="submit" className="w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500">Save and turn on selling</button>
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
      <div className="h-full overflow-y-auto bg-transparent pb-8">
        <ScreenHeader title="Payment settings" onBack={() => setView('main')} />
        <form onSubmit={saveAdvancedSettings} className="space-y-4 p-4">
          <p className="text-[13px] text-white/40">A view key and an xpub only let you watch payments. They stay on this device. Never enter a seed or a spend key.</p>
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
            <input value={xmrAddress} onChange={(event) => setXmrAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Monero address" className="w-full border-b border-white/10 bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30" />
            <input type="password" value={xmrPrivateViewKey} onChange={(event) => setXmrPrivateViewKey(event.target.value)} autoComplete="new-password" spellCheck="false" placeholder="Monero view key" className="w-full border-b border-white/10 bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30" />
            <input type="password" value={btcXpub} onChange={(event) => setBtcXpub(event.target.value)} autoComplete="off" spellCheck="false" placeholder="Bitcoin xpub" className="w-full bg-white/5 px-4 py-4 text-[15px] text-white outline-none placeholder:text-white/30" />
          </div>
          <button type="submit" disabled={savingAdvanced} className="w-full rounded-2xl bg-blue-600 py-3.5 font-bold text-white disabled:opacity-40">
            {savingAdvanced ? 'Saving…' : 'Save'}
          </button>
          {status && <p role="status" className={`text-center text-sm ${status.startsWith('Could not') || status.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>{status}</p>}
        </form>
      </div>
    );
  }

  // --- SUB-SCREEN: EDIT PROFILE ---
  if (view === 'edit_profile') {
    return (
      <div className="h-full overflow-y-auto bg-transparent pb-8">
        <ScreenHeader title="Edit profile" onBack={() => setView('main')} />
        <div className="space-y-4 p-4">
          <div className="relative">
            <Picture src={picture} alt="avatar" className="w-24 h-24 rounded-full object-cover border-2 border-white/10 shadow-lg" fallback={<div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center border-2 border-white/10 shadow-lg"><User size={32} className="text-white/30" /></div>} />
            <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'profile')} className="hidden" id="profile-upload" />
            <label htmlFor="profile-upload" className="absolute bottom-0 right-0 p-2 bg-blue-600 text-white rounded-full border-4 border-black cursor-pointer hover:bg-blue-500 transition-transform active:scale-95">
              {uploadingImage ? <RefreshCw size={14} className="animate-spin"/> : <Camera size={14} />}
            </label>
          </div>
        </div>

        <form onSubmit={saveProfile} className="space-y-4 px-4 pb-4">
          <div className="border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4">
            <h3 className="text-xs font-bold text-white/50 uppercase tracking-wider mb-3">Payment Addresses</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-white/60 mb-1">Bitcoin (BTC)</label>
                <input type="text" placeholder="bc1q..." value={btcAddress} onChange={(e) => setBtcAddress(e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white outline-none placeholder-white/30 backdrop-blur-md focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-white/60 mb-1">Monero (XMR)</label>
                <input type="text" placeholder="4..." value={xmrAddress} onChange={(e) => setXmrAddress(e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white outline-none placeholder-white/30 backdrop-blur-md focus:border-blue-500" />
              </div>
            </div>
          </div>

          <div>
            <div className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 flex items-center gap-3">
              <span className="text-white/30 text-lg">@</span>
              <span className="text-sm text-white/50 font-mono tracking-wide">{username}</span>
            </div>
            <p className="text-[10px] text-white/30 mt-1.5 ml-1">Usernames are permanent and cannot be changed.</p>
          </div>

          <div>
            <label className="text-xs text-white/50 ml-1 mb-1.5 block">Display Name</label>
            <input placeholder="e.g. Alice's Shop" value={displayName} onChange={e => setDisplayName(e.target.value)} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm text-white placeholder-white/20 focus:border-blue-500 outline-none transition-colors" />
          </div>
          
          <div>
            <label className="text-xs text-white/50 ml-1 mb-1.5 block">Bio</label>
            <textarea placeholder="Tell buyers about your shop..." value={about} onChange={e => setAbout(e.target.value)} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm text-white placeholder-white/20 focus:border-blue-500 outline-none resize-none h-24 transition-colors" />
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
      <div className="h-full overflow-y-auto bg-transparent pb-8">
        <ScreenHeader title="New listing" onBack={() => setView('main')} />
        <div className="space-y-4 p-4">
          <input placeholder="Product Title" value={title} onChange={e => setTitle(e.target.value)} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
          <textarea placeholder="Description" value={description} onChange={e => setDescription(e.target.value)} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none resize-none h-24" />
          
          <div className="flex items-center gap-4 p-4 border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl">
            <Picture src={image} alt="product" className="w-16 h-16 rounded-xl object-cover" fallback={<div className="flex h-16 w-16 items-center justify-center rounded-xl border border-white/10 bg-white/5"><Camera size={24} className="text-white/20" /></div>} />
            <div className="flex-1">
              <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'product')} className="hidden" id="product-upload" />
              <label htmlFor="product-upload" className="py-2 px-4 bg-white/10 rounded-xl text-sm font-semibold cursor-pointer hover:bg-white/20 transition-colors inline-block">
                {uploadingImage ? 'Uploading...' : 'Choose Photo'}
              </label>
            </div>
          </div>

          <div className="flex gap-3">
            <input placeholder="Price" type="number" value={price} onChange={e => setPrice(e.target.value)} className="flex-1 border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
            <select value={currency} onChange={e => setCurrency(e.target.value)} className="border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl px-4 text-sm focus:border-blue-500 outline-none">
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
      <div className="h-full overflow-y-auto bg-transparent pb-8">
        <ScreenHeader title="Payment addresses" onBack={() => setView('main')} />
        <div className="space-y-4 p-4">
          <input placeholder="Bitcoin (BTC)" value={btcAddress} onChange={e => setBtcAddress(e.target.value)} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
          <input placeholder="Monero (XMR)" value={xmrAddress} onChange={e => setXmrAddress(e.target.value)} className="w-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md rounded-2xl p-4 text-sm focus:border-blue-500 outline-none" />
          <button onClick={savePayments} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-sm mt-4 hover:bg-blue-500 transition-colors">Save Addresses</button>
        </div>
      </div>
    )
  }

  // --- MAIN PROFILE TAB ---
  return (
    <div className="animate-fade-in overflow-y-auto h-full pb-4">
      {status && <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-lg z-50 animate-bounce">{status}</div>}

      {/* HEADER PROFILE CARD */}
      <div className="flex flex-col items-center px-4 pb-2 pt-8">
        <div className="relative mb-4">
          <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'profile')} className="hidden" id="main-avatar-upload" />
          <label htmlFor="main-avatar-upload" className="relative block cursor-pointer">
            <Picture src={myProfile.picture} alt="" className="h-20 w-20 rounded-full border border-white/10 object-cover" fallback={<Avatar name={myProfile.displayName || myProfile.name} className="!h-20 !w-20 text-2xl" />} />
          </label>
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-white">{myProfile.displayName}</h2>
        <p className="mb-3 text-[13px] text-white/40">@{myProfile.name}</p>
        {myProfile.about && <p className="mb-3 px-6 text-center text-[13px] text-white/50">{myProfile.about}</p>}
        <button onClick={copyNpub} className="flex items-center gap-2 rounded-full border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-2 text-[12px] text-white/60">
          {copied ? 'Copied!' : `${identity.npub?.slice(0, 12)}...${identity.npub?.slice(-4)}`}
          <Copy size={12} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
          <button onClick={() => setView('orders')} className={`flex w-full items-center gap-3 border-b border-white/5 p-4 text-left ${pressable}`}>
            <Package size={18} className="text-white/40" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">My Orders</span><span className="block text-[13px] text-white/40">Purchases and shipping</span></span>
            <ChevronRight size={18} className="text-white/30" />
          </button>
          <button onClick={() => setView('profile_editor')} className={`flex w-full items-center gap-3 border-b border-white/5 p-4 text-left ${pressable}`}>
            <User size={18} className="text-white/40" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Edit Profile</span><span className="block text-[13px] text-white/40">Name, bio, and photo</span></span>
            <ChevronRight size={18} className="text-white/30" />
          </button>
          <button onClick={() => setView('privacy')} className={`flex w-full items-center gap-3 border-b border-white/5 p-4 text-left ${pressable}`}>
            <Shield size={18} className="text-white/40" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Privacy</span><span className="block text-[13px] text-white/40">Calls, last seen, blocked</span></span>
            <ChevronRight size={18} className="text-white/30" />
          </button>
          <button onClick={() => setView('connections')} className={`flex w-full items-center gap-3 p-4 text-left ${pressable}`}>
            <Globe size={18} className="text-white/40" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Connections</span><span className="block text-[13px] text-white/40">Every host, and which are Tor</span></span>
            <ChevronRight size={18} className="text-white/30" />
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
          {!isVendor ? (
            <button type="button" onClick={() => { setStatus(''); setView('vendor_setup'); }} className="flex w-full items-center gap-3 p-4 text-left">
              <CreditCard size={18} className="text-white/40" />
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Start selling</span><span className="block text-[13px] text-white/40">Take payment directly</span></span>
              <ChevronRight size={18} className="text-white/30" />
            </button>
          ) : (
            <>
              <button type="button" onClick={() => setView('vendor')} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left">
                <BarChart3 size={18} className="text-white/40" />
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Vendor</span><span className="block text-[13px] text-white/40">Orders and listings</span></span>
                <ChevronRight size={18} className="text-white/30" />
              </button>
              <button type="button" onClick={() => setView('advanced')} className="flex w-full items-center gap-3 p-4 text-left">
                <SlidersHorizontal size={18} className="text-white/40" />
                <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Payment settings</span><span className="block text-[13px] text-white/40">Addresses for each order</span></span>
                <ChevronRight size={18} className="text-white/30" />
              </button>
            </>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
          <button onClick={() => setView('message_requests')} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left">
            <Users size={18} className="text-white/40" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Message requests</span><span className="block text-[13px] text-white/40">People you have not answered</span></span>
            <ChevronRight size={18} className="text-white/30" />
          </button>
          <button onClick={() => setView('identity_backup')} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left">
            <KeyRound size={18} className="text-white/40" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Backup</span><span className="block text-[13px] text-white/40">Secret key and recovery phrase</span></span>
            <ChevronRight size={18} className="text-white/30" />
          </button>
          <button onClick={() => setView('account_switcher')} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left">
            <RefreshCw size={18} className="text-white/40" />
            <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-white">Accounts</span><span className="block text-[13px] text-white/40">Switch on this device</span></span>
            <ChevronRight size={18} className="text-white/30" />
          </button>
          <button onClick={identity.lockApp} className="flex w-full items-center gap-3 p-4 text-left">
            <Lock size={18} className="text-white/40" />
            <span className="min-w-0 flex-1 text-[15px] font-semibold text-white">Lock</span>
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
          {isVendor && (
            <button onClick={() => { setIsVendor(false); useChatStore.getState().setToast({ type: 'success', message: 'Switched to buyer mode.' }); }} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left">
              <span className="text-[15px] font-semibold text-blue-500">Switch to buyer mode</span>
            </button>
          )}
          <button onClick={() => setShowPanicConfirm(true)} className="flex w-full items-center gap-3 p-4 text-left">
            <AlertCircle size={18} className="text-red-400" />
            <span><span className="block text-[15px] font-semibold text-red-400">Panic wipe</span><span className="block text-[13px] text-red-400/70">Erase this device</span></span>
          </button>
        </div>
      </div>

      {/* PANIC CONFIRM MODAL */}
      {showPanicConfirm && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-white/5 border border-red-500/30 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
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
