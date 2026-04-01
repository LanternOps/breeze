import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  PauseCircle,
  RefreshCw,
  Server,
  XCircle,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatBytes, formatDuration, formatTime } from './backupDashboardHelpers';

type BackupJobRecord = {
  id: string;
  type: string;
  deviceId: string;
  configId?: string | null;
  deviceName?: string | null;
  configName?: string | null;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  totalSize?: number | null;
  errorCount?: number | null;
  errorLog?: string | null;
};

function normalizeStatus(status?: string): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  const value = `${status ?? ''}`.toLowerCase();
  if (value === 'running' || value.includes('progress')) return 'running';
  if (value === 'completed' || value.includes('success') || value.includes('complete')) return 'completed';
  if (value === 'failed' || value.includes('fail') || value.includes('error')) return 'failed';
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  return 'queued';
}

const statusConfig = {
  queued: {
    icon: Clock3,
    className: 'text-muted-foreground bg-muted',
    label: 'Queued',
  },
  running: {
    icon: Loader2,
    className: 'text-primary bg-primary/10',
    label: 'Running',
  },
  completed: {
    icon: CheckCircle2,
    className: 'text-success bg-success/10',
    label: 'Completed',
  },
  failed: {
    icon: XCircle,
    className: 'text-destructive bg-destructive/10',
    label: 'Failed',
  },
  cancelled: {
    icon: XCircle,
    className: 'text-muted-foreground bg-muted',
    label: 'Cancelled',
  },
} as const;

export default function BackupJobProgress() {
  const [jobs, setJobs] = useState<BackupJobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      setError(undefined);
      const response = await fetchWithAuth('/backup/jobs');
      if (!response.ok) {
        throw new Error('Failed to fetch backup jobs');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setJobs(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch backup jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
  }, [fetchJobs]);

  const focusJob = useMemo(() => {
    const active = jobs.find((job) => {
      const status = normalizeStatus(job.status);
      return status === 'running' || status === 'queued';
    });
    return active ?? jobs[0] ?? null;
  }, [jobs]);

  useEffect(() => {
    if (!focusJob) return;
    const status = normalizeStatus(focusJob.status);
    if (!['queued', 'running'].includes(status)) return;
    const timer = window.setInterval(() => {
      void fetchJobs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [fetchJobs, focusJob]);

  const handleCancel = useCallback(async () => {
    if (!focusJob) return;
    try {
      setCancellingId(focusJob.id);
      setError(undefined);
      const response = await fetchWithAuth(`/backup/jobs/${focusJob.id}/cancel`, {
        method: 'POST',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? 'Failed to cancel backup job');
      }
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel backup job');
    } finally {
      setCancellingId(null);
    }
  }, [fetchJobs, focusJob]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading backup jobs...</p>
        </div>
      </div>
    );
  }

  if (!focusJob && !error) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Backup Job Progress</h2>
          <p className="text-sm text-muted-foreground">
            Live monitor for queued and running backup operations.
          </p>
        </div>
        <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          No active backup jobs right now.
        </div>
      </div>
    );
  }

  const status = normalizeStatus(focusJob?.status);
  const statusMeta = statusConfig[status];
  const StatusIcon = statusMeta.icon;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Backup Job Progress</h2>
          <p className="text-sm text-muted-foreground">
            Live monitor for queued and running backup operations.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchJobs()}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {focusJob ? (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className={cn('flex h-12 w-12 items-center justify-center rounded-full', statusMeta.className)}>
                <StatusIcon className={cn('h-6 w-6', status === 'running' && 'animate-spin')} />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {focusJob.deviceName ?? focusJob.deviceId?.slice(0, 8) ?? '--'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Config: {focusJob.configName ?? focusJob.configId ?? '--'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium', statusMeta.className)}>
                <StatusIcon className={cn('h-3.5 w-3.5', status === 'running' && 'animate-spin')} />
                {statusMeta.label}
              </span>
              {(status === 'queued' || status === 'running') ? (
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  disabled={cancellingId === focusJob.id}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-60"
                >
                  {cancellingId === focusJob.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PauseCircle className="h-4 w-4" />
                  )}
                  Cancel job
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Started</p>
              <p className="mt-2 text-sm font-semibold text-foreground">{formatTime(focusJob.startedAt ?? focusJob.createdAt)}</p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Duration</p>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {formatDuration(focusJob.startedAt ?? focusJob.createdAt, focusJob.completedAt)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Data Size</p>
              <p className="mt-2 text-sm font-semibold text-foreground">{formatBytes(focusJob.totalSize ?? 0)}</p>
            </div>
            <div className="rounded-md border bg-muted/20 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Errors</p>
              <p className="mt-2 text-sm font-semibold text-foreground">{focusJob.errorCount ?? 0}</p>
            </div>
          </div>

          {focusJob.errorLog ? (
            <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Latest job message</p>
                  <p className="mt-1 text-xs leading-5">{focusJob.errorLog}</p>
                </div>
              </div>
            </div>
          ) : status === 'running' ? (
            <div className="mt-4 rounded-md border border-dashed bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              This view shows live status, timings, and error output. Byte-level progress telemetry is not currently emitted by the backup agent.
            </div>
          ) : null}

          <div className="mt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Queued / running jobs</p>
            <div className="mt-2 space-y-2">
              {jobs.filter((job) => {
                const jobStatus = normalizeStatus(job.status);
                return jobStatus === 'queued' || jobStatus === 'running';
              }).length === 0 ? (
                <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  No other active jobs.
                </div>
              ) : (
                jobs
                  .filter((job) => {
                    const jobStatus = normalizeStatus(job.status);
                    return jobStatus === 'queued' || jobStatus === 'running';
                  })
                  .map((job) => (
                    <div key={job.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <Server className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium text-foreground">
                          {job.deviceName ?? job.deviceId?.slice(0, 8) ?? '--'}
                        </span>
                        <span className="text-muted-foreground">{job.configName ?? job.configId ?? '--'}</span>
                      </div>
                      <span className="text-muted-foreground">{statusConfig[normalizeStatus(job.status)].label}</span>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
