import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  X,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
  Monitor,
  Terminal,
  Calendar,
  Timer
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatNumber } from '@/lib/i18n/format';

type ScriptsT = TFunction<'scripts'>;

export type DeviceRunResult = {
  deviceId: string;
  deviceName: string;
  status: 'pending' | 'success' | 'failed' | 'skipped' | 'running';
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  output?: string;
  error?: string;
};

/** Lazy loader for a run's per-device detail, fetched on expand (#2023). */
export type RunDetailLoader = (runId: string) => Promise<{
  deviceResults: DeviceRunResult[];
  logs?: string[];
} | null>;

export type AutomationRun = {
  id: string;
  automationId: string;
  automationName: string;
  triggeredBy: 'schedule' | 'event' | 'webhook' | 'manual' | 'api';
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'failed' | 'partial';
  devicesTotal: number;
  devicesSuccess: number;
  devicesFailed: number;
  devicesSkipped: number;
  deviceResults: DeviceRunResult[];
  logs?: string[];
};

type AutomationRunHistoryProps = {
  runs: AutomationRun[];
  isOpen: boolean;
  onClose: () => void;
  automationName?: string;
  timezone?: string;
  /** When provided, expanding a run lazily fetches its per-device breakdown. */
  onLoadRunDetail?: RunDetailLoader;
};

type StatusKey = 'running' | 'success' | 'failed' | 'partial' | 'skipped' | 'pending';
const statusConfig: Record<StatusKey, { label: string; color: string; bgColor: string; icon: typeof CheckCircle }> = {
  running: {
    label: 'status.running',
    color: 'text-blue-600',
    bgColor: 'bg-blue-500/20 border-blue-500/40',
    icon: Clock
  },
  pending: {
    label: 'status.pending',
    color: 'text-gray-500',
    bgColor: 'bg-gray-500/20 border-gray-500/40',
    icon: Clock
  },
  success: {
    label: 'status.success',
    color: 'text-green-600',
    bgColor: 'bg-green-500/20 border-green-500/40',
    icon: CheckCircle
  },
  failed: {
    label: 'status.failed',
    color: 'text-red-600',
    bgColor: 'bg-red-500/20 border-red-500/40',
    icon: XCircle
  },
  partial: {
    label: 'status.partial',
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-500/20 border-yellow-500/40',
    icon: AlertTriangle
  },
  skipped: {
    label: 'status.skipped',
    color: 'text-gray-600',
    bgColor: 'bg-gray-500/20 border-gray-500/40',
    icon: Clock
  }
};

const triggerLabels: Record<string, string> = {
  schedule: 'triggeredBy.scheduled',
  event: 'triggeredBy.event',
  webhook: 'triggeredBy.webhook',
  manual: 'triggeredBy.manual',
  api: 'triggeredBy.api'
};

