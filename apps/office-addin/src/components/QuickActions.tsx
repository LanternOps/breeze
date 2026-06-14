import { useEffect, useState } from 'react';
import { captureWorkbookContext } from '../chat/captureContext';
import { quickActionsFor, summarizeSelection, type QuickAction } from '../chat/quickActions';
import type { WorkbookContext } from '../api/types';

type CaptureFn = () => Promise<WorkbookContext | undefined>;

/**
 * Empty-state quick-action chips (selection-aware). On mount we read the current
 * workbook selection and offer a few canned prompts that fit it — a formula cell
 * gets "Explain this formula", a numeric range gets "Summarize this" + "Make a
 * chart", and so on. Clicking a chip hands its canned prompt to `onSelect` (the
 * pane wires that to `controller.send`, so the prompt is sent immediately).
 *
 * Presentational + thin: all selection→chip logic lives in the pure
 * `quickActions` helper. Capture failures degrade silently to the generic set.
 */
export function QuickActions({
  onSelect,
  capture = captureWorkbookContext.bind(null, 'selection'),
}: {
  onSelect: (prompt: string) => void;
  capture?: CaptureFn;
}) {
  const [actions, setActions] = useState<QuickAction[]>(() =>
    quickActionsFor({ shape: 'empty' }),
  );

  useEffect(() => {
    let disposed = false;
    capture()
      .then((ctx) => {
        if (!disposed) setActions(quickActionsFor(summarizeSelection(ctx)));
      })
      .catch(() => {
        // Selection capture is best-effort — keep the generic chips on failure.
        if (!disposed) setActions(quickActionsFor({ shape: 'empty' }));
      });
    return () => {
      disposed = true;
    };
  }, [capture]);

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
