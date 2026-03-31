import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  backupJobs: {
    id: 'backupJobs.id',
    status: 'backupJobs.status',
    configId: 'backupJobs.configId',
    backupType: 'backupJobs.backupType',
  },
  backupSnapshots: {
    id: 'backupSnapshots.id',
    jobId: 'backupSnapshots.jobId',
    snapshotId: 'backupSnapshots.snapshotId',
  },
  backupSnapshotFiles: {
    snapshotDbId: 'backupSnapshotFiles.snapshotDbId',
  },
}));

vi.mock('../db/schema/applicationBackup', () => ({
  backupChains: {
    id: 'backupChains.id',
    orgId: 'backupChains.orgId',
    deviceId: 'backupChains.deviceId',
    configId: 'backupChains.configId',
    chainType: 'backupChains.chainType',
    targetName: 'backupChains.targetName',
    targetId: 'backupChains.targetId',
    fullSnapshotId: 'backupChains.fullSnapshotId',
    chainMetadata: 'backupChains.chainMetadata',
  },
}));

vi.mock('../jobs/backupRetention', () => ({
  applyGfsTagsToSnapshot: vi.fn(),
  computeExpiresAt: vi.fn(),
  resolveGfsConfigForJob: vi.fn(),
}));

import { db } from '../db';
import {
  applyBackupCommandResultToJob,
  markBackupJobFailedIfInFlight,
} from './backupResultPersistence';

describe('backup result persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('ignores stale backup job results when the job is no longer in flight', async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const result = await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    expect(result).toEqual({
      applied: false,
      snapshotDbId: null,
      providerSnapshotId: 'provider-snap-1',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('marks a backup job failed only while it is still pending or running', async () => {
    const returning = vi.fn().mockResolvedValueOnce([{ id: 'job-1' }]).mockResolvedValueOnce([]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning,
        }),
      }),
    } as any);

    await expect(markBackupJobFailedIfInFlight('job-1', 'boom')).resolves.toBe(true);
    await expect(markBackupJobFailedIfInFlight('job-1', 'boom')).resolves.toBe(false);
  });
});
