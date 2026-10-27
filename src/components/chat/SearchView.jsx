import React from 'react';
import { Search, Users, User } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import Logo from '../Logo';
import { noHexName } from '../../lib/npub';
import { useChatStore } from '../../store/chatStore';

export default function SearchView({ handleSearch, joinGroupById, openChat }) {
  const setView = useChatStore((s) => s.setView);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const setSearchQuery = useChatStore((s) => s.setSearchQuery);
  const searchResults = useChatStore((s) => s.searchResults);
  const isSearching = useChatStore((s) => s.isSearching);

  return (
    <div className="absolute inset-0 z-sheet flex h-full w-full flex-col bg-scrim">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <ScreenHeader title={<span className="flex items-center gap-2"><Logo size={24} />Search</span>} onBack={() => setView('list')} />
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 rounded-full border border-line bg-panel px-4 py-3">
            <Search size={24} className="shrink-0 text-inkSubtle" />
            <input
              autoFocus
              type="text"
              placeholder="Name or group"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              className="w-full bg-transparent text-[15px] text-ink placeholder-inkSubtle outline-none"
            />
          </div>
        </div>
        <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-4 pb-8">
          {isSearching ? (
            <div className="mt-10 flex justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accentText border-t-transparent" />
            </div>
          ) : searchResults.length === 0 ? (
            <div className="rounded-2xl border border-line bg-panel px-4 py-16 text-center">
              <p className="text-[15px] font-semibold text-ink">{searchQuery ? 'No results' : 'Find someone'}</p>
              <p className="mt-1 text-[13px] text-inkMuted">{searchQuery ? 'Try another name.' : 'Search a name or a group.'}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line bg-panel">
              {searchResults.map((result, i) => (
                <button
                  type="button"
                  key={result.id || result.pubkey || i}
                  disabled={result.type === 'user' ? !result.pubkey : !result.id}
                  className="flex min-h-[64px] w-full touch-target items-center justify-between gap-3 border-b border-line p-4 text-left last:border-0 active:bg-ink/5 disabled:opacity-50"
                  onClick={() => {
                    if (result.type === 'user') {
                      openChat('dm', result.pubkey);
                    } else if (result.type === 'group') {
                      joinGroupById(result.id, result.name, result.isChannel);
                    }
                  }}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-panelStrong text-accentText">
                    <Picture
                      src={result.picture}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                      fallback={result.type === 'group' ? <Users size={20} /> : <User size={20} />}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-ink">{result.name || noHexName(null, result.pubkey)}</span>
                    <span className="block truncate text-[13px] text-inkMuted">{result.type === 'group' ? (result.isChannel ? 'Menu' : 'Group') : 'Person'}</span>
                  </span>
                  <span className="ml-3 shrink-0 rounded-full bg-accent px-3 py-1.5 text-[13px] font-bold text-accentInk">
                    {result.type === 'group' ? 'Join' : 'Message'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
