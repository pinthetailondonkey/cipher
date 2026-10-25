import { useEffect, useState } from 'react';
import { linkPreviewEndpoint } from '../../lib/egress';
import Picture from '../ui/Picture';

const cache = new Map();
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

export function firstUrl(text) {
  const match = String(text || '').match(URL_PATTERN);
  if (!match) return '';
  return match[0].replace(/[),.!?]+$/, '');
}

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
    let live = true;
    const controller = new AbortController();
    setLoading(true);
    const endpoint = linkPreviewEndpoint(url);
    if (!endpoint) {
      cache.set(url, null);
      setLoading(false);
      return undefined;
    }
    fetch(endpoint, { signal: controller.signal })
      .then((response) => response.json())
      .then((body) => {
        const data = body?.data || {};
        const next = {
          title: data.title || '',
          description: data.description || '',
          image: data.image?.url || data.logo?.url || '',
        };
        cache.set(url, next);
        if (live) setMeta(next);
      })
      .catch(() => {
        if (live) cache.set(url, null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [url]);

  if (loading) {
    return (
      <div className="mb-1 overflow-hidden rounded-xl border border-white/10 bg-black/30">
        <div className="h-20 animate-pulse bg-white/10" />
        <div className="space-y-2 p-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-white/10" />
          <div className="h-2 w-full animate-pulse rounded bg-white/10" />
        </div>
      </div>
    );
  }
  if (!meta?.title && !meta?.image) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="mb-1 block overflow-hidden rounded-xl border border-white/10 bg-black/40 text-left">
      <Picture src={meta.image} alt="" className="h-24 w-full object-cover" />
      <span className="block p-2">
        <span className="block truncate text-[13px] font-semibold text-white">{meta.title || url}</span>
        {meta.description && <span className="mt-0.5 line-clamp-2 block text-[12px] text-white/50">{meta.description}</span>}
      </span>
    </a>
  );
}
