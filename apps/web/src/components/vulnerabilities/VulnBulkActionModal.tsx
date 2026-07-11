import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog } from '../shared/Dialog';
import '@/lib/i18n';

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

const ACTION_KEYS: Record<'remediate' | 'accept' | 'mitigate', string> = {
  remediate: 'remediate',
  accept: 'accept',
  mitigate: 'mitigate',
};

/** One entry per selected finding, for the "which devices" summary line. */
export interface SelectionPreviewItem {
  deviceName: string;
  /** Shown after the device name when set — the software drawer's selection
   *  mixes CVEs, so "WS-01 (CVE-2026-0001)" disambiguates. The CVE drawer
   *  omits it (every finding there is the same CVE). */
  cveId?: string | null;
}

// "WS-01 (CVE-2026-0001), WS-02, WS-03 and 4 more" — the first three findings
// by device name, so the user can see WHAT they selected behind the overlay
// without the modal becoming a wall.
export function formatSelectionPreview(
  items: SelectionPreviewItem[],
  moreLabel: (count: number) => string = (count) => `and ${count} more`,
): string {
  const shown = items.slice(0, 3).map((i) => (i.cveId ? `${i.deviceName} (${i.cveId})` : i.deviceName));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} ${moreLabel(rest)}` : shown.join(', ');
}

export function VulnBulkActionModal({
  kind,
  count,
  deviceCount,
  selection,
  busy,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  kind: 'remediate' | 'accept' | 'mitigate';
  count: number;
  /** Distinct devices in the selection (shown in the confirmation copy). */
  deviceCount: number;
  /** The selected findings (device name + optional CVE id), shown as a compact
   *  summary so the user doesn't have to remember what's checked behind the
   *  overlay. Optional to stay additive for existing callers/tests. */
  selection?: SelectionPreviewItem[];
  busy: boolean;
  /** Failure from the last submit, surfaced inline (the toast alone is easy to
   *  miss while the modal stays open). */
  errorMessage?: string | null;
  onCancel: () => void;
  onSubmit: (payload: { reason?: string; acceptedUntil?: string; note?: string }) => void;
}) {
  const { t } = useTranslation('vulnerabilities');
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const titleId = useId();
  const isAccept = kind === 'accept';
  const isRemediate = kind === 'remediate';
  const canSubmit = isRemediate ? true : isAccept ? text.trim().length > 0 && until.length > 0 : text.trim().length > 0;

  // One factually-accurate consequence sentence per action, matching what the
  // API really does (see routes/vulnerabilities.ts + vulnerabilityRemediation.ts):
  // remediate queues targeted install commands for approved patches; accept
  // hides findings until the expiry date but NOTHING auto-reopens them (they
  // surface via the "Accepted, expiring soon" card); mitigate only records the
  // note as a compensating control.
  const consequence = t(/* i18n-dynamic */ `vulnBulkActionModal.consequence.${ACTION_KEYS[kind]}`, {
    count,
    deviceText: t('vulnBulkActionModal.counts.devices', { count: deviceCount }),
    findingText: t('vulnBulkActionModal.counts.findings', { count }),
  });
  const heading = t(/* i18n-dynamic */ `vulnBulkActionModal.headings.${ACTION_KEYS[kind]}`);

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={heading}
      labelledBy={titleId}
      maxWidth="md"
      className="p-5"
    >
      <div data-testid="vuln-bulk-modal">
        <h3 id={titleId} className="text-base font-semibold">
          {t('vulnBulkActionModal.headingWithCount', { heading, count })}
        </h3>
        {selection && selection.length > 0 && (
          <p data-testid="vuln-bulk-selection" className="mt-2 text-sm">
            {formatSelectionPreview(selection, (rest) => t('vulnBulkActionModal.selection.more', { count: rest }))}
          </p>
        )}
        <p data-testid="vuln-bulk-consequence" className="mt-2 text-sm text-muted-foreground">
          {consequence}
        </p>
        {!isRemediate && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="text-muted-foreground">
                {isAccept ? t('vulnBulkActionModal.fields.reason') : t('vulnBulkActionModal.fields.mitigationNote')}
              </span>
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
                <span className="text-muted-foreground">{t('vulnBulkActionModal.fields.acceptedUntil')}</span>
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
            {t('common:actions.cancel')}
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
            {busy ? t('vulnBulkActionModal.actions.working') : t(/* i18n-dynamic */ `vulnBulkActionModal.actions.${ACTION_KEYS[kind]}`)/* i18n-dynamic */}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export default VulnBulkActionModal;
