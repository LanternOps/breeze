import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Clock, AlertTriangle, PlayCircle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

export type DiscoveryJobStatus = 'scheduled' | 'running' | 'completed' | 'failed';

type ApiJobStatus = 'queued' | 'running' | 'completed' | 'failed';

type ApiDiscoveryJob = {
  id: string;
  profileId?: string;
  profileName?: string;
  status: ApiJobStatus;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  results?: Array<{ assetId: string; status: string; assetType: string }>;
  progress?: number;
  hostsDiscovered?: number;
  hostsTargeted?: number;
};

export type DiscoveryJob = {
  id: string;
  profileName: string;
  status: DiscoveryJobStatus;
  progress: number;
  hostsDiscovered: number;
  hostsTargeted: number;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
};

const statusConfig: Record<DiscoveryJobStatus, { label: string; color: string; icon: typeof Clock }> = {
  scheduled: { label: 'Scheduled', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Clock },
  running: { label: 'Running', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: PlayCircle },
  completed: { label: 'Completed', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: AlertTriangle }
};

const statusMap: Record<ApiJobStatus, DiscoveryJobStatus> = {
  queued: 'scheduled',
  running: 'running',
  completed: 'completed',
  failed: 'failed'
};

function formatTimestamp(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function mapJob(job: ApiDiscoveryJob): DiscoveryJob {
  const status = statusMap[job.status] ?? 'scheduled';
  const discovered = job.hostsDiscovered ?? job.results?.length ?? 0;
  const targeted = job.hostsTargeted ?? Math.max(discovered, job.results?.length ?? 0);

  let progress = typeof job.progress === 'number'
    ? job.progress
    : status === 'completed' || status === 'failed'
      ? 100
      : status === 'running'
        ? 45
        : 0;

  if (status === 'running' && typeof job.progress !== 'number' && targeted > 0) {
    progress = Math.min(95, Math.round((discovered / targeted) * 100));
  }

  return {
    id: job.id,
    profileName: job.profileName ?? job.profileId ?? 'Unknown profile',
    status,
    progress,
    hostsDiscovered: discovered,
    hostsTargeted: targeted,
    scheduledAt: job.createdAt ?? '',
    startedAt: job.startedAt ?? undefined,
    finishedAt: job.completedAt ?? undefined
  };
}

export default function DiscoveryJobList() {
  const [jobs, setJobs] = useState<DiscoveryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchJobs = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(undefined);
      const response = await fetchWithAuth('/discovery/jobs');
      if (!response.ok) {
        throw new Error('Failed to fetch discovery jobs');
      }
      const data = await response.json();
      const items = data.data ?? data.jobs ?? data ?? [];
      setJobs(items.map(mapJob));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    const hasRunning = jobs.some(job => job.status === 'running' || job.status === 'scheduled');
    if (!hasRunning) return;

    const interval = setInterval(() => {
      fetchJobs(false);
    }, 10000);

    return () => clearInterval(interval);
  }, [fetchJobs, jobs]);

  if (loading && jobs.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading discovery jobs...</p>
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
      <div>
        <h2 className="text-lg font-semibold">Discovery Jobs</h2>
        <p className="text-sm text-muted-foreground">Track running and scheduled scans.</p>
      </div>

      {error && jobs.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Profile</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Hosts discovered</th>
              <th className="px-4 py-3">Scheduled</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Finished</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No discovery jobs yet.
                </td>
              </tr>
            ) : (
              jobs.map(job => {
                const status = statusConfig[job.status];
                const StatusIcon = status.icon;

                return (
                  <tr key={job.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm font-medium">{job.profileName}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${status.color}`}>
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${
                              job.status === 'failed' ? 'bg-red-500' : job.status === 'completed' ? 'bg-green-500' : 'bg-yellow-500'
                            }`}
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs">{job.progress}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {job.hostsDiscovered} / {job.hostsTargeted}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.scheduledAt)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.startedAt)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.finishedAt)}</td>
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
