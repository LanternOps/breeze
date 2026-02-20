import { useState, useEffect } from 'react';
import { ListChecks, Check, X, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import type { ActionPlanStep } from '@breeze/shared';

const AUTO_REJECT_MS = 10 * 60 * 1000; // 10 minutes

/** Keys that are internal identifiers */
const HIDDEN_INPUT_KEYS = new Set(['deviceId', 'orgId', 'siteId', 'sessionId']);

function filterInput(input: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!HIDDEN_INPUT_KEYS.has(k)) filtered[k] = v;
  }
  return filtered;
}

/** Human-readable tool name */
function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface AiPlanReviewCardProps {
  steps: ActionPlanStep[];
  onApprove: () => void;
  onReject: () => void;
}

export default function AiPlanReviewCard({ steps, onApprove, onReject }: AiPlanReviewCardProps) {
  const [remainingMs, setRemainingMs] = useState(AUTO_REJECT_MS);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const remaining = AUTO_REJECT_MS - (Date.now() - start);
      if (remaining <= 0) {
        clearInterval(interval);
        onReject();
      } else {
        setRemainingMs(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [onReject]);

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  const progressPct = (remainingMs / AUTO_REJECT_MS) * 100;

  return (
    <div className="my-2 rounded-lg border border-purple-600/50 bg-purple-950/20 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-purple-400" />
          <span className="text-sm font-medium text-purple-300">Action Plan</span>
          <span className="rounded-full bg-purple-900/50 px-2 py-0.5 text-xs text-purple-300">
            {steps.length} step{steps.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Clock className="h-3 w-3" />
          <span>{countdown}</span>
        </div>
      </div>

      {/* Countdown progress bar */}
      <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-gray-800">
        <div
          className="h-full rounded-full bg-purple-500/60 transition-all duration-1000 ease-linear"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Steps list */}
      <div className="mt-3 space-y-1">
        {steps.map((step) => {
          const isExpanded = expandedStep === step.index;
          const visibleInput = filterInput(step.input);
          const hasVisibleInput = Object.keys(visibleInput).length > 0;

          return (
            <div key={step.index} className="rounded-md bg-gray-800/40 px-2.5 py-2">
              <button
                onClick={() => setExpandedStep(isExpanded ? null : step.index)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-700 text-xs text-gray-300">
                  {step.index + 1}
                </span>
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-gray-500" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-gray-500" />
                )}
                <span className="text-xs font-medium text-gray-200 truncate">
                  {formatToolName(step.toolName)}
                </span>
              </button>
              {isExpanded && (
                <div className="mt-1.5 pl-10 space-y-1">
                  <p className="text-xs text-gray-400">{step.reasoning}</p>
                  {hasVisibleInput && (
                    <pre className="max-h-20 overflow-auto rounded bg-gray-900 px-2 py-1 text-xs text-gray-500">
                      {JSON.stringify(visibleInput, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="mt-3 flex gap-2">
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
        >
          <Check className="h-3.5 w-3.5" />
          Approve All
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1.5 rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-600"
        >
          <X className="h-3.5 w-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}
