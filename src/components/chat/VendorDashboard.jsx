import { useEffect } from 'react';
import { ArrowLeft, BadgeDollarSign, Package, ShoppingBag } from 'lucide-react';
import { useVendorStats } from '../../hooks/useVendorStats';

export default function VendorDashboard({ identity, products = [], onBack }) {
  const { stats, loading, fetchStats } = useVendorStats({ identity });

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="h-full overflow-y-auto pb-24">
      <header className="flex items-center gap-3 border-b border-white/5 px-4 py-4">
        <button type="button" onClick={onBack} className="p-2 text-white/50 hover:text-white" aria-label="Back to profile"><ArrowLeft size={20} /></button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Vendor Dashboard</h1>
          <p className="text-[13px] text-white/40">Sales and completed order totals</p>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 p-4">
        <div className="rounded-2xl border border-white/10 bg-[#111] p-4">
          <div className="flex items-center gap-2 text-white/40"><ShoppingBag size={17} /><span className="text-[13px]">Completed orders</span></div>
          <p className="mt-3 text-2xl font-bold text-white">{loading ? '—' : stats.sales}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#111] p-4">
          <div className="flex items-center gap-2 text-white/40"><BadgeDollarSign size={17} /><span className="text-[13px]">USD earnings</span></div>
          <p className="mt-3 text-2xl font-bold text-white">{loading ? '—' : `$${stats.revenueFiat.toFixed(2)}`}</p>
        </div>
        {stats.btc > 0 && <div className="rounded-2xl border border-white/10 bg-[#111] p-4"><p className="text-[13px] text-white/40">Completed BTC</p><p className="mt-2 text-lg font-bold text-white">{stats.btc.toFixed(8)} BTC</p></div>}
        {stats.xmr > 0 && <div className="rounded-2xl border border-white/10 bg-[#111] p-4"><p className="text-[13px] text-white/40">Completed Monero</p><p className="mt-2 text-lg font-bold text-white">{stats.xmr.toFixed(6)} XMR</p></div>}
      </section>

      <section>
        <div className="flex items-center gap-2 px-4 pb-2 pt-3 text-white/50"><Package size={17} /><h2 className="text-[13px] font-semibold">Your listings</h2></div>
        {products.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-white/40">You haven’t published any products yet.</p>
        ) : products.map((product) => (
          <div key={product.id || product.dTag || product.name} className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
            {product.image ? <img src={product.image} alt="" className="h-12 w-12 rounded-full border border-white/10 object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-[#111]"><Package size={18} className="text-white/40" /></div>}
            <div className="min-w-0 flex-1"><p className="truncate text-[15px] font-semibold text-white">{product.name || product.title || 'Product'}</p><p className="text-[13px] text-white/40">{product.price || product.priceUsd || ''} {product.currency || (product.priceUsd ? 'USD' : '')}</p></div>
          </div>
        ))}
      </section>
    </div>
  );
}