function formatDate(dateString: string, timezone: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return formatDateTime(date, { timeZone: timezone });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatRelativeTime(dateString: string, timezone: string, t: ScriptsT): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return t('automationRunHistory.relativeTime.justNow');
  if (diffMins < 60) return t('automationRunHistory.relativeTime.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('automationRunHistory.relativeTime.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('automationRunHistory.relativeTime.daysAgo', { count: diffDays });
  return date.toLocaleDateString([], { timeZone: timezone });
}

function RunItem({
  run,
  timezone,
  onLoadRunDetail,
  t,
}: {
  run: AutomationRun;
  timezone: string;
  onLoadRunDetail?: RunDetailLoader;
  t: ScriptsT;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [detail, setDetail] = useState<{ deviceResults: DeviceRunResult[]; logs?: string[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);

  const isRunning = run.status === 'running';

  // Lazily load the per-device breakdown on first expand, and refresh it while
  // the run is still in progress (parent polling bumps the counts below, which
  // re-triggers this effect) so live progress stays current (#2023).
  useEffect(() => {
    if (!expanded || !onLoadRunDetail) return;
    let cancelled = false;
    setDetailLoading(true);
    onLoadRunDetail(run.id)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setDetail(result);
          setDetailError(false);
        } else {
          // A null result means the fetch failed (not "zero devices"); surface
          // it so an empty panel isn't mistaken for a successful empty load.
          setDetailError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when counts change (live progress) or the run terminates.
  }, [expanded, onLoadRunDetail, run.id, run.status, run.devicesSuccess, run.devicesFailed]);

  const deviceResults = detail?.deviceResults ?? run.deviceResults;
  const logs = detail?.logs ?? run.logs;

  const StatusIcon = statusConfig[run.status].icon;
  const duration = run.completedAt
    ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
    : null;

  const finishedCount = run.devicesSuccess + run.devicesFailed + run.devicesSkipped;
  const progressPct = run.devicesTotal > 0
    ? Math.min(100, Math.round((finishedCount / run.devicesTotal) * 100))
    : 0;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/40"
      >
        <div className="flex items-center gap-3">
          <StatusIcon className={cn('h-5 w-5', statusConfig[run.status].color)} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{formatRelativeTime(run.startedAt, timezone, t)}</span>
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                  statusConfig[run.status].bgColor,
                  statusConfig[run.status].color
                )}
              >
                {t(/* i18n-dynamic */ `automationRunHistory.${statusConfig[run.status].label}`)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(/* i18n-dynamic */ `automationRunHistory.${triggerLabels[run.triggeredBy]}`)} -{' '}
              {t('automationRunHistory.deviceCount', { count: run.devicesTotal })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-green-600">{t('automationRunHistory.resultCount.passed', { count: run.devicesSuccess })}</span>
              {run.devicesFailed > 0 && (
                <span className="text-red-600">{t('automationRunHistory.resultCount.failed', { count: run.devicesFailed })}</span>
              )}
              {run.devicesSkipped > 0 && (
                <span className="text-gray-500">{t('automationRunHistory.resultCount.skipped', { count: run.devicesSkipped })}</span>
              )}
            </div>
            {duration && (
              <p className="text-muted-foreground">{t('automationRunHistory.duration', { duration: formatDuration(duration) })}</p>
            )}
          </div>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Live progress bar — shown while a run is in progress (#2023). */}
      {isRunning && run.devicesTotal > 0 && (
        <div className="px-4 pb-3" data-testid="run-progress">
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {t('automationRunHistory.progress.finished', { finished: finishedCount, total: run.devicesTotal })}
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-blue-500 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {expanded && (
        <div className="border-t bg-muted/20 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h4 className="text-sm font-medium">{t('automationRunHistory.deviceResults.title')}</h4>
            {logs && logs.length > 0 && (
              <button
                type="button"
                onClick={() => setShowLogs(!showLogs)}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Terminal className="h-3 w-3" />
                {showLogs ? t('automationRunHistory.actions.hideLogs') : t('automationRunHistory.actions.viewLogs')}
              </button>
            )}
          </div>

          {showLogs && logs && logs.length > 0 && (
            <div className="mb-4 rounded-md bg-gray-900 p-3 text-xs font-mono text-gray-100 overflow-x-auto max-h-48 overflow-y-auto">
              {logs.map((log, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  {log}
                </div>
              ))}
            </div>
          )}

          {detailLoading && deviceResults.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('automationRunHistory.deviceResults.loading')}</p>
          )}

          {!detailLoading && deviceResults.length === 0 && detailError && (
            <p className="text-xs text-red-600">{t('automationRunHistory.deviceResults.error')}</p>
          )}

          {!detailLoading && deviceResults.length === 0 && !detailError && (
            <p className="text-xs text-muted-foreground">{t('automationRunHistory.deviceResults.empty')}</p>
          )}

          <div className="space-y-2">
            {deviceResults.map(result => {
              const DeviceStatusIcon = statusConfig[result.status].icon;
              return (
                <div
                  key={result.deviceId}
                  className="flex items-center justify-between rounded-md border bg-background p-3"
                >
                  <div className="flex items-center gap-3">
                    <Monitor className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{result.deviceName}</p>
                      {result.error && (
                        <p className="text-xs text-red-600">{result.error}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {result.duration && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Timer className="h-3 w-3" />
                        {formatDuration(result.duration)}
                      </span>
                    )}
                    <DeviceStatusIcon
                      className={cn('h-4 w-4', statusConfig[result.status].color)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {t('automationRunHistory.timestamps.started', { date: formatDate(run.startedAt, timezone) })}
            </div>
            {run.completedAt && (
              <div className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {t('automationRunHistory.timestamps.completed', { date: formatDate(run.completedAt, timezone) })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AutomationRunHistory({
  runs,
  isOpen,
  onClose,
  automationName,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  onLoadRunDetail
}: AutomationRunHistoryProps) {
  const { t } = useTranslation('scripts');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filteredRuns = useMemo(() => {
    if (statusFilter === 'all') return runs;
    return runs.filter(run => run.status === statusFilter);
  }, [runs, statusFilter]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-lg border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t('automationRunHistory.title')}</h2>
            {automationName && (
              <p className="text-sm text-muted-foreground">{automationName}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('automationRunHistory.summary', { shown: filteredRuns.length, total: runs.length })}
            </p>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('automationRunHistory.filters.allStatus')}</option>
              <option value="success">{t('automationRunHistory.status.success')}</option>
              <option value="failed">{t('automationRunHistory.status.failed')}</option>
              <option value="partial">{t('automationRunHistory.status.partial')}</option>
              <option value="running">{t('automationRunHistory.status.running')}</option>
            </select>
          </div>

          {filteredRuns.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center">
              <Clock className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {t('automationRunHistory.empty')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredRuns.map(run => (
                <RunItem key={run.id} run={run} timezone={timezone} onLoadRunDetail={onLoadRunDetail} t={t} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
