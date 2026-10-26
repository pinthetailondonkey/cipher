import React from 'react';
import { Search, Users, User } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import Picture from '../ui/Picture';
import { noHexName } from '../../lib/npub';
import { useChatStore } from '../../store/chatStore';

export default function SearchView({ handleSearch, joinGroupById, openChat }) {
  const setView = useChatStore((s) => s.setView);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const setSearchQuery = useChatStore((s) => s.setSearchQuery);
  const searchResults = useChatStore((s) => s.searchResults);
  const isSearching = useChatStore((s) => s.isSearching);

  return (
    <div className="absolute inset-0 z-50 flex h-full w-full flex-col bg-black">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <ScreenHeader title="Search" onBack={() => setView('list')} />
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 rounded-2xl border border-line bg-panel px-4 py-3 shadow-lg">
            <Search size={18} className="text-white/40" />
            <input
              autoFocus
              type="text"
              placeholder="Name or group"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              className="w-full bg-transparent text-[15px] text-white placeholder-white/40 outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
          {isSearching ? (
            <div className="mt-10 flex justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            </div>
          ) : searchResults.length === 0 ? (
            <div className="rounded-2xl border border-line bg-panel px-4 py-16 text-center shadow-lg">
              <p className="text-[15px] font-semibold text-white">{searchQuery ? 'No results' : 'Find someone'}</p>
              <p className="mt-1 text-[13px] text-white/40">{searchQuery ? 'Try another name.' : 'Search a name or a group.'}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
              {searchResults.map((result, i) => (
                <button
                  type="button"
                  key={result.id || result.pubkey || i}
                  disabled={result.type === 'user' ? !result.pubkey : !result.id}
                  className="flex w-full items-center justify-between border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5 disabled:opacity-50"
                  onClick={() => {
                    if (result.type === 'user') {
                      openChat('dm', result.pubkey);
                    } else if (result.type === 'group') {
                      joinGroupById(result.id, result.name, result.isChannel);
                    }
                  }}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/5 text-blue-500">
                      <Picture
                        src={result.picture}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                        fallback={result.type === 'group' ? <Users size={20} /> : <User size={20} />}
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-semibold text-white">{result.name || noHexName(null, result.pubkey)}</span>
                      <span className="block text-[13px] text-white/40">{result.type === 'group' ? 'Group' : 'Person'}</span>
                    </span>
                  </span>
                  <span className="ml-3 shrink-0 rounded-2xl bg-blue-600 px-3 py-1.5 text-[13px] font-bold text-white">
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
