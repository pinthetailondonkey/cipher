import React from 'react';
import { ArrowLeft, Search, Users, User } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

export default function SearchView({ handleSearch, joinGroupById, openChat }) {
  const setView = useChatStore((s) => s.setView);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const setSearchQuery = useChatStore((s) => s.setSearchQuery);
  const searchResults = useChatStore((s) => s.searchResults);
  const isSearching = useChatStore((s) => s.isSearching);

  return (
    <div className="absolute inset-0 z-50 flex h-full w-full flex-col bg-black/80 backdrop-blur-2xl">
      {/* HEADER & SEARCH BAR */}
      <div className="flex items-center gap-2 border-b border-white/10 bg-[#0A0A0A]/60 px-2 py-3 backdrop-blur-2xl">
        <button onClick={() => setView('list')} className="p-2 text-white" aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <h1 className="sr-only">Search</h1>
        <div className="flex flex-1 items-center gap-2 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl px-4 py-3">
          <Search size={18} className="text-white/40" />
          <input
            autoFocus
            type="text"
            placeholder="Search @username, npub, or group..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            className="w-full bg-transparent text-[15px] text-white placeholder-white/40 outline-none"
          />
        </div>
      </div>

      {/* RESULTS LIST */}
      <div className="flex-1 overflow-y-auto pb-24">
        {isSearching ? (
          <div className="flex justify-center mt-10">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : searchResults.length === 0 ? (
          <div className="text-center text-white/30 mt-10 text-sm">
            {searchQuery ? 'No results found.' : 'Search for people or groups.'}
          </div>
        ) : (
          <div className="mx-4 overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
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
                <div className="w-12 h-12 rounded-full border border-white/10 bg-white/5 shadow-2xl backdrop-blur-md flex items-center justify-center text-blue-500 shrink-0 overflow-hidden">
                  {result.picture ? (
                    <img src={result.picture} alt="" loading="lazy" className="w-full h-full object-cover" />
                  ) : result.type === 'group' ? (
                    <Users size={20} />
                  ) : (
                    <User size={20} />
                  )}
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold text-white">{result.name || `User ${result.pubkey?.slice(0, 6)}`}</h3>
                  <p className="text-[13px] text-white/40">{result.type === 'group' ? 'Group' : 'User'}</p>
                </div>
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
  );
}
