import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Filter,
  Loader2,
  PauseCircle,
  Search,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { formatNumber } from '@/lib/i18n/format';
import { useTranslation } from 'react-i18next';
import { i18n } from '@/lib/i18n';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type JobStatus = 'completed' | 'running' | 'failed' | 'queued' | 'cancelled';

type BackupJobRaw = {
  id: string;
  type: string;
  deviceId: string;
  configId: string;
  deviceName?: string | null;
  configName?: string | null;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  totalSize?: number | null;
  transferredSize?: number | null;
  referencedSize?: number | null;
  referencedFiles?: number | null;
  fileCount?: number | null;
  totalFiles?: number | null;
  lastProgressAt?: string | null;
  errorCount?: number | null;
  errorLog?: string | null;
  policyId?: string | null;
  featureLinkId?: string | null;
  snapshotId?: string | null;
  updatedAt?: string | null;
};

type BackupJob = {
  id: string;
  deviceName: string;
  configName: string;
  type: string;
  status: JobStatus;
  startedAt: string | null;
  completedAt: string | null;
  duration: string;
  size: string;
  errorCount: number;
  errorSummary: string;
  // Live-progress fields (running rows). null when the agent never reported
  // progress (legacy agent) — the UI falls back to an indeterminate bar.
  transferredSize: number | null;
  totalSizeBytes: number | null;
  fileCount: number | null;
  totalFiles: number | null;
  lastProgressAt: string | null;
};

// Poll the jobs list while any job is running so progress/speed stay live.
const POLL_MS = 5000;
// A running job with no progress update for this long is flagged as stalled.
const STALL_MS = 2 * 60 * 1000;
// Statuses a job can no longer leave — used to reconcile optimistic cancels
// against a possibly-stale poll response.
const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

type BackupJobDetails = BackupJobRaw & {
  deviceName?: string | null;
  configName?: string | null;
};

const statusConfig: Record<JobStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    className: 'text-success bg-success/10'
  },
  running: {
    label: 'Running',
    icon: Loader2,
    className: 'text-primary bg-primary/10'
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className: 'text-destructive bg-destructive/10'
  },
  queued: {
    label: 'Queued',
    icon: Clock,
    className: 'text-muted-foreground bg-muted'
  },
  cancelled: {
    label: 'Cancelled',
    icon: XCircle,
    className: 'text-muted-foreground bg-muted'
  }
};

