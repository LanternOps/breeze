import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module — backupWorker uses `import * as dbModule from '../db'`
// then destructures: `const { db } = dbModule;`
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, partnerId: null },
}));

// Must import AFTER mock so the module-level destructure picks up our mock
const { resolveBackupTargets } = await import('./backupWorker');

describe('resolveBackupTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chainable defaults
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
  });

  it('returns file targets unchanged', async () => {
    const result = await resolveBackupTargets(
      'file',
      { paths: ['/data', '/etc'] },
      'device-id'
    );
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { paths: ['/data', '/etc'] } },
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

  it('returns empty paths array for file mode when paths not provided', async () => {
    const result = await resolveBackupTargets('file', {}, 'device-id');
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { paths: [] } },
    ]);
  });
});
