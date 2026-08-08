import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Wrench, X, XCircle } from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';
import { handleActionError } from '@/lib/runAction';
import { getFinding, patchFinding } from '@/services/fleetFindings';
import type {
  FleetFinding, FleetFindingDetail, FleetFindingLifecycleAction,
} from '@/services/fleetFindings';
import {
  RUN_STATUS_CHIP_CLASSES, RUN_STATUS_LABEL_KEYS, STATUS_CHIP_CLASSES, STATUS_LABEL_KEYS,
} from './findingLabels';

/** Evidence blobs are producer-authored JSON of unbounded shape; render them
 *  preformatted and capped rather than trying to pretty-print every variant. */
const EVIDENCE_MAX_CHARS = 4000;

function formatEvidence(evidence: unknown): string {
  if (evidence == null) return '';
  try {
    const text = JSON.stringify(evidence, null, 2) ?? '';
    return text.length > EVIDENCE_MAX_CHARS ? `${text.slice(0, EVIDENCE_MAX_CHARS)}\n…` : text;
  } catch {
    return String(evidence);
  }
}

interface FindingDrawerProps {
  findingId: string;
  onClose: () => void;
  /** Lets the feed keep its row in sync after a lifecycle transition. */
  onStatusChange?: (finding: FleetFinding) => void;
  /** Task 10 supplies the remediation action picker; default is a no-op. */
  onRemediate?: (finding: FleetFindingDetail) => void;
}

