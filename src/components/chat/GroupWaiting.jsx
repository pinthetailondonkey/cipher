// The honest state for a join the relay has not confirmed.
//
// This screen is deliberately not GroupView: mounting that mounts the
// message, roster, reaction and pin reads, every one of which a relay that
// has not admitted this account refuses. The waiting state is what the relay
// has actually said — a request went out and the owner decides — and nothing
// under it may promise a room.
import { PENDING_JOIN } from '../../lib/groupJoin';

export default function GroupWaiting({ group, onBack }) {
  return (
    <section className="relative flex h-full min-h-0 flex-col bg-transparent">
      <div className="m-auto mx-4 max-w-sm rounded-2xl border border-line bg-panel px-4 py-8 text-center">
        <p className="text-[15px] font-semibold text-ink">{group?.name || 'This group'}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink/40">{PENDING_JOIN}</p>
        <button
          type="button"
          onClick={onBack}
          className="touch-target mt-5 rounded-full border border-line px-4 py-2 text-[13px] font-semibold text-ink/70 hover:text-ink"
        >
          Back to chats
        </button>
      </div>
    </section>
  );
}
