import { useState } from 'react';
import { Phone, Eye, Image, Users, CheckCheck, Keyboard, Forward, Ban } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { getPrivacy, setPrivacy } from '../../lib/privacy';
import { useChatStore } from '../../store/chatStore';
import { pressable } from '../ui/Button';
import Avatar from '../ui/Avatar';

function Choice({ icon: Icon, label, hint, value, options, onChange }) {
  return (
    <div className="border-b border-white/5 p-4 last:border-0">
      <div className="flex items-start gap-3">
        <Icon size={18} className="mt-0.5 shrink-0 text-white/40" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-white">{label}</p>
          {hint && <p className="mt-0.5 text-[13px] text-white/40">{hint}</p>}
          <div className="mt-3 flex gap-2">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={value === option.id}
                onClick={() => onChange(option.id)}
                className={`rounded-2xl px-3 py-2 text-[13px] font-bold active:scale-95 ${value === option.id ? 'bg-blue-600 text-white' : 'bg-black text-white/55'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ icon: Icon, label, hint, checked, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5 ${pressable}`}>
      <Icon size={18} className="shrink-0 text-white/40" />
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
    <div className="h-full overflow-y-auto bg-black pb-8">
      <ScreenHeader title="Privacy" onBack={onBack} />
      <div className="space-y-4 p-4">
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]">
          <Choice icon={Phone} label="Calls" hint="Voice only. Video is not available." value={privacy.calls} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(calls) => update({ calls })} />
          <Choice icon={Eye} label="Last seen" hint="Nobody also stops your typing status." value={privacy.lastSeen} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(lastSeen) => update({ lastSeen })} />
          <Choice icon={Image} label="Profile photo" hint="Hidden the next time you save your profile." value={privacy.profilePhoto} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(profilePhoto) => update({ profilePhoto })} />
          <Choice icon={Users} label="Groups" hint="Nobody means only you can join." value={privacy.groups} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'nobody', label: 'Nobody' }]} onChange={(groups) => update({ groups })} />
        </div>
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]">
          <Toggle icon={CheckCheck} label="Read receipts" hint="Let people know when you opened their chat." checked={privacy.readReceipts} onChange={(readReceipts) => update({ readReceipts })} />
          <Toggle icon={Keyboard} label="Typing" hint="Show when you are writing." checked={privacy.typing && privacy.lastSeen !== 'nobody'} onChange={(typing) => update({ typing })} />
          <Toggle icon={Forward} label="Forwarding" hint="When off, new messages cannot be forwarded." checked={privacy.forwarding} onChange={(forwarding) => update({ forwarding })} />
        </div>
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#111]">
          {(blocked || []).length === 0 ? (
            <p className="flex items-center gap-3 p-4 text-[15px] text-white/40"><Ban size={18} /> No blocked people</p>
          ) : blocked.map((pubkey) => {
            const name = profiles[pubkey]?.displayName || `${pubkey.slice(0, 8)}…`;
            return (
              <div key={pubkey} className="flex items-center gap-3 border-b border-white/5 p-4 last:border-0">
                <Avatar src={profiles[pubkey]?.picture} name={name} />
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-white">{name}</span>
                <button type="button" onClick={() => toggleBlockUser(pubkey)} className={`text-[13px] font-bold text-blue-500 ${pressable}`}>Unblock</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
