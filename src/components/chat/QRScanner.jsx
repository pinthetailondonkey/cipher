import { useEffect, useRef, useState } from 'react';
import { CameraOff, Check, Copy, MessageSquare, Scan, Users } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { writeClipboard } from '../../lib/copyText';
import { useChatStore } from '../../store/chatStore';
import { parseGroupReference } from '../../hooks/useNIP29Group';

const HEX64 = /^[0-9a-f]{64}$/i;

// What a scan is. The same shapes the boot path and people search already
// accept: a Cipher group link (?g= / ?group= / ?join= / ?naddr= / a bare
// 64-hex path segment) opens the group; an npub (bare, or behind nostr:,
// nip19-decoded) and a bare 64-hex key open the DM. Anything else stays
// copy-only. Group ids go through parseGroupReference, the shared parser.
function classifyScannedValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const name = url.searchParams.get('name');
      const groupId = url.searchParams.get('g') || url.searchParams.get('group') || url.searchParams.get('join')
        || url.pathname.match(/^\/([0-9a-f]{64})\/?$/)?.[1] || '';
      if (groupId) return { kind: 'group', id: groupId, name };
      const naddr = url.searchParams.get('naddr');
      if (naddr) return { kind: 'group', id: parseGroupReference(naddr).id, name };
      const key = url.searchParams.get('pk') || url.searchParams.get('dm');
      if (key && HEX64.test(key)) return { kind: 'dm', id: key.toLowerCase(), name: null };
      return null;
    } catch {
      return null;
    }
  }
  const bare = raw.replace(/^nostr:/i, '');
  if (/^naddr1/i.test(bare)) return { kind: 'group', id: parseGroupReference(bare).id, name: null };
  if (/^npub1|^nprofile1/i.test(bare)) return { kind: 'npub', id: bare, name: null };
  if (HEX64.test(bare)) return { kind: 'dm', id: bare.toLowerCase(), name: null };
  return null;
}

async function npubToPubkey(bare) {
  const { nip19 } = await import('nostr-tools');
  const decoded = nip19.decode(bare);
  if (decoded?.type === 'npub' || decoded?.type === 'nprofile') {
    return typeof decoded.data === 'string' ? decoded.data : '';
  }
  return '';
}

