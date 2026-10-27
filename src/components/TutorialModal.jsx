import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, X } from 'lucide-react';
import Logo from './Logo';

const steps = [
  {
    title: "Welcome to Cipher",
    desc: "Your encrypted messenger and direct-deal app. Take a quick tour to see how it works.",
  },
  {
    title: "Encrypted Chats",
    desc: "Open Chats for private messages. Create or join a group when you want a room.",
  },
  {
    title: "Find the Menu",
    desc: "Open Discover to find vendor menus and groups to join, or Shop for the current listings.",
  },
  {
    title: "Voice Calls",
    desc: "Start an encrypted voice call from the header of any chat. No one else hears it.",
  },
  {
    title: "Selling",
    desc: "Open Profile, add a paying address to turn on selling, then publish your products and share your menu.",
  },
  {
    title: "Your Keys",
    desc: "Profile → Backup holds your secret key and 12-word recovery phrase. Only you have those words: save them somewhere safe and never share them.",
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
        className="fixed inset-0 z-sheet flex items-center justify-center bg-scrim/80 p-6"
      >
        <motion.div 
          key={currentStep}
          initial={{ x: 20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="relative bg-panel border border-line rounded-3xl w-full max-w-sm p-8 overflow-hidden shadow-lg flex flex-col items-center text-center"
        >
          <button onClick={() => { localStorage.removeItem('cipher_new_account'); onClose(); }} className="absolute top-4 right-4 text-ink/30 hover:text-ink transition-colors">
            <X size={20} />
          </button>

          <div className="mb-8 mt-2">
            <Logo size={72} />
          </div>

          <h2 className="text-2xl font-bold text-ink mb-3">{step.title}</h2>
          <p className="text-[14px] text-ink/60 leading-relaxed mb-4 px-2">{step.desc}</p>
          {currentStep === steps.length - 1 && (
            <p className="text-[13px] text-accentText leading-relaxed mb-4 px-2">You can reopen this guide any time under Profile → How to use.</p>
          )}

          <div className="flex gap-2 mb-8">
            {steps.map((_, i) => (
              <div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === currentStep ? 'w-6 bg-accent' : 'w-1.5 bg-ink/10'}`} />
            ))}
          </div>

          <button onClick={handleNext} className="w-full bg-accent hover:bg-accent text-accentInk font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-colors">
            {currentStep === steps.length - 1 ? "Start Using Cipher" : "Next"}
            {currentStep !== steps.length - 1 && <ChevronRight size={18} />}
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
