import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, Clock, AlertTriangle, PlayCircle, X, ArrowRight } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

export type DiscoveryJobStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

type ApiJobStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

type ApiDiscoveryJob = {
  id: string;
  profileId?: string;
  profileName?: string;
  status: ApiJobStatus;
  createdAt?: string;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  results?: Array<{ assetId: string; status: string; assetType: string }>;
  progress?: number;
  hostsDiscovered?: number;
  hostsScanned?: number;
  hostsTargeted?: number;
  newAssets?: number | null;
  errors?: { message?: string; error?: string } | string | null;
};

export type DiscoveryJob = {
  id: string;
  profileId: string | null;
  profileName: string;
  status: DiscoveryJobStatus;
  progress: number;
  isIndeterminate: boolean;
  hostsDiscovered: number;
  hostsTargeted: number;
  newAssets: number | null;
  errors: string | null;
  duration: string | null;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
};

const statusConfig: Record<DiscoveryJobStatus, { label: string; color: string; icon: typeof Clock }> = {
  scheduled: { label: 'Scheduled', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Clock },
  running: { label: 'Running', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: PlayCircle },
  completed: { label: 'Completed', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: AlertTriangle },
  cancelled: { label: 'Cancelled', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: AlertTriangle }
};

const progressBarColor: Record<DiscoveryJobStatus, string> = {
  failed: 'bg-red-500',
  cancelled: 'bg-gray-400',
  completed: 'bg-green-500',
  running: 'bg-yellow-500',
  scheduled: 'bg-yellow-500'
};

function formatTimestamp(value?: string, timezone?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { timeZone: timezone });
}

function formatDuration(startedAt?: string | null, completedAt?: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const diffMs = end - start;
  if (diffMs < 0) return null;
  const totalSeconds = Math.round(diffMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function mapJob(job: ApiDiscoveryJob): DiscoveryJob {
  const status: DiscoveryJobStatus = job.status ?? 'scheduled';
  const discovered = job.hostsDiscovered ?? job.results?.length ?? 0;
  const targeted = job.hostsTargeted ?? job.hostsScanned ?? Math.max(discovered, job.results?.length ?? 0);

  let progress: number;
  let isIndeterminate = false;

  if (status === 'completed' || status === 'failed') {
    progress = 100;
  } else if (status === 'cancelled') {
    progress = typeof job.progress === 'number'
      ? job.progress
      : targeted > 0
        ? Math.round((discovered / targeted) * 100)
        : 0;
  } else if (status === 'running') {
    if (typeof job.progress === 'number') {
      progress = Math.min(95, job.progress);
    } else if (targeted > 0) {
      progress = Math.min(95, Math.round((discovered / targeted) * 100));
    } else {
      progress = 0;
      isIndeterminate = true;
    }
  } else {
    // scheduled
    progress = 0;
  }

  return {
    id: job.id,
    profileId: job.profileId ?? null,
    profileName: job.profileName ?? job.profileId ?? 'Unknown profile',
    status,
    progress,
    isIndeterminate,
    hostsDiscovered: discovered,
    hostsTargeted: targeted,
    newAssets: job.newAssets ?? null,
    errors: typeof job.errors === 'string'
      ? job.errors
      : job.errors?.message ?? job.errors?.error ?? null,
    duration: formatDuration(job.startedAt, job.completedAt),
    scheduledAt: job.scheduledAt ?? job.createdAt ?? '',
    startedAt: job.startedAt ?? undefined,
    finishedAt: job.completedAt ?? undefined
  };
}

interface DiscoveryJobListProps {
  timezone?: string;
  profileFilter?: string | null;
  onClearFilter?: () => void;
  onViewProfile?: () => void;
  onViewAssets?: () => void;
}

export default function DiscoveryJobList({ timezone, profileFilter, onClearFilter, onViewProfile, onViewAssets }: DiscoveryJobListProps) {
  const [jobs, setJobs] = useState<DiscoveryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

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

  const cancelJob = useCallback(async (jobId: string) => {
    setCancellingId(jobId);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/discovery/jobs/${jobId}/cancel`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to cancel job');
      }
      await fetchJobs(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setCancellingId(null);
    }
  }, [fetchJobs]);

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

  const filteredJobs = useMemo(() => {
    if (!profileFilter) return jobs;
    return jobs.filter(job => job.profileId === profileFilter);
  }, [jobs, profileFilter]);

  const filterProfileName = profileFilter
    ? filteredJobs[0]?.profileName ?? jobs.find(j => j.profileId === profileFilter)?.profileName
    : null;

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

      {profileFilter && filterProfileName && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Filtered by profile:</span>
          <span className="font-medium">{filterProfileName}</span>
          <button
            type="button"
            onClick={onClearFilter}
            className="ml-auto rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Clear filter
          </button>
        </div>
      )}

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
              <th className="px-4 py-3">New assets</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Scheduled</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Finished</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {profileFilter ? 'No jobs for this profile yet.' : 'No discovery jobs yet.'}
                </td>
              </tr>
            ) : (
              filteredJobs.map(job => {
                const status = statusConfig[job.status];
                const StatusIcon = status.icon;

                return (
                  <tr key={job.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm font-medium">
                      {onViewProfile ? (
                        <button
                          type="button"
                          onClick={onViewProfile}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {job.profileName}
                        </button>
                      ) : (
                        job.profileName
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${status.color}`}>
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                      {job.errors && (
                        <span className="mt-1 block text-xs text-destructive">{job.errors}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                          {job.isIndeterminate ? (
                            <div className="h-full w-full animate-pulse rounded-full bg-yellow-500" />
                          ) : (
                            <div
                              className={`h-full rounded-full ${progressBarColor[job.status]}`}
                              style={{ width: `${job.progress}%` }}
                            />
                          )}
                        </div>
                        <span className="w-10 text-right text-xs">
                          {job.isIndeterminate ? '...' : `${job.progress}%`}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {job.hostsDiscovered} / {job.hostsTargeted}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {job.newAssets != null ? job.newAssets : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {job.duration ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.scheduledAt, timezone)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.startedAt, timezone)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.finishedAt, timezone)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {(job.status === 'scheduled' || job.status === 'running') && (
                          <button
                            type="button"
                            onClick={() => cancelJob(job.id)}
                            disabled={cancellingId === job.id}
                            title="Cancel job"
                            className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                        {job.status === 'completed' && job.hostsDiscovered > 0 && onViewAssets && (
                          <button
                            type="button"
                            onClick={onViewAssets}
                            title="View discovered assets"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10"
                          >
                            Assets
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        )}
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
