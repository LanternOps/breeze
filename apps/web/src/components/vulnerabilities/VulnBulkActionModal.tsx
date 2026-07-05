import { useId, useState } from 'react';

import { Dialog } from '../shared/Dialog';
import { plural } from '../../lib/utils';

const BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50';

const INPUT =
  'mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary';

// Serialize the picked YYYY-MM-DD as end-of-day in the USER'S timezone. The
// previous `new Date(`${d}T00:00:00Z`)` treated the date as UTC midnight,
// which lands on the previous local day for anyone west of UTC.
export function localEndOfDayIso(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 23, 59, 59, 999).toISOString();
}

const HEADINGS: Record<'remediate' | 'accept' | 'mitigate', string> = {
  remediate: 'Remediate findings',
  accept: 'Accept risk',
  mitigate: 'Mark mitigated',
};

const CONFIRM_LABELS: Record<'remediate' | 'accept' | 'mitigate', string> = {
  remediate: 'Remediate',
  accept: 'Accept risk',
  mitigate: 'Mark mitigated',
};

export function VulnBulkActionModal({
  kind,
  count,
  deviceCount,
  busy,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  kind: 'remediate' | 'accept' | 'mitigate';
  count: number;
  /** Distinct devices in the selection (shown in the confirmation copy). */
  deviceCount: number;
  busy: boolean;
  /** Failure from the last submit, surfaced inline (the toast alone is easy to
   *  miss while the modal stays open). */
  errorMessage?: string | null;
  onCancel: () => void;
  onSubmit: (payload: { reason?: string; acceptedUntil?: string; note?: string }) => void;
}) {
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const titleId = useId();
  const isAccept = kind === 'accept';
  const isRemediate = kind === 'remediate';
  const canSubmit = isRemediate ? true : isAccept ? text.trim().length > 0 && until.length > 0 : text.trim().length > 0;

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={HEADINGS[kind]}
      labelledBy={titleId}
      maxWidth="md"
      className="p-5"
    >
      <div data-testid="vuln-bulk-modal">
        <h3 id={titleId} className="text-base font-semibold">
          {HEADINGS[kind]} — {plural(count, 'finding')}
        </h3>
        {isRemediate ? (
          <p data-testid="vuln-bulk-remediate-summary" className="mt-3 text-sm text-muted-foreground">
            This schedules remediation for {plural(count, 'finding')} on {plural(deviceCount, 'device')}.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="text-muted-foreground">{isAccept ? 'Reason' : 'Mitigation note'}</span>
              <textarea
                data-testid="vuln-bulk-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                className={INPUT}
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
                  className={INPUT}
                />
              </label>
            )}
          </div>
        )}
        {errorMessage && (
          <div
            data-testid="vuln-bulk-error"
            role="alert"
            className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300"
          >
            {errorMessage}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-testid="vuln-bulk-cancel" className={`${BTN} hover:bg-muted`} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="vuln-bulk-submit"
            className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={!canSubmit || busy}
            onClick={() =>
              onSubmit(
                isRemediate
                  ? {}
                  : isAccept
                    ? { reason: text.trim(), acceptedUntil: localEndOfDayIso(until) }
                    : { note: text.trim() },
              )
            }
          >
            {busy ? 'Working…' : CONFIRM_LABELS[kind]}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export default VulnBulkActionModal;
