import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, FolderOpen, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { osRootScanPath } from '@breeze/shared';
import { showToast } from '@/components/shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import '../../lib/i18n';
import type { OSType } from './DeviceList';
import VolumePicker from './filesystem/VolumePicker';
import { useFilesystemVolumes } from './filesystem/useFilesystemVolumes';
import { useFilesystemSnapshot } from './filesystem/useFilesystemSnapshot';
import { useCommandPoll } from './filesystem/useCommandPoll';
import SnapshotPanels from './filesystem/SnapshotPanels';
import CleanupPanel from './filesystem/CleanupPanel';
import CleanupRunHistory from './filesystem/CleanupRunHistory';
import type { FilesystemCleanupPreview } from './filesystem/filesystemTabUtils';

/**
 * Disk Cleanup tab (spec §8).
 *
 * This file used to be 958 lines and stopped at a preview: the Execute that
 * finished the job lived in File Manager, re-derived its own candidates, and
 * posted no `cleanupRunId`. It is now a composer over `./filesystem/` —
 * volume picker (W02) → scan controls → snapshot panels → cleanup panel →
 * run history — and every piece is independently tested.
 */

type DeviceFilesystemTabProps = {
  deviceId: string;
  osType: OSType;
  onOpenFiles?: () => void;
};

const SCAN_TIMEOUT_SECONDS = 300;

