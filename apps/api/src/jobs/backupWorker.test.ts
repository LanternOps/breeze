import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module — backupWorker uses `import * as dbModule from '../db'`
// then destructures: `const { db } = dbModule;`
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  selectDistinct: vi.fn(),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, partnerId: null },
}));

const cleanupExpiredSnapshotsMock = vi.fn();
const sweepUnreferencedBackupObjectsMock = vi.fn();

vi.mock('./backupRetention', () => ({
  cleanupExpiredSnapshots: cleanupExpiredSnapshotsMock,
  sweepUnreferencedBackupObjects: sweepUnreferencedBackupObjectsMock,
}));

const captureExceptionMock = vi.fn();
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

// Must import AFTER mock so the module-level destructure picks up our mock
const { resolveBackupTargets, processCleanupExpiredSnapshots } = await import('./backupWorker');

describe('resolveBackupTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chainable defaults
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
  });

  it('returns file targets unchanged, omitting excludes when not configured', async () => {
    // No excludes key at all — the agent treats a missing field as "fall back
    // to locally-configured excludes", so the worker must not invent one.
    const result = await resolveBackupTargets(
      'file',
      { paths: ['/data', '/etc'] },
      'device-id'
    );
    expect(result).toEqual([
      {
        commandType: 'backup_run',
        payload: { paths: ['/data', '/etc'] },
      },
    ]);
    expect(result[0]!.payload).not.toHaveProperty('excludes');
  });

  it('forwards an explicit empty excludes list for file mode', async () => {
    // Explicit [] means "no exclusions for this run" on the agent side.
    const result = await resolveBackupTargets(
      'file',
      { paths: ['/data'], excludes: [] },
      'device-id'
    );
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { paths: ['/data'], excludes: [] } },
    ]);
  });

  it('forwards exclusion patterns for file mode (#2418)', async () => {
    const result = await resolveBackupTargets(
      'file',
      {
        paths: ['C:\\Users'],
        excludes: ['*.tmp', 'node_modules/**', '**/AppData/Local/Temp/**'],
      },
      'device-id'
    );
    expect(result).toEqual([
      {
        commandType: 'backup_run',
        payload: {
          paths: ['C:\\Users'],
          excludes: ['*.tmp', 'node_modules/**', '**/AppData/Local/Temp/**'],
        },
      },
    ]);
  });

  it('returns system_image target', async () => {
    const result = await resolveBackupTargets(
      'system_image',
      { includeSystemState: true },
      'device-id'
    );
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { systemImage: true } },
    ]);
  });

  it('returns one entry per discovered VM for hyperv minus excludes', async () => {
    // Chain: db.select({vmName}).from(hypervVms).where(eq(deviceId))
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { vmName: 'DC-01' },
          { vmName: 'SQL-01' },
          { vmName: 'DevVM' },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'hyperv',
      {
        exportPath: 'D:\\Backups',
        consistencyType: 'application',
        excludeVms: ['DevVM'],
      },
      'device-id'
    );

    expect(result).toHaveLength(2);
    expect(result[0]!).toEqual({
      commandType: 'hyperv_backup',
      payload: {
        vmName: 'DC-01',
        consistencyType: 'application',
      },
    });
    expect(result[1]!).toEqual({
      commandType: 'hyperv_backup',
      payload: {
        vmName: 'SQL-01',
        consistencyType: 'application',
      },
    });
  });

  it('returns empty array when all VMs excluded', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ vmName: 'DevVM' }]),
      }),
    });

    const result = await resolveBackupTargets(
      'hyperv',
      { exportPath: 'D:\\Backups', excludeVms: ['DevVM'] },
      'device-id'
    );

    expect(result).toEqual([]);
  });

  it('returns one entry per database for mssql minus excludes', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            instanceName: 'SQLEXPRESS',
            databases: ['AppDB', 'AuthDB', 'tempdb'],
          },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      {
        outputPath: 'D:\\SQLBackups',
        backupType: 'full',
        excludeDatabases: ['tempdb'],
      },
      'device-id'
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.payload).toEqual({
      instance: 'SQLEXPRESS',
      database: 'AppDB',
      backupType: 'full',
    });
    expect(result[1]!.payload).toEqual({
      instance: 'SQLEXPRESS',
      database: 'AuthDB',
      backupType: 'full',
    });
  });

  it('handles multiple SQL instances', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { instanceName: 'MSSQLSERVER', databases: ['master', 'AppDB'] },
          { instanceName: 'SQLEXPRESS', databases: ['DevDB'] },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      { outputPath: 'D:\\SQLBackups', backupType: 'differential' },
      'device-id'
    );

    expect(result).toHaveLength(3);
    expect(result[0]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'master',
    });
    expect(result[1]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'AppDB',
    });
    expect(result[2]!.payload).toMatchObject({
      instance: 'SQLEXPRESS',
      database: 'DevDB',
    });
  });

  it('extracts database names from discovered MSSQL database objects', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            instanceName: 'MSSQLSERVER',
            databases: [
              { name: 'master' },
              { name: 'AppDB' },
            ],
          },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      { backupType: 'full' },
      'device-id'
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'master',
    });
    expect(result[1]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'AppDB',
    });
  });

  it('defaults backupType to full for mssql when not specified', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { instanceName: 'SQL01', databases: ['TestDB'] },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      { outputPath: 'D:\\Backups' },
      'device-id'
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.payload).toMatchObject({ backupType: 'full' });
  });

  it('defaults consistencyType to application for hyperv', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ vmName: 'VM-01' }]),
      }),
    });

    const result = await resolveBackupTargets(
      'hyperv',
      { exportPath: 'D:\\Backups' },
      'device-id'
    );

    expect(result[0]!.payload).toMatchObject({
      consistencyType: 'application',
    });
  });

  it('returns empty array for unknown mode', async () => {
    const result = await resolveBackupTargets(
      'unknown' as any,
      {},
      'device-id'
    );
    expect(result).toEqual([]);
  });

  it('returns empty paths and no excludes field for file mode when not provided', async () => {
    const result = await resolveBackupTargets('file', {}, 'device-id');
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { paths: [] } },
    ]);
  });
});

