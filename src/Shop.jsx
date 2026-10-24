import React, { useState, useEffect } from 'react';
import { Search, ShoppingBag, Loader2 } from 'lucide-react';
import Logo from './components/Logo';

export default function Shop() {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMarketplace = async () => {
      setLoading(true);
      try {
        const { SimplePool } = await import('nostr-tools');
        const pool = new SimplePool();

        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Relay timeout')), 4000)
        );

        const fetchPromise = pool.querySync(
          ['wss://groups.aegispayhq.com'],
          { kinds: [30402], '#t': ['cipher_marketplace'], limit: 50 }
        );

        const events = await Promise.race([fetchPromise, timeoutPromise]);

        const parsed = events.map(ev => {
          const getTag = (name) => ev.tags.find(t => t[0] === name)?.[1];
          return {
            id: getTag('d') || ev.id,
            name: getTag('title') || 'Unnamed Product',
            priceUsd: parseFloat(getTag('price') || '0'),
            image: getTag('image') || '',
            vendorPubkey: ev.pubkey
          };
        }).filter(p => p.priceUsd > 0);

        const unique = Array.from(new Map(parsed.map(p => [p.id, p])).values());
        setProducts(unique);
      } catch (err) {
        console.error("Failed to fetch marketplace:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchMarketplace();
  }, []);

  const displayProducts = products.filter(p => 
    p.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full w-full relative">
      <div className="flex items-center gap-3 px-4 pt-4 pb-2 sticky top-0 z-10">
        <Logo size={32} />
        <h1 className="text-2xl font-bold tracking-tight text-white">Marketplace</h1>
      </div>

      <div className="px-4 py-3 sticky top-[60px] z-10">
        <div className="flex items-center gap-2 bg-[#111] border border-white/5 rounded-xl px-4 py-3 focus-within:border-blue-500/50 transition-colors">
          <Search size={18} className="text-white/40" />
          <input 
            type="text" 
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products..." 
            className="flex-1 bg-transparent text-[15px] text-white placeholder-white/40 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {loading ? (
          <div className="flex flex-col items-center justify-center mt-20 text-white/40">
            <Loader2 size={32} className="animate-spin mb-4 text-blue-500" />
            <p className="text-sm">Fetching products from the network...</p>
          </div>
        ) : displayProducts.length === 0 ? (
          <div className="text-center text-white/30 mt-20">
            <ShoppingBag size={48} className="mx-auto mb-4 opacity-50" />
            <p>No products found on the network yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 p-4">
            {displayProducts.map(p => (
              <div key={p.id} className="bg-[#111] border border-white/10 rounded-2xl overflow-hidden flex flex-col group">
                <div className="relative h-32 w-full cursor-pointer overflow-hidden">
                  {p.image ? (
                    <img src={p.image} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  ) : (
                    <div className="w-full h-full bg-white/5 flex items-center justify-center text-white/20">
                      <ShoppingBag size={32} />
                    </div>
                  )}
                </div>
                <div className="p-3 flex-1 flex flex-col justify-between">
                  <div>
                    <p className="text-sm font-semibold truncate text-white">{p.name}</p>
                    <p className="text-green-400 font-bold">${p.priceUsd}</p>
                  </div>
                  <button className="w-full mt-3 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 rounded-lg transition-colors">
                    Buy Now
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
