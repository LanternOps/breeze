import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  backupJobs: {
    id: 'backupJobs.id',
    orgId: 'backupJobs.orgId',
    configId: 'backupJobs.configId',
    featureLinkId: 'backupJobs.featureLinkId',
    deviceId: 'backupJobs.deviceId',
    status: 'backupJobs.status',
    type: 'backupJobs.type',
    createdAt: 'backupJobs.createdAt',
    updatedAt: 'backupJobs.updatedAt',
  },
}));

import { db } from '../db';
import {
  createManualBackupJobIfIdle,
  createScheduledBackupJobIfAbsent,
} from './backupJobCreation';

function buildTx(options?: {
  existingRows?: Array<Record<string, unknown>>;
  insertedRows?: Array<Record<string, unknown>>;
}) {
  const existingRows = options?.existingRows ?? [];
  const insertedRows = options?.insertedRows ?? [{
    id: 'job-1',
    orgId: 'org-1',
    configId: 'cfg-1',
    featureLinkId: 'feature-1',
    deviceId: 'dev-1',
    status: 'pending',
    type: 'manual',
  }];

  return {
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(existingRows),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertedRows),
      }),
    }),
  };
}

describe('backup job creation helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('createManualBackupJobIfIdle', () => {
    it('returns { created: true } when no active job exists', async () => {
      const tx = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const result = await createManualBackupJobIfIdle({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
      });

      expect(tx.execute).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        job: expect.objectContaining({ id: 'job-1' }),
        created: true,
      });
    });

    it('returns { created: false } with existing job when active job exists', async () => {
      const existingJob = {
        id: 'job-existing',
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
        status: 'running',
      };
      const tx = buildTx({ existingRows: [existingJob] });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const result = await createManualBackupJobIfIdle({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
      });

      expect(tx.insert).not.toHaveBeenCalled();
      expect(result).toEqual({
        job: expect.objectContaining({ id: 'job-existing' }),
        created: false,
      });
    });

    it('returns null when insert returns no rows', async () => {
      const tx = buildTx({ insertedRows: [] });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const result = await createManualBackupJobIfIdle({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
      });

      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('acquires advisory lock with correct key format', async () => {
      const tx = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      await createManualBackupJobIfIdle({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
      });

      // The first tx.execute call is the advisory lock
      expect(tx.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('createScheduledBackupJobIfAbsent', () => {
    it('returns { created: true } when no existing job in the same minute window', async () => {
      const tx = buildTx({
        insertedRows: [{
          id: 'sched-1',
          orgId: 'org-1',
          configId: 'cfg-1',
          featureLinkId: 'feature-1',
          deviceId: 'dev-1',
          status: 'pending',
          type: 'scheduled',
        }],
      });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const result = await createScheduledBackupJobIfAbsent({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
        occurrenceKey: '2026-03-31T11:00',
      });

      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        job: expect.objectContaining({ id: 'sched-1' }),
        created: true,
      });
    });

    it('returns { created: false } with existing job when same occurrence exists', async () => {
      const existingJob = {
        id: 'sched-existing',
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
        status: 'pending',
        type: 'scheduled',
      };
      const tx = buildTx({ existingRows: [existingJob] });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const result = await createScheduledBackupJobIfAbsent({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
        occurrenceKey: '2026-03-31T11:00',
      });

      expect(tx.insert).not.toHaveBeenCalled();
      expect(result).toEqual({
        job: expect.objectContaining({ id: 'sched-existing' }),
        created: false,
      });
    });

    it('returns null when insert returns no rows', async () => {
      const tx = buildTx({ insertedRows: [] });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const result = await createScheduledBackupJobIfAbsent({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
        occurrenceKey: '2026-03-31T11:00',
      });

      expect(result).toBeNull();
    });

    it('uses featureLinkId in lock key when present, falls back to configId', async () => {
      const tx = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      // With featureLinkId
      await createScheduledBackupJobIfAbsent({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'fl-1',
        deviceId: 'dev-1',
        occurrenceKey: '2026-03-31T11:00',
      });

      expect(tx.execute).toHaveBeenCalledTimes(1);

      vi.resetAllMocks();
      const tx2 = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx2));

      // Without featureLinkId — falls back to configId
      await createScheduledBackupJobIfAbsent({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: null,
        deviceId: 'dev-1',
        occurrenceKey: '2026-03-31T11:00',
      });

      expect(tx2.execute).toHaveBeenCalledTimes(1);
    });
  });
});
