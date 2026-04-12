import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, selectMock, restoreJobsTable } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  selectMock: vi.fn(),
  restoreJobsTable: {
    id: 'restore_jobs.id',
    status: 'restore_jobs.status',
    targetConfig: 'restore_jobs.target_config',
    commandId: 'restore_jobs.command_id',
    deviceId: 'restore_jobs.device_id',
    completedAt: 'restore_jobs.completed_at',
    restoredSize: 'restore_jobs.restored_size',
    restoredFiles: 'restore_jobs.restored_files',
    updatedAt: 'restore_jobs.updated_at',
  },
}));

vi.mock('../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  restoreJobs: restoreJobsTable,
}));

import {
  buildRestoreResultMetadata,
  updateRestoreJobFromResult,
} from './restoreResultPersistence';

describe('restore result persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('preserves the full structured restore metadata payload', () => {
    const metadata = buildRestoreResultMetadata(
      'bmr_recover',
      {
        status: 'completed',
        durationMs: 31_000,
      },
      {
        status: 'completed',
        snapshotId: 'snap-1',
        filesRestored: 42,
        bytesRestored: 4096,
        filesFailed: 1,
        failedFiles: ['/etc/hosts'],
        stagingDir: '/staging',
        stateApplied: true,
        driversInjected: 2,
        validated: true,
        vmName: 'restored-vm',
        newVmId: 'vm-1',
        vhdxPath: '/hyperv/disk.vhdx',
        bootTimeMs: 15_000,
        warnings: ['driver mismatch'],
        backgroundSyncActive: true,
        syncProgress: { percent: 85 },
        databaseName: 'customer-db',
        restoredAs: 'alternate-path',
      }
    );

    expect(metadata).toEqual({
      commandType: 'bmr_recover',
      status: 'completed',
      snapshotId: 'snap-1',
      filesRestored: 42,
      bytesRestored: 4096,
      filesFailed: 1,
      failedFiles: ['/etc/hosts'],
      stagingDir: '/staging',
      stateApplied: true,
      driversInjected: 2,
      validated: true,
      vmName: 'restored-vm',
      newVmId: 'vm-1',
      vhdxPath: '/hyperv/disk.vhdx',
      durationMs: 31_000,
      bootTimeMs: 15_000,
      warnings: ['driver mismatch'],
      backgroundSyncActive: true,
      syncProgress: { percent: 85 },
      databaseName: 'customer-db',
      restoredAs: 'alternate-path',
    });
  });

  it('updates mutable restore jobs with the persisted restore summary', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'restore-1' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });

    const applied = await updateRestoreJobFromResult(
      {
        id: 'restore-1',
        status: 'running',
        targetConfig: { existing: true },
      },
      'backup_restore',
      {
        status: 'completed',
        result: {
          status: 'partial',
          filesRestored: 20,
          bytesRestored: 1024,
          filesFailed: 2,
          failedFiles: ['/tmp/a', '/tmp/b'],
          error: 'Two files were locked',
        },
      }
    );

    expect(applied).toBe(true);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'partial',
      restoredSize: 1024,
      restoredFiles: 20,
      targetConfig: {
        existing: true,
        result: {
          commandType: 'backup_restore',
          status: 'partial',
          filesRestored: 20,
          bytesRestored: 1024,
          filesFailed: 2,
          failedFiles: ['/tmp/a', '/tmp/b'],
          error: 'Two files were locked',
        },
      },
    }));
  });
});
