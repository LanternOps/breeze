import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { vmRestoreRoutes } from './vmrestore';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const RESTORE_JOB_ID = '99999999-9999-4999-8999-999999999999';
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../../services', () => ({}));

const queueCommandForExecutionMock = vi.fn();
const runOutsideDbContextMock = vi.fn((fn: () => unknown) => fn());

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'innerJoin']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
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
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: (...args: unknown[]) => runOutsideDbContextMock(...(args as [any])),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
  },
  restoreJobs: {
    id: 'restore_jobs.id',
    orgId: 'restore_jobs.org_id',
    status: 'restore_jobs.status',
    snapshotId: 'restore_jobs.snapshot_id',
    deviceId: 'restore_jobs.device_id',
    commandId: 'restore_jobs.command_id',
    createdAt: 'restore_jobs.created_at',
    startedAt: 'restore_jobs.started_at',
    completedAt: 'restore_jobs.completed_at',
    targetConfig: 'restore_jobs.target_config',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    status: 'devices.status',
    hostname: 'devices.hostname',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
  CommandTypes: {
    VM_RESTORE_FROM_BACKUP: 'VM_RESTORE_FROM_BACKUP',
    VM_INSTANT_BOOT: 'VM_INSTANT_BOOT',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../services/backupMetrics', () => ({
  recordBackupDispatchFailure: vi.fn(),
}));

import { authMiddleware } from '../../middleware/auth';

describe('vm restore routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
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
    app.route('/', vmRestoreRoutes);
  });

  it('validates required fields for restore as VM', async () => {
    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        hypervisor: 'hyperv',
        vmName: 'Recovered VM',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('validates required fields for instant boot', async () => {
    const res = await app.request('/backup/restore/instant-boot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        targetDeviceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('creates a VM restore job and persists the queued command id', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, orgId: ORG_ID, snapshotId: 'snap-ext-001' }]))
      .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, status: 'online' }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: RESTORE_JOB_ID,
        status: 'pending',
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }])
    );
    updateMock.mockReturnValue(
      chainMock([{
        id: RESTORE_JOB_ID,
        status: 'running',
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
        commandId: COMMAND_ID,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValue({
      command: { id: COMMAND_ID, status: 'sent' },
    });

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        targetDeviceId: DEVICE_ID,
        hypervisor: 'hyperv',
        vmName: 'Recovered VM',
        switchName: 'Default Switch',
        vmSpecs: {
          memoryMb: 8192,
          cpuCount: 4,
          diskSizeGb: 120,
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(body.commandId).toBe(COMMAND_ID);
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'VM_RESTORE_FROM_BACKUP',
      {
        restoreJobId: RESTORE_JOB_ID,
        snapshotId: 'snap-ext-001',
        vmName: 'Recovered VM',
        memoryMb: 8192,
        cpuCount: 4,
        diskSizeGb: 120,
        switchName: 'Default Switch',
      },
      { userId: 'user-123' }
    );
  });

  it('returns the updated instant boot restore job state after dispatch', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, orgId: ORG_ID, snapshotId: 'snap-ext-001' }]))
      .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, status: 'online' }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: RESTORE_JOB_ID,
        status: 'pending',
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }])
    );
    updateMock.mockReturnValue(
      chainMock([{
        id: RESTORE_JOB_ID,
        status: 'running',
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
        commandId: COMMAND_ID,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }])
    );
    queueCommandForExecutionMock.mockResolvedValue({
      command: { id: COMMAND_ID, status: 'sent' },
    });

    const res = await app.request('/backup/restore/instant-boot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        targetDeviceId: DEVICE_ID,
        vmName: 'Instant VM',
        vmSpecs: {
          memoryMb: 4096,
          cpuCount: 2,
          diskSizeGb: 80,
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(body.commandId).toBe(COMMAND_ID);
    expect(runOutsideDbContextMock).toHaveBeenCalled();
  });

  it('keeps instant boot jobs visible while background sync is active', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: RESTORE_JOB_ID,
      status: 'completed',
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      startedAt: new Date('2026-03-30T00:00:00.000Z'),
      completedAt: new Date('2026-03-30T01:00:00.000Z'),
      targetConfig: {
        mode: 'instant_boot',
        vmName: 'Instant VM',
        result: {
          backgroundSyncActive: true,
          syncProgress: 74,
        },
      },
      hostDeviceName: 'host-1',
    }]));

    const res = await app.request('/backup/restore/instant-boot/active', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('running');
    expect(body[0].syncProgress).toBe(74);
  });

  it('fails the restore job immediately when the target device is offline', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, orgId: ORG_ID, snapshotId: 'snap-ext-001' }]))
      .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, status: 'offline' }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: RESTORE_JOB_ID,
        status: 'pending',
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }])
    );
    updateMock.mockReturnValue(chainMock([]));
    queueCommandForExecutionMock.mockResolvedValue({
      error: 'Device is offline, cannot execute command',
    });

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        targetDeviceId: DEVICE_ID,
        hypervisor: 'hyperv',
        vmName: 'Recovered VM',
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Device is offline, cannot execute command');
  });

  it('returns a VM restore estimate', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_ID,
      orgId: ORG_ID,
      size: 50 * 1024 * 1024 * 1024,
      hardwareProfile: {
        cpuCores: 4,
        totalMemoryMB: 8192,
        disks: [{ sizeBytes: 80 * 1024 * 1024 * 1024 }],
      },
      metadata: {
        platform: 'hyperv',
        osVersion: 'Windows Server 2022',
      },
    }]));

    const res = await app.request(`/backup/restore/as-vm/estimate/${SNAPSHOT_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memoryMb).toBe(8192);
    expect(body.cpuCount).toBe(4);
    expect(body.diskSizeGb).toBe(100);
    expect(body.platform).toBe('hyperv');
  });
});
