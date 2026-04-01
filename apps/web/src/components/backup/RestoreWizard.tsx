import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ClipboardList,
  FolderOpen,
  Loader2,
  MapPin,
  RefreshCw,
  RotateCcw,
  Server,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import AlphaBadge from '../shared/AlphaBadge';

type RestoreType = 'full' | 'selective';

type DestinationType = 'original' | 'alternate';

type SnapshotFile = {
  id: string;
  name: string;
  size?: string;
  path: string;
};

type Snapshot = {
  id: string;
  label: string;
  size?: string;
  status?: string;
  files?: SnapshotFile[];
};

type RestoreResultDetails = {
  status?: string;
  commandType?: string;
  error?: string;
  stderr?: string;
  warnings?: string[];
  durationMs?: number;
  [key: string]: unknown;
};

type RestoreJob = {
  id: string;
  snapshotId: string;
  deviceId: string;
  restoreType: RestoreType | string;
  selectedPaths?: string[];
  status: string;
  targetPath?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  restoredSize?: number | null;
  restoredFiles?: number | null;
  commandId?: string | null;
  errorSummary?: string | null;
  resultDetails?: RestoreResultDetails | null;
};

type SnapshotTreeItem = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
  children?: SnapshotTreeItem[];
};

function flattenSnapshotTree(nodes: SnapshotTreeItem[]): SnapshotFile[] {
  const files: SnapshotFile[] = [];

  const visit = (entries: SnapshotTreeItem[]) => {
    for (const entry of entries) {
      if (entry.type === 'file') {
        files.push({
          id: entry.path,
          path: entry.path,
          name: entry.name,
          size: typeof entry.sizeBytes === 'number' ? `${entry.sizeBytes} B` : undefined,
        });
        continue;
      }
      if (entry.children) visit(entry.children);
    }
  };

  visit(nodes);
  return files;
}

function formatBytes(bytes?: number | null): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return '--';
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

function formatTimestamp(value?: string | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
}

