import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { vmRestoreRoutes } from './vmrestore';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const RESTORE_JOB_ID = '99999999-9999-4999-8999-999999999999';
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const RECOVERY_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_ID = '44444444-4444-4444-8444-444444444444';

vi.mock('../../services', () => ({}));

const queueCommandForExecutionMock = vi.fn();
const createBareMetalRecoveryMock = vi.fn();
const mintRecoveryTokenForRecoveryMock = vi.fn();
const cancelBareMetalRecoveryMock = vi.fn();
const queueBareMetalRebuildMock = vi.fn();
const authorizeResilienceResourcesMock = vi.fn();
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
  principal: { kind: 'user_session' as const },
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
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    deviceId: 'backup_snapshots.device_id',
    layoutManifest: 'backup_snapshots.layout_manifest',
    bareMetalRestorable: 'backup_snapshots.bare_metal_restorable',
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
    recoveryTokenId: 'restore_jobs.recovery_token_id',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    status: 'devices.status',
    hostname: 'devices.hostname',
    osType: 'devices.os_type',
  },
}));

vi.mock('../../services/bareMetalRecoveryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/bareMetalRecoveryService')>();
  return {
    ...actual,
    createBareMetalRecovery: (...args: unknown[]) => createBareMetalRecoveryMock(...args),
    mintRecoveryTokenForRecovery: (...args: unknown[]) => mintRecoveryTokenForRecoveryMock(...args),
    cancelBareMetalRecovery: (...args: unknown[]) => cancelBareMetalRecoveryMock(...args),
  };
});

vi.mock('../../services/bareMetalRebuildCommand', () => ({
  queueBareMetalRebuild: (...args: unknown[]) => queueBareMetalRebuildMock(...args),
}));

vi.mock('../../services/recoveryBootstrap', () => ({
  resolveServerUrl: vi.fn(() => 'https://api.example.test'),
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

vi.mock('../../services/resilienceSiteAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/resilienceSiteAuthorization')>();
  return {
    ...actual,
    authorizeResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...args),
  };
});

import { authMiddleware } from '../../middleware/auth';
import { ResilienceAuthorizationError } from '../../services/resilienceSiteAuthorization';
import { writeRouteAudit } from '../../services/auditEvents';

