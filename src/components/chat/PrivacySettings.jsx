import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { getPrivacy, setPrivacy } from '../../lib/privacy';
import { useChatStore } from '../../store/chatStore';
import { pressable } from '../ui/Button';
import Avatar from '../ui/Avatar';

function Choice({ label, hint, value, options, onChange }) {
  return (
    <div className="border-b border-white/5 bg-[#111] px-4 py-3">
      <p className="text-[15px] font-semibold text-white">{label}</p>
      {hint && <p className="mt-0.5 text-[13px] text-white/40">{hint}</p>}
      <div className="mt-2 flex gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={`rounded-2xl px-3 py-2 text-[13px] font-bold active:scale-95 transition-transform duration-100 ${value === option.id ? 'bg-blue-600 text-white active:bg-blue-700' : 'border border-white/10 bg-black text-white/55 active:bg-white/10'}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className={`flex w-full items-center gap-3 border-b border-white/5 bg-[#111] px-4 py-3 text-left active:bg-white/10 ${pressable}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-white">{label}</span>
        {hint && <span className="mt-0.5 block text-[13px] text-white/40">{hint}</span>}
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full ${checked ? 'bg-blue-600' : 'bg-white/15'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

export default function PrivacySettings({ onBack }) {
  const [privacy, setLocal] = useState(() => getPrivacy());
  const blocked = useChatStore((state) => state.blockedUsers);
  const toggleBlockUser = useChatStore((state) => state.toggleBlockUser);
  const profiles = useChatStore((state) => state.profiles);

  const update = (patch) => setLocal(setPrivacy(patch));

  return (
    <div className="h-full overflow-y-auto bg-black pb-24">
      <button type="button" onClick={onBack} className={`flex items-center gap-1 px-4 pb-2 pt-4 text-[13px] text-white/40 hover:text-white ${pressable}`}><ArrowLeft size={16} /> Back</button>
      <h2 className="px-4 pb-4 text-2xl font-bold tracking-tight text-white">Privacy and Security</h2>
      <p className="px-4 pb-2 text-[13px] text-white/40">Who can reach you</p>
      <Choice label="Calls" hint="Voice only. Video is not available." value={privacy.calls} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(calls) => update({ calls })} />
      <Choice label="Last seen and online" hint="Nobody means you also stop sending typing." value={privacy.lastSeen} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(lastSeen) => update({ lastSeen })} />
      <Choice label="Profile photo" hint="Hidden photos are removed from your public profile the next time you save it." value={privacy.profilePhoto} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(profilePhoto) => update({ profilePhoto })} />
      <Choice label="Groups" hint="Nobody means only you can join groups. Other people cannot add you." value={privacy.groups} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(groups) => update({ groups })} />
      <p className="px-4 pb-2 pt-5 text-[13px] text-white/40">Messaging</p>
      <Toggle label="Read receipts" hint="Let people know when you have opened their chat." checked={privacy.readReceipts} onChange={(readReceipts) => update({ readReceipts })} />
      <Toggle label="Typing indicator" hint="Show when you are writing a message." checked={privacy.typing && privacy.lastSeen !== 'nobody'} onChange={(typing) => update({ typing })} />
      <Toggle label="Forwarding" hint="When off, new messages you send cannot be forwarded." checked={privacy.forwarding} onChange={(forwarding) => update({ forwarding })} />
      <p className="px-4 pb-2 pt-5 text-[13px] text-white/40">Blocked</p>
      {(blocked || []).length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-white/40">No blocked people.</p>
      ) : blocked.map((pubkey) => {
        const name = profiles[pubkey]?.displayName || `${pubkey.slice(0, 8)}…`;
        return (
          <div key={pubkey} className="flex items-center gap-3 border-b border-white/5 bg-[#111] px-4 py-3">
            <Avatar src={profiles[pubkey]?.picture} name={name} />
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-white">{name}</span>
            <button type="button" onClick={() => toggleBlockUser(pubkey)} className={`text-[13px] font-bold text-blue-500 ${pressable}`}>Unblock</button>
          </div>
        );
      })}
    </div>
  );
}
