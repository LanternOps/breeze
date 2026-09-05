import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(),
    select: vi.fn(),
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
    backupMode: 'backupJobs.backupMode',
    modeTargets: 'backupJobs.modeTargets',
    createdAt: 'backupJobs.createdAt',
    updatedAt: 'backupJobs.updatedAt',
  },
  devices: {
    id: 'devices.id',
    backupVersion: 'devices.backupVersion',
  },
}));

import { db } from '../db';
import {
  createManualBackupJobIfIdle,
  createScheduledBackupJobIfAbsent,
} from './backupJobCreation';

/** devices.backup_version lookup that precedes the manual advisory lock. */
function mockHelperVersion(version: string | null) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(version === undefined ? [] : [{ backupVersion: version }]),
      }),
    }),
  } as any);
}

// Every resetAllMocks() below also wipes the devices lookup; re-arm it so the
// existing tests keep exercising the queue-capable (relaxed) dedupe path.
function resetMocksWithQueueCapableHelper() {
  vi.resetAllMocks();
  mockHelperVersion('0.110.0');
}

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
    resetMocksWithQueueCapableHelper();
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

      resetMocksWithQueueCapableHelper();
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

  // Profile fan-out (spec 2026-07-13): a Server profile creates a file +
  // system_image + mssql job for the SAME device+occurrence. If the mode ever
  // drops out of the advisory-lock key or the dedupe predicate, those jobs
  // dedupe against each other and two thirds of a customer's configured
  // backups stop running — with no error anywhere. These tests pin the mode
  // into both.
  describe('mode-aware dedupe (profile fan-out)', () => {
    /** Serialized advisory-lock statement (the lock key rides in as a param). */
    function lockKeyOf(tx: ReturnType<typeof buildTx>): string {
      return JSON.stringify(vi.mocked(tx.execute).mock.calls[0]?.[0]);
    }

    /** Serialized dedupe WHERE clause, including column refs. */
    function whereTextOf(tx: ReturnType<typeof buildTx>): string {
      const where = vi.mocked(tx.select().from().where).mock.calls[0]?.[0];
      return JSON.stringify(where).toLowerCase();
    }

    it('scopes the manual lock key + dedupe predicate by mode', async () => {
      const tx = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      await createManualBackupJobIfIdle({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
        backupMode: 'system_image',
        modeTargets: { includeSystemState: true },
      });

      expect(lockKeyOf(tx)).toContain('system_image');
      expect(whereTextOf(tx)).toContain('backupmode');
    });

    it('uses a distinct lock key per mode, so every selection is retained for the device queue', async () => {
      const keys: string[] = [];
      for (const mode of ['file', 'system_image', 'mssql'] as const) {
        resetMocksWithQueueCapableHelper();
        const tx = buildTx();
        vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

        const result = await createManualBackupJobIfIdle({
          orgId: 'org-1',
          configId: 'cfg-1',
          featureLinkId: 'feature-1',
          deviceId: 'dev-1',
          backupMode: mode,
        });

        expect(result?.created).toBe(true);
        keys.push(lockKeyOf(tx));
      }

      expect(new Set(keys).size).toBe(3);
    });

    it('retains same-mode selections from different profiles on the same device', async () => {
      const keys: string[] = [];
      for (const featureLinkId of ['profile-a', 'profile-b']) {
        const tx = buildTx();
        vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
        const result = await createManualBackupJobIfIdle({
          orgId: 'org-1', configId: 'cfg-1', deviceId: 'dev-1',
          featureLinkId, backupMode: 'file', modeTargets: { paths: [featureLinkId] },
        });
        expect(result?.created).toBe(true);
        expect(whereTextOf(tx)).toContain(featureLinkId);
        expect(whereTextOf(tx)).toContain('configid');
        keys.push(lockKeyOf(tx));
      }
      expect(new Set(keys).size).toBe(2);
    });

    // A helper that predates the execution queue runs every dispatched job
    // concurrently. Relaxing the server-side guard for it would recreate the
    // exact overlap #4923 reports, so those devices keep the pre-queue
    // one-active-job-per-device+mode dedupe.
    it.each([
      ['older helper', '0.109.0'],
      ['unknown helper version', null],
    ])('keeps device+mode dedupe for a %s (no queue on the device)', async (_label, version) => {
      vi.resetAllMocks();
      mockHelperVersion(version);
      const tx = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      await createManualBackupJobIfIdle({
        orgId: 'org-1', configId: 'cfg-1', deviceId: 'dev-1',
        featureLinkId: 'profile-a', backupMode: 'file', modeTargets: { paths: ['/a'] },
      });

      const key = lockKeyOf(tx);
      expect(key).toContain('dev-1');
      expect(key).toContain('file');
      expect(key).not.toContain('cfg-1');
      expect(key).not.toContain('profile-a');
      const where = whereTextOf(tx);
      expect(where).toContain('backupmode');
      expect(where).not.toContain('configid');
      expect(where).not.toContain('featurelinkid');
    });

    it('reports the existing device+mode job as busy for an older helper instead of creating a second one', async () => {
      vi.resetAllMocks();
      mockHelperVersion('0.108.0');
      const existing = { id: 'job-running', status: 'running', backupMode: 'file', featureLinkId: 'profile-b' };
      const tx = buildTx({ existingRows: [existing] });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const result = await createManualBackupJobIfIdle({
        orgId: 'org-1', configId: 'cfg-1', deviceId: 'dev-1',
        featureLinkId: 'profile-a', backupMode: 'file',
      });

      expect(result?.created).toBe(false);
      expect(result?.job).toEqual(existing);
      expect(tx.insert).not.toHaveBeenCalled();
    });

    it('retains scheduled same-mode selections from different profiles sharing storage', async () => {
      for (const featureLinkId of ['profile-a', 'profile-b']) {
        const tx = buildTx();
        vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
        const result = await createScheduledBackupJobIfAbsent({
          orgId: 'org-1', configId: 'shared-storage', deviceId: 'dev-1',
          featureLinkId, backupMode: 'file', occurrenceKey: '2026-09-04T12:00',
        });
        expect(result?.created).toBe(true);
        expect(whereTextOf(tx)).toContain(featureLinkId);
        expect(whereTextOf(tx)).toContain('shared-storage');
        expect(lockKeyOf(tx)).toContain(featureLinkId);
      }
    });

    it('keeps legacy (mode-less) jobs on their own lock key and NULL-mode predicate', async () => {
      const tx = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      await createManualBackupJobIfIdle({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
      });

      // A legacy job must not collide with a profile job's key...
      expect(lockKeyOf(tx)).toContain('legacy');
      // ...and must still match only NULL-mode rows, so a profile job in
      // flight never makes a legacy run look "already pending".
      expect(whereTextOf(tx)).toContain('is null');
      expect(vi.mocked(tx.insert().values).mock.calls[0]?.[0]).toMatchObject({
        backupMode: null,
        modeTargets: null,
      });
    });

    it('persists backupMode + modeTargets on the created job', async () => {
      const tx = buildTx();
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

      const targets = { backupType: 'full', excludeDatabases: ['tempdb'] };
      await createManualBackupJobIfIdle({
        orgId: 'org-1',
        configId: 'cfg-1',
        featureLinkId: 'feature-1',
        deviceId: 'dev-1',
        backupMode: 'mssql',
        modeTargets: targets,
      });

      // Dispatch reads these off the job row, not the (mutable) settings row —
      // if they were dropped, every profile job would dispatch as a file backup.
      expect(vi.mocked(tx.insert().values).mock.calls[0]?.[0]).toMatchObject({
        backupMode: 'mssql',
        modeTargets: targets,
      });
    });

    it('scopes the scheduled lock key by mode within one occurrence', async () => {
      const keys: string[] = [];
      for (const mode of ['file', 'mssql'] as const) {
        resetMocksWithQueueCapableHelper();
        const tx = buildTx();
        vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

        await createScheduledBackupJobIfAbsent({
          orgId: 'org-1',
          configId: 'cfg-1',
          featureLinkId: 'fl-1',
          deviceId: 'dev-1',
          occurrenceKey: '2026-07-13T01:00',
          backupMode: mode,
        });

        keys.push(lockKeyOf(tx));
      }

      // Same device, same occurrence, different modes → different locks.
      expect(keys[0]).not.toEqual(keys[1]);
      expect(keys[0]).toContain('file');
      expect(keys[1]).toContain('mssql');
    });
  });
});
