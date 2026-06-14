/**
 * "Changes applied" log — the client-facing record of what the assistant did to
 * THIS workbook, newest-first. Opened from the pane header (mirrors
 * HistoryPanel). Revertible writes (write_range / insert_formula, where a real
 * before-grid was captured) show an "Undo" button that re-writes the original
 * values; summary-only mutations (create sheet/table/chart/pivot, format, clear,
 * sort) are listed as applied-but-not-revertible. A reverted change shows its
 * reverted state and can't be undone again.
 *
 * This is a governance/trust surface — it must only claim a change is revertible
 * when one truly is (ApprovalStore sets `revertible` only for captured grids).
 */
import type { AppliedChange } from '../approval/approvalStore';

/** Human label for a tool name, e.g. write_range → "Write range". */
function toolLabel(toolName: string): string {
  const words = toolName.split('_');
  if (words.length === 0) return toolName;
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ChangesPanel({
  changes,
  onRevert,
  onClose,
}: {
  changes: readonly AppliedChange[];
  onRevert: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-white" data-testid="changes-panel">
      {/* pr-10: keep the close × clear of Office's pinned top-right pane button (Mac). */}
      <div className="flex items-center justify-between border-b border-gray-100 py-2 pl-3 pr-10">
        <span className="text-sm font-semibold text-gray-800">Changes applied</span>
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-semibold text-gray-500 hover:text-gray-800"
          aria-label="Close changes"
          data-testid="changes-close"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {changes.length === 0 ? (
          <div className="p-4 text-center text-sm text-gray-400" data-testid="changes-empty">
            No changes yet. When the assistant edits this workbook, you&apos;ll see it here.
          </div>
        ) : (
          <div className="space-y-1">
            {changes.map((c) => (
              <div
                key={c.id}
                className="rounded-md border border-gray-200 p-2"
                data-testid={`change-item-${c.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-gray-800">
                    {toolLabel(c.toolName)}
                  </span>
                  <span className="shrink-0 text-xs text-gray-500">{formatWhen(c.appliedAt)}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-gray-500">{c.target}</div>
                <div className="mt-1.5">
                  {c.reverted ? (
                    <span
                      className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                      data-testid={`change-reverted-${c.id}`}
                    >
                      Reverted
                    </span>
                  ) : c.revertible ? (
                    <button
                      type="button"
                      onClick={() => onRevert(c.id)}
                      className="inline-flex items-center rounded border border-blue-300 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
                      data-testid={`change-undo-${c.id}`}
                    >
                      Undo
                    </button>
                  ) : (
                    <span
                      className="inline-flex items-center rounded bg-gray-50 px-2 py-0.5 text-xs text-gray-400"
                      data-testid={`change-notrevertible-${c.id}`}
                      title="This kind of change can't be automatically undone."
                    >
                      Not revertible
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
