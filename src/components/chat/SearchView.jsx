import React from 'react';
import { ArrowLeft, Search, Users, User, MessageCircle, UserPlus } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

export default function SearchView({ handleSearch, joinGroupById, openChat }) {
  const setView = useChatStore((s) => s.setView);
  const searchQuery = useChatStore((s) => s.searchQuery);
  const setSearchQuery = useChatStore((s) => s.setSearchQuery);
  const searchResults = useChatStore((s) => s.searchResults);
  const isSearching = useChatStore((s) => s.isSearching);

  return (
    <div className="flex flex-col h-full w-full bg-black absolute inset-0 z-50">
      {/* HEADER & SEARCH BAR */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-white/5 bg-black/90 backdrop-blur-xl sticky top-0 z-10">
        <button onClick={() => setView('list')} className="p-2 -ml-2 text-white/60 hover:text-white transition-colors">
          <ArrowLeft size={22} />
        </button>
        
        <div className="flex-1 flex items-center gap-2 bg-[#111] rounded-xl px-3 py-2.5 border border-white/10 focus-within:border-white/20 transition-colors">
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
          searchResults.map((result, i) => (
            <button
              type="button"
              key={result.id || result.pubkey || i}
              disabled={result.type === 'user' ? !result.pubkey : !result.id}
              className={`flex w-full items-center justify-between px-4 py-3 text-left hover:bg-white/5 active:bg-white/10 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${i !== searchResults.length - 1 ? 'border-b border-white/5' : ''}`}
              onClick={() => {
                if (result.type === 'user') {
                  openChat('dm', result.pubkey);
                } else if (result.type === 'group') {
                  joinGroupById(result.id, result.name, result.isChannel);
                }
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-[#111] border border-white/10 flex items-center justify-center text-blue-500 shrink-0 overflow-hidden">
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
              
              <span className="ml-3 flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/50 px-3 py-2 text-[13px] font-semibold text-blue-400">
                {result.type === 'group' ? <><UserPlus size={15} /> Join</> : <><MessageCircle size={15} /> Message</>}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
