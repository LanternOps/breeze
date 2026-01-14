import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  FolderOpen,
  MapPin,
  RotateCcw,
  Server
} from 'lucide-react';
import { cn } from '@/lib/utils';

type RestoreType = 'full' | 'selective';

type DestinationType = 'original' | 'alternate';

type SnapshotFile = {
  id: string;
  name: string;
  size?: string;
};

type Snapshot = {
  id: string;
  label: string;
  size?: string;
  status?: string;
  files?: SnapshotFile[];
};

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

  const nextStep = () => setStep((prev) => Math.min(prev + 1, 4));
  const prevStep = () => setStep((prev) => Math.max(prev - 1, 0));

  const fetchSnapshots = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/backup/snapshots');
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

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  useEffect(() => {
    if (!snapshotId && snapshots.length > 0) {
      setSnapshotId(snapshots[0].id);
    }
  }, [snapshotId, snapshots]);

  useEffect(() => {
    setSelectedFiles(new Set());
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

  const handleRestore = useCallback(async () => {
    try {
      setRestoring(true);
      setRestoreError(undefined);
      setRestoreSuccess(undefined);
      const payload = {
        snapshotId,
        restoreType,
        files: restoreType === 'selective' ? Array.from(selectedFiles) : [],
        destination,
        alternatePath: destination === 'alternate' ? alternatePath : undefined
      };

      const response = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error('Failed to start restore');
      }

      setRestoreSuccess('Restore started successfully.');
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Failed to start restore');
    } finally {
      setRestoring(false);
    }
  }, [alternatePath, destination, restoreType, selectedFiles, snapshotId]);

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
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
          {restoreSuccess}
        </div>
      )}

      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {['Select snapshot', 'Restore type', 'Select files', 'Destination', 'Review'].map(
            (label, index) => (
              <div
                key={label}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide',
                  index === step
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted bg-muted/30 text-muted-foreground'
                )}
              >
                {index + 1}. {label}
              </div>
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
                      No files available for this snapshot.
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
                  <label className="text-xs font-medium text-muted-foreground">Alternate path</label>
                  <input
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
    </div>
  );
}
