import { Square, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import type { ActionPlanStep } from '@breeze/shared';

/** Human-readable tool name */
function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface AiPlanProgressBarProps {
  steps: ActionPlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'aborted';
  onAbort?: () => void;
}

export default function AiPlanProgressBar({ steps, currentStepIndex, status, onAbort }: AiPlanProgressBarProps) {
  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const progressPct = steps.length > 0 ? (completedCount / steps.length) * 100 : 0;
  const currentStep = steps[currentStepIndex];
  const isFinished = status === 'completed' || status === 'aborted';

  return (
    <div className="my-2 rounded-lg border border-blue-600/40 bg-blue-950/20 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status === 'executing' && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />}
          {status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />}
          {status === 'aborted' && <XCircle className="h-3.5 w-3.5 text-red-400" />}
          <span className="text-xs font-medium text-gray-300">
            {isFinished
              ? status === 'completed'
                ? `Plan completed (${completedCount}/${steps.length})`
                : `Plan aborted at step ${currentStepIndex + 1}`
              : `Executing: Step ${currentStepIndex + 1} of ${steps.length}`}
          </span>
        </div>
        {!isFinished && onAbort && (
          <button
            onClick={onAbort}
            className="flex items-center gap-1 rounded bg-red-700/80 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red-600"
          >
            <Square className="h-3 w-3" />
            Stop
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            status === 'aborted' ? 'bg-red-500/60' : status === 'completed' ? 'bg-green-500/60' : 'bg-blue-500/60'
          }`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Current step name */}
      {!isFinished && currentStep && (
        <p className="mt-1.5 text-xs text-gray-400 truncate">
          {formatToolName(currentStep.toolName)}
          {currentStep.reasoning && <span className="text-gray-600"> — {currentStep.reasoning}</span>}
        </p>
      )}

      {/* Step indicators */}
      <div className="mt-2 flex gap-1">
        {steps.map((step, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full ${
              step.status === 'completed' ? 'bg-green-500' :
              step.status === 'failed' ? 'bg-red-500' :
              step.status === 'executing' ? 'bg-blue-500 animate-pulse' :
              step.status === 'skipped' ? 'bg-gray-600' :
              'bg-gray-700'
            }`}
            title={`Step ${i + 1}: ${formatToolName(step.toolName)}`}
          />
        ))}
      </div>
    </div>
  );
}
