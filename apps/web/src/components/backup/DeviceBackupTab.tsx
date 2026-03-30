import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { friendlyFetchError } from '../../lib/utils';
import BackupVerificationTab from './BackupVerificationTab';
import DeviceVaultStatus from './DeviceVaultStatus';

type BackupJobStatus = 'completed' | 'running' | 'failed' | 'pending' | 'cancelled';
type VssWriterState = 'stable' | 'failed' | 'waiting' | string;

type VssWriter = {
  name?: string | null;
  writerName?: string | null;
  state?: VssWriterState | null;
};

type VssMetadata = {
  writers?: VssWriter[] | null;
} | VssWriter[];

type BackupJob = {
  id: string;
  deviceId: string;
  type: string;
  status: BackupJobStatus;
  startedAt: string;
  completedAt?: string | null;
  sizeBytes?: number | null;
  errorCount?: number | null;
  vssMetadata?: VssMetadata | null;
};

type Snapshot = {
  id: string;
  deviceId: string;
  label: string;
  timestamp: string;
  sizeBytes?: number | null;
  type?: 'full' | 'incremental';
};

type BackupStatus = {
  protected?: boolean;
  lastJob?: BackupJob | null;
  lastSuccessAt?: string | null;
  nextScheduledAt?: string | null;
};

const jobStatusConfig: Record<BackupJobStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  completed: { icon: CheckCircle2, className: 'text-success bg-success/10', label: 'Completed' },
  running: { icon: Clock, className: 'text-primary bg-primary/10', label: 'Running' },
  failed: { icon: XCircle, className: 'text-destructive bg-destructive/10', label: 'Failed' },
  pending: { icon: Clock, className: 'text-muted-foreground bg-muted', label: 'Pending' },
  cancelled: { icon: XCircle, className: 'text-muted-foreground bg-muted', label: 'Cancelled' },
};

