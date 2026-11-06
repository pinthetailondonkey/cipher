import { useEffect, useState } from 'react';
import { MEDIA_FETCH_OPTIONS, mediaFetch, mediaHref, mediaHostOf } from '../../lib/mediaUrl';

// The address a picture is drawn from. A URL that came off the wire goes
// through the one gate (lib/mediaUrl) first, so a value the browser would do
// something odd with never reaches the element.
export function useVisibleSrc(src) {
  const href = mediaHref(src);
  const local = href && /^(data|blob):/.test(href) ? href : '';
  const [loaded, setLoaded] = useState({ href: '', src: '' });
  useEffect(() => {
    if (!href || local) return undefined;
    const controller = new AbortController();
    let objectUrl = '';
    let live = true;
    mediaFetch(href, globalThis.fetch, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The media host answered ${response.status}.`);
        return URL.createObjectURL(await response.blob());
      })
      .then((url) => {
        objectUrl = url;
        if (live) setLoaded({ href, src: url });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {});
    return () => {
      live = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [href, local]);
  return local || (loaded.href === href ? loaded.src : '');
}

export default function Picture({ src, link = false, fallback = null, onClick, ...props }) {
  const shown = useVisibleSrc(src);
  if (!shown) return fallback;
  // The host rides a tooltip so a reader can see where the bytes come from
  // without opening anything. A caller's own title still wins.
  const host = mediaHostOf(src);
  const image = (
    <img src={shown} referrerPolicy={MEDIA_FETCH_OPTIONS.referrerPolicy} title={host || undefined} {...props} />
  );
  if (!link) return image;
  return (
    <a href={shown} target="_blank" rel="noreferrer" className="block" onClick={(event) => { event.stopPropagation(); onClick?.(event); }}>
      {image}
    </a>
  );
}