describe('vm restore routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    authState = {
      principal: { kind: 'user_session' },
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

  it('denies cross-site VM restore before loading snapshot metadata or creating a job', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

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

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
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

describe('vm restore routes — rebuild engine', () => {
  let app: Hono;

  const rebuildBody = {
    engine: 'rebuild',
    snapshotId: SNAPSHOT_ID,
    rebuildHostDeviceId: HOST_ID,
    outputPath: '/srv/rebuild/dev-1.vhdx',
    imageSizeGb: 120,
  };

  function mockHappyPath() {
    selectMock
      .mockReturnValueOnce(chainMock([{
        id: SNAPSHOT_ID,
        orgId: ORG_ID,
        snapshotId: 'snap-ext-001',
        deviceId: DEVICE_ID,
        layoutManifest: { disks: [] },
        bareMetalRestorable: true,
      }]))
      .mockReturnValueOnce(chainMock([{ id: HOST_ID, status: 'online', osType: 'linux' }]));
    insertMock.mockReturnValueOnce(
      chainMock([{
        id: RESTORE_JOB_ID,
        status: 'pending',
        snapshotId: SNAPSHOT_ID,
        deviceId: HOST_ID,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }])
    );
    updateMock.mockReturnValue(
      chainMock([{
        id: RESTORE_JOB_ID,
        status: 'pending',
        snapshotId: SNAPSHOT_ID,
        deviceId: HOST_ID,
        commandId: COMMAND_ID,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }])
    );
    createBareMetalRecoveryMock.mockResolvedValue({
      row: { id: RECOVERY_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, status: 'created' },
      code: 'ABC-DEF-GHJ',
    });
    mintRecoveryTokenForRecoveryMock.mockResolvedValue({ token: 'plaintext-token', tokenId: TOKEN_ID });
    queueBareMetalRebuildMock.mockResolvedValue({ command: { id: COMMAND_ID, status: 'queued' }, error: null });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/', vmRestoreRoutes);
  });

  it('rejects an identity field on the rebuild variant (server forces identity: new)', async () => {
    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ ...rebuildBody, identity: 'original' }),
    });

    expect(res.status).toBe(400);
    expect(createBareMetalRecoveryMock).not.toHaveBeenCalled();
  });

  it('rejects a relative or non-vhdx output path', async () => {
    for (const outputPath of ['relative/out.vhdx', '/srv/rebuild/out.img']) {
      const res = await app.request('/backup/restore/as-vm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ ...rebuildBody, outputPath }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('returns 409 snapshot_not_bare_metal_restorable when the snapshot has no layout manifest', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_ID,
      orgId: ORG_ID,
      snapshotId: 'snap-ext-001',
      deviceId: DEVICE_ID,
      layoutManifest: null,
      bareMetalRestorable: true,
    }]));

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(rebuildBody),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'snapshot_not_bare_metal_restorable' });
    expect(createBareMetalRecoveryMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueBareMetalRebuildMock).not.toHaveBeenCalled();
  });

  it('authorizes the rebuild host as a device target and the snapshot as source', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(rebuildBody),
    });

    expect(res.status).toBe(403);
    expect(authorizeResilienceResourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        operation: 'restore',
        refs: [
          { kind: 'snapshot', id: SNAPSHOT_ID, role: 'source' },
          { kind: 'device', id: HOST_ID, role: 'target' },
        ],
      })
    );
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('creates an identity:new recovery, mints the token, records the restore job and queues bare_metal_rebuild to the host', async () => {
    mockHappyPath();

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(rebuildBody),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      jobId: RESTORE_JOB_ID,
      recoveryId: RECOVERY_ID,
      commandId: COMMAND_ID,
      status: 'queued',
    });

    expect(createBareMetalRecoveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        snapshotId: SNAPSHOT_ID,
        identity: 'new',
        source: 'vm_restore',
        executingDeviceId: HOST_ID,
        createdBy: 'user-123',
      })
    );
    expect(mintRecoveryTokenForRecoveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryId: RECOVERY_ID, orgId: ORG_ID })
    );

    // restore_jobs row: deviceId is the HOST (updateRestoreJobByCommandId
    // filters by the device that ran the command); the source device rides
    // in targetConfig.
    const insertChain = insertMock.mock.results[0]!.value;
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        snapshotId: SNAPSHOT_ID,
        deviceId: HOST_ID,
        restoreType: 'full',
        status: 'pending',
        recoveryTokenId: TOKEN_ID,
        targetConfig: expect.objectContaining({
          mode: 'rebuild_vhdx',
          outputPath: '/srv/rebuild/dev-1.vhdx',
          rebuildHostDeviceId: HOST_ID,
          sourceDeviceId: DEVICE_ID,
          recoveryId: RECOVERY_ID,
        }),
      })
    );

    expect(queueBareMetalRebuildMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      hostDeviceId: HOST_ID,
      userId: 'user-123',
      payload: {
        recoveryId: RECOVERY_ID,
        token: 'plaintext-token',
        server: 'https://api.example.test',
        target: { kind: 'vhdx', path: '/srv/rebuild/dev-1.vhdx', imageSizeBytes: 120 * 1024 * 1024 * 1024 },
        identity: 'new',
      },
    });
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();

    // commandId persisted on the restore job.
    const updateChain = updateMock.mock.results[0]!.value;
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ commandId: COMMAND_ID }));

    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'bmr.vm_restore.create',
        resourceType: 'restore_job',
        resourceId: RESTORE_JOB_ID,
        details: expect.objectContaining({
          engine: 'rebuild',
          snapshotId: SNAPSHOT_ID,
          rebuildHostDeviceId: HOST_ID,
          recoveryId: RECOVERY_ID,
          outputPath: '/srv/rebuild/dev-1.vhdx',
        }),
      })
    );
  });

  it('refuses a rebuild host that is not a Linux device', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{
        id: SNAPSHOT_ID,
        orgId: ORG_ID,
        snapshotId: 'snap-ext-001',
        deviceId: DEVICE_ID,
        layoutManifest: { disks: [] },
        bareMetalRestorable: true,
      }]))
      .mockReturnValueOnce(chainMock([{ id: HOST_ID, status: 'online', osType: 'windows' }]));

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(rebuildBody),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'rebuild_host_unsupported' });
    expect(createBareMetalRecoveryMock).not.toHaveBeenCalled();
  });

  it('fails the restore job and cancels the recovery when the rebuild command cannot be queued', async () => {
    mockHappyPath();
    queueBareMetalRebuildMock.mockResolvedValue({ command: null, error: 'Device is offline, cannot execute command' });
    cancelBareMetalRecoveryMock.mockResolvedValue({ id: RECOVERY_ID, status: 'failed' });

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify(rebuildBody),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Device is offline, cannot execute command' });
    expect(cancelBareMetalRecoveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryId: RECOVERY_ID, orgId: ORG_ID })
    );
    // restore job marked failed
    const updateChain = updateMock.mock.results[0]!.value;
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('still accepts the legacy Hyper-V payload without an engine field', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, orgId: ORG_ID, snapshotId: 'snap-ext-001' }]))
      .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, status: 'online' }]));
    insertMock.mockReturnValueOnce(chainMock([{ id: RESTORE_JOB_ID, status: 'pending', snapshotId: SNAPSHOT_ID, deviceId: DEVICE_ID, createdAt: new Date() }]));
    updateMock.mockReturnValue(chainMock([{ id: RESTORE_JOB_ID, status: 'running', snapshotId: SNAPSHOT_ID, deviceId: DEVICE_ID, commandId: COMMAND_ID, createdAt: new Date() }]));
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: COMMAND_ID, status: 'sent' } });

    const res = await app.request('/backup/restore/as-vm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ snapshotId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, hypervisor: 'hyperv', vmName: 'Recovered VM' }),
    });

    expect(res.status).toBe(201);
    expect(queueBareMetalRebuildMock).not.toHaveBeenCalled();
    expect(createBareMetalRecoveryMock).not.toHaveBeenCalled();
  });
});
