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
import AlphaBadge from '../shared/AlphaBadge';

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
  label: string | null;
  createdAt: string;
  sizeBytes?: number | null;
  fileCount?: number | null;
  location?: string | null;
  expiresAt?: string | null;
  legalHold: boolean;
  legalHoldReason?: string | null;
  isImmutable: boolean;
  immutableUntil?: string | null;
  immutabilityEnforcement?: 'application' | 'provider' | null;
  requestedImmutabilityEnforcement?: 'application' | 'provider' | null;
  immutabilityFallbackReason?: string | null;
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

function protectionSummary(snapshot: Snapshot): string {
  if (snapshot.legalHold && snapshot.isImmutable) {
    return snapshot.immutabilityEnforcement === 'provider'
      ? 'Legal hold + provider immutability'
      : 'Legal hold + app immutability';
  }
  if (snapshot.legalHold) return 'Legal hold';
  if (snapshot.isImmutable) {
    return snapshot.immutabilityEnforcement === 'provider'
      ? 'Provider immutability'
      : 'App immutability';
  }
  return 'Standard retention';
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
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [reason, setReason] = useState('');
  const [immutableDays, setImmutableDays] = useState(30);
  const [immutabilityMode, setImmutabilityMode] = useState<'application' | 'provider'>('application');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<string>();

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

  useEffect(() => {
    if (!selectedSnapshotId && snapshots.length > 0) {
      setSelectedSnapshotId(snapshots[0].id);
      return;
    }

    if (selectedSnapshotId && !snapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) {
      setSelectedSnapshotId(snapshots[0]?.id ?? '');
    }
  }, [selectedSnapshotId, snapshots]);

  const handleProtectionAction = useCallback(async (
    action: 'apply-hold' | 'release-hold' | 'apply-immutability' | 'release-immutability',
  ) => {
    if (!selectedSnapshotId) return;

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setActionError('A reason is required for snapshot protection changes.');
      return;
    }

    if (action === 'apply-immutability' && immutableDays < 1) {
      setActionError('Immutable days must be at least 1.');
      return;
    }

    const path = (() => {
      switch (action) {
        case 'apply-hold':
          return `/backup/snapshots/${selectedSnapshotId}/legal-hold`;
        case 'release-hold':
          return `/backup/snapshots/${selectedSnapshotId}/legal-hold/release`;
        case 'apply-immutability':
          return `/backup/snapshots/${selectedSnapshotId}/immutability`;
        case 'release-immutability':
          return `/backup/snapshots/${selectedSnapshotId}/immutability/release`;
      }
    })();

    const body = action === 'apply-immutability'
      ? { reason: trimmedReason, immutableDays, enforcement: immutabilityMode }
      : { reason: trimmedReason };

    try {
      setActionLoading(true);
      setActionError(undefined);
      setActionMessage(undefined);

      const response = await fetchWithAuth(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? 'Failed to update snapshot protection');
      }

      const updated = payload?.data ?? payload;
      setSnapshots((prev) => prev.map((snapshot) => (
        snapshot.id === selectedSnapshotId
          ? { ...snapshot, ...updated }
          : snapshot
      )));
      setActionMessage(
        action === 'apply-hold'
          ? 'Legal hold applied to the selected restore point.'
          : action === 'release-hold'
            ? 'Legal hold released from the selected restore point.'
            : action === 'apply-immutability'
              ? `${immutabilityMode === 'provider' ? 'Provider' : 'Application'} immutability applied to the selected restore point.`
              : 'Application immutability released from the selected restore point.'
      );
      setReason('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update snapshot protection');
    } finally {
      setActionLoading(false);
    }
  }, [immutableDays, immutabilityMode, reason, selectedSnapshotId]);

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
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? snapshots[0] ?? null;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {actionError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700">
          {actionMessage}
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
            <h3 className="font-semibold">VSS Status <AlphaBadge /></h3>
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Restore Points</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Manage snapshot protection for this device without leaving the device record.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              {snapshots.length} restore point{snapshots.length === 1 ? '' : 's'}
            </span>
          </div>

          {selectedSnapshot && (
            <div className="mt-4 grid gap-4 rounded-lg border bg-muted/15 p-4 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {selectedSnapshot.label ?? selectedSnapshot.id}
                  </span>
                  {selectedSnapshot.legalHold && (
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Legal hold
                    </span>
                  )}
                  {selectedSnapshot.isImmutable && (
                    <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700">
                      {selectedSnapshot.immutabilityEnforcement === 'provider'
                        ? 'Provider immutability'
                        : 'Application immutability'}
                    </span>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border bg-background p-3 text-sm">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Timing
                    </div>
                    <div className="mt-2 space-y-1 text-foreground">
                      <div>Created: {formatTime(selectedSnapshot.createdAt)}</div>
                      <div>Expires: {formatTime(selectedSnapshot.expiresAt)}</div>
                      <div>Immutable until: {formatTime(selectedSnapshot.immutableUntil)}</div>
                    </div>
                  </div>
                  <div className="rounded-md border bg-background p-3 text-sm">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Snapshot Details
                    </div>
                    <div className="mt-2 space-y-1 text-foreground">
                      <div>Size: {formatBytes(selectedSnapshot.sizeBytes)}</div>
                      <div>Files: {selectedSnapshot.fileCount ?? '-'}</div>
                      <div>Protection: {protectionSummary(selectedSnapshot)}</div>
                    </div>
                  </div>
                </div>

                {(selectedSnapshot.legalHoldReason || selectedSnapshot.immutabilityEnforcement || selectedSnapshot.location) && (
                  <div className="rounded-md border bg-background p-3 text-sm">
                    {selectedSnapshot.legalHoldReason && (
                      <div>
                        <span className="font-medium text-foreground">Hold reason:</span>{' '}
                        <span className="text-muted-foreground">{selectedSnapshot.legalHoldReason}</span>
                      </div>
                    )}
                    {selectedSnapshot.immutabilityEnforcement && (
                      <div>
                        <span className="font-medium text-foreground">Enforcement:</span>{' '}
                        <span className="text-muted-foreground">
                          {selectedSnapshot.immutabilityEnforcement === 'provider'
                            ? 'Provider-enforced WORM'
                            : 'Application-level cleanup protection'}
                        </span>
                      </div>
                    )}
                    {selectedSnapshot.location && (
                      <div className="break-all">
                        <span className="font-medium text-foreground">Location:</span>{' '}
                        <span className="text-muted-foreground">{selectedSnapshot.location}</span>
                      </div>
                    )}
                  </div>
                )}

                {selectedSnapshot.requestedImmutabilityEnforcement === 'provider' &&
                  selectedSnapshot.immutabilityEnforcement === 'application' && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
                      Provider immutability was requested by policy, but Breeze applied application protection instead.
                      {selectedSnapshot.immutabilityFallbackReason && (
                        <div className="mt-1 text-xs text-amber-900/80">
                          Reason: {selectedSnapshot.immutabilityFallbackReason}
                        </div>
                      )}
                    </div>
                  )}
              </div>

              <div className="space-y-3 rounded-md border bg-background p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Protection Controls
                </div>
                <p className="text-xs text-muted-foreground">
                  These actions apply only to the selected restore point. Releasing protection can make an expired snapshot eligible for deletion immediately.
                </p>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Reason</label>
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason for applying or releasing protection"
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Immutable for (days)</label>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={immutableDays}
                    onChange={(event) => setImmutableDays(Number(event.target.value) || 30)}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Immutability enforcement</label>
                  <select
                    value={immutabilityMode}
                    onChange={(event) => setImmutabilityMode(event.target.value as 'application' | 'provider')}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="application">Application-level</option>
                    <option value="provider">Provider-enforced</option>
                  </select>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={actionLoading || selectedSnapshot.legalHold}
                    onClick={() => void handleProtectionAction('apply-hold')}
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 disabled:opacity-50"
                  >
                    {actionLoading ? 'Working...' : 'Apply legal hold'}
                  </button>
                  <button
                    type="button"
                    disabled={actionLoading || !selectedSnapshot.legalHold}
                    onClick={() => void handleProtectionAction('release-hold')}
                    className="rounded-md border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                  >
                    Release legal hold
                  </button>
                  <button
                    type="button"
                    disabled={actionLoading || selectedSnapshot.isImmutable}
                    onClick={() => void handleProtectionAction('apply-immutability')}
                    className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-800 disabled:opacity-50"
                  >
                    Apply immutability
                  </button>
                  <button
                    type="button"
                    disabled={
                      actionLoading ||
                      !selectedSnapshot.isImmutable ||
                      selectedSnapshot.immutabilityEnforcement === 'provider'
                    }
                    onClick={() => void handleProtectionAction('release-immutability')}
                    className="rounded-md border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                  >
                    Release app immutability
                  </button>
                </div>
                {selectedSnapshot.immutabilityEnforcement === 'provider' && selectedSnapshot.isImmutable && (
                  <p className="text-xs text-muted-foreground">
                    Provider-enforced immutability must be released at the storage provider.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Label</th>
                  <th className="pb-2 pr-4 font-medium">Created</th>
                  <th className="pb-2 pr-4 font-medium">Expires</th>
                  <th className="pb-2 pr-4 font-medium">Size</th>
                  <th className="pb-2 font-medium">Protection</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => (
                  <tr
                    key={snap.id}
                    className={cn(
                      'cursor-pointer border-b last:border-0',
                      selectedSnapshotId === snap.id ? 'bg-primary/5' : undefined
                    )}
                    onClick={() => setSelectedSnapshotId(snap.id)}
                  >
                    <td className="py-2 pr-4 text-foreground">{snap.label ?? snap.id}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatTime(snap.createdAt)}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">{formatTime(snap.expiresAt)}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {formatBytes(snap.sizeBytes)}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {snap.legalHold && (
                          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                            Hold
                          </span>
                        )}
                        {snap.isImmutable && (
                          <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700">
                            {snap.immutabilityEnforcement === 'provider' ? 'Provider lock' : 'App lock'}
                          </span>
                        )}
                        {!snap.legalHold && !snap.isImmutable && (
                          <span className="text-muted-foreground">Standard</span>
                        )}
                      </div>
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
