import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../db/schema', () => ({
  deviceDisks: { deviceId: { name: 'device_id' } },
}));
vi.mock('./filesystemAnalysis', () => ({
  getFilesystemScanState: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(() => []),
  buildCleanupPreview: vi.fn(() => ({ estimatedBytes: 0 })),
}));

import { db } from '../db';
import {
  buildCleanupPreview,
  getFilesystemScanState,
  getLatestFilesystemCleanupSnapshot,
  readCheckpointPendingDirectories,
} from './filesystemAnalysis';
import { isScannableVolume, listFilesystemVolumes, NON_SCANNABLE_FS_TYPES } from './filesystemVolumes';

function mockDisks(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.mocked(getFilesystemScanState).mockResolvedValue(null as never);
  vi.mocked(getLatestFilesystemCleanupSnapshot).mockResolvedValue(null as never);
  vi.mocked(readCheckpointPendingDirectories).mockReturnValue([]);
  vi.mocked(buildCleanupPreview).mockReturnValue({ estimatedBytes: 0 } as never);
});

describe('isScannableVolume (spec §5.1)', () => {
  it('accepts an ordinary fixed volume on every OS', () => {
    expect(isScannableVolume({ mountPoint: 'C:\\', fsType: 'NTFS' }, 'windows')).toBe(true);
    expect(isScannableVolume({ mountPoint: '/', fsType: 'apfs' }, 'macos')).toBe(true);
    expect(isScannableVolume({ mountPoint: '/data', fsType: 'ext4' }, 'linux')).toBe(true);
  });

  it('refuses every filesystem type in NON_SCANNABLE_FS_TYPES, case-insensitively', () => {
    for (const fsType of NON_SCANNABLE_FS_TYPES) {
      expect(isScannableVolume({ mountPoint: '/mnt/x', fsType }, 'linux')).toBe(false);
      expect(isScannableVolume({ mountPoint: '/mnt/x', fsType: fsType.toUpperCase() }, 'linux')).toBe(false);
    }
  });

  it('refuses every fuse* variant by prefix, not by exact name', () => {
    for (const fsType of ['fuse', 'fuseblk', 'fuse.sshfs', 'fuse.gvfsd-fuse', 'FUSE.rclone']) {
      expect(isScannableVolume({ mountPoint: '/mnt/x', fsType }, 'linux')).toBe(false);
    }
  });

  it('refuses a Windows UNC mount point — that is another machine\u2019s disk', () => {
    expect(isScannableVolume({ mountPoint: '\\\\fileserver\\share', fsType: 'NTFS' }, 'windows')).toBe(false);
    expect(isScannableVolume({ mountPoint: '//fileserver/share', fsType: 'NTFS' }, 'windows')).toBe(false);
  });

  it('refuses an empty or missing mount point', () => {
    expect(isScannableVolume({ mountPoint: '', fsType: 'ext4' }, 'linux')).toBe(false);
    expect(isScannableVolume({ mountPoint: '   ', fsType: 'ext4' }, 'linux')).toBe(false);
    expect(isScannableVolume({ mountPoint: null, fsType: 'ext4' }, 'linux')).toBe(false);
  });

  it('accepts a volume whose filesystem type the agent did not report', () => {
    // The OS told us a mount point exists; refusing on a missing label would
    // hide real fixed volumes on agents that do not populate fsType.
    expect(isScannableVolume({ mountPoint: 'D:\\', fsType: null }, 'windows')).toBe(true);
    expect(isScannableVolume({ mountPoint: 'D:\\', fsType: '' }, 'windows')).toBe(true);
  });
});

