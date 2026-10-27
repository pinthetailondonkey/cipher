import { useEffect, useState } from 'react';
import { Package, Plus } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import { useVendorStats } from '../../hooks/useVendorStats';
import { rankVolumeByStanding, readPublicViews } from '../../lib/proofOfTrade';

function VolumeList({ title, rows }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel">
      <p className="border-b border-line p-4 text-[13px] text-inkMuted">{title}</p>
      {rows.length === 0 ? (
        <p className="p-4 text-[13px] text-inkMuted">None yet.</p>
      ) : rows.map((row) => (
        <p key={`${row.vendor}-${row.currency}`} className="border-b border-line p-4 text-[15px] text-ink last:border-0">{row.volume} {row.currency}</p>
      ))}
    </div>
  );
}

export default function VendorDashboard({ identity, products = [], onBack, onCreate }) {
  const { stats, loading, fetchStats } = useVendorStats({ identity });
  const [standing, setStanding] = useState({ countersigned: [], vendor: [] });

  useEffect(() => {
    fetchStats();
    setStanding(rankVolumeByStanding(readPublicViews()));
  }, [fetchStats, identity?.pk]);

  return (
    <div className="h-full overflow-y-auto bg-transparent pb-24 md:pb-4">
      <ScreenHeader title="Vendor" onBack={onBack} />
      <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-line bg-panel p-4">
          <p className="text-[13px] text-inkMuted">Orders</p>
          <p className="mt-1 text-2xl font-bold text-ink">{loading ? '—' : stats.sales}</p>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-4">
          <p className="text-[13px] text-inkMuted">USD</p>
          <p className="mt-1 text-2xl font-bold text-ink">{loading ? '—' : `$${stats.revenueFiat.toFixed(2)}`}</p>
        </div>
      </div>
      {(stats.btc > 0 || stats.xmr > 0) && (
        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          {stats.btc > 0 && <p className="border-b border-line p-4 text-[15px] text-ink">{stats.btc.toFixed(8)} BTC</p>}
          {stats.xmr > 0 && <p className="p-4 text-[15px] text-ink">{stats.xmr.toFixed(6)} XMR</p>}
        </div>
      )}
      <VolumeList title="Countersigned" rows={standing.countersigned} />
      <VolumeList title="Vendor signature only" rows={standing.vendor} />
      {onCreate && <button type="button" onClick={onCreate} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent py-3.5 font-bold text-accentInk hover:bg-accent"><Plus size={16} /> List an item</button>}
      <div className="overflow-hidden rounded-2xl border border-line bg-panel">
        {products.length === 0 ? (
          <p className="p-4 text-[13px] text-inkMuted">You haven’t published any products yet.</p>
        ) : products.map((product) => (
          <div key={product.id || product.dTag || product.name} className="flex items-center gap-3 border-b border-line p-4 last:border-0">
            <Picture src={product.image} alt="" className="h-12 w-12 rounded-xl object-cover" fallback={<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-panelAlt"><Package size={18} className="text-inkMuted" /></div>} />
            <div className="min-w-0 flex-1"><p className="truncate text-[15px] font-semibold text-ink">{product.name || product.title || 'Product'}</p><p className="text-[13px] text-accentText">{product.price || product.priceUsd || ''} {product.currency || (product.priceUsd ? 'USD' : '')}</p></div>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
