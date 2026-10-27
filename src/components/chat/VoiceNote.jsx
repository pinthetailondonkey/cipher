import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { openPrivateMedia, releasePrivateMedia } from '../../lib/mediaCrypto';

const BARS = 32;
// Even placeholder bars until the real amplitude decode lands.
const FALLBACK_PEAKS = Array.from({ length: BARS }, () => 0.34);

function height(peak) {
  // 3px floor so a silent stretch still reads as a bar.
  return Math.max(3, Math.round((Math.min(1, peak) || 0.34) * 20));
}

// The voice pill: play/pause circle, scrub bar, 32 bars sampled from the
// decoded waveform (ink/40 idle, accent once played through). The open/
// decrypt machinery underneath is the same MediaAudio path — reskin only,
// nothing about how media enters or leaves changes here.
function VoiceNoteInner({ item, name = '', sent = false, className = '' }) {
  // A plain entry already has its url; an encrypted one opens on mount.
  const [src, setSrc] = useState(() => (item?.shape === 'private' ? '' : item?.entry?.url || ''));
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [peaks, setPeaks] = useState(FALLBACK_PEAKS);
  const audioRef = useRef(null);

  useEffect(() => {
    if (item?.shape !== 'private') return undefined;
    const entry = item.entry;
    let live = true;
    if (!entry?.url || !entry?.key || !entry?.iv) {
      setFailed(true);
      return undefined;
    }
    openPrivateMedia(entry)
      .then((url) => { if (live) setSrc(url); })
      .catch((error) => {
        console.error('[voice] Could not open the voice note:', error);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      releasePrivateMedia(entry);
    };
  }, [item]);

  useEffect(() => {
    if (!src) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buffer);
        const data = audio.getChannelData(0);
        const block = Math.max(1, Math.floor(data.length / BARS));
        const next = [];
        for (let i = 0; i < BARS; i += 1) {
          let peak = 0;
          for (let j = 0; j < block; j += 1) {
            const value = Math.abs(data[i * block + j] || 0);
            if (value > peak) peak = value;
          }
          next.push(peak);
        }
        ctx.close();
        if (!cancelled) setPeaks(next);
      } catch {
        // Waveform stays a nice-to-have: the pill plays without it.
      }
    })();
    return () => { cancelled = true; };
  }, [src]);

  const toggle = (event) => {
    event.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  const scrub = (event) => {
    event.stopPropagation();
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = fraction * audio.duration;
    setProgress(fraction);
  };

  return (
    <div className={`${sent ? 'bg-scrim/25' : 'bg-ink/5'} flex min-h-[44px] max-w-[16rem] items-center gap-2.5 rounded-full px-2 py-1.5 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accentInk"
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button
        type="button"
        onClick={scrub}
        aria-label="Scrub voice note"
        aria-hidden="false"
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-[2px]"
      >
        {peaks.map((peak, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={`w-[3px] shrink-0 rounded-full ${index / BARS <= progress ? 'bg-accentText' : sent ? 'bg-scrim/40' : 'bg-ink/25'}`}
            style={{ height: `${height(peak)}px` }}
          />
        ))}
      </button>
      <audio
        ref={audioRef}
        src={src || undefined}
        preload="metadata"
        onTimeUpdate={() => {
          const audio = audioRef.current;
          if (audio?.duration) setProgress(audio.currentTime / audio.duration);
        }}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onError={() => setFailed(true)}
        className="hidden"
      />
      {name && <span className="max-w-24 truncate text-[11px] text-ink/50">{name}</span>}
      {failed && <span className="text-[11px] text-ink/45">Couldn't open</span>}
    </div>
  );
}

// One pill for both shapes: an encrypted voice note decrypts on open
// (same openPrivateMedia path MediaAudio uses); a pre-encryption entry
// plays off its plain url.
export default function VoiceNote({ item, name = '', sent = false, className = '' }) {
  return <VoiceNoteInner item={item} name={name} sent={sent} className={className} />;
}
