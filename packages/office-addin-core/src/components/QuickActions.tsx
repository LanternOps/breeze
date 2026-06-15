import { useEffect, useState } from 'react';
import { quickActionsFor, summarizeSelection, type QuickAction } from '../chat/quickActions';
import type { WorkbookContext } from '../api/types';

type CaptureFn = () => Promise<WorkbookContext | undefined>;

type ComputeFn = (ctx: WorkbookContext | undefined) => QuickAction[];

/** Default (Excel) chip logic: classify the grid shape and map it to chips. */
const defaultCompute: ComputeFn = (ctx) => quickActionsFor(summarizeSelection(ctx));

/**
 * Empty-state quick-action chips (context-aware). On mount we read the current
 * host context and offer a few canned prompts that fit it. For Excel (the
 * default `compute`) a formula cell gets "Explain this formula", a numeric range
 * gets "Summarize this" + "Make a chart", and so on. Non-Excel hosts pass their
 * own `compute` (from `host.quickActions`) so Word gets "Summarize this
 * document", Outlook gets "Draft a reply", etc. — never the spreadsheet
 * fallback. Clicking a chip hands its canned prompt to `onSelect` (the pane
 * wires that to `controller.send`, so the prompt is sent immediately).
 *
 * Presentational + thin: all context→chip logic lives in the pure `compute`
 * function. Capture failures degrade to `compute(undefined)` (the host's own
 * generic set).
 */
export function QuickActions({
  onSelect,
  capture,
  compute = defaultCompute,
}: {
  onSelect: (prompt: string) => void;
  // Required: threaded from ChatPane (the active adapter's context capture) so
  // this presentational component never imports `Excel.*` or the host-bound
  // `captureContext` directly.
  capture: CaptureFn;
  // Optional: host-specific chip logic (`host.quickActions`). Defaults to the
  // Excel grid heuristic when unset.
  compute?: ComputeFn;
}) {
  const [actions, setActions] = useState<QuickAction[]>(() => compute(undefined));

  useEffect(() => {
    let disposed = false;
    capture()
      .then((ctx) => {
        if (!disposed) setActions(compute(ctx));
      })
      .catch(() => {
        // Context capture is best-effort — fall back to the host's generic set.
        if (!disposed) setActions(compute(undefined));
      });
    return () => {
      disposed = true;
    };
  }, [capture, compute]);

  if (actions.length === 0) return null;

  return (
    <div className="px-3 pt-3" data-testid="quick-actions">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Suggestions
      </div>
      <div className="flex flex-wrap gap-1.5">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => onSelect(action.prompt)}
            title={action.prompt}
            className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:border-blue-400 hover:text-blue-600"
            data-testid={`quickaction-${action.id}`}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
