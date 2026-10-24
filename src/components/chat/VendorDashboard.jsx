import { useEffect } from 'react';
import { Package, Plus } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { useVendorStats } from '../../hooks/useVendorStats';

export default function VendorDashboard({ identity, products = [], onBack, onCreate }) {
  const { stats, loading, fetchStats } = useVendorStats({ identity });

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="h-full overflow-y-auto bg-black pb-24">
      <ScreenHeader title="Vendor" onBack={onBack} />
      <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-white/10 bg-[#111] p-4">
          <p className="text-[13px] text-white/40">Orders</p>
          <p className="mt-1 text-2xl font-bold text-white">{loading ? '—' : stats.sales}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#111] p-4">
          <p className="text-[13px] text-white/40">USD</p>
          <p className="mt-1 text-2xl font-bold text-white">{loading ? '—' : `$${stats.revenueFiat.toFixed(2)}`}</p>
        </div>
      </div>
      {(stats.btc > 0 || stats.xmr > 0) && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]">
          {stats.btc > 0 && <p className="border-b border-white/5 p-4 text-[15px] text-white">{stats.btc.toFixed(8)} BTC</p>}
          {stats.xmr > 0 && <p className="p-4 text-[15px] text-white">{stats.xmr.toFixed(6)} XMR</p>}
        </div>
      )}
      {onCreate && <button type="button" onClick={onCreate} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 font-bold text-white hover:bg-blue-500"><Plus size={16} /> List an item</button>}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]">
        {products.length === 0 ? (
          <p className="p-4 text-[13px] text-white/40">You haven’t published any products yet.</p>
        ) : products.map((product) => (
          <div key={product.id || product.dTag || product.name} className="flex items-center gap-3 border-b border-white/5 p-4 last:border-0">
            {product.image ? <img src={product.image} alt="" className="h-12 w-12 rounded-xl object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-black"><Package size={18} className="text-white/40" /></div>}
            <div className="min-w-0 flex-1"><p className="truncate text-[15px] font-semibold text-white">{product.name || product.title || 'Product'}</p><p className="text-[13px] text-blue-500">{product.price || product.priceUsd || ''} {product.currency || (product.priceUsd ? 'USD' : '')}</p></div>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
