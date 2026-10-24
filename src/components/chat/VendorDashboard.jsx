import { useEffect } from 'react';
import { Package } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { useVendorStats } from '../../hooks/useVendorStats';

export default function VendorDashboard({ identity, products = [], onBack }) {
  const { stats, loading, fetchStats } = useVendorStats({ identity });

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="h-full overflow-y-auto bg-black pb-24">
      <ScreenHeader title="Vendor" onBack={onBack} />
      <div className="flex border-b border-white/5">
        <div className="flex-1 border-r border-white/5 px-4 py-3">
          <p className="text-[13px] text-white/40">Completed orders</p>
          <p className="text-[17px] font-semibold text-white">{loading ? '—' : stats.sales}</p>
        </div>
        <div className="flex-1 px-4 py-3">
          <p className="text-[13px] text-white/40">USD</p>
          <p className="text-[17px] font-semibold text-white">{loading ? '—' : `$${stats.revenueFiat.toFixed(2)}`}</p>
        </div>
      </div>
      {stats.btc > 0 && <p className="border-b border-white/5 px-4 py-3 text-[15px] text-white">{stats.btc.toFixed(8)} BTC</p>}
      {stats.xmr > 0 && <p className="border-b border-white/5 px-4 py-3 text-[15px] text-white">{stats.xmr.toFixed(6)} XMR</p>}
      <p className="px-4 pb-1 pt-4 text-[13px] text-white/40">Listings</p>
        {products.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-white/40">You haven’t published any products yet.</p>
        ) : products.map((product) => (
          <div key={product.id || product.dTag || product.name} className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
            {product.image ? <img src={product.image} alt="" className="h-12 w-12 rounded-full border border-white/10 object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-[#111]"><Package size={18} className="text-white/40" /></div>}
            <div className="min-w-0 flex-1"><p className="truncate text-[15px] font-semibold text-white">{product.name || product.title || 'Product'}</p><p className="text-[13px] text-white/40">{product.price || product.priceUsd || ''} {product.currency || (product.priceUsd ? 'USD' : '')}</p></div>
          </div>
        ))}
    </div>
  );
}
