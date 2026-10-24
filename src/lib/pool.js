let pools = {};

export const getAuthenticatedPool = async (identity) => {
  if (pools[identity.pk]) return pools[identity.pk];

  const { SimplePool, finalizeEvent } = await import('nostr-tools');
  const pool = new SimplePool({
    enablePing: false,
    enableReconnect: true,
    onRelayConnectionSuccess: (url) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cipher:relay-connected', { detail: { url } }));
      }
    },
    // nostr-tools passes the unsigned kind 22242 template, including the real relay URL.
    onauth: async (authEvent) => finalizeEvent(authEvent, identity.sk),
  });

  pools[identity.pk] = pool;
  return pool;
};

export const clearPool = () => {
  Object.values(pools).forEach((pool) => pool.destroy());
  pools = {};
};
