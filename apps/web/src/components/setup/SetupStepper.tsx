import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Step {
  label: string;
}

interface SetupStepperProps {
  steps: Step[];
  currentStep: number;
}

export default function SetupStepper({ steps, currentStep }: SetupStepperProps) {
  return (
    <nav aria-label="Setup progress" className="flex items-center justify-center gap-2">
      {steps.map((step, index) => {
        const isCompleted = index < currentStep;
        const isCurrent = index === currentStep;

        return (
          <div key={step.label} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
                  isCompleted && 'bg-primary text-primary-foreground',
                  isCurrent && 'bg-primary text-primary-foreground ring-2 ring-primary/30 ring-offset-2 ring-offset-background',
                  !isCompleted && !isCurrent && 'bg-muted text-muted-foreground'
                )}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
              </div>
              <span
                className={cn(
                  'hidden text-sm font-medium sm:inline',
                  isCurrent && 'text-foreground',
                  isCompleted && 'text-foreground',
                  !isCompleted && !isCurrent && 'text-muted-foreground'
                )}
              >
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        );
      })}
    </nav>
  );
}
