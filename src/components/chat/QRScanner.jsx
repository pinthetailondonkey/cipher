import { useEffect, useRef, useState } from 'react';
import { CameraOff, Check, Copy, Scan } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { writeClipboard } from '../../lib/copyText';

export default function QRScanner({ onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const decodedRef = useRef('');
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

  return (
    <div className="fixed inset-0 z-[999] flex flex-col bg-black pt-safe pb-safe" role="dialog" aria-modal="true" aria-label="Scan QR code">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <ScreenHeader title="Scan" onBack={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-4">
          {error ? (
            <div className="w-full max-w-xs rounded-2xl border border-line bg-panel px-4 py-10 text-center shadow-lg">
              <CameraOff size={48} className="mb-4 text-white/40" />
              <h3 className="text-[15px] font-semibold text-white">Scanner unavailable</h3>
              <p role="alert" className="mt-2 text-[13px] text-white/50">{error}</p>
            </div>
          ) : (
            <>
              <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-3xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl">
                <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                <canvas ref={canvasRef} className="hidden" />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <Scan size={64} className="text-white/70" />
                </div>
              </div>
              {decodedValue ? (
                <section className="w-full max-w-sm rounded-2xl border border-line bg-panel p-4 shadow-lg">
                  <p className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-white"><Check size={17} className="text-blue-500" /> Scanned</p>
                  <p className="break-all rounded-2xl border border-white/10 bg-white/5 p-3 font-mono text-[13px] text-white/80">{decodedValue}</p>
                  <button type="button" onClick={copyDecodedValue} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 text-[15px] font-bold text-white">
                    <Copy size={16} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </section>
              ) : (
                <p className="text-center text-[13px] text-white/50">Hold a QR code inside the frame to scan it.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
