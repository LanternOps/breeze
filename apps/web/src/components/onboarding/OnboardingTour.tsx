import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface TourStep {
  target: string; // CSS selector for the target element
  titleKey: string;
  descriptionKey: string;
  position: 'bottom' | 'right' | 'left';
}

const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="sidebar-nav"]',
    titleKey: 'longTail.onboarding.OnboardingTour.steps.navigate.title',
    descriptionKey: 'longTail.onboarding.OnboardingTour.steps.navigate.description',
    position: 'right'
  },
  {
    target: '[data-tour="search"]',
    titleKey: 'longTail.onboarding.OnboardingTour.steps.search.title',
    descriptionKey: 'longTail.onboarding.OnboardingTour.steps.search.description',
    position: 'bottom'
  },
  {
    target: '[data-tour="org-switcher"]',
    titleKey: 'longTail.onboarding.OnboardingTour.steps.switchOrgs.title',
    descriptionKey: 'longTail.onboarding.OnboardingTour.steps.switchOrgs.description',
    position: 'bottom'
  },
  {
    target: '[data-tour="ai-assistant"]',
    titleKey: 'longTail.onboarding.OnboardingTour.steps.aiHelp.title',
    descriptionKey: 'longTail.onboarding.OnboardingTour.steps.aiHelp.description',
    position: 'bottom'
  }
];

const TOUR_STORAGE_KEY = 'breeze-onboarding-complete';

export default function OnboardingTour() {
  const { t } = useTranslation('common');
  const [currentStep, setCurrentStep] = useState(-1); // -1 = not started
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Don't show if already completed
    try {
      if (localStorage.getItem(TOUR_STORAGE_KEY)) return;
    } catch { return; }

    // Delay start to let the page fully render
    const timer = setTimeout(() => setCurrentStep(0), 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (currentStep < 0 || currentStep >= TOUR_STEPS.length) return;

    // Dismiss the tour on any pointer interaction outside the tooltip card.
    // The backdrop is pointer-events-none so the underlying page stays
    // interactive; this listener ensures the first such interaction also
    // ends (and persists the dismissal of) the tour.
    const handleOutsidePointer = (e: MouseEvent) => {
      if (tooltipRef.current?.contains(e.target as Node)) return;
      handleDismiss();
    };
    document.addEventListener('mousedown', handleOutsidePointer, true);

    const step = TOUR_STEPS[currentStep];
    let cancelled = false;

    const positionTooltip = (target: Element) => {
      const rect = target.getBoundingClientRect();
      const pos = { top: 0, left: 0 };

      switch (step.position) {
        case 'bottom':
          pos.top = rect.bottom + 8;
          pos.left = rect.left + rect.width / 2;
          break;
        case 'right':
          pos.top = rect.top + rect.height / 2;
          pos.left = rect.right + 8;
          break;
        case 'left':
          pos.top = rect.top + rect.height / 2;
          pos.left = rect.left - 8;
          break;
      }

      setTooltipPos(pos);
      target.classList.add('tour-highlight');
    };

    const target = document.querySelector(step.target);
    if (target) {
      positionTooltip(target);
      return () => {
        document.removeEventListener('mousedown', handleOutsidePointer, true);
        target.classList.remove('tour-highlight');
      };
    }

    // Target not found — retry once after 500ms (async-loaded islands)
    const retryTimer = setTimeout(() => {
      if (cancelled) return;
      const retryTarget = document.querySelector(step.target);
      if (retryTarget) {
        positionTooltip(retryTarget);
      } else {
        // Still not found, skip this step
        handleNext();
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      document.removeEventListener('mousedown', handleOutsidePointer, true);
      // Clean up highlight from retry target if it was found
      document.querySelector(step.target)?.classList.remove('tour-highlight');
    };
  }, [currentStep]);

  const handleNext = () => {
    if (currentStep >= TOUR_STEPS.length - 1) {
      handleDismiss();
    } else {
      setCurrentStep(s => s + 1);
    }
  };

  const handleDismiss = () => {
    setCurrentStep(-1);
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, 'true');
    } catch { /* ignore */ }
    // Clean up any remaining highlights
    document.querySelectorAll('.tour-highlight').forEach(el =>
      el.classList.remove('tour-highlight')
    );
  };

  if (currentStep < 0 || currentStep >= TOUR_STEPS.length) return null;

  const step = TOUR_STEPS[currentStep];
  const isLast = currentStep === TOUR_STEPS.length - 1;

  return (
    <>
      {/* Subtle backdrop — non-blocking so the page beneath stays interactive.
          Any mousedown outside the tooltip dismisses the tour (see effect above). */}
      <div className="pointer-events-none fixed inset-0 z-60 bg-background/40" />

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="fixed z-61 w-72 rounded-lg border bg-card p-4 shadow-xl"
        style={{
          top: tooltipPos.top,
          left: tooltipPos.left,
          transform: step.position === 'bottom'
            ? 'translateX(-50%)'
            : step.position === 'right'
              ? 'translateY(-50%)'
              : 'translateX(-100%) translateY(-50%)'
        }}
      >
        <div className="flex items-start justify-between mb-2">
          <h4 className="text-sm font-semibold text-foreground">{t(step.titleKey)}</h4>
          <button
            onClick={handleDismiss}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            title={t('longTail.onboarding.OnboardingTour.skipTour')}
            aria-label={t('longTail.onboarding.OnboardingTour.skipTour')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed mb-3">{t(step.descriptionKey)}</p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground/70">
            {t('longTail.onboarding.OnboardingTour.progress', { current: currentStep + 1, total: TOUR_STEPS.length })}
          </span>
          <button
            onClick={handleNext}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {isLast ? t('longTail.onboarding.OnboardingTour.gotIt') : t('common:actions.next')}
          </button>
        </div>
      </div>
    </>
  );
}
