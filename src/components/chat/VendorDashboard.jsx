import { useEffect, useState } from 'react';
import { Package, Plus, Stamp } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import Skeleton from '../ui/Skeleton';
import Chip from '../ui/Chip';
import Textarea from '../ui/Textarea';
import Sheet from '../ui/Sheet';
import { pushToast } from '../ui/toast';
import ProvenBanner from './ProvenBanner';
import { useVendorStats } from '../../hooks/useVendorStats';
import { useVendorReviews } from '../../hooks/useVendorReviews';
import { rankVolumeByStanding, readPublicViews } from '../../lib/proofOfTrade';
import { haptic } from '../../lib/haptics';

// The rails the bulletin composer offers, with the plain words their
// banners speak (src/lib/vendorStats.js owns the sentence law; the chip
// here only names the rail).
const RAILS = [
  { id: 'btc', label: 'BTC' },
  { id: 'xmr', label: 'XMR' },
];

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
  const { stats, loading, fetchStats, publishBulletin } = useVendorStats({ identity });
  const [standing, setStanding] = useState({ countersigned: [], vendor: [] });
  // The desk reads the same standing the public door reads — the vendor's
  // own published bulletin wins when fetch finds one, the device's own
  // countersigned receipts cover a rail without one. Nothing invented here;
  // ProvenBanner speaks the contract's exact words.
  const ownStanding = useVendorReviews({ vendorPubkey: identity?.pk || null, identity });

  // The bulletin composer: one rail at a time, one txid per line. The
  // refusal words come straight from the data layer's guard, and a queued
  // publish answers with the outbox's own words — a publish that is saving,
  // not an answer, is not a publish that happened.
  const [composerOpen, setComposerOpen] = useState(false);
  const [rail, setRail] = useState('btc');
  const [txidText, setTxidText] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');

  const openComposer = () => {
    haptic('light');
    setTxidText('');
    setError('');
    setComposerOpen(true);
  };

  const publish = async () => {
    if (publishing) return;
    const txids = txidText.split(/\n+/).map((row) => row.trim()).filter(Boolean);
    setPublishing(true);
    setError('');
    const result = await publishBulletin(rail, txids);
    if (result?.success) {
      pushToast({ type: 'success', message: result.queued ? 'Saved and will send.' : 'Published.' });
      haptic('light');
      setComposerOpen(false);
      setTxidText('');
    } else {
      setError(result?.error || 'The bulletin could not be published.');
    }
    setPublishing(false);
  };

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
        <section aria-label="Deals proven">
          <ProvenBanner proven={ownStanding.proven} />
          <div className="mt-3 rounded-2xl border border-line bg-panel p-4">
            <p className="text-[13px] text-inkMuted">Deals proven</p>
            <p className="mt-1 text-[12px] leading-relaxed text-inkSubtle">
              Publish the txids so anyone can check one. No amounts go out — the count is the list. The newest bulletin you publish stands for that rail.
            </p>
            <Button
              size="md"
              leadingIcon={<Stamp size={16} />}
              className="mt-3"
              onClick={openComposer}
              disabled={!identity?.pk}
            >
              Publish a bulletin
            </Button>
          </div>
        </section>
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
              line="Tap List an item above and your first one lands here."
            />
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
      <Sheet
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        heading="Publish the txids"
        ariaLabel="Publish the txids"
      >
        <form
          onSubmit={(event) => { event.preventDefault(); publish(); }}
          className="pb-4"
        >
          {error && (
            <p role="alert" className="rounded-xl border border-line bg-panelStrong px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
            <div className="mt-1 flex gap-2">
              {RAILS.map((option) => (
                <Chip
                  key={option.id}
                  selected={option.id === rail}
                  onClick={() => { setRail(option.id); setError(''); }}
                >
                  {option.label}
                </Chip>
              ))}
            </div>
          <p className="mt-2 text-[12px] text-inkSubtle">
            One txid per line, copied from this vendor's own wallet or watcher. Anyone who wants to checks one on their own terms.
          </p>
          <div className="mt-3">
            <Textarea
              label="One txid per line"
              value={txidText}
              maxLength={4000}
              rows={5}
              className="mono"
              onChange={(event) => setTxidText(event.target.value)}
              placeholder="64 hex characters each"
            />
          </div>
          <Button type="submit" size="lg" fullWidth disabled={!txidText.trim()} className="mt-4">
            {publishing ? 'Publishing…' : 'Publish'}
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