const vssStateConfig: Record<string, { className: string; label: string }> = {
  stable: { className: 'text-success bg-success/10', label: 'Stable' },
  failed: { className: 'text-destructive bg-destructive/10', label: 'Failed' },
  waiting: { className: 'text-warning bg-warning/10', label: 'Waiting' },
  unknown: { className: 'text-muted-foreground bg-muted', label: 'Unknown' },
};

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startedAt: string | null | undefined, completedAt: string | null | undefined): string {
  if (!startedAt || !completedAt) return '-';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (isNaN(ms) || ms < 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m`;
}

function getVssWriters(vssMetadata: VssMetadata | null | undefined): VssWriter[] {
  if (!vssMetadata) return [];
  if (Array.isArray(vssMetadata)) return vssMetadata;
  return Array.isArray(vssMetadata.writers) ? vssMetadata.writers : [];
}

function normalizeVssState(state: string | null | undefined): keyof typeof vssStateConfig {
  const normalized = state?.toLowerCase?.() ?? 'unknown';
  if (normalized === 'stable' || normalized === 'failed' || normalized === 'waiting') {
    return normalized;
  }
  return 'unknown';
}

type DeviceBackupTabProps = {
  deviceId: string;
  timezone?: string;
};

export default function DeviceBackupTab({ deviceId }: DeviceBackupTabProps) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    setError(undefined);
    try {
      const [statusRes, jobsRes, snapshotsRes] = await Promise.all([
        fetchWithAuth(`/backup/status/${deviceId}`),
        fetchWithAuth(`/backup/jobs?deviceId=${deviceId}`),
        fetchWithAuth(`/backup/snapshots?deviceId=${deviceId}`),
      ]);

      if (statusRes.ok) {
        const payload = await statusRes.json();
        setStatus(payload?.data ?? payload ?? null);
      }

      if (jobsRes.ok) {
        const payload = await jobsRes.json();
        setJobs(Array.isArray(payload?.data) ? payload.data : []);
      }

      if (snapshotsRes.ok) {
        const payload = await snapshotsRes.json();
        setSnapshots(Array.isArray(payload?.data) ? payload.data : []);
      }

      const firstFail = [statusRes, jobsRes, snapshotsRes].find((r) => !r.ok);
      if (firstFail) {
        setError(`Failed to load some data (${firstFail.status})`);
      }
    } catch (err) {
      console.error('[DeviceBackupTab] fetchData:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading backup data...</p>
        </div>
      </div>
    );
  }

  // Empty state
  if (!error && !status?.protected && !status?.lastJob && jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Database className="h-12 w-12 text-muted-foreground/40" />
        <h3 className="mt-4 text-base font-semibold text-foreground">No backup configured</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign a backup policy to protect this device.
        </p>
      </div>
    );
  }

  const recentJobs = jobs.slice(0, 20);
  const lastJob = status?.lastJob ?? recentJobs[0] ?? null;
  const lastJobStatus = lastJob?.status as BackupJobStatus | undefined;
  const statusCfg = lastJobStatus ? (jobStatusConfig[lastJobStatus] ?? jobStatusConfig.pending) : null;
  const latestVssWriters = getVssWriters(status?.lastJob?.vssMetadata);
  const showVssStatus = status?.lastJob?.vssMetadata != null;
  const hasVssWarnings = latestVssWriters.some((writer) => normalizeVssState(writer.state) !== 'stable');

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Status Header */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            {statusCfg && lastJobStatus ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Last backup</span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                    statusCfg.className
                  )}
                >
                  <statusCfg.icon className="h-3.5 w-3.5" />
                  {statusCfg.label}
                </span>
              </div>
            ) : status?.protected ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Policy assigned
                </span>
                <span className="text-xs text-muted-foreground">Awaiting first backup run</span>
              </div>
            ) : null}
            {status?.lastSuccessAt && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                <span>Last success: {formatTime(status.lastSuccessAt)}</span>
              </div>
            )}
            {status?.nextScheduledAt && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                <span>Next: {formatTime(status.nextScheduledAt)}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Job History */}
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <h3 className="mb-4 font-semibold">Job History</h3>
        {recentJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {status?.protected
              ? 'No jobs yet. The first backup will run at the next scheduled time.'
              : 'No jobs recorded.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Type</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Started</th>
                  <th className="pb-2 pr-4 font-medium">Duration</th>
                  <th className="pb-2 pr-4 font-medium">Size</th>
                  <th className="pb-2 font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {recentJobs.map((job) => {
                  const jStatus = job.status as BackupJobStatus;
                  const cfg = jobStatusConfig[jStatus] ?? jobStatusConfig.pending;
                  const Icon = cfg.icon;
                  const errorCount = job.errorCount ?? 0;
                  return (
                    <tr key={job.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 capitalize text-foreground">
                        {job.type}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                            cfg.className
                          )}
                        >
                          <Icon className="h-3 w-3" />
                          {cfg.label}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {formatTime(job.startedAt)}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {formatDuration(job.startedAt, job.completedAt)}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {formatBytes(job.sizeBytes)}
                      </td>
                      <td className="py-2">
                        {errorCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {errorCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* VSS Status */}
      {showVssStatus && (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">VSS Status</h3>
            <span className="text-xs text-muted-foreground">Latest backup job</span>
          </div>

          {hasVssWarnings && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>One or more VSS writers are not stable. Review the latest writer states before the next run.</span>
            </div>
          )}

          {latestVssWriters.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Writer</th>
                    <th className="pb-2 font-medium">State</th>
                  </tr>
                </thead>
                <tbody>
                  {latestVssWriters.map((writer, index) => {
                    const normalizedState = normalizeVssState(writer.state);
                    const writerState = vssStateConfig[normalizedState] ?? vssStateConfig.unknown;
                    const writerName = writer.writerName ?? writer.name ?? `Writer ${index + 1}`;
                    return (
                      <tr key={`${writerName}-${index}`} className="border-b last:border-0">
                        <td className="py-2 pr-4 text-foreground">{writerName}</td>
                        <td className="py-2">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                              writerState.className
                            )}
                          >
                            {writerState.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No VSS writer details were reported for the latest backup.</p>
          )}
        </div>
      )}

      {/* Vault Status */}
      <DeviceVaultStatus deviceId={deviceId} />

      {/* Snapshots */}
      {snapshots.length > 0 && (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <h3 className="mb-4 font-semibold">Restore Points</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Label</th>
                  <th className="pb-2 pr-4 font-medium">Timestamp</th>
                  <th className="pb-2 pr-4 font-medium">Size</th>
                  <th className="pb-2 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => (
                  <tr key={snap.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 text-foreground">{snap.label}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatTime(snap.timestamp)}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatBytes(snap.sizeBytes)}
                    </td>
                    <td className="py-2">
                      {snap.type ? (
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            snap.type === 'full'
                              ? 'bg-primary/10 text-primary'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {snap.type === 'full' ? 'Full' : 'Incremental'}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Verification & Readiness */}
      <BackupVerificationTab deviceId={deviceId} />
    </div>
  );
}
