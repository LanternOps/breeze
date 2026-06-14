import type { PendingApproval } from '../approval/approvalStore';
import type { CellValue } from '../api/types';

function cellText(value: CellValue | undefined): string {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

export function WritePreviewCard({
  approval,
  onApply,
  onReject,
  busy,
}: {
  approval: PendingApproval;
  onApply: () => void;
  onReject: () => void;
  busy?: boolean;
}) {
  const { preview } = approval;
  return (
    <div
      className="my-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
      data-testid="write-preview-card"
    >
      <div className="mb-1 font-semibold text-amber-900">
        {approval.toolName} → {preview.target}
      </div>
      {preview.kind === 'summary' ? (
        <p className="mb-2 text-amber-900">{preview.description}</p>
      ) : preview.kind === 'text' ? (
        <div className="mb-2 space-y-2" data-testid="write-preview-text">
          {preview.before !== undefined ? (
            <div data-testid="write-preview-text-before">
              <div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-amber-700">
                Before
              </div>
              <div className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-amber-200 bg-white/60 p-2 text-xs text-gray-500 line-through">
                {preview.before}
              </div>
            </div>
          ) : null}
          <div data-testid="write-preview-text-after">
            {preview.before !== undefined ? (
              <div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-amber-700">
                After
              </div>
            ) : null}
            <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-amber-200 bg-white p-2 text-amber-900">
              {preview.after}
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-2">
          <div className="max-h-48 overflow-auto">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {preview.after.map((row, r) => (
                  <tr key={r}>
                    {row.map((after, c) => {
                      const before = preview.before[r]?.[c];
                      const changed = (before ?? '') !== after;
                      return (
                        <td
                          key={c}
                          className={`border border-amber-200 px-1 py-0.5 ${changed ? 'bg-amber-100' : ''}`}
                        >
                          {changed && cellText(before) !== '' ? (
                            <>
                              <span className="text-gray-400 line-through">{cellText(before)}</span>{' '}
                            </>
                          ) : null}
                          <span className={changed ? 'font-medium text-amber-900' : 'text-gray-600'}>
                            {cellText(after)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-1 text-xs text-amber-700">{preview.changedCount} cell(s) will change</div>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onApply}
          className="rounded bg-emerald-600 px-3 py-1 text-white disabled:opacity-50"
          data-testid="approval-apply"
        >
          Apply
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          className="rounded border border-gray-300 px-3 py-1 text-gray-700 disabled:opacity-50"
          data-testid="approval-reject"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