export default function QRScanner({ onClose, openChat, joinGroupById }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const decodedRef = useRef('');
  const [error, setError] = useState('');
  const [decodedValue, setDecodedValue] = useState('');
  const [copied, setCopied] = useState(false);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    let stream;
    let active = true;
    let scanTimer;
    let jsQRPromise;
    let detector = null;
    try {
      if (typeof BarcodeDetector !== 'undefined') detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (detectorError) {
      console.warn('[QRScanner] Native QR detection is unavailable:', detectorError);
    }
    const loadJsQR = () => {
      jsQRPromise ||= import('jsqr').then((mod) => mod.default || mod);
      return jsQRPromise;
    };
    const scan = async () => {
      if (!active || decodedRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA || video.videoWidth === 0) {
        scanTimer = window.setTimeout(scan, 150);
        return;
      }
      try {
        let value = '';
        if (detector) {
          try {
            value = (await detector.detect(video))[0]?.rawValue || '';
          } catch (nativeError) {
            console.warn('[QRScanner] Native QR detection failed; using fallback decoder:', nativeError);
            detector = null;
          }
        }
        if (!value) {
          const width = Math.min(video.videoWidth, 720);
          const scale = width / video.videoWidth;
          canvas.width = width;
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('QR decoding is unavailable in this browser.');
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const decode = await loadJsQR();
          value = decode(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' })?.data || '';
        }
        if (value) {
          decodedRef.current = value;
          setDecodedValue(value);
          stream?.getTracks().forEach((track) => track.stop());
          return;
        }
      } catch (scanError) {
        console.error('[QRScanner] Could not decode QR code:', scanError);
        setError(scanError?.message || 'Could not decode the QR code.');
        active = false;
        stream?.getTracks().forEach((track) => track.stop());
      }
      if (active) scanTimer = window.setTimeout(scan, 180);
    };
    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser does not support camera access.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!active || !videoRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        scan();
      } catch (cameraError) {
        console.warn('[QRScanner] Camera unavailable:', cameraError);
        if (active) setError(cameraError.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Camera is unavailable on this device.');
      }
    };
    startCamera();
    return () => {
      active = false;
      window.clearTimeout(scanTimer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const copyDecodedValue = async () => {
    try {
      const ok = await writeClipboard(decodedValue);
      if (!ok) throw new Error('clipboard denied');
      setCopied(true);
    } catch (copyError) {
      console.error('[QRScanner] Could not copy decoded value:', copyError);
      setError('QR code decoded, but clipboard access is unavailable.');
    }
  };

  // The scanner acts on what it recognizes — the same joins and opens the
  // boot path and people search perform — and keeps copy for the rest.
  const actOnDecodedValue = async () => {
    const found = classifyScannedValue(decodedValue);
    if (!found || acting) return;
    setActing(true);
    const store = useChatStore.getState();
    try {
      if (found.kind === 'group' && found.id && joinGroupById) {
        onClose();
        await joinGroupById(found.id, found.name);
        return;
      }
      const pk = found.kind === 'npub' ? await npubToPubkey(found.id) : found.id;
      if ((found.kind === 'dm' || found.kind === 'npub') && pk && openChat) {
        onClose();
        openChat('dm', pk);
        store.setToast({ type: 'success', message: 'Chat opened' });
        return;
      }
      if (found.kind === 'npub' && !pk) {
        store.setToast({ type: 'error', message: 'The key could not be read. Use Copy instead.' });
        return;
      }
      store.setToast({ type: 'error', message: 'The scan did not name anything this app can open.' });
    } catch (actError) {
      console.error('[QRScanner] Could not act on the scan:', actError);
      store.setToast({ type: 'error', message: 'Could not open that. Use Copy instead.' });
    } finally {
      setActing(false);
    }
  };

  const found = classifyScannedValue(decodedValue);
  const canAct = Boolean(found && ((found.kind === 'group' && found.id) || found.kind === 'dm' || found.kind === 'npub'));
  const actionLabel = found?.kind === 'group' ? 'Open group' : 'Open chat';

  return (
    <div className="fixed inset-0 z-[999] flex flex-col bg-scrim pt-safe pb-safe md:items-center md:justify-center md:bg-scrim/70" role="dialog" aria-modal="true" aria-label="Scan QR code">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col md:w-[420px] md:max-h-[80vh] md:flex-none md:rounded-2xl md:border md:border-line md:bg-panel md:shadow-2xl md:overflow-hidden">
        <ScreenHeader title="Scan" onBack={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-4">
          {error ? (
            <div className="w-full max-w-xs rounded-2xl border border-line bg-panel px-4 py-10 text-center shadow-lg">
              <CameraOff size={48} className="mb-4 text-ink/40" />
              <h3 className="text-[15px] font-semibold text-ink">Scanner unavailable</h3>
              <p role="alert" className="mt-2 text-[13px] text-ink/50">{error}</p>
            </div>
          ) : (
            <>
              <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-3xl border border-ink/10 bg-[#0A0A0A]/60 shadow-2xl">
                <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                <canvas ref={canvasRef} className="hidden" />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <Scan size={64} className="text-ink/70" />
                </div>
              </div>
              {decodedValue ? (
                <section className="w-full max-w-sm rounded-2xl border border-line bg-panel p-4 shadow-lg">
                  <p className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-ink"><Check size={17} className="text-accent" /> Scanned</p>
                  <p className="break-all rounded-2xl border border-ink/10 bg-ink/5 p-3 font-mono text-[13px] text-ink/80">{decodedValue}</p>
                  {canAct ? (
                    <>
                      <button type="button" onClick={actOnDecodedValue} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 text-[15px] font-bold text-accentInk active:scale-[0.98]">
                        {found?.kind === 'group' ? <Users size={16} /> : <MessageSquare size={16} />} {acting ? 'Opening…' : actionLabel}
                      </button>
                      <button type="button" onClick={copyDecodedValue} className="touch-target mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-line py-3 text-[14px] font-semibold text-ink/70 active:scale-[0.98]">
                        <Copy size={15} /> {copied ? 'Copied' : 'Copy'}
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={copyDecodedValue} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 text-[15px] font-bold text-accentInk active:scale-[0.98]">
                      <Copy size={16} /> {copied ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </section>
              ) : (
                <p className="text-center text-[13px] text-ink/50">Hold a QR code inside the frame to scan it.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
