import { useState } from 'react';

const BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

export function VulnBulkActionModal({
  kind,
  count,
  busy,
  onCancel,
  onSubmit,
}: {
  kind: 'accept' | 'mitigate';
  count: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { reason?: string; acceptedUntil?: string; note?: string }) => void;
}) {
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const isAccept = kind === 'accept';
  const canSubmit = isAccept ? text.trim().length > 0 && until.length > 0 : text.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg" data-testid="vuln-bulk-modal">
        <h3 className="text-base font-semibold">
          {isAccept ? 'Accept risk' : 'Mark mitigated'} — {count} finding{count === 1 ? '' : 's'}
        </h3>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">{isAccept ? 'Reason' : 'Mitigation note'}</span>
            <textarea
              data-testid="vuln-bulk-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          {isAccept && (
            <label className="block text-sm">
              <span className="text-muted-foreground">Accepted until</span>
              <input
                type="date"
                data-testid="vuln-bulk-until"
                value={until}
                min={(() => {
                  const d = new Date();
                  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                })()}
                onChange={(e) => setUntil(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              />
            </label>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="vuln-bulk-submit"
            className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={!canSubmit || busy}
            onClick={() =>
              onSubmit(
                isAccept
                  ? { reason: text.trim(), acceptedUntil: new Date(`${until}T00:00:00Z`).toISOString() }
                  : { note: text.trim() },
              )
            }
          >
            {isAccept ? 'Accept risk' : 'Mark mitigated'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default VulnBulkActionModal;