function renderJson(value: unknown): string {
  if (value == null) return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function RestoreWizard() {
  const [step, setStep] = useState(0);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState('');
  const [restoreType, setRestoreType] = useState<RestoreType>('full');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState<DestinationType>('original');
  const [alternatePath, setAlternatePath] = useState('/restore/nyc-db-14');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [restoreError, setRestoreError] = useState<string>();
  const [restoreSuccess, setRestoreSuccess] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [restoreJob, setRestoreJob] = useState<RestoreJob | null>(null);
  const [restoreHistory, setRestoreHistory] = useState<RestoreJob[]>([]);
  const [restoreHistoryLoading, setRestoreHistoryLoading] = useState(false);

  const nextStep = () => setStep((prev) => Math.min(prev + 1, 4));
  const prevStep = () => setStep((prev) => Math.max(prev - 1, 0));

  const fetchSnapshots = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/snapshots');
      if (!response.ok) {
        throw new Error('Failed to fetch snapshots');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? {};
      const snapshotList = Array.isArray(data) ? data : data.snapshots ?? [];
      setSnapshots(Array.isArray(snapshotList) ? snapshotList : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRestoreHistory = useCallback(async () => {
    try {
      setRestoreHistoryLoading(true);
      const response = await fetchWithAuth('/backup/restore?limit=6');
      if (!response.ok) {
        throw new Error('Failed to fetch restore history');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? [];
      setRestoreHistory(Array.isArray(data) ? data as RestoreJob[] : []);
    } catch (err) {
      setRestoreError((prev) => prev ?? (err instanceof Error ? err.message : 'Failed to fetch restore history'));
    } finally {
      setRestoreHistoryLoading(false);
    }
  }, []);

  const fetchRestoreJob = useCallback(async (restoreId: string) => {
    const response = await fetchWithAuth(`/backup/restore/${restoreId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch restore job status');
    }
    const payload = await response.json();
    const data = payload?.data ?? payload;
    setRestoreJob(data as RestoreJob);
    return data as RestoreJob;
  }, []);

  useEffect(() => {
    fetchSnapshots();
    void fetchRestoreHistory();
  }, [fetchRestoreHistory, fetchSnapshots]);

  useEffect(() => {
    if (!snapshotId && snapshots.length > 0) {
      setSnapshotId(snapshots[0].id);
    }
  }, [snapshotId, snapshots]);

  useEffect(() => {
    setSelectedFiles(new Set());
  }, [snapshotId]);

  useEffect(() => {
    if (!snapshotId) return;

    let cancelled = false;
    const loadSnapshotFiles = async () => {
      try {
        setFilesLoading(true);
        const response = await fetchWithAuth(`/backup/snapshots/${snapshotId}/browse`);
        if (!response.ok) {
          throw new Error('Failed to browse snapshot contents');
        }
        const payload = await response.json();
        const items = Array.isArray(payload?.data) ? payload.data as SnapshotTreeItem[] : [];
        const files = flattenSnapshotTree(items);
        if (cancelled) return;
        setSnapshots((prev) => prev.map((snapshot) => (
          snapshot.id === snapshotId
            ? { ...snapshot, files }
            : snapshot
        )));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load snapshot contents');
        }
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    };

    void loadSnapshotFiles();
    return () => {
      cancelled = true;
    };
  }, [snapshotId]);

  const toggleFile = (id: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedSnapshot = useMemo(
    () => snapshots.find((snap) => snap.id === snapshotId),
    [snapshotId, snapshots]
  );
  const selectableFiles = selectedSnapshot?.files ?? [];
  const activeRestore = restoreJob && ['pending', 'running'].includes(`${restoreJob.status}`.toLowerCase()) ? restoreJob : null;

  useEffect(() => {
    if (!activeRestore?.id) return;
    const timer = window.setInterval(() => {
      void fetchRestoreJob(activeRestore.id)
        .then((nextJob) => {
          if (!['pending', 'running'].includes(`${nextJob.status}`.toLowerCase())) {
            void fetchRestoreHistory();
          }
        })
        .catch((err) => {
          setRestoreError(err instanceof Error ? err.message : 'Failed to refresh restore job');
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeRestore?.id, fetchRestoreHistory, fetchRestoreJob]);

  const handleRestore = useCallback(async () => {
    try {
      setRestoring(true);
      setRestoreError(undefined);
      setRestoreSuccess(undefined);
      const requestBody = {
        snapshotId,
        restoreType,
        selectedPaths: restoreType === 'selective' ? Array.from(selectedFiles) : [],
        targetPath: destination === 'alternate' ? alternatePath : undefined
      };

      const response = await fetchWithAuth('/backup/restore', {
        method: 'POST',
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error('Failed to start restore');
      }
      const payload = await response.json();
      const created = (payload?.data ?? payload) as RestoreJob;
      setRestoreJob(created);
      setRestoreSuccess(`Restore job ${created.id} queued successfully.`);
      await fetchRestoreHistory();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Failed to start restore');
    } finally {
      setRestoring(false);
    }
  }, [alternatePath, destination, fetchRestoreHistory, restoreType, selectedFiles, snapshotId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading restore options...</p>
        </div>
      </div>
    );
  }

  if (error && snapshots.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchSnapshots}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="File restore with staging and selective paths is in early access. Resume support for interrupted restores is available but has not been extensively tested." />
      <div>
        <h2 className="text-xl font-semibold text-foreground">Restore Wizard</h2>
        <p className="text-sm text-muted-foreground">
          Guided restore flow for snapshots and targeted files.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {restoreError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {restoreError}
        </div>
      )}
      {restoreSuccess && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {restoreSuccess}
        </div>
      )}

      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {['Select snapshot', 'Restore type', 'Select files', 'Destination', 'Review'].map(
            (label, index) => (
              <button
                type="button"
                key={label}
                onClick={() => setStep(index)}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors',
                  index === step
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted bg-muted/30 text-muted-foreground hover:text-foreground'
                )}
              >
                {index + 1}. {label}
              </button>
            )
          )}
        </div>

        <div className="mt-6 space-y-6">
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Select a snapshot</h3>
                <p className="text-sm text-muted-foreground">
                  Choose the recovery point you want to restore from.
                </p>
              </div>
              {snapshots.length === 0 ? (
                <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  No snapshots available.
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-3">
                  {snapshots.map((snapshot) => (
                    <button
                      key={snapshot.id}
                      onClick={() => setSnapshotId(snapshot.id)}
                      className={cn(
                        'rounded-lg border p-4 text-left',
                        snapshotId === snapshot.id
                          ? 'border-primary bg-primary/5'
                          : 'border-muted bg-muted/20'
                      )}
                    >
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{snapshot.size ?? '--'}</span>
                        <span>{snapshot.status ?? 'Ready'}</span>
                      </div>
                      <div className="mt-2 text-sm font-semibold text-foreground">
                        {snapshot.label}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Select restore type</h3>
                <p className="text-sm text-muted-foreground">
                  Full restores everything, selective restores specific files.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={() => setRestoreType('full')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    restoreType === 'full'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Server className="h-4 w-4 text-primary" />
                    Full restore
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Restores all data from the selected snapshot.
                  </p>
                </button>
                <button
                  onClick={() => setRestoreType('selective')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    restoreType === 'selective'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ClipboardList className="h-4 w-4 text-primary" />
                    Selective restore
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Restore only the files and folders you choose.
                  </p>
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Select files</h3>
                <p className="text-sm text-muted-foreground">
                  Choose files to restore for selective recoveries.
                </p>
              </div>
              {restoreType === 'selective' ? (
                <div className="space-y-3">
                  {selectableFiles.length === 0 ? (
                    <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                      {filesLoading ? 'Loading snapshot contents...' : 'No files available for this snapshot.'}
                    </div>
                  ) : (
                    selectableFiles.map((file) => (
                      <label
                        key={file.id}
                        className="flex items-center justify-between rounded-md border bg-muted/20 px-4 py-3 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedFiles.has(file.id)}
                            onChange={() => toggleFile(file.id)}
                            className="h-4 w-4"
                          />
                          <span className="font-medium text-foreground">{file.name}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{file.size ?? '--'}</span>
                      </label>
                    ))
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  Full restore selected. Skip this step to continue.
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Destination</h3>
                <p className="text-sm text-muted-foreground">
                  Restore to the original location or provide an alternate path.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={() => setDestination('original')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    destination === 'original'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <RotateCcw className="h-4 w-4 text-primary" />
                    Original location
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Restore files in place.</p>
                </button>
                <button
                  onClick={() => setDestination('alternate')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    destination === 'alternate'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FolderOpen className="h-4 w-4 text-primary" />
                    Alternate path
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Restore to a new folder.</p>
                </button>
              </div>
              {destination === 'alternate' && (
                <div className="space-y-2">
                  <label htmlFor="restore-alt-path" className="text-xs font-medium text-muted-foreground">Alternate path</label>
                  <input
                    id="restore-alt-path"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={alternatePath}
                    onChange={(event) => setAlternatePath(event.target.value)}
                  />
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Review & confirm</h3>
                <p className="text-sm text-muted-foreground">Confirm the restore summary before starting.</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    Snapshot
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectedSnapshot?.label ?? 'No snapshot selected'}
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Server className="h-4 w-4 text-primary" />
                    Restore type
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {restoreType === 'full' ? 'Full restore' : 'Selective restore'}
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <MapPin className="h-4 w-4 text-primary" />
                    Destination
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {destination === 'original' ? 'Original path' : 'Alternate path'}
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ClipboardList className="h-4 w-4 text-primary" />
                    Files
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {restoreType === 'full'
                      ? 'All files from snapshot'
                      : `${selectedFiles.size} files selected`}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <button
            onClick={prevStep}
            disabled={step === 0}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="flex items-center gap-2">
            {step < 4 ? (
              <button
                onClick={nextStep}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleRestore}
                disabled={
                  restoring ||
                  !snapshotId ||
                  (restoreType === 'selective' && selectedFiles.size === 0)
                }
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {restoring ? 'Starting...' : 'Start restore'}
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {(restoreJob || restoreHistoryLoading || restoreHistory.length > 0) ? (
        <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">Latest restore job</h3>
                <p className="text-sm text-muted-foreground">
                  Status and result details for the most recently started restore.
                </p>
              </div>
              {restoreJob?.id ? (
                <button
                  type="button"
                  onClick={() => void fetchRestoreJob(restoreJob.id)}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </button>
              ) : null}
            </div>

            {restoreJob ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</p>
                    <p className="mt-2 text-sm font-semibold capitalize text-foreground">{restoreJob.status}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Created</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{formatTimestamp(restoreJob.createdAt)}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Restored files</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{restoreJob.restoredFiles ?? '--'}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Restored size</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{formatBytes(restoreJob.restoredSize)}</p>
                  </div>
                </div>

                {restoreJob.errorSummary ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{restoreJob.errorSummary}</span>
                    </div>
                  </div>
                ) : null}

                {Array.isArray(restoreJob.resultDetails?.warnings) && restoreJob.resultDetails.warnings.length > 0 ? (
                  <div className="rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-medium">Warnings</p>
                        <ul className="mt-1 space-y-1 text-xs">
                          {restoreJob.resultDetails.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-md border border-dashed bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Command / target</p>
                    <p className="mt-2 text-xs text-foreground">Command: {restoreJob.commandId ?? '--'}</p>
                    <p className="mt-1 text-xs text-foreground">Target path: {restoreJob.targetPath ?? 'Original location'}</p>
                    <p className="mt-1 text-xs text-foreground">Completed: {formatTimestamp(restoreJob.completedAt)}</p>
                  </div>
                  <div className="rounded-md border border-dashed bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Result payload</p>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground">
                      {renderJson(restoreJob.resultDetails)}
                    </pre>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                Start a restore to load live result details here.
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">Recent restore history</h3>
                <p className="text-sm text-muted-foreground">
                  Most recent restore jobs for this organization.
                </p>
              </div>
              {restoreHistoryLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>

            <div className="mt-4 space-y-3">
              {restoreHistory.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No restore history yet.
                </div>
              ) : (
                restoreHistory.map((job) => {
                  const isFailed = `${job.status}`.toLowerCase().includes('fail');
                  const isRunning = ['pending', 'running'].includes(`${job.status}`.toLowerCase());
                  return (
                    <div key={job.id} className="rounded-md border px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{job.id}</p>
                          <p className="text-xs text-muted-foreground">
                            {job.restoreType} restore · {formatTimestamp(job.createdAt)}
                          </p>
                        </div>
                        <span className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium capitalize',
                          isFailed && 'bg-destructive/10 text-destructive',
                          isRunning && 'bg-primary/10 text-primary',
                          !isFailed && !isRunning && 'bg-success/10 text-success'
                        )}>
                          {isFailed ? <XCircle className="h-3.5 w-3.5" /> : isRunning ? <Clock3 className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                          {job.status}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>Files: {job.restoredFiles ?? '--'}</span>
                        <span>Size: {formatBytes(job.restoredSize)}</span>
                      </div>
                      {job.errorSummary ? (
                        <p className="mt-2 line-clamp-2 text-xs text-destructive">{job.errorSummary}</p>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
