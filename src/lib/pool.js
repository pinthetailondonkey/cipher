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
    onauth: async (challenge) => {
      console.log("AUTH challenge:", challenge);
      return finalizeEvent({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", "wss://groups.aegispayhq.com"],
          ["challenge", challenge]
        ],
        content: ""
      }, identity.sk);
    }
  });

  const originalEnsure = pool.ensureRelay.bind(pool);
  pool.ensureRelay = async (url) => {
    const relay = await originalEnsure(url);
    if (url.includes("aegispayhq.com") && !relay.__patchedAuth) {
      relay.__patchedAuth = true;
      const originalSend = relay.send.bind(relay);
      relay.send = (msg) => {
        try {
          const parsed = JSON.parse(msg);
          if (parsed[0] === "AUTH" && typeof parsed[1] === "object") {
            msg = JSON.stringify(["AUTH", JSON.stringify(parsed[1])]);
          }
        } catch (e) {}
        originalSend(msg);
      };
    }
    return relay;
  };

  pools[identity.pk] = pool;
  return pool;
};

export const clearPool = () => {
  Object.values(pools).forEach((pool) => pool.destroy());
  pools = {};
};
