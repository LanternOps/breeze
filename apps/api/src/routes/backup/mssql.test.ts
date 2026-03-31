import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mssqlRoutes } from './mssql';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_DB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../services', () => ({}));

const executeCommandMock = vi.fn();
const resolveBackupConfigForDeviceMock = vi.fn();
const applyBackupCommandResultToJobMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve(resolvedValue));
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: vi.fn(() => chainMock([])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
  },
  backupJobs: {
    id: 'backup_jobs.id',
    configId: 'backup_jobs.config_id',
    featureLinkId: 'backup_jobs.feature_link_id',
    deviceId: 'backup_jobs.device_id',
    status: 'backup_jobs.status',
    type: 'backup_jobs.type',
    backupType: 'backup_jobs.backup_type',
    createdAt: 'backup_jobs.created_at',
    updatedAt: 'backup_jobs.updated_at',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    metadata: 'backup_snapshots.metadata',
  },
}));

vi.mock('../../db/schema/applicationBackup', () => ({
  sqlInstances: {
    orgId: 'sql_instances.org_id',
    deviceId: 'sql_instances.device_id',
    instanceName: 'sql_instances.instance_name',
  },
  backupChains: {
    orgId: 'backup_chains.org_id',
  },
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
  CommandTypes: {
    MSSQL_DISCOVER: 'MSSQL_DISCOVER',
    MSSQL_BACKUP: 'MSSQL_BACKUP',
    MSSQL_RESTORE: 'MSSQL_RESTORE',
    MSSQL_VERIFY: 'MSSQL_VERIFY',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolveBackupConfigForDevice: (...args: unknown[]) => resolveBackupConfigForDeviceMock(...(args as [])),
}));

vi.mock('../../services/backupResultPersistence', () => ({
  applyBackupCommandResultToJob: (...args: unknown[]) => applyBackupCommandResultToJobMock(...(args as [])),
}));

import { authMiddleware } from '../../middleware/auth';

describe('mssql routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    executeCommandMock.mockReset();
    resolveBackupConfigForDeviceMock.mockReset();
    applyBackupCommandResultToJobMock.mockReset();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', mssqlRoutes);
  });

  it('returns an empty MSSQL instance list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/mssql/instances', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('dispatches MSSQL discovery for a device', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: ORG_ID }]));
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ instances: [] }),
    });

    const res = await app.request(`/backup/mssql/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.instances).toEqual([]);
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'MSSQL_DISCOVER',
      {},
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('validates required MSSQL backup fields', async () => {
    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        instance: 'MSSQLSERVER',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('dispatches MSSQL backup against provider-backed storage and persists snapshot metadata', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: ORG_ID }]));
    insertMock.mockReturnValueOnce(chainMock([{ id: 'job-1' }]));
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({
      configId: 'config-1',
      featureLinkId: 'feature-1',
    });
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({
        snapshotId: 'provider-snapshot-1',
        filesBackedUp: 1,
        bytesBackedUp: 1024,
        backupType: 'database',
        metadata: {
          backupKind: 'mssql_database',
          instance: 'MSSQLSERVER',
          database: 'AppDb',
          backupSubtype: 'full',
          backupFileName: 'AppDb_full_20260331.bak',
        },
        snapshot: {
          id: 'provider-snapshot-1',
          timestamp: '2026-03-31T00:00:00.000Z',
          size: 1024,
          files: [
            {
              sourcePath: 'AppDb_full_20260331.bak',
              backupPath: 'snapshots/provider-snapshot-1/files/AppDb_full_20260331.bak',
              size: 1024,
            },
          ],
        },
      }),
    });
    applyBackupCommandResultToJobMock.mockResolvedValueOnce({
      snapshotDbId: 'snapshot-db-1',
      providerSnapshotId: 'provider-snapshot-1',
    });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        instance: 'MSSQLSERVER',
        database: 'AppDb',
      }),
    });

    expect(res.status).toBe(200);
    expect(resolveBackupConfigForDeviceMock).toHaveBeenCalledWith(DEVICE_ID);
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'MSSQL_BACKUP',
      expect.objectContaining({
        instance: 'MSSQLSERVER',
        database: 'AppDb',
        backupType: 'full',
      }),
      expect.objectContaining({ userId: 'user-123' })
    );
    expect(applyBackupCommandResultToJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
      })
    );
    const body = await res.json();
    expect(body.data.snapshotDbId).toBe('snapshot-db-1');
    expect(body.data.snapshotId).toBe('provider-snapshot-1');
  });

  it('restores MSSQL from snapshot metadata instead of a local backup path', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: ORG_ID }]))
      .mockReturnValueOnce(chainMock([{
        id: 'snapshot-db-1',
        providerSnapshotId: 'provider-snapshot-1',
        metadata: {
          backupKind: 'mssql_database',
          instance: 'MSSQLSERVER',
          backupFileName: 'AppDb_full_20260331.bak',
        },
      }]));
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ status: 'completed' }),
    });

    const res = await app.request('/backup/mssql/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_DB_ID,
        targetDatabase: 'AppDb_Restore',
      }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'MSSQL_RESTORE',
      expect.objectContaining({
        instance: 'MSSQLSERVER',
        snapshotId: 'provider-snapshot-1',
        backupFileName: 'AppDb_full_20260331.bak',
        targetDatabase: 'AppDb_Restore',
      }),
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('verifies MSSQL snapshots using persisted artifact metadata', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_DB_ID,
      deviceId: DEVICE_ID,
      providerSnapshotId: 'provider-snapshot-1',
      metadata: {
        backupKind: 'mssql_database',
        instance: 'MSSQLSERVER',
        backupFileName: 'AppDb_full_20260331.bak',
      },
    }]));
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ valid: true }),
    });

    const res = await app.request(`/backup/mssql/verify/${SNAPSHOT_DB_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'MSSQL_VERIFY',
      expect.objectContaining({
        instance: 'MSSQLSERVER',
        snapshotId: 'provider-snapshot-1',
        backupFileName: 'AppDb_full_20260331.bak',
      }),
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('rejects cross-org device discovery', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, orgId: OTHER_ORG_ID }]));

    const res = await app.request(`/backup/mssql/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
