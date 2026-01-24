import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  PlayCircle,
  AlertTriangle,
  CheckCircle,
  PauseCircle,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type PatchJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused';

export type PatchJob = {
  id: string;
  name: string;
  status: PatchJobStatus;
  startedAt: string;
  completedAt?: string;
  devicesTotal: number;
  devicesPatched: number;
  devicesFailed: number;
};

type PatchJobListProps = {
  pageSize?: number;
  onSelect?: (job: PatchJob) => void;
};

const POLL_INTERVAL_MS = 15000;

const statusConfig: Record<PatchJobStatus, { label: string; color: string; icon: typeof PlayCircle }> = {
  queued: { label: 'Queued', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: PlayCircle },
  running: { label: 'Running', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: PlayCircle },
  completed: { label: 'Completed', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: AlertTriangle },
  paused: { label: 'Paused', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: PauseCircle }
};

const statusMap: Record<string, PatchJobStatus> = {
  queued: 'queued',
  pending: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  paused: 'paused',
  cancelled: 'paused'
};

function formatDate(dateString?: string): string {
  if (!dateString) return '—';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeStatus(value?: string): PatchJobStatus {
  if (!value) return 'queued';
  return statusMap[value.toLowerCase()] ?? 'queued';
}

function normalizeJob(raw: Record<string, unknown>, index: number): PatchJob {
  const id = raw.id ?? raw.jobId ?? raw.job_id ?? `job-${index}`;
  const name = raw.name ?? raw.title ?? raw.label ?? 'Patch deployment';
  const status = normalizeStatus(raw.status ? String(raw.status) : undefined);
  const startedAt = raw.startedAt ?? raw.started_at ?? raw.createdAt ?? raw.created_at ?? '';
  const completedAt = raw.completedAt ?? raw.completed_at ?? raw.finishedAt ?? raw.finished_at;

  return {
    id: String(id),
    name: String(name),
    status,
    startedAt: String(startedAt),
    completedAt: completedAt ? String(completedAt) : undefined,
    devicesTotal: toNumber(raw.devicesTotal ?? raw.deviceTotal ?? raw.totalDevices ?? raw.devices_total),
    devicesPatched: toNumber(raw.devicesPatched ?? raw.devicesCompleted ?? raw.completedDevices ?? raw.devices_patched),
    devicesFailed: toNumber(raw.devicesFailed ?? raw.failedDevices ?? raw.devices_failed)
  };
}

export default function PatchJobList({ pageSize = 8, onSelect }: PatchJobListProps) {
  const [jobs, setJobs] = useState<PatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const fetchJobs = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) {
        setLoading(true);
        setError(undefined);
      }

      const response = await fetch('/api/patches/jobs');
      if (!response.ok) {
        throw new Error('Failed to fetch patch jobs');
      }

      const data = await response.json();
      const jobData = data.data ?? data.jobs ?? data.items ?? data ?? [];
      const normalized = Array.isArray(jobData)
        ? jobData.map((job: Record<string, unknown>, index: number) => normalizeJob(job, index))
        : [];
      setJobs(normalized);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch patch jobs');
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(() => {
      fetchJobs(false);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchJobs]);

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return jobs.filter(job => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : job.name.toLowerCase().includes(normalizedQuery) || job.id.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : job.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [jobs, query, statusFilter]);

  const totalPages = Math.ceil(filteredJobs.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedJobs = filteredJobs.slice(startIndex, startIndex + pageSize);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading patch jobs...</p>
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
          onClick={() => fetchJobs()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Deployment Jobs</h2>
          <p className="text-sm text-muted-foreground">
            {filteredJobs.length} of {jobs.length} jobs
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search jobs..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Status</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="paused">Paused</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Job</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Devices</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Completed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedJobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No jobs found. Try adjusting your search.
                </td>
              </tr>
            ) : (
              paginatedJobs.map(job => {
                const status = statusConfig[job.status];
                const StatusIcon = status.icon;
                const progress = job.devicesTotal > 0 ? Math.round((job.devicesPatched / job.devicesTotal) * 100) : 0;

                return (
                  <tr key={job.id} className="text-sm">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onSelect?.(job)}
                        className="text-left text-sm font-medium text-foreground hover:text-primary"
                      >
                        {job.name}
                      </button>
                      <div className="text-xs text-muted-foreground">{job.id}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium', status.color)}>
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 rounded-full bg-muted">
                          <div className="h-2 rounded-full bg-primary" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground">{progress}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {job.devicesPatched}/{job.devicesTotal} patched
                      {job.devicesFailed > 0 && (
                        <span className="ml-2 text-xs text-destructive">{job.devicesFailed} failed</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(job.startedAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(job.completedAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
