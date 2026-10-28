import { useEffect, useState } from 'react';
import { fetchLinkPreview } from '../../lib/linkPreview';
import { allowsLinkPreviews } from '../../lib/privacy';
import Picture from '../ui/Picture';

const cache = new Map();

export default function LinkPreview({ url }) {
  const [meta, setMeta] = useState(() => cache.get(url) || null);
  const [loading, setLoading] = useState(() => !cache.has(url));

  useEffect(() => {
    if (!url) return undefined;
    if (cache.has(url)) {
      setMeta(cache.get(url));
      setLoading(false);
      return undefined;
    }
    // The gate lives in fetchLinkPreview too; a stray render with the
    // profile opted out still makes no request.
    if (!allowsLinkPreviews()) {
      setLoading(false);
      return undefined;
    }
    let live = true;
    const controller = new AbortController();
    setLoading(true);
    fetchLinkPreview(url, { signal: controller.signal })
      .then((next) => {
        cache.set(url, next);
        if (live) setMeta(next);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [url]);

  // Off stays plain: no skeleton either, the way the words say.
  if (!allowsLinkPreviews()) return null;
  if (loading) {
    return (
      <div className="mb-1 overflow-hidden rounded-xl border border-ink/10 bg-scrim/30">
        <div className="h-20 animate-pulse bg-ink/10" />
        <div className="space-y-2 p-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-ink/10" />
          <div className="h-2 w-full animate-pulse rounded bg-ink/10" />
        </div>
      </div>
    );
  }
  if (!meta?.title && !meta?.image) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="mb-1 block overflow-hidden rounded-xl border border-ink/10 bg-scrim/40 text-left">
      <Picture src={meta.image} alt="" className="h-24 w-full object-cover" />
      <span className="block p-2">
        <span className="block truncate text-[13px] font-semibold text-ink">{meta.title || url}</span>
        {meta.description && <span className="mt-0.5 line-clamp-2 block text-[12px] text-ink/50">{meta.description}</span>}
      </span>
    </a>
  );
}
