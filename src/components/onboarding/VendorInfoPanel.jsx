import Button from '../ui/Button';

// The after-signup tour's Selling step, shown as a panel inside the tour's own
// sheet: one dialog, one name, one close control. Copy only — no identity, no
// store read, no fetch. The tour's own body is gone from this step, so the
// paying-address path is taught here once, not twice.
export default function VendorInfoPanel({ onBack }) {
  return (
    <div className="pb-6 pt-2 text-center">
      <h2 className="mb-3 text-[22px] font-bold tracking-tight text-ink">Selling</h2>
      <p className="mb-4 px-2 text-[14px] leading-relaxed text-inkMuted">
        Turn on selling in Profile and add a paying address. Publish items to your menu and share the link. Orders reach you in chat, and payment goes straight to your address. Cipher never holds the money.
      </p>
      <Button onClick={onBack} fullWidth>
        Back to the tour
      </Button>
    </div>
  );
}
