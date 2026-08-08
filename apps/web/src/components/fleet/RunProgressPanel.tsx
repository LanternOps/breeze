import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, X, XCircle } from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';
import { getRun, isTerminalRunStatus } from '@/services/fleetFindings';
import type { FleetRemediationRunDetail } from '@/services/fleetFindings';
import {
  RUN_STATUS_CHIP_CLASSES, RUN_STATUS_LABEL_KEYS,
  TARGET_STATUS_CHIP_CLASSES, TARGET_STATUS_LABEL_KEYS, skipReasonLabelKey,
} from './findingLabels';

/** Poll cadence while the run is `queued` or `running`. Exported so the test
 *  advances the exact interval rather than a magic number that can silently
 *  drift out of sync with the component. */
export const RUN_POLL_INTERVAL_MS = 5000;

/** Agent result summaries are capped at 2000 chars server-side
 *  (REMEDIATION_RESULT_SUMMARY_MAX) — still far too long for a table row, so
 *  bound it again here rather than letting one failure blow out the panel. */
const SUMMARY_MAX_CHARS = 200;

function truncate(value: string): string {
  return value.length > SUMMARY_MAX_CHARS ? `${value.slice(0, SUMMARY_MAX_CHARS)}…` : value;
}

interface RunProgressPanelProps {
  runId: string;
  onClose: () => void;
}

export default function RunProgressPanel({ runId, onClose }: RunProgressPanelProps) {
  const { t } = useTranslation('common');
  const [run, setRun] = useState<FleetRemediationRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the retry button to re-arm the effect after a poll failure.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Self-scheduling setTimeout rather than setInterval: the next poll is
    // only armed once the previous response has landed, so a slow API can't
    // stack overlapping in-flight requests, and the terminal check happens
    // before anything is armed at all.
    const tick = async () => {
      try {
        const data = await getRun(runId);
        if (cancelled) return;
        setRun(data);
        setError(null);
        if (!isTerminalRunStatus(data.status)) {
          timer = setTimeout(() => { void tick(); }, RUN_POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        // Stop polling and say so, rather than hammering a failing endpoint
        // every 5s or (worse) leaving a stale run on screen as if it were live.
        // The last good snapshot stays rendered UNDER the banner so the
        // operator keeps the context, and Retry re-arms the loop — one blip
        // must not strand a long fleet run behind a dead panel.
        setError(
          err instanceof Error && err.message
            ? err.message
            : t('longTail.fleet.RunProgress.errors.loadFailed')
        );
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    setIsLoading(true);
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, retryToken, t]);

  const terminal = run ? isTerminalRunStatus(run.status) : false;

  return (
    <div
      data-testid="run-progress"
      className="flex h-full flex-col border-l bg-card text-card-foreground"
    >
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('longTail.fleet.RunProgress.heading')}</h2>
          {run && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                data-testid="run-progress-status"
                className={cn(
                  'rounded-full px-2 py-0.5 font-medium',
                  RUN_STATUS_CHIP_CLASSES[run.status] ?? 'bg-muted text-muted-foreground'
                )}
              >
                {t(/* i18n-dynamic */ RUN_STATUS_LABEL_KEYS[run.status])}
              </span>
              <span>{run.commandType ?? run.actionKind}</span>
              <span>{formatRelativeTime(new Date(run.startedAt ?? run.createdAt))}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="run-progress-close"
          aria-label={t('actions.close')}
          className="rounded-md border p-1.5 text-muted-foreground transition-colors hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && !run && (
          <div className="flex items-center justify-center p-10" data-testid="run-progress-loading">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div
            className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
            data-testid="run-progress-error"
          >
            <div className="flex flex-wrap items-center gap-2 text-destructive">
              <XCircle className="h-4 w-4 shrink-0" />
              <span className="text-sm font-medium">{error}</span>
              <button
                type="button"
                data-testid="run-progress-retry"
                onClick={() => setRetryToken((v) => v + 1)}
                className="ml-auto flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs transition-colors hover:bg-destructive/10"
              >
                <RefreshCw className="h-3 w-3" />
                {t('actions.retry')}
              </button>
            </div>
          </div>
        )}

        {run && (
          <div className="space-y-4">
            <p data-testid="run-progress-summary" className="text-sm text-muted-foreground">
              {t('longTail.fleet.RunProgress.counts', {
                succeeded: formatNumber(run.succeededCount),
                failed: formatNumber(run.failedCount),
                skipped: formatNumber(run.skippedCount),
                targets: formatNumber(run.targetCount),
              })}
            </p>

            {!terminal && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('longTail.fleet.RunProgress.polling')}
              </p>
            )}

            {run.targets.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="run-progress-empty">
                {t('longTail.fleet.RunProgress.targetsEmpty')}
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {run.targets.map((target) => {
                  const skipKey = skipReasonLabelKey(target.skipReason);
                  const detail = target.skipReason
                    ? skipKey
                      ? t(/* i18n-dynamic */ skipKey)
                      : target.skipReason
                    : target.resultSummary
                      ? truncate(target.resultSummary)
                      : null;
                  return (
                    <li
                      key={target.deviceId}
                      data-testid={`run-progress-target-${target.deviceId}`}
                      className="flex items-start gap-3 p-2 text-sm"
                    >
                      <span
                        className={cn(
                          'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                          TARGET_STATUS_CHIP_CLASSES[target.status] ?? 'bg-muted text-muted-foreground'
                        )}
                      >
                        {t(/* i18n-dynamic */ TARGET_STATUS_LABEL_KEYS[target.status])}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {target.hostname ?? target.deviceId}
                        </span>
                        {detail && (
                          <span
                            data-testid={`run-progress-summary-${target.deviceId}`}
                            className="block break-words text-xs text-muted-foreground"
                          >
                            {detail}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
