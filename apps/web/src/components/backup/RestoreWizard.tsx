import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '../../stores/auth';
import AlphaBadge from '../shared/AlphaBadge';
import RestoreResultNotices from './RestoreResultNotices';
import { showToast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';
import { asList } from '@/lib/asList';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import {
  isUnattestedRestoreStepUp,
  suppressUnattestedRestoreStepUpToast,
  useUnattestedRestoreStepUp,
  type UnattestedRestoreExtras,
} from './useUnattestedRestoreStepUp';
import SnapshotIntegrityBadge from './SnapshotIntegrityBadge';
import '../../lib/i18n';

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
  deviceName?: string | null;
  size?: string;
  sizeBytes?: number | null;
  // /backup/snapshots carries no status (a snapshot row only exists once its
  // backup completed), so the card shows when it was captured instead (#6496).
  createdAt?: string | null;
  files?: SnapshotFile[];
  /** Integrity status from GET /backup/snapshots (absent on an older API). */
  integrityStatus?: string | null;
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
  deviceName?: string | null;
  // 'vm' / 'instant_boot' / 'rebuild' restores persist restoreType 'full' (#7213).
  restoreMode?: 'vm' | 'instant_boot' | 'rebuild' | null;
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
          size: typeof entry.sizeBytes === 'number' ? formatBytes(entry.sizeBytes) : undefined,
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
  return `${formatNumber(value, { minimumFractionDigits: precision, maximumFractionDigits: precision })} ${units[unitIndex]}`;
}

function isActiveRestoreStatus(status: string | null | undefined): boolean {
  return ['pending', 'running'].includes(`${status ?? ''}`.toLowerCase());
}

// Only file restores (full / selective, the jobs this wizard starts) can be
// cancelled here. VM, instant-boot and rebuild jobs have their own lifecycle:
// the restore cancel route does not close a rebuild's bare-metal recovery,
// which would then block the next rebuild of that device.
function isCancellableFileRestore(job: RestoreJob): boolean {
  return !job.restoreMode && isActiveRestoreStatus(job.status);
}

