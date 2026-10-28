import { linkPreviewEndpoint } from './egress';
import { allowsLinkPreviews } from './privacy';

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

export function firstUrl(text) {
  const match = String(text || '').match(URL_PATTERN);
  if (!match) return '';
  return match[0].replace(/[),.!?]+$/, '');
}

// What a preview may ask about. The fragment is not part of the page a link
// points at, and for a burn note the fragment IS the key: the preview host
// must never be handed one. A note link has nothing to preview anyway, so it
// is skipped outright instead of being sent without its fragment.
export function previewTarget(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    parsed.hash = '';
    if (parsed.pathname.replace(/\/+$/, '') === '/note') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

// The one fetch door for previews. A fresh profile is opted out
// (DEFAULT_PRIVACY.linkPreviews is false), and this check — not the call
// site alone — is what keeps a link in a chat from reaching the preview
// host. No opt-in, no request, whatever renders this.
export async function fetchLinkPreview(url, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (!url || typeof fetchImpl !== 'function') return null;
  if (!allowsLinkPreviews()) return null;
  const target = previewTarget(url);
  if (!target) return null;
  const endpoint = linkPreviewEndpoint(target);
  if (!endpoint) return null;
  try {
    const response = await fetchImpl(endpoint, { signal });
    if (!response?.ok) return null;
    const body = await response.json();
    const data = body?.data || {};
    return {
      title: data.title || '',
      description: data.description || '',
      image: data.image?.url || data.logo?.url || '',
    };
  } catch {
    return null;
  }
}