function normalizeStatus(status?: string): JobStatus {
  if (!status) return 'queued';
  const s = status.toLowerCase();
  if (s === 'running' || s.includes('progress')) return 'running';
  if (s === 'completed' || s.includes('success') || s.includes('complete')) return 'completed';
  if (s === 'failed' || s.includes('fail') || s.includes('error')) return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'pending' || s.includes('queue')) return 'queued';
  return 'queued';
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${formatNumber(value, { minimumFractionDigits: precision, maximumFractionDigits: precision })} ${units[unitIndex]}`;
}

function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return '--';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '--';

  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(end)) return '--';

  const diffMs = Math.max(0, end - start);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTime(iso?: string | null): string {
  return formatDateTime(iso, {
    fallback: '--',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function mapJob(raw: BackupJobRaw): BackupJob {
  return {
    id: raw.id,
    deviceName: raw.deviceName ?? raw.deviceId?.slice(0, 8) ?? '--',
    configName: raw.configName ?? '--',
    type: raw.type ?? '--',
    status: normalizeStatus(raw.status),
    startedAt: raw.startedAt ?? null,
    completedAt: raw.completedAt ?? null,
    duration: formatDuration(raw.startedAt, raw.completedAt),
    size: raw.totalSize ? formatBytes(raw.totalSize) : '--',
    transferredSize: raw.transferredSize ?? null,
    totalSizeBytes: raw.totalSize ?? null,
    fileCount: raw.fileCount ?? null,
    totalFiles: raw.totalFiles ?? null,
    lastProgressAt: raw.lastProgressAt ?? null,
    errorCount: raw.errorCount ?? 0,
    errorSummary: raw.errorLog
      ? raw.errorLog.length > 60
        ? `${raw.errorLog.slice(0, 57)}...`
        : raw.errorLog
      : raw.errorCount
        ? i18n.t('backup:backupJobList.errorCount', { count: raw.errorCount })
        : '-'
  };
}

export default function BackupJobList() {
  const { t } = useTranslation('backup');
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
  const [configFilter, setConfigFilter] = useState('all');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [loadingDetailsId, setLoadingDetailsId] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<Record<string, BackupJobDetails>>({});
  // Transfer speed (bytes/sec) per running job, derived from consecutive poll
  // samples. Samples persist across renders in a ref; the derived speed lives in
  // state so the row re-renders when it changes.
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const speedSamplesRef = useRef<Map<string, { bytes: number; at: number }>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Jobs the user just cancelled (id -> timestamp). A poll GET already in flight
  // when the cancel POST lands would otherwise revert the row to running; we keep
  // the local terminal status until the server confirms a terminal status too.
  // Entries expire after ~2 poll intervals as a safety net.
  const recentlyCancelledRef = useRef<Map<string, number>>(new Map());

  const fetchJobs = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/jobs');
      if (!response.ok) {
        throw new Error('Failed to fetch backup jobs');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      const now = Date.now();

      // Reconcile against recently-cancelled jobs before anything else so a stale
      // poll can't resurrect a job the user just stopped, and expire old entries.
      const cancelled = recentlyCancelledRef.current;
      for (const [id, at] of cancelled) {
        if (now - at > POLL_MS * 2) cancelled.delete(id);
      }
      const nextJobs = (Array.isArray(data) ? data : []).map(mapJob).map((job) => {
        if (!cancelled.has(job.id)) return job;
        if (TERMINAL_STATUSES.includes(job.status)) {
          // Server agrees the job has ended — accept its truth and stop overriding.
          cancelled.delete(job.id);
          return job;
        }
        return { ...job, status: 'cancelled' as JobStatus };
      });

      // Derive transfer speed from the delta since the previous sample. The
      // running-average fallback fires ONLY when there is no prior sample; once a
      // sample exists, a zero/negative delta (a stalled job) yields no speed at
      // all rather than a misleading average. A fresh nextSpeeds map each refresh
      // means a stalled job's previously shown speed is cleared automatically.
      const nextSpeeds: Record<string, number> = {};
      const samples = speedSamplesRef.current;
      const seen = new Set<string>();
      for (const job of nextJobs) {
        if (job.status !== 'running' || job.transferredSize == null) continue;
        seen.add(job.id);
        const prev = samples.get(job.id);
        let bps: number | undefined;
        if (prev) {
          if (now > prev.at && job.transferredSize > prev.bytes) {
            bps = (job.transferredSize - prev.bytes) / ((now - prev.at) / 1000);
          }
          // prior sample but no forward progress -> stalled -> leave bps unset.
        } else if (job.startedAt) {
          const elapsedSec = (now - new Date(job.startedAt).getTime()) / 1000;
          if (elapsedSec > 0) bps = job.transferredSize / elapsedSec;
        }
        if (bps != null && Number.isFinite(bps) && bps > 0) {
          nextSpeeds[job.id] = bps;
        }
        samples.set(job.id, { bytes: job.transferredSize, at: now });
      }
      // Drop samples for jobs no longer running so the map can't grow unbounded.
      for (const id of samples.keys()) {
        if (!seen.has(id)) samples.delete(id);
      }

      setSpeeds(nextSpeeds);
      setJobs(nextJobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Poll while any job is running so live progress and speed keep updating.
  const hasRunning = useMemo(() => jobs.some((job) => job.status === 'running'), [jobs]);
  useEffect(() => {
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void fetchJobs();
      }, POLL_MS);
    } else if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasRunning, fetchJobs]);

  const handleCancel = useCallback(async (jobId: string) => {
    // Mark as recently-cancelled up front so even a poll GET that was already in
    // flight when this POST resolves gets reconciled to the terminal status.
    recentlyCancelledRef.current.set(jobId, Date.now());
    setCancellingId(jobId);
    try {
      // runAction surfaces every failure (including HTTP-200 {success:false})
      // and returns the parsed success body. The cancel route additionally
      // returns HTTP 200 with a `warning` field when the job was marked
      // cancelled but the stop signal could NOT be delivered to the agent — a
      // partial success runAction treats as success, so we inspect the body and
      // surface the warning ourselves. Without this the user sees a clean
      // "Cancelled" row while the device may still be uploading.
      const result = await runAction<{ warning?: string } | null>({
        request: () => fetchWithAuth(`/backup/jobs/${jobId}/cancel`, { method: 'POST' }),
        errorFallback: 'Failed to cancel job',
        onUnauthorized: UNAUTHORIZED,
      });
      setJobs((prev) =>
        prev.map((job) =>
          job.id === jobId ? { ...job, status: 'cancelled' as JobStatus } : job
        )
      );
      const warning = result && typeof result === 'object' ? result.warning : undefined;
      if (typeof warning === 'string' && warning.length > 0) {
        showToast({ message: warning, type: 'warning' });
      }
    } catch (err) {
      // The cancel failed — stop overriding the server's view of this job.
      // runAction already toasted non-401 ActionErrors; handleActionError toasts
      // network failures and lets the auth redirect handle 401s.
      recentlyCancelledRef.current.delete(jobId);
      handleActionError(err, 'Failed to cancel job');
    } finally {
      setCancellingId(null);
    }
  }, []);

  const handleToggleDetails = useCallback(async (jobId: string) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      return;
    }

    if (jobDetails[jobId]) {
      setExpandedJobId(jobId);
      return;
    }

    try {
      setLoadingDetailsId(jobId);
      setError(undefined);
      const response = await fetchWithAuth(`/backup/jobs/${jobId}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to fetch backup job details');
      }

      const payload = await response.json();
      setJobDetails((prev) => ({
        ...prev,
        [jobId]: payload,
      }));
      setExpandedJobId(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch backup job details');
    } finally {
      setLoadingDetailsId(null);
    }
  }, [expandedJobId, jobDetails]);

  const availableConfigs = useMemo(() => {
    const unique = new Set(jobs.map((job) => job.configName).filter((c) => c && c !== '--'));
    return Array.from(unique);
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesQuery = normalizedQuery
        ? job.deviceName.toLowerCase().includes(normalizedQuery) ||
          job.configName.toLowerCase().includes(normalizedQuery)
        : true;
      const matchesStatus = statusFilter === 'all' ? true : job.status === statusFilter;
      const matchesConfig = configFilter === 'all' ? true : job.configName === configFilter;
      return matchesQuery && matchesStatus && matchesConfig;
    });
  }, [configFilter, jobs, query, statusFilter]);

  // Only take over the whole view on the initial load. Poll-triggered refreshes
  // set `loading` too, but must not blank an already-rendered table.
  if (loading && jobs.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('backupJobList.loadingBackupJobs')}</p>
        </div>
      </div>
    );
  }

  if (error && jobs.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchJobs}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('backupJobList.tryAgain')} </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('backupJobList.backupJobs')}</h2>
        <p className="text-sm text-muted-foreground">{t('backupJobList.trackJobExecutionStatusAndTroubleshootErrors')}</p>
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-xs md:grid-cols-3">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="job-search" className="sr-only">{t('backupJobList.searchDevice')}</label>
          <input
            id="job-search"
            className="w-full bg-transparent text-sm outline-hidden"
            placeholder={t('backupJobList.searchDevice2')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Filter className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="job-status-filter" className="sr-only">{t('backupJobList.filterByStatus')}</label>
          <select
            id="job-status-filter"
            className="w-full appearance-none bg-transparent text-sm outline-hidden"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as JobStatus | 'all')}
          >
            <option value="all">{t('backupJobList.allStatus')}</option>
            <option value="running">{t('backupJobList.running')}</option>
            <option value="failed">{t('backupJobList.failed')}</option>
            <option value="completed">{t('backupJobList.completed')}</option>
            <option value="queued">{t('backupJobList.queued')}</option>
            <option value="cancelled">{t('backupJobList.cancelled')}</option>
          </select>
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-sm">
          <label htmlFor="job-config-filter" className="sr-only">{t('backupJobList.filterByConfig')}</label>
          <select
            id="job-config-filter"
            className="w-full appearance-none bg-transparent text-sm outline-hidden"
            value={configFilter}
            onChange={(event) => setConfigFilter(event.target.value)}
          >
            <option value="all">{t('backupJobList.allConfigs')}</option>
            {availableConfigs.map((config) => (
              <option key={config} value={config}>
                {config}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
        <table className="w-full min-w-[700px]">
          <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">{t('backupJobList.device')}</th>
              <th className="px-4 py-3">{t('backupJobList.config')}</th>
              <th className="px-4 py-3">{t('backupJobList.type')}</th>
              <th className="px-4 py-3">{t('backupJobList.status')}</th>
              <th className="px-4 py-3">{t('backupJobList.started')}</th>
              <th className="px-4 py-3">{t('backupJobList.duration')}</th>
              <th className="px-4 py-3">{t('backupJobList.size')}</th>
              <th className="px-4 py-3">{t('backupJobList.errors')}</th>
              <th className="px-4 py-3 text-right">{t('backupJobList.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('backupJobList.noBackupJobsMatchYourFilters')} </td>
              </tr>
            ) : (
              filteredJobs.map((job) => {
                const status = statusConfig[job.status] ?? statusConfig.queued;
                const StatusIcon = status.icon;
                const isCancellable = job.status === 'running' || job.status === 'queued';
                const isRunning = job.status === 'running';
                // Percent only when totals are known; otherwise indeterminate.
                const hasTotal = isRunning && (job.totalSizeBytes ?? 0) > 0;
                const percent = hasTotal
                  ? Math.min(100, ((job.transferredSize ?? 0) / (job.totalSizeBytes as number)) * 100)
                  : null;
                const speedBps = isRunning ? speeds[job.id] : undefined;
                const showFiles = isRunning && job.fileCount != null && job.totalFiles != null;
                const stalledMs = isRunning && job.lastProgressAt
                  ? Date.now() - new Date(job.lastProgressAt).getTime()
                  : 0;
                const isStalled = isRunning && !!job.lastProgressAt && stalledMs > STALL_MS;
                const stalledMinutes = Math.max(1, Math.floor(stalledMs / 60000));
                const details = jobDetails[job.id];
                const isExpanded = expandedJobId === job.id;
                const isLoadingDetails = loadingDetailsId === job.id;
                return (
                  <Fragment key={job.id}>
                    <tr key={job.id} className="text-sm text-foreground">
                      <td className="px-4 py-3 font-medium">{job.deviceName}</td>
                      <td className="px-4 py-3 text-muted-foreground">{job.configName}</td>
                      <td className="px-4 py-3 capitalize text-muted-foreground">{job.type}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
                              status.className
                            )}
                          >
                            <StatusIcon
                              className={cn('h-3.5 w-3.5', job.status === 'running' && 'animate-spin')}
                            />
                            {status.label}
                          </span>
                          {isStalled && (
                            <span
                              data-testid="backup-job-stalled"
                              title={t('backupJobList.stalledTooltip', { minutes: stalledMinutes })}
                              className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-xs font-medium text-warning"
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {t('backupJobList.stalled')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatTime(job.startedAt)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{job.duration}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {isRunning ? (
                          <div className="min-w-[140px] space-y-1">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn(
                                  'h-full rounded-full bg-primary',
                                  percent == null && 'w-1/3 animate-pulse'
                                )}
                                style={percent == null ? undefined : { width: `${percent}%` }}
                              />
                            </div>
                            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                              {percent != null && (
                                <span>{`${formatNumber(percent, { maximumFractionDigits: 0 })}%`}</span>
                              )}
                              {showFiles && (
                                <span>
                                  {t('backupJobList.filesProgress', {
                                    done: job.fileCount,
                                    total: job.totalFiles,
                                  })}
                                </span>
                              )}
                              {speedBps != null && (
                                <span>{t('backupJobList.speedValue', { value: formatBytes(speedBps) })}</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          job.size
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {job.errorCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {job.errorSummary}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {isCancellable && (
                            <button
                              type="button"
                              onClick={() => handleCancel(job.id)}
                              disabled={cancellingId === job.id}
                              aria-label={`Stop backup for ${job.deviceName}`}
                              className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                            >
                              {cancellingId === job.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <PauseCircle className="h-3.5 w-3.5" />
                              )}
                              {t('backupJobList.stop')} </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleToggleDetails(job.id)}
                            disabled={isLoadingDetails}
                            aria-label={`${isExpanded ? 'Hide' : 'View'} details for ${job.deviceName} backup`}
                            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                          >
                            {isLoadingDetails ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')} />
                            )}
                            {isExpanded ? 'Hide details' : 'View details'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && details && (
                      <tr className="bg-muted/20 text-sm">
                        <td colSpan={9} className="px-4 py-4">
                          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('backupJobList.created')}</p>
                              <p className="mt-1 text-foreground">{formatTime(details.createdAt)}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('backupJobList.updated')}</p>
                              <p className="mt-1 text-foreground">{formatTime(details.updatedAt)}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('backupJobList.files')}</p>
                              <p className="mt-1 text-foreground">{details.fileCount ?? 0}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('backupJobList.snapshotId')}</p>
                              <p className="mt-1 break-all text-foreground">{details.snapshotId ?? '--'}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('backupJobList.policyId')}</p>
                              <p className="mt-1 break-all text-foreground">{details.policyId ?? '--'}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('backupJobList.featureLinkId')}</p>
                              <p className="mt-1 break-all text-foreground">{details.featureLinkId ?? '--'}</p>
                            </div>
                          </div>
                          {job.status === 'completed' && details.referencedSize != null && (
                            <p
                              data-testid="backup-job-savings"
                              className="mt-4 text-xs text-muted-foreground"
                            >
                              {t('backupJobList.savings', {
                                protected: formatBytes(details.totalSize ?? 0),
                                uploaded: formatBytes(Math.max(0, (details.totalSize ?? 0) - details.referencedSize)),
                              })}
                            </p>
                          )}
                          <div className="mt-4">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('backupJobList.errorLog')}</p>
                            <pre className="mt-1 whitespace-pre-wrap rounded-md border bg-background px-3 py-2 text-xs text-foreground">
                              {details.errorLog ?? 'No error log recorded.'}
                            </pre>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
