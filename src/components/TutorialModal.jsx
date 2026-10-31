import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import Logo from './Logo';
import Sheet from './ui/Sheet';
import Button from './ui/Button';

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
    desc: "Open Discover to find menus and groups to join, or Menus for the current listings.",
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
  // The sheet shell stays mounted between closes; the steps remount below, so
  // every open starts the tour again at step one.
  if (!isOpen) return null;
  return <TutorialSteps onClose={onClose} />;
}

function TutorialSteps({ onClose }) {
  const [currentStep, setCurrentStep] = useState(0);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      localStorage.removeItem('cipher_new_account');
      onClose();
    }
  };

  const step = steps[currentStep];
  const last = currentStep === steps.length - 1;

  return (
    <Sheet open onClose={onClose} title="How to use" label="How to use" closeLabel="Close guide">
      <div className="pb-6 pt-2 text-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentStep}
            initial={{ x: 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -20, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            className="flex flex-col items-center"
          >
            <div className="mb-6 mt-1">
              <Logo size={72} />
            </div>
            <h2 className="mb-3 text-[22px] font-bold tracking-tight text-ink">{step.title}</h2>
            <p className="mb-4 px-2 text-[14px] leading-relaxed text-inkMuted">{step.desc}</p>
            {last && (
              <p className="mb-4 px-2 text-[13px] leading-relaxed text-accentText">You can reopen this guide any time under Profile → How to use.</p>
            )}
            <div className="mb-6 flex gap-2">
              {steps.map((_, i) => (
                <span key={i} className={`h-1.5 w-1.5 rounded-full transition-all duration-300 ${i === currentStep ? 'h-1.5 w-6 bg-accent' : 'bg-ink/10'}`} />
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
        <Button onClick={handleNext} fullWidth>
          {last ? 'Start Using Cipher' : 'Next'}
          {!last && <ChevronRight size={18} className="ml-1 inline" />}
        </Button>
      </div>
    </Sheet>
  );
}
