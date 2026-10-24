import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Copy, Scan, X } from 'lucide-react';

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
    let decoderPromise;
    let detector = null;
    try {
      if (typeof BarcodeDetector !== 'undefined') detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (detectorError) {
      console.warn('[QRScanner] Native QR detection is unavailable:', detectorError);
    }

    const decodeWithJsQr = async () => {
      decoderPromise ||= import('jsqr').then((module) => module.default || module);
      return decoderPromise;
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
            const codes = await detector.detect(video);
            value = codes[0]?.rawValue || '';
          } catch (detectError) {
            console.warn('[QRScanner] Native QR detection failed; using fallback decoder:', detectError);
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
          const decode = await decodeWithJsQr();
          const decoded = decode(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, {
            inversionAttempts: 'attemptBoth',
          });
          value = decoded?.data || '';
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
      await navigator.clipboard.writeText(decodedValue);
      setCopied(true);
    } catch (copyError) {
      console.error('[QRScanner] Could not copy decoded value:', copyError);
      setError('QR code decoded, but clipboard access is unavailable.');
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex flex-col bg-black pt-safe pb-safe" role="dialog" aria-modal="true" aria-label="Scan QR code">
      <div className="flex items-center justify-between border-b border-white/10 p-4">
        <h2 className="text-lg font-bold text-white">Scan QR Code</h2>
        <button type="button" onClick={onClose} className="touch-target p-2 text-white/60 hover:text-white" aria-label="Close scanner"><X size={24} /></button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-5">
        {error ? (
          <div className="flex max-w-xs flex-col items-center text-center">
            <Camera size={48} className="mb-4 text-white/40" />
            <h3 className="text-[15px] font-semibold text-white">Scanner unavailable</h3>
            <p role="alert" className="mt-2 text-[13px] text-white/50">{error}</p>
          </div>
        ) : (
          <>
            <div className="relative aspect-square w-full max-w-xs overflow-hidden rounded-3xl border-2 border-blue-500 bg-[#111]">
              <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
              <canvas ref={canvasRef} className="hidden" />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Scan size={64} className="text-white/70" /></div>
            </div>
            {decodedValue ? (
              <section className="w-full max-w-sm rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-300"><Check size={17} /> QR code decoded</p>
                <p className="break-all rounded-xl bg-black/50 p-3 font-mono text-xs text-white/80">{decodedValue}</p>
                <button type="button" onClick={copyDecodedValue} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white/10 text-sm font-semibold text-white hover:bg-white/15">
                  <Copy size={16} /> {copied ? 'Copied' : 'Copy result'}
                </button>
              </section>
            ) : (
              <p className="text-center text-[13px] text-white/50">Hold a QR code inside the frame to scan it.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
