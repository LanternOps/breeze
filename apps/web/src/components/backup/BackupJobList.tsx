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

type JobStatus = 'completed' | 'running' | 'failed' | 'queued';

type BackupJob = {
  id: string;
  device: string;
  config: string;
  type: string;
  status: JobStatus;
  started: string;
  duration: string;
  size: string;
  errors: string;
  progress?: number;
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
  }
};

const normalizeStatus = (status?: string): JobStatus => {
  if (!status) {
    return 'queued';
  }
  const normalized = status.toLowerCase();
  if (normalized.includes('run') || normalized.includes('progress')) {
    return 'running';
  }
  if (normalized.includes('complete') || normalized.includes('success')) {
    return 'completed';
  }
  if (normalized.includes('fail') || normalized.includes('error')) {
    return 'failed';
  }
  if (normalized.includes('queue') || normalized.includes('pending')) {
    return 'queued';
  }
  return 'queued';
};

export default function BackupJobList() {
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
  const [configFilter, setConfigFilter] = useState('all');
  const [timeRange, setTimeRange] = useState('24h');

  const fetchJobs = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/backup/jobs');
      if (!response.ok) {
        throw new Error('Failed to fetch backup jobs');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      const nextJobs = Array.isArray(data) ? data : [];

      setJobs(
        nextJobs.map((job: BackupJob) => ({
          ...job,
          status: normalizeStatus(job.status),
          errors: job.errors ?? '-'
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const availableConfigs = useMemo(() => {
    const unique = new Set(jobs.map((job) => job.config).filter(Boolean));
    return Array.from(unique);
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesQuery = normalizedQuery
        ? job.device.toLowerCase().includes(normalizedQuery)
        : true;
      const matchesStatus = statusFilter === 'all' ? true : job.status === statusFilter;
      const matchesConfig = configFilter === 'all' ? true : job.config === configFilter;
      const matchesTimeRange = timeRange ? true : true;
      return matchesQuery && matchesStatus && matchesConfig && matchesTimeRange;
    });
  }, [configFilter, jobs, query, statusFilter, timeRange]);

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

      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm md:grid-cols-4">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            className="w-full bg-transparent text-sm outline-none"
            placeholder="Search device..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            className="w-full bg-transparent text-sm outline-none"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as JobStatus | 'all')}
          >
            <option value="all">All status</option>
            <option value="running">Running</option>
            <option value="failed">Failed</option>
            <option value="completed">Completed</option>
            <option value="queued">Queued</option>
          </select>
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-sm">
          <select
            className="w-full bg-transparent text-sm outline-none"
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
        <div className="rounded-md border bg-background px-3 py-2 text-sm">
          <select
            className="w-full bg-transparent text-sm outline-none"
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value)}
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="w-full">
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
                  No backup jobs found.
                </td>
              </tr>
            ) : (
              filteredJobs.map((job) => {
                const status = statusConfig[job.status];
                const StatusIcon = status.icon;
                return (
                  <tr key={job.id} className="text-sm text-foreground">
                    <td className="px-4 py-3 font-medium">{job.device}</td>
                    <td className="px-4 py-3 text-muted-foreground">{job.config}</td>
                    <td className="px-4 py-3 text-muted-foreground">{job.type}</td>
                    <td className="px-4 py-3">
                      <div className="space-y-2">
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
                        {job.status === 'running' && (
                          <div className="h-1.5 w-24 rounded-full bg-muted">
                            <div
                              className="h-1.5 rounded-full bg-primary"
                              style={{ width: `${job.progress ?? 0}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{job.started ?? '--'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{job.duration ?? '--'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{job.size ?? '--'}</td>
                    <td className="px-4 py-3">
                      {job.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {job.errors}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{job.errors}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {job.status === 'running' && (
                          <button className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent">
                            <PauseCircle className="h-3.5 w-3.5" />
                            Cancel
                          </button>
                        )}
                        <button className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10">
                          View details
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
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