export default function DeviceFilesystemTab({
  deviceId,
  osType,
  onOpenFiles,
}: DeviceFilesystemTabProps) {
  const { t } = useTranslation('devices');
  const volumes = useFilesystemVolumes(deviceId);
  // W02's hook is stateless about selection, so the composer owns it — the
  // same shape W02's own mount used before the split.
  const [selectedScanPath, setSelectedScanPath] = useState<string>(() => osRootScanPath(osType));
  useEffect(() => {
    if (volumes.volumes.length === 0) return;
    if (volumes.volumes.some((volume) => volume.scanPath === selectedScanPath)) return;
    const osVolume = volumes.volumes.find((volume) => volume.isOsRoot) ?? volumes.volumes[0]!;
    setSelectedScanPath(osVolume.scanPath);
  }, [volumes.volumes, selectedScanPath]);
  const selectedVolume = volumes.volumes.find((volume) => volume.scanPath === selectedScanPath) ?? null;
  const scanPath = selectedScanPath;
  const snapshotState = useFilesystemSnapshot(deviceId, scanPath);
  const scanPoll = useCommandPoll(deviceId);

  const [busy, setBusy] = useState<'scan' | 'preview' | 'refresh' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilesystemCleanupPreview | null>(null);
  const [historyToken, setHistoryToken] = useState(0);

  const runAnalyze = useCallback(async () => {
    if (!scanPath) return;
    setBusy('scan');
    setActionError(null);
    scanPoll.reset();
    try {
      const commandId = await runAction<string>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/scan`, {
          method: 'POST',
          body: JSON.stringify({
            path: scanPath,
            maxDepth: 32,
            topFiles: 50,
            topDirs: 30,
            maxEntries: 10_000_000,
            workers: 6,
            timeoutSeconds: SCAN_TIMEOUT_SECONDS,
          }),
        }),
        errorFallback: t('deviceFilesystemTab.filesystemScanFailed'),
        parseSuccess: (body) => {
          const id = (body as { data?: { commandId?: unknown } })?.data?.commandId;
          if (typeof id !== 'string' || !id) throw new Error('missing commandId');
          return id;
        },
      });

      await scanPoll.poll(commandId, Math.max(120_000, (SCAN_TIMEOUT_SECONDS + 90) * 1000));
      setPreview(null);
      await snapshotState.reload({ silent: true });
      await volumes.reload();
      scanPoll.reset();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        const message = err instanceof Error ? err.message : t('deviceFilesystemTab.filesystemScanFailed');
        setActionError(message);
        showToast({ type: 'error', message });
      } else {
        setActionError(err.message);
      }
      scanPoll.reset();
    } finally {
      setBusy(null);
    }
  }, [deviceId, scanPath, scanPoll, snapshotState, t, volumes]);

  const runCleanupPreview = useCallback(async () => {
    if (!scanPath) return;
    setBusy('preview');
    setActionError(null);
    try {
      const data = await runAction<FilesystemCleanupPreview>({
        request: () => fetchWithAuth(`/devices/${deviceId}/filesystem/cleanup-preview`, {
          method: 'POST',
          body: JSON.stringify({ path: scanPath }),
        }),
        errorFallback: t('deviceFilesystemTab.cleanupPreviewFailed'),
        parseSuccess: (body) => (body as { data: FilesystemCleanupPreview }).data,
      });
      setPreview(data);
      setHistoryToken((value) => value + 1);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('deviceFilesystemTab.cleanupPreviewFailed') });
      }
      setActionError(
        err instanceof Error ? err.message : t('deviceFilesystemTab.cleanupPreviewFailed'),
      );
    } finally {
      setBusy(null);
    }
  }, [deviceId, scanPath, t]);

  const refresh = useCallback(async () => {
    setBusy('refresh');
    setActionError(null);
    try {
      await Promise.all([snapshotState.reload({ silent: true }), volumes.reload()]);
      setHistoryToken((value) => value + 1);
    } finally {
      setBusy(null);
    }
  }, [snapshotState, volumes]);

  const onExecuted = useCallback(() => {
    // Keep the pinned preview mounted so CleanupPanel can display its result.
    setHistoryToken((value) => value + 1);
    void snapshotState.reload({ silent: true });
    void volumes.reload();
  }, [snapshotState, volumes]);

  const bannerError = actionError ?? snapshotState.error ?? volumes.error;

  return (
    <div className="space-y-6" data-testid="device-filesystem-tab">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 data-testid="filesystem-heading" className="text-lg font-semibold">{t('deviceFilesystemTab.title')}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="filesystem-analyze"
              onClick={() => { void runAnalyze(); }}
              disabled={busy !== null || !scanPath}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === 'scan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {t('deviceFilesystemTab.analyzeNow')}
            </button>
            <button
              type="button"
              data-testid="filesystem-cleanup-preview"
              onClick={() => { void runCleanupPreview(); }}
              disabled={busy !== null || !snapshotState.snapshot}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t('deviceFilesystemTab.cleanupPreview')}
            </button>
            <button
              type="button"
              data-testid="filesystem-refresh"
              onClick={() => { void refresh(); }}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'animate-spin' : ''}`} />
              {t('deviceFilesystemTab.refresh')}
            </button>
            {onOpenFiles && (
              <button
                type="button"
                data-testid="filesystem-open-files"
                onClick={() => onOpenFiles()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('deviceFilesystemTab.openFileManager')}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4">
          <VolumePicker
            volumes={volumes.volumes}
            selectedScanPath={selectedScanPath}
            onSelect={setSelectedScanPath}
            loading={volumes.loading}
            error={volumes.error}
          />
        </div>

        {bannerError && (
          <div
            data-testid="filesystem-error-banner"
            role="alert"
            className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              <span>{bannerError}</span>
            </div>
          </div>
        )}

        {scanPoll.status && (
          <div
            data-testid="filesystem-scan-banner"
            role="status"
            className="mt-4 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800"
          >
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t('deviceFilesystemTab.scanRunning', { status: scanPoll.status })}</span>
            </div>
          </div>
        )}

        {snapshotState.loading ? (
          <div className="mt-4 flex items-center justify-center py-8" data-testid="filesystem-loading">
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('deviceFilesystemTab.loadingDiskIntelligence')}
              </p>
            </div>
          </div>
        ) : snapshotState.snapshot ? (
          <div className="mt-4">
            <SnapshotPanels
              snapshot={snapshotState.snapshot}
              thresholdEvents={snapshotState.thresholdEvents}
            />
          </div>
        ) : (
          <div
            data-testid="filesystem-empty-state"
            className="mt-4 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
          >
            {t('deviceFilesystemTab.noFilesystemSnapshotYetRunAnalyze')}
          </div>
        )}
      </div>

      <CleanupPanel
        deviceId={deviceId}
        volumeLabel={selectedVolume?.mountPoint ?? scanPath}
        preview={preview}
        onExecuted={onExecuted}
      />

      <CleanupRunHistory deviceId={deviceId} refreshToken={historyToken} />
    </div>
  );
}
