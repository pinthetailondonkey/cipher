import { useEffect, useState } from 'react';
import { Package, Plus } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import Skeleton from '../ui/Skeleton';
import { useVendorStats } from '../../hooks/useVendorStats';
import { rankVolumeByStanding, readPublicViews } from '../../lib/proofOfTrade';
import { haptic } from '../../lib/haptics';

function StatCard({ label, value, sub = null, loading = false }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <p className="text-[13px] text-inkMuted">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <p className="mono mt-1 truncate text-2xl font-bold tracking-tight text-ink">{value}</p>
      )}
      {sub && !loading && <p className="mt-0.5 text-[11px] text-inkSubtle">{sub}</p>}
    </div>
  );
}

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

// The vendor's own desk: stat cards up top, then the products this account
// published, then the standing ledgers. Data stays in useVendorStats —
// presentation only.
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
          <StatCard label="Orders" value={String(stats.sales)} loading={loading} />
          <StatCard label="Revenue" value={loading ? '—' : `$${stats.revenueFiat.toFixed(2)}`} loading={loading} />
        </div>
        {(stats.btc > 0 || stats.xmr > 0) && (
          <div className="grid grid-cols-2 gap-3">
            {stats.btc > 0 && (
              <StatCard label="Volume · BTC" value={stats.btc.toFixed(8)} />
            )}
            {stats.xmr > 0 && (
              <StatCard label="Volume · XMR" value={stats.xmr.toFixed(6)} />
            )}
          </div>
        )}
        <VolumeList title="Countersigned" rows={standing.countersigned} />
        <VolumeList title="Vendor signature only" rows={standing.vendor} />
        {onCreate && (
          <Button
            size="lg"
            fullWidth
            leadingIcon={<Plus size={16} />}
            onClick={() => {
              haptic('light');
              onCreate();
            }}
          >
            List an item
          </Button>
        )}
        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          {products.length === 0 ? (
            <EmptyState
              icon={<Package size={20} />}
              title="Your menu is empty"
            >
              Tap List an item above and your first one lands here.
            </EmptyState>
          ) : products.map((product) => (
            <div key={product.id || product.dTag || product.name} className="flex items-center gap-3 border-b border-line p-4 last:border-0">
              <Picture src={product.image} alt="" className="h-12 w-12 rounded-xl object-cover" fallback={<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-panelAlt"><Package size={18} className="text-inkMuted" /></div>} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-ink">{product.name || product.title || 'Item'}</p>
                <p className="mono truncate text-[13px] text-accentText">{product.price || product.priceUsd || ''} {product.currency || (product.priceUsd ? 'USD' : '')}</p>
              </div>
              {product.stock != null && <Badge tone="outline">Stock {product.stock}</Badge>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