describe('processCleanupExpiredSnapshots — GC wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.selectDistinct.mockReset();
    cleanupExpiredSnapshotsMock.mockReset();
    sweepUnreferencedBackupObjectsMock.mockReset();
  });

  it('runs the GC sweep exactly once, after row-level retention has completed for every org', async () => {
    mockDb.selectDistinct.mockReturnValue({
      from: vi.fn().mockResolvedValue([{ orgId: 'org-a' }, { orgId: 'org-b' }]),
    });
    cleanupExpiredSnapshotsMock.mockResolvedValue({
      deleted: 1,
      skippedLegalHold: 0,
      skippedImmutable: 0,
      prunedByMaxVersions: 0,
    });
    sweepUnreferencedBackupObjectsMock.mockResolvedValue({ deleted: 5, skippedIdentities: 2, blockedIdentities: 1 });

    const result = await processCleanupExpiredSnapshots();

    // Row-level retention for both orgs happens before the sweep is called.
    expect(cleanupExpiredSnapshotsMock).toHaveBeenCalledTimes(2);
    expect(cleanupExpiredSnapshotsMock).toHaveBeenNthCalledWith(1, 'org-a');
    expect(cleanupExpiredSnapshotsMock).toHaveBeenNthCalledWith(2, 'org-b');
    expect(sweepUnreferencedBackupObjectsMock).toHaveBeenCalledTimes(1);
    // Sweep is storage-identity-scoped, not org-scoped — called once total, not once per org.
    expect(result).toEqual({
      deleted: 2,
      skipped: 0,
      prunedByMaxVersions: 0,
      gcDeleted: 5,
      gcSkippedIdentities: 2,
      gcBlockedIdentities: 1,
    });
  });

  it('does not fail the retention run when the GC sweep throws', async () => {
    mockDb.selectDistinct.mockReturnValue({
      from: vi.fn().mockResolvedValue([{ orgId: 'org-a' }]),
    });
    cleanupExpiredSnapshotsMock.mockResolvedValue({
      deleted: 3,
      skippedLegalHold: 1,
      skippedImmutable: 0,
      prunedByMaxVersions: 0,
    });
    sweepUnreferencedBackupObjectsMock.mockRejectedValue(new Error('S3 listing failed'));

    // Must resolve, not reject — a GC failure isn't a retention-run failure.
    const result = await processCleanupExpiredSnapshots();

    expect(result.deleted).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.gcDeleted).toBe(0);
    expect(result.gcSkippedIdentities).toBe(0);
    expect(result.gcBlockedIdentities).toBe(0);
    // A thrown GC sweep is escalated to Sentry (retention run still succeeds).
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('still runs the sweep when there are no orgs with snapshots (row-level retention is a no-op)', async () => {
    mockDb.selectDistinct.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    });
    sweepUnreferencedBackupObjectsMock.mockResolvedValue({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });

    const result = await processCleanupExpiredSnapshots();

    expect(cleanupExpiredSnapshotsMock).not.toHaveBeenCalled();
    expect(sweepUnreferencedBackupObjectsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      deleted: 0,
      skipped: 0,
      prunedByMaxVersions: 0,
      gcDeleted: 0,
      gcSkippedIdentities: 0,
      gcBlockedIdentities: 0,
    });
  });
});
