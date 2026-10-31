import ScreenHeader from '../ui/ScreenHeader';
import { HOW_TO_STEPS } from '../../lib/howToGuide';

// The full-screen guide behind Profile → How to use. Words only: the same
// header, cards and numbering the app already uses — SaveKey numbers the
// recovery words the same way — so this screen restyles nothing. The after-
// signup tour (TutorialModal) keeps its own door and is untouched here.
export default function HowToGuide({ onBack }) {
  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-transparent pb-8">
      <ScreenHeader title="How to use" onBack={onBack} />
      <ol className="space-y-4 p-4" aria-label="How to use Cipher">
        {HOW_TO_STEPS.map((step, index) => (
          <li key={step.title} className="rounded-2xl border border-line bg-panel p-4">
            <div className="flex items-start gap-3">
              <span className="w-5 shrink-0 text-right text-[13px] font-semibold text-inkMuted">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold text-ink">{step.title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-inkMuted">{step.body}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
