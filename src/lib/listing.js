// A listing's price is an amount and a unit. Only USD is dollars: a listing
// priced in BTC or XMR keeps its coin amount all the way to the order card,
// where the vendor's acceptance reads it as the coin amount to collect.
// The listing never carries a payment address (security S2).

export function priceLabel(amount, currency) {
  const text = String(amount ?? '').trim();
  if (!text) return '';
  const unit = String(currency || 'USD').toUpperCase();
  return unit === 'USD' ? `$${text}` : `${text} ${unit}`;
}

export function listingFromEvent(event) {
  const tag = (name) => event.tags.find((item) => item[0] === name);
  const priceTag = tag('price');
  const amount = String(priceTag?.[1] || '').trim();
  const currency = String(priceTag?.[2] || 'USD').toUpperCase();
  // A listing's own `payment` tags are never read here. An address the buyer
  // scans straight off the menu skips the order — no accept, no issued
  // address, no chain check, no receipt — so nothing on a menu starts a
  // payment. The only address a buyer is sent comes through the order flow.
  return {
    id: tag('d')?.[1] || event.id,
    name: tag('title')?.[1] || 'Unnamed Product',
    price: amount,
    currency,
    ...(currency === 'USD' ? { priceUsd: amount } : {}),
    image: tag('image')?.[1] || '',
    vendorPubkey: event.pubkey,
  };
}

// The relay filter every read of one vendor's kind-30402 listings shares:
// the storefront fetches it to draw the shop, and a ?product=&vendor= link
// fetches it to reach a single listing on boot (backlog item 16.3).
export function vendorListingFilter(vendorPubkey) {
  return { kinds: [30402], authors: [vendorPubkey], '#t': ['cipher_marketplace'], limit: 50 };
}

// The product block an order carries. A coin price stays a coin price.
export function orderProduct(listing) {
  const currency = String(listing?.currency || (listing?.priceUsd ? 'USD' : '')).toUpperCase() || 'USD';
  const price = String(listing?.price ?? listing?.priceUsd ?? '').replace(/^\$/, '').trim();
  return {
    id: listing?.id || null,
    title: listing?.name || listing?.title || 'Product',
    name: listing?.name || listing?.title || 'Product',
    price,
    currency,
    ...(currency === 'USD' ? { priceUsd: price } : {}),
    image: listing?.image || '',
  };
}

// The one product store: what this account published, cached at publish
// time and read back filtered to own pubkey. One key, one reader helper —
// a second JSON.parse of the same key is how the duplicate-key mess the
// audit flagged started.
export function readCachedProducts() {
  try {
    const rows = JSON.parse(localStorage.getItem('cipher_cached_products') || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// The delivery state a product publish can honestly claim: 'published'
// when a relay took the event, 'queued' when the outbox owns it, and
// 'unconfirmed' after an ask to the relays came back without this
// listing. A row is never 'published' on the writer's say-so alone.
export const PRODUCT_DELIVERY_WORDS = {
  queued: 'Saved and will send.',
  unconfirmed: 'Not found on the relays we just asked.',
};

// A product card's share link. The base is the canonical app host the egress
// table names, never the origin the window happens to carry: the desktop
// build serves from a loopback address, and such a link only opens on the
// machine that made it. The boot reader already opens ?product=&vendor=.
export function productShareLink(product, base = '') {
  const id = String(product?.id ?? '').trim();
  const vendor = String(product?.vendorPubkey ?? '').trim();
  if (!id || !vendor) return '';
  const root = String(base || '').trim()
    || (typeof window !== 'undefined' ? String(window.location?.origin || '') : '');
  try {
    const url = new URL(root);
    url.searchParams.set('product', id);
    url.searchParams.set('vendor', vendor);
    return url.toString();
  } catch {
    return '';
  }
}

export function markCachedProductDelivery(productId, delivery) {
  const rows = readCachedProducts();
  const next = rows.map((row) => (row && row.id === productId ? { ...row, delivery } : row));
  try { localStorage.setItem('cipher_cached_products', JSON.stringify(next)); } catch { /* the row keeps the state in memory only */ }
  return next.find((row) => row == null ? false : row.id === productId) || null;
}

// What the order card shows for an order's price.
export function orderPriceLabel(content) {
  const product = content?.product || {};
  const currency = String(product.currency || content?.currency || (product.priceUsd != null ? 'USD' : '')).toUpperCase() || 'USD';
  const amount = currency === 'USD' ? (product.priceUsd ?? product.price ?? content?.amount) : (product.price ?? content?.amount);
  return priceLabel(amount, currency);
}