describe('listFilesystemVolumes (spec §5.1)', () => {
  it('normalises the mount point into a scan path and flags the OS root', async () => {
    mockDisks([
      { mountPoint: 'c:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
      { mountPoint: 'd:/', fsType: 'NTFS', totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes.map((v) => v.scanPath)).toEqual(['C:\\', 'D:\\']);
    expect(volumes[0]!.isOsRoot).toBe(true);
    expect(volumes[1]!.isOsRoot).toBe(false);
    expect(volumes[0]!.mountPoint).toBe('c:\\');   // the raw string stays visible
    expect(volumes[1]!.usedPercent).toBe(5);
  });

  it('drops non-scannable rows', async () => {
    mockDisks([
      { mountPoint: '/', fsType: 'ext4', totalGb: 100, usedGb: 50, freeGb: 50, usedPercent: 50 },
      { mountPoint: '/run', fsType: 'tmpfs', totalGb: 8, usedGb: 1, freeGb: 7, usedPercent: 12 },
      { mountPoint: '/mnt/nas', fsType: 'nfs4', totalGb: 9000, usedGb: 1, freeGb: 8999, usedPercent: 1 },
      { mountPoint: '/media/cd', fsType: 'iso9660', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 100 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'linux');

    expect(volumes.map((v) => v.scanPath)).toEqual(['/']);
  });

  it('always offers the OS root, even when the device reported no disks at all', async () => {
    mockDisks([]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes).toHaveLength(1);
    expect(volumes[0]!.scanPath).toBe('C:\\');
    expect(volumes[0]!.isOsRoot).toBe(true);
    // Capacity is genuinely unknown here, and must NOT read as a full disk or
    // an empty one — the scan route's delta check depends on null meaning
    // "no delta available, take a baseline".
    expect(volumes[0]!.totalGb).toBeNull();
    expect(volumes[0]!.usedPercent).toBeNull();
  });

  it('de-duplicates two disk rows that normalise onto the same volume', async () => {
    mockDisks([
      { mountPoint: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
      { mountPoint: 'c:/', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes).toHaveLength(1);
    expect(volumes[0]!.scanPath).toBe('C:\\');
  });

  it('orders the OS root first and the rest by scan path', async () => {
    mockDisks([
      { mountPoint: '/data', fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1 },
      { mountPoint: '/backup', fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1 },
      { mountPoint: '/', fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1 },
    ]);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'linux');

    expect(volumes.map((v) => v.scanPath)).toEqual(['/', '/backup', '/data']);
  });

  it('attaches per-volume scan state and the latest snapshot, keyed on that volume', async () => {
    mockDisks([
      { mountPoint: 'C:\\', fsType: 'NTFS', totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80 },
      { mountPoint: 'D:\\', fsType: 'NTFS', totalGb: 2000, usedGb: 100, freeGb: 1900, usedPercent: 5 },
    ]);
    vi.mocked(getFilesystemScanState).mockImplementation(async (_deviceId, scanPath) =>
      (scanPath === 'C:\\'
        ? { lastRunMode: 'incremental', lastBaselineCompletedAt: new Date('2026-09-18T10:00:00Z'), checkpoint: { pendingDirs: [{ path: 'C:\\x', depth: 1 }] } }
        : null) as never,
    );
    vi.mocked(readCheckpointPendingDirectories).mockImplementation((value) =>
      (value && typeof value === 'object' && 'pendingDirs' in (value as object) ? [{ path: 'C:\\x', depth: 1 }] : []) as never,
    );
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockImplementation(async (_deviceId, scanPath) =>
      (scanPath === 'D:\\'
        ? { id: 'snap-d', scanPath: 'D:\\', capturedAt: new Date('2026-09-19T09:00:00Z'), partial: true, cleanupCandidates: [] }
        : null) as never,
    );
    vi.mocked(buildCleanupPreview).mockReturnValue({ estimatedBytes: 4096 } as never);

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'windows');

    expect(volumes[0]!.scanState).toEqual({
      lastRunMode: 'incremental',
      lastBaselineCompletedAt: '2026-09-18T10:00:00.000Z',
      hasCheckpoint: true,
    });
    expect(volumes[0]!.latestSnapshot).toBeNull();
    expect(volumes[1]!.scanState).toBeNull();
    expect(volumes[1]!.latestSnapshot).toEqual({
      id: 'snap-d',
      capturedAt: '2026-09-19T09:00:00.000Z',
      partial: true,
      cleanupEstimateBytes: 4096,
    });
  });

  it('caps the list so a pathological mount table cannot fan out unbounded queries', async () => {
    mockDisks(
      Array.from({ length: 60 }, (_unused, index) => ({
        mountPoint: `/mnt/vol${String(index).padStart(3, '0')}`,
        fsType: 'ext4', totalGb: 1, usedGb: 1, freeGb: 0, usedPercent: 1,
      })),
    );

    const volumes = await listFilesystemVolumes(DEVICE_ID, 'linux');

    expect(volumes).toHaveLength(24);
    // The OS root is synthesised and sorts first, so it survives the cap.
    expect(volumes[0]!.scanPath).toBe('/');
  });
});
