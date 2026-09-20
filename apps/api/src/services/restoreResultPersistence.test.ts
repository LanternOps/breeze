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

  it('redacts secrets from agent-supplied error/stderr/warnings before persistence (#2434)', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

    const metadata = buildRestoreResultMetadata(
      'backup_restore',
      {
        status: 'failed',
        stderr: `restore stderr, key follows:\n${pem}`,
        error: `restore failed, key follows:\n${pem}`,
      },
      {
        status: 'failed',
        warnings: [`warning with key:\n${pem}`, 'plain warning'],
      }
    );

    for (const value of [metadata.error, metadata.stderr, (metadata.warnings as string[])[0]]) {
      expect(value).toContain('[PRIVATE_KEY_REDACTED]');
      expect(value).not.toContain('BEGIN RSA PRIVATE KEY');
    }
    expect((metadata.warnings as string[])[1]).toBe('plain warning');
  });

  it('redacts the agent-supplied structured error too (#2434)', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

    const metadata = buildRestoreResultMetadata(
      'backup_restore',
      { status: 'failed' },
      { status: 'failed', error: `structured error, key follows:\n${pem}` }
    );

    expect(metadata.error).toContain('[PRIVATE_KEY_REDACTED]');
    expect(metadata.error).not.toContain('BEGIN RSA PRIVATE KEY');
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
  it('clears the stale server-timeout error when a late genuine success lands (#6415)', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'restore-1' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });

    const applied = await updateRestoreJobFromResult(
      {
        id: 'restore-1',
        status: 'failed',
        targetConfig: {
          existing: true,
          error: 'Server-side timeout: no response from agent after 60 minutes',
          result: {
            status: 'failed',
            error: 'Server-side timeout: no response from agent after 60 minutes',
            timedOutBy: 'server',
          },
        },
      },
      'bmr_recover',
      {
        status: 'completed',
        result: { status: 'completed', filesRestored: 105_946, bytesRestored: 2_660_000_000 },
      }
    );

    expect(applied).toBe(true);
    const persisted = set.mock.calls[0][0] as { status: string; targetConfig: Record<string, unknown> };
    expect(persisted.status).toBe('completed');
    expect(persisted.targetConfig).not.toHaveProperty('error');
    expect(persisted.targetConfig.existing).toBe(true);
    expect(persisted.targetConfig.result).toMatchObject({ status: 'completed', filesRestored: 105_946 });
  });

  it('drops the sweep-owned top-level error even when the genuine outcome is a failure (#6415)', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'restore-1' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    updateMock.mockReturnValue({ set });

    await updateRestoreJobFromResult(
      {
        id: 'restore-1',
        status: 'failed',
        targetConfig: {
          error: 'Server-side timeout: no response from agent after 60 minutes',
          result: { status: 'failed', timedOutBy: 'server' },
        },
      },
      'bmr_recover',
      { status: 'completed', result: { status: 'failed', error: 'disk too small' } }
    );

    const persisted = set.mock.calls[0][0] as { status: string; targetConfig: Record<string, unknown> };
    expect(persisted.status).toBe('failed');
    // The sweep's guess is gone; the device's own reason is authoritative and
    // lives inside `result`, which every reader prefers.
    expect(persisted.targetConfig).not.toHaveProperty('error');
    expect(persisted.targetConfig.result).toMatchObject({ error: 'disk too small' });
  });
});