export default function FindingDrawer({
  findingId, onClose, onStatusChange, onRemediate,
}: FindingDrawerProps) {
  const { t } = useTranslation('common');
  const [finding, setFinding] = useState<FleetFindingDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<FleetFindingLifecycleAction | null>(null);
  const [showDismiss, setShowDismiss] = useState(false);
  const [dismissNotes, setDismissNotes] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setShowDismiss(false);
    setDismissNotes('');

    getFinding(findingId)
      .then((detail) => {
        if (cancelled) return;
        setFinding(detail);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFinding(null);
        setError(
          err instanceof Error && err.message
            ? err.message
            : t('longTail.fleet.FindingDrawer.errors.loadFailed')
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [findingId, t]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const runLifecycle = useCallback(
    async (action: FleetFindingLifecycleAction, notes?: string) => {
      setPendingAction(action);
      try {
        // Call with two args when there are no notes — an explicit trailing
        // `undefined` would otherwise ride along into the request builder.
        const updated = notes === undefined
          ? await patchFinding(findingId, action)
          : await patchFinding(findingId, action, notes);
        if (!mounted.current) return;
        // Merge onto the loaded detail so members/runs survive the transition.
        setFinding((prev) => (prev ? { ...prev, ...updated } : prev));
        setShowDismiss(false);
        setDismissNotes('');
        onStatusChange?.(updated);
      } catch (err) {
        // runAction already toasted anything but a 401 / non-ActionError; this
        // keeps the failure from being swallowed and leaves the finding in its
        // pre-mutation state (no optimistic lie).
        handleActionError(err, t('longTail.fleet.FindingDrawer.errors.lifecycleFailed'));
      } finally {
        if (mounted.current) setPendingAction(null);
      }
    },
    [findingId, onStatusChange, t]
  );

  const status = finding?.status;
  const canAcknowledge = status === 'open';
  const canDismiss = status === 'open' || status === 'acknowledged';
  const canReopen = status === 'acknowledged' || status === 'dismissed';
  // A closed finding (resolved or dismissed) can no longer be remediated —
  // its device membership may be stale, and dismissal was a deliberate call
  // not to act. Reopening (see canReopen) is the only way back to actionable.
  const canRemediate = status === 'open' || status === 'acknowledged';
  const hasRemediationTargets = (finding?.deviceCount ?? 0) > 0;
  const busy = pendingAction !== null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        data-testid="finding-drawer-backdrop"
        aria-hidden="true"
      />
      <aside
        data-testid="finding-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={finding?.title ?? t('longTail.fleet.FindingDrawer.heading')}
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l bg-card text-card-foreground shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">
              {finding?.title ?? t('longTail.fleet.FindingDrawer.heading')}
            </h2>
            {finding && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 font-medium',
                    STATUS_CHIP_CLASSES[finding.status]
                  )}
                >
                  {t(/* i18n-dynamic */ STATUS_LABEL_KEYS[finding.status])}
                </span>
                {finding.orgName && <span>{finding.orgName}</span>}
                <span>
                  {t('longTail.fleet.FindingDrawer.meta.firstSeen', {
                    when: formatRelativeTime(new Date(finding.firstSeenAt)),
                  })}
                </span>
                <span>
                  {t('longTail.fleet.FindingDrawer.meta.lastSeen', {
                    when: formatRelativeTime(new Date(finding.lastSeenAt)),
                  })}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="finding-drawer-close"
            aria-label={t('actions.close')}
            className="rounded-md border p-1.5 text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex items-center justify-center p-10" data-testid="finding-drawer-loading">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/10 p-4"
              data-testid="finding-drawer-error"
            >
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="h-4 w-4 shrink-0" />
                <span className="text-sm font-medium">{error}</span>
              </div>
            </div>
          )}

          {finding && !error && (
            <div className="space-y-6">
              {finding.status === 'resolved' && (
                <section
                  data-testid="finding-resolved-note"
                  className="rounded-lg border bg-muted/30 p-3"
                >
                  <h3 className="mb-1 text-sm font-semibold">
                    {t('longTail.fleet.FindingDrawer.resolvedNote.heading')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t('longTail.fleet.FindingDrawer.resolvedNote.body')}
                  </p>
                  {finding.resolutionReason && (
                    <p
                      className="mt-1 text-sm text-muted-foreground"
                      data-testid="finding-resolved-reason"
                    >
                      {t('longTail.fleet.FindingDrawer.resolvedNote.reason', {
                        reason: finding.resolutionReason,
                      })}
                    </p>
                  )}
                </section>
              )}

              {finding.summary && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">
                    {t('longTail.fleet.FindingDrawer.summaryHeading')}
                  </h3>
                  <p className="text-sm text-muted-foreground">{finding.summary}</p>
                </section>
              )}

              {finding.dismissNotes && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">
                    {t('longTail.fleet.FindingDrawer.dismissNotesHeading')}
                  </h3>
                  <p className="text-sm text-muted-foreground">{finding.dismissNotes}</p>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('longTail.fleet.FindingDrawer.evidenceHeading')}
                </h3>
                <pre
                  data-testid="finding-evidence"
                  className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground"
                >
                  {formatEvidence(finding.evidence)}
                </pre>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('longTail.fleet.FindingDrawer.membersHeading')}
                </h3>
                {finding.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="finding-members-empty">
                    {t('longTail.fleet.FindingDrawer.membersEmpty')}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="p-2 text-left font-medium">
                            {t('longTail.fleet.FindingDrawer.table.device')}
                          </th>
                          <th className="p-2 text-left font-medium">
                            {t('longTail.fleet.FindingDrawer.table.source')}
                          </th>
                          <th className="p-2 text-left font-medium">
                            {t('longTail.fleet.FindingDrawer.table.lastSeen')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {finding.members.map((m) => (
                          <tr key={m.deviceId} data-testid={`finding-member-${m.deviceId}`}>
                            <td className="p-2">
                              <a
                                href={`/devices/${m.deviceId}`}
                                data-testid={`finding-member-link-${m.deviceId}`}
                                className="text-primary hover:underline"
                              >
                                {m.displayName || m.hostname}
                              </a>
                            </td>
                            <td className="p-2 text-muted-foreground">{m.sourceKind}</td>
                            <td className="p-2 text-muted-foreground">
                              {formatRelativeTime(new Date(m.lastSeenAt))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('longTail.fleet.FindingDrawer.runsHeading')}
                </h3>
                {finding.runs.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="finding-runs-empty">
                    {t('longTail.fleet.FindingDrawer.runsEmpty')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {finding.runs.map((run) => (
                      <li
                        key={run.id}
                        data-testid={`finding-run-${run.id}`}
                        className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
                      >
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 font-medium',
                            RUN_STATUS_CHIP_CLASSES[run.status] ?? 'bg-muted text-muted-foreground'
                          )}
                        >
                          {t(/* i18n-dynamic */ RUN_STATUS_LABEL_KEYS[run.status])}
                        </span>
                        <span className="text-muted-foreground">
                          {run.commandType ?? run.actionKind}
                        </span>
                        <span className="text-muted-foreground">
                          {t('longTail.fleet.FindingDrawer.runCounts', {
                            succeeded: formatNumber(run.succeededCount),
                            failed: formatNumber(run.failedCount),
                            skipped: formatNumber(run.skippedCount),
                            targets: formatNumber(run.targetCount),
                          })}
                        </span>
                        <span className="ml-auto text-muted-foreground">
                          {formatRelativeTime(new Date(run.completedAt ?? run.createdAt))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Actions */}
        {finding && !error && (
          <div className="border-t p-4">
            {showDismiss && (
              <div className="mb-3 rounded-md border bg-muted/30 p-3" data-testid="finding-dismiss-popover">
                <label
                  htmlFor="finding-dismiss-notes"
                  className="mb-1 block text-xs font-medium"
                >
                  {t('longTail.fleet.FindingDrawer.dismiss.notesLabel')}
                </label>
                <textarea
                  id="finding-dismiss-notes"
                  data-testid="finding-dismiss-notes"
                  value={dismissNotes}
                  onChange={(e) => setDismissNotes(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder={t('longTail.fleet.FindingDrawer.dismiss.notesPlaceholder')}
                  className="w-full rounded-md border bg-background p-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowDismiss(false); setDismissNotes(''); }}
                    data-testid="finding-dismiss-cancel"
                    className="rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-muted"
                  >
                    {t('actions.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => runLifecycle('dismiss', dismissNotes.trim())}
                    disabled={dismissNotes.trim().length === 0 || busy}
                    data-testid="finding-dismiss-confirm"
                    className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('longTail.fleet.FindingDrawer.dismiss.confirm')}
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {canRemediate && (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => onRemediate?.(finding)}
                    data-testid="finding-remediate"
                    disabled={!hasRemediationTargets}
                    title={
                      hasRemediationTargets
                        ? undefined
                        : t('longTail.fleet.FindingDrawer.actions.remediateDisabledReason')
                    }
                    aria-describedby={
                      hasRemediationTargets ? undefined : 'finding-remediate-disabled-reason'
                    }
                    className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary"
                  >
                    <Wrench className="h-4 w-4" />
                    {t('longTail.fleet.FindingDrawer.actions.remediate', { count: finding.deviceCount })}
                  </button>
                  {!hasRemediationTargets && (
                    <p
                      id="finding-remediate-disabled-reason"
                      data-testid="finding-remediate-disabled-reason"
                      className="text-xs text-muted-foreground"
                    >
                      {t('longTail.fleet.FindingDrawer.actions.remediateDisabledReason')}
                    </p>
                  )}
                </div>
              )}

              {canAcknowledge && (
                <button
                  type="button"
                  onClick={() => runLifecycle('acknowledge')}
                  disabled={busy}
                  data-testid="finding-ack"
                  className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {t('longTail.fleet.FindingDrawer.actions.acknowledge')}
                </button>
              )}

              {canDismiss && (
                <button
                  type="button"
                  onClick={() => setShowDismiss((v) => !v)}
                  disabled={busy}
                  data-testid="finding-dismiss"
                  className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {t('longTail.fleet.FindingDrawer.actions.dismiss')}
                </button>
              )}

              {canReopen && (
                <button
                  type="button"
                  onClick={() => runLifecycle('reopen')}
                  disabled={busy}
                  data-testid="finding-reopen"
                  className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {t('longTail.fleet.FindingDrawer.actions.reopen')}
                </button>
              )}

              {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
