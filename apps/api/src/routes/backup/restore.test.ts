import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const queueCommandForExecutionMock = vi.fn();
const queueBackupStopCommandMock = vi.fn();
const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());
const authzState = vi.hoisted(() => ({
  allowedPermissions: new Set<string>(['*:*']),
}));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) => runOutsideDbContextMock(...(args as [any])),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupSnapshotFiles: {
    id: 'backup_snapshot_files.id',
    snapshotDbId: 'backup_snapshot_files.snapshot_db_id',
    sourcePath: 'backup_snapshot_files.source_path',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    snapshotId: 'backup_snapshots.snapshot_id',
  },
  restoreJobs: {
    id: 'restore_jobs.id',
    orgId: 'restore_jobs.org_id',
    snapshotId: 'restore_jobs.snapshot_id',
    deviceId: 'restore_jobs.device_id',
    restoreType: 'restore_jobs.restore_type',
    targetPath: 'restore_jobs.target_path',
    selectedPaths: 'restore_jobs.selected_paths',
    status: 'restore_jobs.status',
    startedAt: 'restore_jobs.started_at',
    completedAt: 'restore_jobs.completed_at',
    restoredSize: 'restore_jobs.restored_size',
    restoredFiles: 'restore_jobs.restored_files',
    targetConfig: 'restore_jobs.target_config',
    commandId: 'restore_jobs.command_id',
    createdAt: 'restore_jobs.created_at',
    updatedAt: 'restore_jobs.updated_at',
  },
  deviceCommands: {
    id: 'device_commands.id',
    status: 'device_commands.status',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    status: 'devices.status',
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => (c: any, next: any) => {
    if (
      !authzState.allowedPermissions.has('*:*') &&
      !authzState.allowedPermissions.has(`${resource}:${action}`)
    ) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {
    BACKUP_RESTORE: 'backup_restore',
  },
  queueBackupStopCommand: (...args: unknown[]) => queueBackupStopCommandMock(...(args as [])),
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
}));

vi.mock('../../services/backupMetrics', () => ({
  recordBackupDispatchFailure: vi.fn(),
}));

import { restoreRoutes } from './restore';

describe('restore routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authzState.allowedPermissions.clear();
    authzState.allowedPermissions.add('*:*');
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: 'org-1',
        partnerId: null,
        accessibleOrgIds: ['org-1'],
        canAccessOrg: (candidateOrgId: string) => candidateOrgId === 'org-1',
        orgCondition: () => undefined,
        token: { sub: 'user-1', scope: 'organization' } as any,
      });
      await next();
    });
    app.route('/', restoreRoutes);
  });

  it('denies restore creation without backup read permission even when device execution is allowed', async () => {
    authzState.allowedPermissions.clear();
    authzState.allowedPermissions.add('devices:execute');

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('creates a restore job and persists the queued command id', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValueOnce({
      command: { id: 'command-1', status: 'sent' },
    });
    updateMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'running',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: 'command-1',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.commandId).toBe('command-1');
    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      'device-1',
      'backup_restore',
      {
        restoreJobId: 'restore-1',
        snapshotId: 'provider-snap-1',
        targetPath: '',
        selectedPaths: [],
      },
      { userId: 'user-1' }
    );
  });

  it('returns a restore job by id', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'running',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: null,
        restoredSize: 1024,
        restoredFiles: 4,
        targetConfig: {
          result: {
            status: 'running',
            commandType: 'backup_restore',
          },
        },
        commandId: 'command-1',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );

    const res = await app.request('/restore/restore-1', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('restore-1');
    expect(body.data.commandId).toBe('command-1');
    expect(body.data.resultDetails).toEqual({
      status: 'running',
      commandType: 'backup_restore',
    });
  });

  it('surfaces immediate dispatch failure details through the read API', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-2',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'failed',
        targetPath: null,
        startedAt: null,
        completedAt: new Date('2026-04-01T00:00:00Z'),
        restoredSize: null,
        restoredFiles: null,
        targetConfig: {
          error: 'Device is offline, cannot execute command',
        },
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );

    const res = await app.request('/restore/restore-2', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.errorSummary).toBe('Device is offline, cannot execute command');
    expect(body.data.resultDetails).toMatchObject({
      status: 'failed',
      error: 'Device is offline, cannot execute command',
    });
  });

  it('returns 404 when a restore job is not found by id', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/restore/missing-restore', {
      method: 'GET',
    });

    expect(res.status).toBe(404);
  });

  it('returns 409 and does not create a restore job when the target device is offline', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'offline' }]));

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(409);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('marks the restore failed and returns 502 when command dispatch fails after row creation', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([{ id: 'snap-db-1', orgId: 'org-1', deviceId: 'device-1', snapshotId: 'provider-snap-1' }])
      )
      .mockReturnValueOnce(chainMock([{ id: 'device-1', status: 'online' }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValueOnce({
      error: 'Command bus unavailable',
    });
    updateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const res = await app.request('/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'snap-db-1', restoreType: 'full' }),
    });

    expect(res.status).toBe(502);
    expect(updateMock).toHaveBeenCalled();
  });

  it('cancels a running restore job and queues backup_stop', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-3',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'running',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: 'command-3',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    updateMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-3',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'cancelled',
        targetPath: null,
        startedAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: new Date('2026-04-01T01:00:00Z'),
        restoredSize: null,
        restoredFiles: null,
        targetConfig: {
          error: 'Cancelled by user',
          result: { status: 'cancelled', error: 'Cancelled by user' },
        },
        commandId: 'command-3',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T01:00:00Z'),
      }])
    );
    queueBackupStopCommandMock.mockResolvedValueOnce({ command: { id: 'stop-1', status: 'sent' } });

    const res = await app.request('/restore/restore-3/cancel', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('cancelled');
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-1', { userId: 'user-1' });
  });

  it('removes a pending restore dispatch before cancelling', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-4',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'pending',
        targetPath: null,
        startedAt: null,
        completedAt: null,
        restoredSize: null,
        restoredFiles: null,
        targetConfig: null,
        commandId: 'command-4',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
      }])
    );
    updateMock.mockReturnValueOnce(
      chainMock([{
        id: 'restore-4',
        orgId: 'org-1',
        snapshotId: 'snap-db-1',
        deviceId: 'device-1',
        restoreType: 'full',
        selectedPaths: [],
        status: 'cancelled',
        targetPath: null,
        startedAt: null,
        completedAt: new Date('2026-04-01T01:00:00Z'),
        restoredSize: null,
        restoredFiles: null,
        targetConfig: {
          error: 'Cancelled by user',
          result: { status: 'cancelled', error: 'Cancelled by user' },
        },
        commandId: 'command-4',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T01:00:00Z'),
      }])
    );
    deleteMock.mockReturnValueOnce(chainMock([{ id: 'command-4' }]));

    const res = await app.request('/restore/restore-4/cancel', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });
});
