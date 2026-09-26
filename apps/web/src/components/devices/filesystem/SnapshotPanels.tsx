/**
 * The read-only half of the Disk Cleanup tab (spec §8): summary tiles, scan
 * summary, collected signals, temp accumulation, recent threshold triggers,
 * and the largest files/directories.
 *
 * Content is unchanged from the tab it was lifted out of, with three fixes:
 * `tempAccumulation` is rendered (the agent has always collected it and the
 * API has always returned it — nothing displayed it), every list row keys on
 * a stable synthetic id rather than an optional `path`, and the partial-scan
 * banner is a `role="status"` live region instead of a silent div.
 */

import { useMemo } from 'react';
import { AlertCircle, Clock, FolderOpen, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/i18n/format';
import '@/lib/i18n';
import {
  collapseAncestorDirectories,
  formatBytes,
  formatDateTime,
  type FilesystemSnapshot,
  type ThresholdEvent,
} from './filesystemTabUtils';

const statusBadgeClasses: Record<string, string> = {
  pending: 'bg-gray-500/15 text-gray-700 border-gray-500/30',
  sent: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  completed: 'bg-green-500/15 text-green-700 border-green-500/30',
  failed: 'bg-red-500/15 text-red-700 border-red-500/30',
};

type Props = {
  snapshot: FilesystemSnapshot;
  thresholdEvents: ThresholdEvent[];
};

export default function SnapshotPanels({ snapshot, thresholdEvents }: Props) {
  const { t } = useTranslation('devices');

  const summary = snapshot.summary ?? {};
  const largestFiles = (snapshot.topLargestFiles ?? []).slice(0, 8);
  // Memoised at the call site, per spec §8 — the collapse is O(n²) over up to
  // 30 directories and re-running it on every keystroke elsewhere is waste.
  const largestDirectories = useMemo(
    () => collapseAncestorDirectories(snapshot.topLargestDirectories ?? [], 8),
    [snapshot.topLargestDirectories],
  );
  const tempAccumulation = snapshot.tempAccumulation ?? [];
  const totalTrashBytes = (snapshot.trashUsage ?? []).reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

  return (
    <div className="space-y-4" data-testid="filesystem-snapshot-panels">
      {snapshot.partial && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>
              {t('deviceFilesystemTab.partialScanResult')}
              {snapshot.reason ? `: ${snapshot.reason}` : '.'}
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.lastScan')}</p>
          <p className="mt-1 text-sm font-medium">{formatDateTime(snapshot.capturedAt)}</p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.trigger')}</p>
          <p className="mt-1 text-sm font-medium">
            {snapshot.trigger === 'threshold'
              ? t('deviceFilesystemTab.threshold')
              : t('deviceFilesystemTab.onDemand')}
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.runMode')}</p>
          <p className="mt-1 text-sm font-medium">
            {snapshot.scanMode === 'incremental'
              ? t('deviceFilesystemTab.incremental')
              : t('deviceFilesystemTab.baseline')}
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.scanPath')}</p>
          <p className="mt-1 truncate text-sm font-medium">
            {snapshot.scanPath ?? snapshot.path ?? '-'}
          </p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.scannedDataInPath')}</p>
          <p className="mt-1 text-sm font-medium">{formatBytes(summary.bytesScanned)}</p>
        </div>
        <div className="rounded-md border bg-muted/20 p-3" data-testid="filesystem-cleanup-candidates-tile">
          <p className="text-xs text-muted-foreground">{t('deviceFilesystemTab.cleanupCandidates')}</p>
          {/* Issue #6376: a bare count left the operator with no idea whether
              cleaning was worth doing. The bytes are already in the snapshot. */}
          <p className="mt-1 text-sm font-medium">
            {formatNumber(snapshot.cleanupCandidates?.length ?? 0)}
            {' · '}
            {formatBytes(
              (snapshot.cleanupCandidates ?? []).reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0),
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border p-3" data-testid="filesystem-scan-summary">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.scanSummary')}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">{t('deviceFilesystemTab.filesScanned')}</span>
            <span className="text-right font-medium">{formatNumber(summary.filesScanned ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.directoriesScanned')}</span>
            <span className="text-right font-medium">{formatNumber(summary.dirsScanned ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.maxDepthReached')}</span>
            <span className="text-right font-medium">{summary.maxDepthReached ?? 0}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.permissionDenials')}</span>
            <span className="text-right font-medium">{summary.permissionDeniedCount ?? 0}</span>
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-collected-signals">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.collectedSignals')}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted-foreground">{t('deviceFilesystemTab.oldDownloads')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.oldDownloads?.length ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.unrotatedLogs')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.unrotatedLogs?.length ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.trashSize')}</span>
            <span className="text-right font-medium">{formatBytes(totalTrashBytes)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.duplicateGroups')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.duplicateCandidates?.length ?? 0)}</span>
            <span className="text-muted-foreground">{t('deviceFilesystemTab.scanErrors')}</span>
            <span className="text-right font-medium">{formatNumber(snapshot.errors?.length ?? 0)}</span>
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-temp-accumulation">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" />
            {t('deviceFilesystemTab.tempAccumulation')}
          </p>
          <div className="mt-2 space-y-1">
            {tempAccumulation.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('deviceFilesystemTab.noTempAccumulationData')}
              </p>
            ) : (
              tempAccumulation.map((item, index) => (
                <div
                  key={`temp-${item.category ?? 'unknown'}-${index}`}
                  data-testid={`filesystem-temp-accumulation-${index}`}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {item.category
                      // i18n-dynamic: the category comes from the agent payload.
                      ? t(/* i18n-dynamic */ `deviceFilesystemTab.categories.${item.category}`, {
                          defaultValue: item.category,
                        })
                      : '-'}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                    {formatBytes(item.bytes)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-threshold-triggers">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {t('deviceFilesystemTab.recentThresholdTriggers')}
          </p>
          <div className="mt-2 space-y-2">
            {thresholdEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('deviceFilesystemTab.noRecentThresholdTriggeredScans')}
              </p>
            ) : (
              thresholdEvents.slice(0, 5).map((event) => (
                <div
                  key={event.id}
                  data-testid={`filesystem-threshold-event-${event.id}`}
                  className="flex items-start justify-between gap-2 rounded bg-muted/20 px-2 py-1.5 text-xs"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{event.path}</p>
                    <p className="text-muted-foreground">{formatDateTime(event.createdAt)}</p>
                  </div>
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 ${statusBadgeClasses[event.status] ?? 'bg-muted/30 text-muted-foreground border-muted'}`}
                  >
                    {event.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-largest-files">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" />
            {t('deviceFilesystemTab.largestFiles')}
          </p>
          <div className="mt-2 space-y-1">
            {largestFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('deviceFilesystemTab.noFileDataAvailable')}</p>
            ) : (
              largestFiles.map((item, index) => (
                <div
                  key={`file-${index}-${item.path ?? ''}`}
                  data-testid={`filesystem-largest-file-${index}`}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="truncate">{item.path ?? '-'}</span>
                  <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                    {formatBytes(item.sizeBytes)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border p-3" data-testid="filesystem-largest-directories">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('deviceFilesystemTab.largestDirectories')}
          </p>
          {largestDirectories.some((item) => item.estimated) && (
            <p className="mt-1 text-xs text-muted-foreground">
              ≥ {t('deviceFilesystemTab.indicatesLowerBoundSizeFromPartial')}
            </p>
          )}
          <div className="mt-2 space-y-1">
            {largestDirectories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('deviceFilesystemTab.noDirectoryDataAvailable')}
              </p>
            ) : (
              largestDirectories.map((item, index) => (
                <div
                  key={`dir-${index}-${item.path ?? ''}`}
                  data-testid={`filesystem-largest-directory-${index}`}
                  className="flex items-center justify-between gap-2 rounded bg-muted/20 px-2 py-1.5 text-sm"
                >
                  <span className="truncate">{item.path ?? '-'}</span>
                  <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                    {item.estimated ? '≥' : ''}
                    {formatBytes(item.sizeBytes)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
