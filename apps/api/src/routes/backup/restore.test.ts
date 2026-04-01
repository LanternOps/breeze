import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const queueCommandForExecutionMock = vi.fn();

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

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
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
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    status: 'devices.status',
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {
    BACKUP_RESTORE: 'backup_restore',
  },
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
}));

import { restoreRoutes } from './restore';

describe('restore routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
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
        token: { sub: 'user-1', scope: 'organization' },
      });
      await next();
    });
    app.route('/', restoreRoutes);
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
});
