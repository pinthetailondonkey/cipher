import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare, Compass, User, ShieldCheck, ChevronRight, X } from 'lucide-react';
import Logo from './Logo';

const steps = [
  {
    icon: <ShieldCheck className="text-blue-500" size={40} />,
    title: "Welcome to Cipher",
    desc: "Your decentralized, encrypted messaging & commerce app. Take a quick tour to see how it works.",
  },
  {
    icon: <MessageSquare className="text-blue-500" size={40} />,
    title: "Encrypted Chats",
    desc: "Tap 'Chats' to access your secure DMs. Create or join public/private Groups using decentralized relays.",
  },
  {
    icon: <Compass className="text-blue-500" size={40} />,
    title: "Global Marketplace",
    desc: "Tap 'Discover' to browse the marketplace. Buy items using BTC or XMR seamlessly, with zero-custody payments.",
  },
  {
    icon: <User className="text-blue-500" size={40} />,
    title: "Your Identity",
    desc: "Tap 'Profile' to manage your wallet addresses, open your Vendor Dashboard, or backup your identity.",
  }
];

export default function TutorialModal({ isOpen, onClose }) {
  const [currentStep, setCurrentStep] = useState(0);

  if (!isOpen) return null;

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      localStorage.removeItem('cipher_new_account');
      onClose();
    }
  };

  const step = steps[currentStep];

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-md p-6"
      >
        <motion.div 
          key={currentStep}
          initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="relative bg-[#0A0A0A] border border-white/10 rounded-3xl w-full max-w-sm p-8 overflow-hidden shadow-2xl flex flex-col items-center text-center"
        >
          <button onClick={() => { localStorage.removeItem('cipher_new_account'); onClose(); }} className="absolute top-4 right-4 text-white/30 hover:text-white transition-colors">
            <X size={20} />
          </button>

          <div className="mb-6 mt-2">
            <Logo size={56} />
          </div>

          <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-6">
            {step.icon}
          </div>
          
          <h2 className="text-2xl font-bold text-white mb-3">{step.title}</h2>
          <p className="text-[14px] text-white/60 leading-relaxed mb-8 px-2">{step.desc}</p>

          <div className="flex gap-2 mb-8">
            {steps.map((_, i) => (
              <div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === currentStep ? 'w-6 bg-blue-500' : 'w-1.5 bg-white/10'}`} />
            ))}
          </div>

          <button onClick={handleNext} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors">
            {currentStep === steps.length - 1 ? "Start Using Cipher" : "Next"}
            {currentStep !== steps.length - 1 && <ChevronRight size={18} />}
          </button>

          {/* POWERED BY NOSTR */}
          <div className="mt-8 flex flex-col items-center justify-center opacity-40">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-white tracking-wide">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
              Powered by Nostr
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
