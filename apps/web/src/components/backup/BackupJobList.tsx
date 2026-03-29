import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { fetchWithAuth } from '../../stores/auth';

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
  fileCount?: number | null;
  errorCount?: number | null;
  errorLog?: string | null;
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
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
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
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString([], {
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
    errorCount: raw.errorCount ?? 0,
    errorSummary: raw.errorLog
      ? raw.errorLog.length > 60
        ? `${raw.errorLog.slice(0, 57)}...`
        : raw.errorLog
      : raw.errorCount
        ? `${raw.errorCount} error${raw.errorCount !== 1 ? 's' : ''}`
        : '-'
  };
}

export default function BackupJobList() {
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
  const [configFilter, setConfigFilter] = useState('all');
  const [cancellingId, setCancellingId] = useState<string | null>(null);

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
      const nextJobs = Array.isArray(data) ? data : [];
      setJobs(nextJobs.map(mapJob));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const handleCancel = useCallback(async (jobId: string) => {
    try {
      setCancellingId(jobId);
      const response = await fetchWithAuth(`/backup/jobs/${jobId}/cancel`, {
        method: 'POST'
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to cancel job');
      }
      setJobs((prev) =>
        prev.map((job) =>
          job.id === jobId ? { ...job, status: 'cancelled' as JobStatus } : job
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setCancellingId(null);
    }
  }, []);

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

  if (error && jobs.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchJobs}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Backup Jobs</h2>
        <p className="text-sm text-muted-foreground">Track job execution status and troubleshoot errors.</p>
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm md:grid-cols-3">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="job-search" className="sr-only">Search device</label>
          <input
            id="job-search"
            className="w-full bg-transparent text-sm outline-none"
            placeholder="Search device..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Filter className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <label htmlFor="job-status-filter" className="sr-only">Filter by status</label>
          <select
            id="job-status-filter"
            className="w-full appearance-none bg-transparent text-sm outline-none"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as JobStatus | 'all')}
          >
            <option value="all">All status</option>
            <option value="running">Running</option>
            <option value="failed">Failed</option>
            <option value="completed">Completed</option>
            <option value="queued">Queued</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-sm">
          <label htmlFor="job-config-filter" className="sr-only">Filter by config</label>
          <select
            id="job-config-filter"
            className="w-full appearance-none bg-transparent text-sm outline-none"
            value={configFilter}
            onChange={(event) => setConfigFilter(event.target.value)}
          >
            <option value="all">All configs</option>
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

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full min-w-[700px]">
          <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Config</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">Errors</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No backup jobs match your filters.
                </td>
              </tr>
            ) : (
              filteredJobs.map((job) => {
                const status = statusConfig[job.status] ?? statusConfig.queued;
                const StatusIcon = status.icon;
                const isCancellable = job.status === 'running' || job.status === 'queued';
                return (
                  <tr key={job.id} className="text-sm text-foreground">
                    <td className="px-4 py-3 font-medium">{job.deviceName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{job.configName}</td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{job.type}</td>
                    <td className="px-4 py-3">
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
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatTime(job.startedAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{job.duration}</td>
                    <td className="px-4 py-3 text-muted-foreground">{job.size}</td>
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
                            aria-label={`Cancel backup for ${job.deviceName}`}
                            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                          >
                            {cancellingId === job.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <PauseCircle className="h-3.5 w-3.5" />
                            )}
                            Cancel
                          </button>
                        )}
                        <a
                          href={`/backup/jobs/${job.id}`}
                          aria-label={`View details for ${job.deviceName} backup`}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
                        >
                          View details
                          <ChevronRight className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
