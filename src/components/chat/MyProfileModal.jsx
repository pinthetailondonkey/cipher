import React from 'react';

export default function MyProfileModal({ isOpen, onClose, ...props }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-md p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-white/50 hover:text-white">✕</button>
        <h2 className="text-xl font-bold mb-4">MyProfileModal</h2>
        <p className="text-sm text-white/50">This modal is under construction.</p>
      </div>
    </div>
  );
}
