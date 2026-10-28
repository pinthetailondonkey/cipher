import { useEffect, useRef, useState } from 'react';
import { CameraOff, Check, Copy, Link2, Scan, UserRound } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Sheet from '../ui/Sheet';
import useDialogA11y from '../ui/dialogA11y';
import { writeClipboard } from '../../lib/copyText';
import { pubkeyFromScanned } from '../../lib/npub';
import { scannedTargets, scannedHref } from '../../lib/scannedTarget';
import { haptic } from '../../lib/haptics';
import { useChatStore } from '../../store/chatStore';

export default function QRScanner({ onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const decodedRef = useRef('');
  useDialogA11y(true, () => onClose?.());
  const setProfilePubkey = useChatStore((state) => state.setProfilePubkey);
  const [error, setError] = useState('');
  const [decodedValue, setDecodedValue] = useState('');
  const [copied, setCopied] = useState(false);

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

  // Act on a scanned key: the profile opens over the scanner (its own
  // Message action starts the chat). Not a key, no action — copy remains.
  const decodedPubkey = decodedValue ? pubkeyFromScanned(decodedValue) : '';
  const openDecodedProfile = () => {
    haptic('light');
    setProfilePubkey(decodedPubkey);
    onClose?.();
  };

  // Everything Cipher itself hands out opens from here: a group by any of its
  // link shapes or its id, a shared product card, a chat, a burn note. Each
  // one walks out through the same boot path a tapped link uses, so a scan
  // and a link cannot drift into two different joins.
  const LABELS = { group: 'Open group', product: 'Open menu item', chat: 'Open chat', note: 'Open note' };
  const doors = (decodedValue ? scannedTargets(decodedValue) : [])
    .filter((target) => target.kind !== 'profile')
    .map((target) => ({ ...target, href: scannedHref(target, window.location.origin) }))
    .filter((target) => target.href);
  const openDoor = (href) => {
    haptic('light');
    window.location.assign(href);
  };

  return (
    <>
    <div className="fixed inset-0 z-call flex flex-col bg-scrim pt-safe pb-safe md:items-center md:justify-center md:bg-scrim/70" role="dialog" aria-modal="true" aria-label="Scan QR code">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative flex min-h-0 flex-1 flex-col md:w-[420px] md:max-h-[80vh] md:flex-none md:rounded-2xl md:border md:border-line md:bg-panel md:overflow-hidden">
        <ScreenHeader title="Scan" onBack={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-4">
          {error ? (
            <div className="w-full max-w-xs rounded-2xl border border-line bg-panel px-4 py-10 text-center">
              <CameraOff size={48} className="mb-4 text-ink/40" />
              <h3 className="text-[15px] font-semibold text-ink">Scanner unavailable</h3>
              <p role="alert" className="mt-2 text-[13px] text-inkSubtle">{error}</p>
            </div>
          ) : (
            <>
              <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-3xl border border-line bg-scrim/60">
                <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                <canvas ref={canvasRef} className="hidden" />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <Scan size={64} className="text-inkSubtle" />
                </div>
              </div>
              {decodedValue ? (
                <p aria-live="polite" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Check size={17} className="text-accentText" /> Scanned</p>
              ) : (
                <p className="text-center text-[13px] text-inkSubtle">Hold a QR code inside the frame to scan it.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
      {/* The decoded result opens on the Sheet — the camera has already
          stopped by then, the copy action rides with it. */}
      <Sheet open={!!decodedValue} onClose={onClose} label="Scanned code" heading="Scanned">
        <div className="px-5 pb-5 pt-4">
          <p className="break-all rounded-2xl border border-ink/10 bg-ink/5 p-3 font-mono text-[13px] text-ink/80">{decodedValue}</p>
          <button type="button" onClick={copyDecodedValue} className="mt-4 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-accent text-[15px] font-bold text-accentInk">
            <Copy size={16} /> {copied ? 'Copied' : 'Copy'}
          </button>
          {decodedPubkey && (
            <button type="button" onClick={openDecodedProfile} className="mt-2 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full border border-line text-[15px] font-bold text-ink">
              <UserRound size={16} /> Open profile
            </button>
          )}
          {doors.map((door) => (
            <button
              key={`${door.kind}:${door.href}`}
              type="button"
              onClick={() => openDoor(door.href)}
              className="mt-2 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full border border-line text-[15px] font-bold text-ink"
            >
              <Link2 size={16} /> {LABELS[door.kind] || 'Open'}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}