function formatTimestamp(value?: string | null): string {
  return formatDateTime(value, { fallback: '--' });
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    const message = payload?.error;
    return typeof message === 'string' && message.trim().length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

type RestoreWizardProps = {
  /**
   * Carried from `SnapshotBrowser` via the `#restore?snapshot=…&paths=…` hash
   * (#6456) — pre-populates the snapshot + selection instead of making the
   * operator re-pick the same files they already checked off there.
   */
  initialSnapshotId?: string;
  initialSelectedPaths?: string[];
};

export default function RestoreWizard({ initialSnapshotId, initialSelectedPaths }: RestoreWizardProps = {}) {
  const { t } = useTranslation('backup');
  const [step, setStep] = useState(0);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState(initialSnapshotId ?? '');
  const [restoreType, setRestoreType] = useState<RestoreType>(
    initialSelectedPaths && initialSelectedPaths.length > 0 ? 'selective' : 'full'
  );
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
    () => new Set(initialSelectedPaths ?? [])
  );
  // The snapshot-change effect below clears the selection on every
  // `snapshotId` change so a user picking a *different* snapshot in step 0
  // doesn't drag a stale selection along. That would also fire on mount and
  // wipe out the selection carried in via `initialSelectedPaths` the instant
  // the wizard renders — skip its first run.
  const isFirstSnapshotChange = useRef(true);
  const [destination, setDestination] = useState<DestinationType>('original');
  // #6349: this defaulted to the demo path '/restore/nyc-db-14'. The wizard
  // was unreachable, so nobody saw it; now that it is mounted, a pre-filled
  // stranger's path is a restore aimed at the wrong directory one click away.
  const [alternatePath, setAlternatePath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [restoreError, setRestoreError] = useState<string>();
  const [restoreSuccess, setRestoreSuccess] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [restoreJob, setRestoreJob] = useState<RestoreJob | null>(null);
  const [restoreHistory, setRestoreHistory] = useState<RestoreJob[]>([]);
  const [restoreHistoryLoading, setRestoreHistoryLoading] = useState(false);
  const [cancellingRestoreId, setCancellingRestoreId] = useState<string | null>(null);
  // The success banner's "View progress" scrolls here. A plain anchor would
  // rewrite the URL hash, which carries the backup dashboard's tab state.
  const latestRestoreRef = useRef<HTMLDivElement>(null);

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
      const data = asList(payload);
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
      throw new Error(await readApiError(response, 'Failed to fetch restore job status'));
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
    if (isFirstSnapshotChange.current) {
      isFirstSnapshotChange.current = false;
      return;
    }
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

  const restoreKindLabel = (job: RestoreJob): string => {
    if (job.restoreMode === 'vm') return t('restoreWizard.kindVm');
    if (job.restoreMode === 'instant_boot') return t('restoreWizard.kindInstantBoot');
    if (job.restoreMode === 'rebuild') return t('restoreWizard.kindRebuild');
    return job.restoreType === 'selective' ? t('restoreWizard.kindSelective') : t('restoreWizard.kindFull');
  };

  const selectedSnapshot = useMemo(
    () => snapshots.find((snap) => snap.id === snapshotId),
    [snapshotId, snapshots]
  );
  const selectableFiles = selectedSnapshot?.files ?? [];
  const latestKnownRestore = useMemo(() => {
    if (restoreJob) return restoreJob;
    return restoreHistory[0] ?? null;
  }, [restoreHistory, restoreJob]);
  const activeRestore = useMemo(() => {
    const candidate =
      restoreJob
      ?? restoreHistory.find((job) => ['pending', 'running'].includes(`${job.status}`.toLowerCase()))
      ?? null;
    return candidate && ['pending', 'running'].includes(`${candidate.status}`.toLowerCase()) ? candidate : null;
  }, [restoreHistory, restoreJob]);

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

  // A backup without an integrity attestation is restored only after the
  // operator confirms it (two-factor when enabled); the server asks for it.
  const unattestedStepUp = useUnattestedRestoreStepUp();

  const submitRestore = useCallback(async (extras: UnattestedRestoreExtras): Promise<boolean> => {
    try {
      setRestoring(true);
      setRestoreError(undefined);
      setRestoreSuccess(undefined);
      const requestBody = {
        snapshotId,
        restoreType,
        selectedPaths: restoreType === 'selective' ? Array.from(selectedFiles) : [],
        targetPath: destination === 'alternate' ? alternatePath : undefined,
        ...extras,
      };

      // runAction (CLAUDE.md): a failed restore must toast, not just tint a
      // panel the operator may have scrolled past.
      const created = await runAction<RestoreJob>({
        request: () =>
          fetchWithAuth('/backup/restore', {
            method: 'POST',
            body: JSON.stringify(requestBody)
          }),
        errorFallback: 'Failed to start restore',
        parseSuccess: (data) => ((data as { data?: RestoreJob })?.data ?? data) as RestoreJob,
        suppressErrorToast: suppressUnattestedRestoreStepUpToast,
      });
      setRestoreJob(created);
      // Name the device, not the job UUID; the Latest restore job panel
      // below carries the details and the Cancel control.
      const deviceName = created.deviceName ?? selectedSnapshot?.deviceName ?? null;
      const started = `${created.status}`.toLowerCase() === 'running';
      let confirmation: string;
      if (deviceName) {
        confirmation = started
          ? t('restoreWizard.restoreStartedOnDevice', { device: deviceName })
          : t('restoreWizard.restoreQueuedOnDevice', { device: deviceName });
      } else {
        confirmation = started ? t('restoreWizard.restoreStarted') : t('restoreWizard.restoreQueued');
      }
      setRestoreSuccess(confirmation);
      await fetchRestoreHistory();
      return true;
    } catch (err) {
      // 401 is handled by the auth redirect; every other ActionError was
      // already toasted by runAction, and the inline banner keeps the detail
      // on screen next to the wizard controls.
      if (err instanceof ActionError && err.status === 401) return false;
      // The confirmation prompt handles a step-up request.
      if (isUnattestedRestoreStepUp(err)) throw err;
      setRestoreError(err instanceof Error ? err.message : 'Failed to start restore');
      return false;
    } finally {
      setRestoring(false);
    }
  }, [alternatePath, destination, fetchRestoreHistory, restoreType, selectedFiles, selectedSnapshot, snapshotId, t]);

  const { run: runWithStepUp } = unattestedStepUp;
  const handleRestore = useCallback(() => {
    // Every other failure was surfaced by submitRestore itself.
    void runWithStepUp(submitRestore).catch(() => undefined);
  }, [runWithStepUp, submitRestore]);

  const handleCancelRestore = useCallback(async (restoreId: string) => {
    setCancellingRestoreId(restoreId);
    try {
      // The cancel route answers 200 with a `warning` when the job is marked
      // cancelled but the stop signal could not reach the agent — a partial
      // success runAction treats as success, so surface it ourselves instead
      // of a clean "cancelled" toast.
      const result = await runAction<{ data?: RestoreJob; warning?: string } | null>({
        request: () => fetchWithAuth(`/backup/restore/${restoreId}/cancel`, { method: 'POST' }),
        errorFallback: t('restoreWizard.cancelRestoreFailed'),
        successMessage: (body) => (body?.warning ? '' : t('restoreWizard.restoreCancelled')),
      });
      if (result?.data) setRestoreJob(result.data);
      setRestoreSuccess(undefined);
      if (typeof result?.warning === 'string' && result.warning.trim()) {
        showToast({ message: result.warning, type: 'warning' });
      }
      await fetchRestoreHistory();
    } catch (err) {
      handleActionError(err, t('restoreWizard.cancelRestoreFailed'));
    } finally {
      setCancellingRestoreId(null);
    }
  }, [fetchRestoreHistory, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('restoreWizard.loadingRestoreOptions')}</p>
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
          {t('restoreWizard.tryAgain')} </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="File restore with staging and selective paths is in early access. Resume support for interrupted restores is available but has not been extensively tested." />
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('restoreWizard.restoreWizard')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('restoreWizard.guidedRestoreFlowForSnapshotsAndTargetedFiles')} </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {unattestedStepUp.prompt}
      {restoreError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {restoreError}
        </div>
      )}
      {restoreSuccess && (
        <div
          data-testid="restore-success-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
        >
          <span>{restoreSuccess}</span>
          <button
            type="button"
            onClick={() => latestRestoreRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
            className="text-xs font-medium underline underline-offset-2 hover:no-underline"
          >
            {t('restoreWizard.viewProgress')}
          </button>
        </div>
      )}

      <div className="rounded-lg border bg-card p-5 shadow-xs">
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
                <h3 className="text-lg font-semibold text-foreground">{t('restoreWizard.selectASnapshot')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('restoreWizard.chooseTheRecoveryPointYouWantToRestore')} </p>
              </div>
              {snapshots.length === 0 ? (
                <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  {t('restoreWizard.noSnapshotsAvailable')} </div>
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
                        <span>
                          {typeof snapshot.sizeBytes === 'number'
                            ? formatBytes(snapshot.sizeBytes)
                            : snapshot.size ?? '--'}
                        </span>
                        {snapshot.createdAt ? <span>{formatDateTime(snapshot.createdAt)}</span> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                        {snapshot.label}
                        <SnapshotIntegrityBadge status={snapshot.integrityStatus} />
                      </div>
                      {snapshot.deviceName ? (
                        <div className="mt-1 text-xs text-muted-foreground">{snapshot.deviceName}</div>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('restoreWizard.selectRestoreType')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('restoreWizard.fullRestoresEverythingSelectiveRestoresSpecificFiles')} </p>
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
                    {t('restoreWizard.fullRestore')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('restoreWizard.restoresAllDataFromTheSelectedSnapshot')} </p>
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
                    {t('restoreWizard.selectiveRestore')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('restoreWizard.restoreOnlyTheFilesAndFoldersYouChoose')} </p>
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('restoreWizard.selectFiles')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('restoreWizard.chooseFilesToRestoreForSelectiveRecoveries')} </p>
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
                  {t('restoreWizard.fullRestoreSelectedSkipThisStepToContinue')} </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('restoreWizard.destination')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('restoreWizard.restoreToAStagingFolderOrProvideAn')} </p>
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
                    {t('restoreWizard.stagingFolder')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">{t('restoreWizard.stagingFolderHint')}</p>
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
                    {t('restoreWizard.alternatePath')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">{t('restoreWizard.restoreToANewFolder')}</p>
                </button>
              </div>
              {destination === 'alternate' && (
                <div className="space-y-2">
                  <label htmlFor="restore-alt-path" className="text-xs font-medium text-muted-foreground">{t('restoreWizard.alternatePath')}</label>
                  <input
                    id="restore-alt-path"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder={t('restoreWizard.alternatePathPlaceholder')}
                    value={alternatePath}
                    onChange={(event) => setAlternatePath(event.target.value)}
                  />
                  {!alternatePath.trim() && (
                    <p className="text-xs text-muted-foreground">{t('restoreWizard.alternatePathRequired')}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('restoreWizard.reviewConfirm')}</h3>
                <p className="text-sm text-muted-foreground">{t('restoreWizard.confirmTheRestoreSummaryBeforeStarting')}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    {t('restoreWizard.snapshot')} </div>
                  <p data-testid="restore-review-snapshot" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {selectedSnapshot?.label ?? 'No snapshot selected'}
                    <SnapshotIntegrityBadge status={selectedSnapshot?.integrityStatus} />
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Server className="h-4 w-4 text-primary" />
                    {t('restoreWizard.restoreType')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {restoreType === 'full' ? 'Full restore' : 'Selective restore'}
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <MapPin className="h-4 w-4 text-primary" />
                    {t('restoreWizard.destination')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {destination === 'original'
                      ? t('restoreWizard.stagingFolder')
                      : `Alternate path: ${alternatePath.trim() || '(none entered)'}`}
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ClipboardList className="h-4 w-4 text-primary" />
                    {t('restoreWizard.files')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {restoreType === 'full'
                      ? 'All files from snapshot'
                      : t('restoreWizard.filesSelected', { count: selectedFiles.size })}
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
            {t('restoreWizard.back')} </button>
          <div className="flex items-center gap-2">
            {step < 4 ? (
              <button
                onClick={nextStep}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('restoreWizard.continue')} <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleRestore}
                disabled={
                  restoring ||
                  !snapshotId ||
                  (restoreType === 'selective' && selectedFiles.size === 0) ||
                  (destination === 'alternate' && !alternatePath.trim())
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

      {(latestKnownRestore || restoreHistoryLoading || restoreHistory.length > 0) ? (
        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div ref={latestRestoreRef} data-testid="restore-latest-job" className="scroll-mt-4 rounded-lg border bg-card p-5 shadow-xs">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">{t('restoreWizard.latestRestoreJob')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('restoreWizard.statusAndResultDetailsForTheMostRecently')} </p>
              </div>
              {latestKnownRestore?.id ? (
                <div className="flex items-center gap-2">
                  {isCancellableFileRestore(latestKnownRestore) ? (
                    <button
                      type="button"
                      onClick={() => void handleCancelRestore(latestKnownRestore.id)}
                      disabled={cancellingRestoreId === latestKnownRestore.id}
                      className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {cancellingRestoreId === latestKnownRestore.id
                        ? t('restoreWizard.cancellingRestore')
                        : t('restoreWizard.cancelRestore')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void fetchRestoreJob(latestKnownRestore.id)}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('restoreWizard.refresh')} </button>
                </div>
              ) : null}
            </div>

            {latestKnownRestore ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restoreWizard.status')}</p>
                    <p className="mt-2 text-sm font-semibold capitalize text-foreground">{latestKnownRestore.status}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restoreWizard.created')}</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{formatTimestamp(latestKnownRestore.createdAt)}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restoreWizard.restoredFiles')}</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{latestKnownRestore.restoredFiles ?? '--'}</p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restoreWizard.restoredSize')}</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">{formatBytes(latestKnownRestore.restoredSize)}</p>
                  </div>
                </div>

                {latestKnownRestore.errorSummary ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{latestKnownRestore.errorSummary}</span>
                    </div>
                  </div>
                ) : null}

                {Array.isArray(latestKnownRestore.resultDetails?.warnings) && latestKnownRestore.resultDetails.warnings.length > 0 ? (
                  <div className="rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-medium">{t('restoreWizard.warnings')}</p>
                        <ul className="mt-1 space-y-1 text-xs">
                          {latestKnownRestore.resultDetails.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ) : null}

                <RestoreResultNotices result={latestKnownRestore.resultDetails} showUnattestedWarning={false} />

                <div className="grid gap-3">
                  <div className="rounded-md border border-dashed bg-muted/20 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restoreWizard.commandTarget')}</p>
                    <p className="mt-2 text-xs text-foreground">{t('restoreWizard.command')} {latestKnownRestore.commandId ?? '--'}</p>
                    <p className="mt-1 text-xs text-foreground">{t('restoreWizard.targetPath')} {latestKnownRestore.targetPath ?? t('restoreWizard.stagingFolder')}</p>
                    <p className="mt-1 text-xs text-foreground">{t('restoreWizard.completed')} {formatTimestamp(latestKnownRestore.completedAt)}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                {t('restoreWizard.noRestoreHistoryYetStartARestoreTo')} </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-xs">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-foreground">{t('restoreWizard.recentRestoreHistory')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('restoreWizard.mostRecentRestoreJobsForThisOrganization')} </p>
              </div>
              {restoreHistoryLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>

            <div className="mt-4 space-y-3">
              {restoreHistory.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  {t('restoreWizard.noRestoreHistoryYet')} </div>
              ) : (
                restoreHistory.map((job) => {
                  const isFailed = `${job.status}`.toLowerCase().includes('fail');
                  const isRunning = ['pending', 'running'].includes(`${job.status}`.toLowerCase());
                  return (
                    <div key={job.id} className="rounded-md border px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">
                            {job.deviceName ?? t('restoreWizard.unknownDevice')}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {restoreKindLabel(job)} · {formatTimestamp(job.createdAt)}
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
                        <span>{t('restoreWizard.files2')} {job.restoredFiles ?? '--'}</span>
                        <span>{t('restoreWizard.size')} {formatBytes(job.restoredSize)}</span>
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
