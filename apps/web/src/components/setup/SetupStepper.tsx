import { Check, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface Step {
  label: string;
  /** Shown beneath the label — only rendered in `orientation="vertical"`
   *  (the horizontal auth wizard rail has never had room for it). */
  description?: string;
}

interface SetupStepperProps {
  steps: Step[];
  currentStep: number;
  onStepClick?: (step: number) => void;
  /** Overrides the nav's accessible name. Defaults to the auth setup
   *  wizard's own string (`setup.stepper.ariaLabel`) so every existing
   *  caller is unaffected — a caller outside that flow (the AI agent create
   *  flow's vertical rail) names itself instead of borrowing that copy. */
  ariaLabel?: string;
  /** `'horizontal'` (default) is the original auth-wizard rail: circles in a
   *  row, chevron separators, labels beside/under each circle. `'vertical'`
   *  stacks the steps in a column with a 1px connector between circles and
   *  the label (plus an optional `description`) beside each one — the
   *  left-rail pattern the AI agent create flow (spec §4.6) needs. */
  orientation?: 'horizontal' | 'vertical';
  /** Highest step index the caller allows jumping FORWARD to (a step the
   *  operator has already visited, e.g. after an "Edit" link from a review
   *  step sent them back). Completed steps are always clickable; without
   *  this, nothing ahead of `currentStep` is — the original behaviour. The
   *  caller still owns validation of the steps being skipped over. */
  reachableStep?: number;
}

export default function SetupStepper({
  steps,
  currentStep,
  onStepClick,
  ariaLabel,
  orientation = 'horizontal',
  reachableStep = -1,
}: SetupStepperProps) {
  const { t } = useTranslation('auth');
  const label = ariaLabel ?? t('setup.stepper.ariaLabel');
  const clickable = (index: number): boolean =>
    !!onStepClick && index !== currentStep && (index < currentStep || index <= reachableStep);

  if (orientation === 'vertical') {
    return (
      <nav aria-label={label} className="flex flex-col" data-testid="setup-stepper-vertical">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isClickable = clickable(index);
          const isLast = index === steps.length - 1;

          return (
            <div key={step.label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  disabled={!isClickable}
                  onClick={() => isClickable && onStepClick?.(index)}
                  aria-current={isCurrent ? 'step' : undefined}
                  // A completed circle swaps its number for an icon, which
                  // would otherwise leave the button with no accessible name
                  // (#5048 QA) — the number + label names it in every state.
                  aria-label={`${index + 1}. ${step.label}`}
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    isCompleted && 'bg-primary text-primary-foreground',
                    isCurrent && 'bg-primary text-primary-foreground ring-2 ring-primary/30 ring-offset-2 ring-offset-background',
                    !isCompleted && !isCurrent && 'bg-muted text-muted-foreground',
                    isClickable && 'cursor-pointer',
                  )}
                  data-testid={`setup-stepper-step-${index}`}
                >
                  {isCompleted ? <Check className="h-4 w-4" aria-hidden="true" /> : index + 1}
                </button>
                {/* The connector between this circle and the next — a plain
                    1px line, not a progress bar: the circles themselves
                    already carry the completed/current/upcoming state. */}
                {!isLast && <div className="w-px flex-1 bg-border" aria-hidden="true" />}
              </div>
              <div className={cn('min-w-0', isLast ? 'pb-0' : 'pb-6')}>
                <button
                  type="button"
                  disabled={!isClickable}
                  onClick={() => isClickable && onStepClick?.(index)}
                  className={cn(
                    'text-left text-sm font-medium',
                    (isCurrent || isCompleted) && 'text-foreground',
                    !isCompleted && !isCurrent && 'text-muted-foreground',
                    isClickable && 'cursor-pointer hover:underline',
                  )}
                >
                  {step.label}
                </button>
                {step.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
                )}
              </div>
            </div>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label={label} className="flex items-center justify-center gap-2">
      {steps.map((step, index) => {
        const isCompleted = index < currentStep;
        const isCurrent = index === currentStep;
        const isClickable = clickable(index);

        return (
          <div key={step.label} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!isClickable}
              onClick={() => isClickable && onStepClick?.(index)}
              className={cn(
                'flex items-center gap-2',
                isClickable && 'cursor-pointer'
              )}
              data-testid={`setup-stepper-step-${index}`}
            >
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
                  isCompleted && 'bg-primary text-primary-foreground',
                  isCurrent && 'bg-primary text-primary-foreground ring-2 ring-primary/30 ring-offset-2 ring-offset-background',
                  !isCompleted && !isCurrent && 'bg-muted text-muted-foreground'
                )}
              >
                {isCompleted ? <Check className="h-4 w-4" aria-hidden="true" /> : index + 1}
              </div>
              <span
                className={cn(
                  'hidden text-sm font-medium sm:inline',
                  isCurrent && 'text-foreground',
                  isCompleted && 'text-foreground',
                  !isCompleted && !isCurrent && 'text-muted-foreground',
                  isClickable && 'hover:underline'
                )}
              >
                {step.label}
              </span>
            </button>
            {index < steps.length - 1 && (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        );
      })}
    </nav>
  );
}
