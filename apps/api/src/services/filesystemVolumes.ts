/**
 * Which of a device's disks can be scanned and cleaned, and what we already
 * know about each (spec §5.1).
 *
 * Source of truth is `device_disks`, the inventory the agent already reports
 * and `GET /devices/:id/disks` already serves. This module adds the two things
 * the disk-cleanup surface needs on top of it: the NORMALISED scan path that
 * keys every snapshot and scan-state row, and the per-volume state that makes
 * a volume chip worth looking at.
 */
import { eq } from 'drizzle-orm';
import { normalizeScanPath, osRootScanPath } from '@breeze/shared';
import { db } from '../db';
import { deviceDisks } from '../db/schema';
import {
  buildCleanupPreview,
  getFilesystemScanState,
  getLatestFilesystemCleanupSnapshot,
  readCheckpointPendingDirectories,
} from './filesystemAnalysis';

/**
 * Filesystem types a disk-cleanup scan must never walk (spec §5.1).
 *
 * Read-only media (`cdfs`, `udf`, `iso9660`, `squashfs`) free nothing. Memory
 * filesystems (`tmpfs`, `devtmpfs`) vanish on reboot and "reclaiming" them is
 * meaningless. Kernel filesystems (`proc`, `sysfs`) are not files. Container
 * and network mounts (`overlay`, `nfs`, `nfs4`, `cifs`, `smbfs`, `9p`,
 * `autofs`, and every `fuse*`) are someone else's storage: deleting through
 * them frees space on a machine that is not the one being cleaned, which is
 * the cross-volume mistake this whole wave exists to stop.
 */
export const NON_SCANNABLE_FS_TYPES: ReadonlySet<string> = new Set([
  'cdfs',
  'udf',
  'iso9660',
  'squashfs',
  'tmpfs',
  'devtmpfs',
  'overlay',
  'nfs',
  'nfs4',
  'cifs',
  'smbfs',
  '9p',
  'autofs',
  'proc',
  'sysfs',
]);

/**
 * `listFilesystemVolumes` issues two queries per volume, so the list is
 * bounded. A real endpoint has one to four fixed volumes; a Linux box with a
 * pathological mount table could otherwise fan one GET into hundreds of
 * round-trips.
 */
export const MAX_VOLUMES_PER_DEVICE = 24;

export type FilesystemVolume = {
  /** Exactly what the agent reported, so the UI can show the operator's own string. */
  mountPoint: string;
  /** The normalised key: what `scan_path` holds and what `POST /scan` sends. */
  scanPath: string;
  fsType: string | null;
  /** Null when the device has reported no disk row for this volume. */
  totalGb: number | null;
  usedGb: number | null;
  freeGb: number | null;
  usedPercent: number | null;
  isOsRoot: boolean;
  scanState: {
    lastRunMode: string;
    lastBaselineCompletedAt: string | null;
    hasCheckpoint: boolean;
  } | null;
  latestSnapshot: {
    id: string;
    capturedAt: string;
    partial: boolean;
    cleanupEstimateBytes: number;
  } | null;
};

export function isScannableVolume(
  volume: { mountPoint?: string | null; fsType?: string | null },
  osType: unknown,
): boolean {
  const mountPoint = typeof volume.mountPoint === 'string' ? volume.mountPoint.trim() : '';
  if (mountPoint.length === 0) return false;

  // A UNC share is another machine's disk. `normalizeScanPath` preserves the
  // two leading separators precisely so this check can see them; POSIX network
  // mounts have no such marker and are caught by fsType below.
  if (normalizeScanPath(osType, mountPoint).startsWith('\\\\')) return false;

  const fsType = typeof volume.fsType === 'string' ? volume.fsType.trim().toLowerCase() : '';
  // An agent that does not populate fsType still reported a real mount point.
  // Refusing on a missing label would hide genuine fixed volumes.
  if (fsType.length === 0) return true;
  if (fsType.startsWith('fuse')) return false;
  return !NON_SCANNABLE_FS_TYPES.has(fsType);
}

type VolumeBase = Omit<FilesystemVolume, 'scanState' | 'latestSnapshot'>;

export async function listFilesystemVolumes(
  deviceId: string,
  osType: unknown,
): Promise<FilesystemVolume[]> {
  const rows = await db
    .select({
      mountPoint: deviceDisks.mountPoint,
      fsType: deviceDisks.fsType,
      totalGb: deviceDisks.totalGb,
      usedGb: deviceDisks.usedGb,
      freeGb: deviceDisks.freeGb,
      usedPercent: deviceDisks.usedPercent,
    })
    .from(deviceDisks)
    .where(eq(deviceDisks.deviceId, deviceId));

  const osRoot = osRootScanPath(osType);
  const byScanPath = new Map<string, VolumeBase>();

  for (const row of rows) {
    if (!isScannableVolume(row, osType)) continue;
    const scanPath = normalizeScanPath(osType, row.mountPoint);
    // Two rows can normalise onto one volume (`C:\` and `c:/`). First wins:
    // they describe the same disk, so the figures are the same either way.
    if (byScanPath.has(scanPath)) continue;
    byScanPath.set(scanPath, {
      mountPoint: row.mountPoint,
      scanPath,
      fsType: row.fsType ?? null,
      totalGb: row.totalGb,
      usedGb: row.usedGb,
      freeGb: row.freeGb,
      usedPercent: row.usedPercent,
      isOsRoot: scanPath === osRoot,
    });
  }

  // The OS root is always offerable, even on a device that has never reported
  // a disk inventory — otherwise the tab has nothing to scan and the operator
  // cannot bootstrap one. Capacity stays NULL rather than zero: the scan
  // route's delta check reads null as "no delta available, take a baseline",
  // and a fabricated 0% would instead read as a huge drop.
  if (!byScanPath.has(osRoot)) {
    byScanPath.set(osRoot, {
      mountPoint: osRoot,
      scanPath: osRoot,
      fsType: null,
      totalGb: null,
      usedGb: null,
      freeGb: null,
      usedPercent: null,
      isOsRoot: true,
    });
  }

  const ordered = Array.from(byScanPath.values())
    .sort((a, b) => {
      if (a.isOsRoot !== b.isOsRoot) return a.isOsRoot ? -1 : 1;
      return a.scanPath.localeCompare(b.scanPath);
    })
    .slice(0, MAX_VOLUMES_PER_DEVICE);

  return Promise.all(ordered.map(async (volume): Promise<FilesystemVolume> => {
    const [state, snapshot] = await Promise.all([
      getFilesystemScanState(deviceId, volume.scanPath),
      getLatestFilesystemCleanupSnapshot(deviceId, volume.scanPath),
    ]);

    return {
      ...volume,
      scanState: state
        ? {
            lastRunMode: state.lastRunMode,
            lastBaselineCompletedAt: state.lastBaselineCompletedAt
              ? state.lastBaselineCompletedAt.toISOString()
              : null,
            hasCheckpoint: readCheckpointPendingDirectories(state.checkpoint, 1).length > 0,
          }
        : null,
      latestSnapshot: snapshot
        ? {
            id: snapshot.id,
            capturedAt: snapshot.capturedAt.toISOString(),
            partial: snapshot.partial,
            cleanupEstimateBytes: buildCleanupPreview(snapshot).estimatedBytes,
          }
        : null,
    };
  }));
}
