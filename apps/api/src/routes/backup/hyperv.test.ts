import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { hypervRoutes } from './hyperv';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const VM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../services', () => ({}));

const executeCommandMock = vi.fn();
// The depth-0 dispatch entry point: recorded separately, answered by the same
// mock so every case can script the device's reply in one place.
const executeCommandWithSystemPrecheckSpy = vi.fn();
// Models withAuthDbAccessContext as a fresh transaction that COMMITS when its
// callback resolves: `stack` is the contexts open right now, `committed` the
// ids whose callback has finished.
const authDbContexts = { seq: 0, stack: [] as number[], committed: new Set<number>() };
function openAuthContext(): number | null {
  return authDbContexts.stack[authDbContexts.stack.length - 1] ?? null;
}
const queueCommandForExecutionMock = vi.fn();
const dispatchTrackedDbRestoreMock = vi.fn();
vi.mock('./dbRestoreJob', () => ({
  dispatchTrackedDbRestore: (...args: unknown[]) => dispatchTrackedDbRestoreMock(...(args as [])),
}));

// The integrity check itself is covered in restoreIntegrityGate.test.ts; here
// only how the route uses its answer.
const integrityGate = vi.hoisted(() => ({ gate: vi.fn(), check: vi.fn(), record: vi.fn() }));
vi.mock('./restoreIntegrityGate', () => ({
  gateRestoreCommand: (...args: unknown[]) => integrityGate.gate(...args),
  checkRestoreIntegrityRequest: (...args: unknown[]) => integrityGate.check(...args),
  recordRequestAuthorization: (...args: unknown[]) => integrityGate.record(...args),
  restoreIntegrityResponse: (c: any, check: any) => c.json(check.body, check.status),
}));
const authorizeResilienceResourcesMock = vi.fn();
const resolveAllBackupAssignedDevicesMock = vi.fn();

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
const updateMock = vi.fn(() => chainMock([]));

// D20b item A/D: resolveBackupWriteCommandDestination / resolveBackupProviderConfig
// (services/backupProviderConfig.ts) run for real against the mocked db, so
// every on-demand backup/restore request now needs a backup_configs row
// queued for the destination-resolution select.
function queueDestinationConfigSelect(
  overrides: Partial<{ provider: string; providerConfig: unknown; encryption: boolean }> = {}
) {
  selectMock.mockReturnValueOnce(chainMock([{
    provider: 'local',
    providerConfig: { path: '/tmp/backups' },
    encryption: false,
    ...overrides,
  }]));
}
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
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    displayName: 'devices.display_name',
    hostname: 'devices.hostname',
    osType: 'devices.os_type',
    status: 'devices.status',
  },
  backupJobs: {
    id: 'backup_jobs.id',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    metadata: 'backup_snapshots.metadata',
    configId: 'backup_snapshots.config_id',
  },
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
    encryption: 'backup_configs.encryption',
  },
  hypervVms: {
    id: 'hyperv_vms.id',
    orgId: 'hyperv_vms.org_id',
    deviceId: 'hyperv_vms.device_id',
    vmId: 'hyperv_vms.vm_id',
    vmName: 'hyperv_vms.vm_name',
  },
}));

const writeRouteAuditMock = vi.fn();

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

const resolveBackupConfigForDeviceMock = vi.fn();
vi.mock('../../services/featureConfigResolver', () => ({
  resolveAllBackupAssignedDevices: (...args: unknown[]) =>
    resolveAllBackupAssignedDevicesMock(...(args as [])),
  resolveBackupConfigForDevice: (...args: unknown[]) =>
    resolveBackupConfigForDeviceMock(...(args as [])),
  effectiveBackupModes: (entry: { selectionSpecs: Array<{ backupMode: string }> | null; settings: { backupMode: string } | null }) =>
    entry.selectionSpecs
      ? entry.selectionSpecs.map((spec) => spec.backupMode)
      : entry.settings
        ? [entry.settings.backupMode]
        : [],
}));

const applyBackupCommandResultToJobMock = vi.fn();
const markBackupJobFailedIfInFlightMock = vi.fn();
vi.mock('../../services/backupResultPersistence', () => ({
  applyBackupCommandResultToJob: (...args: unknown[]) =>
    applyBackupCommandResultToJobMock(...(args as [])),
  markBackupJobFailedIfInFlight: (...args: unknown[]) =>
    markBackupJobFailedIfInFlightMock(...(args as [])),
}));

// D20-C: keep the REAL isBackupQueuedAck/isBackupStartedAck predicates (pure,
// no DB) and mock only the DB-touching applyBackupStartedAck.
const applyBackupStartedAckMock = vi.fn();
vi.mock('../../services/backupProgress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/backupProgress')>();
  return {
    ...actual,
    applyBackupStartedAck: (...args: unknown[]) => applyBackupStartedAckMock(...(args as [])),
  };
});

vi.mock('../../services/commandQueue', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
  executeCommandWithSystemPrecheck: (...args: unknown[]) => {
    executeCommandWithSystemPrecheckSpy(...args);
    return executeCommandMock(...(args as []));
  },
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
  CommandTypes: {
    HYPERV_DISCOVER: 'HYPERV_DISCOVER',
    HYPERV_BACKUP: 'HYPERV_BACKUP',
    HYPERV_CHECKPOINT: 'HYPERV_CHECKPOINT',
    HYPERV_VM_STATE: 'HYPERV_VM_STATE',
    HYPERV_RESTORE: 'HYPERV_RESTORE',
  },
}));

vi.mock('../../services/resilienceSiteAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/resilienceSiteAuthorization')>();
  return {
    ...actual,
    authorizeResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...args),
  };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
  withAuthDbAccessContext: vi.fn(async (_auth: any, fn: any) => {
    const id = ++authDbContexts.seq;
    authDbContexts.stack.push(id);
    try {
      return await fn();
    } finally {
      authDbContexts.stack.pop();
      authDbContexts.committed.add(id);
    }
  }),
}));

import { authMiddleware } from '../../middleware/auth';
import { ResilienceAuthorizationError } from '../../services/resilienceSiteAuthorization';
import { BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE } from '../../services/backupReadHelperGate';
import { BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE } from '../../services/backupWriteHelperGate';

describe('hyperv routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    integrityGate.gate.mockResolvedValue({ ok: true });
    integrityGate.check.mockResolvedValue({ ok: true, authorizationReason: null });
    integrityGate.record.mockResolvedValue('authorization-1');
    authDbContexts.seq = 0;
    authDbContexts.stack = [];
    authDbContexts.committed = new Set();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    authState = {
      principal: { kind: 'user_session' },
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    resolveBackupConfigForDeviceMock.mockResolvedValue({
      configId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      featureLinkId: '99999999-9999-4999-8999-999999999999',
    });
    resolveAllBackupAssignedDevicesMock.mockReset();
    applyBackupCommandResultToJobMock.mockResolvedValue({
      snapshotDbId: '55555555-5555-4555-8555-555555555555',
      providerSnapshotId: 'hyperv-accounting-1',
    });
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup/hyperv', hypervRoutes);
  });

  it('denies a source-site Hyper-V restore before metadata or command side effects', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request('/backup/hyperv/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        vmName: 'Recovered VM',
        generateNewId: true,
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('returns an empty Hyper-V VM list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/hyperv/vms', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vms).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns only Hyper-V-protected Windows discovery targets', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      {
        deviceId: 'host-1',
        configId: 'config-1',
        settings: { backupMode: 'hyperv' },
      },
      {
        deviceId: 'host-2',
        configId: 'config-2',
        settings: { backupMode: 'file' },
      },
      {
        deviceId: 'host-3',
        configId: null,
        settings: { backupMode: 'hyperv' },
      },
    ]);
    selectMock.mockReturnValueOnce(chainMock([
      {
        id: 'host-1',
        displayName: 'hyperv-01',
        hostname: 'hyperv-01.local',
        osType: 'windows',
        status: 'online',
      },
    ]));

    const res = await app.request('/backup/hyperv/discovery-targets', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(resolveAllBackupAssignedDevicesMock).toHaveBeenCalledWith(ORG_ID);
    expect((await res.json()).data).toEqual([
      expect.objectContaining({
        id: 'host-1',
        displayName: 'hyperv-01',
        eligible: true,
      }),
    ]);
  });

  it('dispatches Hyper-V discovery for a device', async () => {
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify([]),
    });

    const res = await app.request(`/backup/hyperv/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vms).toEqual([]);
    expect(body.total).toBe(0);
  });

  // D20-F: with the stdout double-encoded (any agent still on a pre-D20-B
  // build), this route's existing double-unwrap (`typeof parsed === 'string'
  // ? JSON.parse(parsed) : parsed`) already tolerated it — this pins that it
  // keeps working now that the unwrap runs through the shared
  // parseAgentJsonStdout instead of a bespoke inline check.
  it('D20-F: persists hypervVms from a double-encoded discovery payload (pre-fix agent)', async () => {
    const vms = [{ id: 'vm-1', name: 'Accounting VM', generation: 2, state: 'running' }];
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify(JSON.stringify(vms)),
    });

    const res = await app.request(`/backup/hyperv/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.vms[0]).toMatchObject({ id: 'vm-1', name: 'Accounting VM' });
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('validates required Hyper-V backup fields', async () => {
    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
      }),
    });

    expect(res.status).toBe(400);
  });

  it('dispatches provider-backed Hyper-V backup without an export path', async () => {
    insertMock.mockReturnValueOnce(
      chainMock([{ id: '44444444-4444-4444-8444-444444444444' }])
    );
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({
        snapshotId: 'hyperv-accounting-1',
        filesBackedUp: 2,
        bytesBackedUp: 1024,
        backupType: 'application',
        metadata: { backupKind: 'hyperv_export', vmName: 'Accounting VM' },
        snapshot: { id: 'hyperv-accounting-1', size: 1024, files: [] },
      }),
    });

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        vmName: 'Accounting VM',
        consistencyType: 'application',
      }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'HYPERV_BACKUP',
      {
        // D20-E: lets agentWs.ts's processCommandResult (and
        // handleProviderBackedBackupResult) correlate the REAL terminal
        // result — which arrives as a second, unsolicited command_result
        // frame after a queue-admission ack — back to this backup_jobs row.
        jobId: '44444444-4444-4444-8444-444444444444',
        // D20b item A: same provider/providerConfig/storageEncryption shape
        // backupWorker.ts attaches to a profile-scheduled hyperv_backup — the
        // helper only builds a manager from THIS payload when it has no
        // agent.yaml backup config, which is the normal state for every
        // policy-managed device.
        configId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        provider: 'local',
        providerConfigRef: { configId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orgId: ORG_ID },
        storageEncryption: { required: false, mode: 'disabled' },
        vmName: 'Accounting VM',
        consistencyType: 'application',
      },
      expect.objectContaining({ userId: 'user-123' })
    );
    expect(applyBackupCommandResultToJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: '44444444-4444-4444-8444-444444444444',
        resultStatus: 'completed',
      })
    );
  });

  // The helper's write session is minted when the command is DELIVERED, on
  // the delivery path's own connection, and only for a backup job that
  // connection can see. A job inserted in the request transaction is still
  // uncommitted when executeCommand pushes the command, so delivery found no
  // live job and sent the storage destination instead of a write session.
  it('commits the backup job before dispatching the backup, and dispatches holding no context', async () => {
    let insertedIn: number | null = null;
    insertMock.mockImplementationOnce(() => {
      insertedIn = openAuthContext();
      return chainMock([{ id: '44444444-4444-4444-8444-444444444444' }]);
    });
    queueDestinationConfigSelect({ provider: 's3', providerConfig: { endpoint: 'https://storage.example.com', bucket: 'b', accessKeyId: 'AKIA', secretAccessKey: 'secret' } });
    let dispatchState: { open: number | null; jobCommitted: boolean } | null = null;
    executeCommandMock.mockImplementationOnce(async () => {
      dispatchState = { open: openAuthContext(), jobCommitted: insertedIn !== null && authDbContexts.committed.has(insertedIn) };
      return { status: 'completed', stdout: JSON.stringify({ queued: true }) };
    });
    let ackIn: number | null = null;
    applyBackupStartedAckMock.mockImplementationOnce(async () => { ackIn = openAuthContext(); });

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, vmName: 'Accounting VM', consistencyType: 'application' }),
    });

    expect(res.status).toBe(202);
    // The job row was written inside a short context of its own...
    expect(insertedIn).not.toBeNull();
    // ...that had committed by the time the command was dispatched, and the
    // dispatch (which waits on the device) held no context at all.
    expect(dispatchState).toEqual({ open: null, jobCommitted: true });
    // No context is held across the wait, so the precheck opens its own and
    // must be told which organization the request decided under.
    expect(executeCommandWithSystemPrecheckSpy).toHaveBeenCalledWith(
      DEVICE_ID,
      'HYPERV_BACKUP',
      expect.objectContaining({ jobId: '44444444-4444-4444-8444-444444444444' }),
      expect.objectContaining({ userId: 'user-123', expectedOrgId: ORG_ID }),
    );
    // Recording the device's reply writes the job again, in a fresh context.
    expect(ackIn).not.toBeNull();
    expect(ackIn).not.toBe(insertedIn);
  });

  it('writes a failed result into a context of its own after the dispatch', async () => {
    insertMock.mockReturnValueOnce(chainMock([{ id: '44444444-4444-4444-8444-444444444444' }]));
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'helper crashed', stdout: 'not json' });
    let markedIn: number | null = null;
    markBackupJobFailedIfInFlightMock.mockImplementationOnce(async () => { markedIn = openAuthContext(); });

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, vmName: 'Accounting VM', consistencyType: 'application' }),
    });

    expect(res.status).toBe(500);
    expect(markBackupJobFailedIfInFlightMock).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444', expect.any(String));
    expect(markedIn).not.toBeNull();
  });

  it('records the destination storage identity on the on-demand job it creates', async () => {
    const jobInsert = chainMock([{ id: '44444444-4444-4444-8444-444444444444' }]);
    insertMock.mockReturnValueOnce(jobInsert);
    queueDestinationConfigSelect({ provider: 's3', providerConfig: { endpoint: 'https://Storage.Example.com:9443', bucket: 'Backups', accessKeyId: 'AKIA', secretAccessKey: 'secret' } });
    executeCommandMock.mockResolvedValueOnce({ status: 'completed', stdout: JSON.stringify({ queued: true }) });

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, vmName: 'Accounting VM', consistencyType: 'application' }),
    });

    expect(res.status).toBe(202);
    expect(jobInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      backupType: 'application',
      storageIdentity: 's3::storage.example.com:9443::Backups',
    }));
  });

  it('answers 409 and fails the job with the update message when the helper cannot write through a storage session', async () => {
    insertMock.mockReturnValueOnce(chainMock([{ id: '44444444-4444-4444-8444-444444444444' }]));
    
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({ status: 'failed', error: BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE });

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, vmName: 'Accounting VM', consistencyType: 'application' }),
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ error: BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE, reason: 'helper_update_required' });
    expect(markBackupJobFailedIfInFlightMock).toHaveBeenCalledWith(
      '44444444-4444-4444-8444-444444444444',
      BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE,
    );
  });

  // D20b item A: a resolved config id whose backup_configs row has since
  // been deleted must fail clearly and never create an orphaned job or
  // dispatch a command the helper can't act on.
  it('D20b: fails the Hyper-V backup dispatch when the destination config no longer resolves', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        vmName: 'Accounting VM',
        consistencyType: 'application',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe('config_not_found');
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  // D20-C: a queued/starting agent acks admission with {"queued":true}/
  // {"started":true} instead of the real backup outcome — before this fix the
  // route ran that straight through backupCommandResultSchema, which does not
  // recognize either shape, and 500'd with "expected object, received string"
  // (proven live against agent 0.112.5, same mechanism as MSSQL). The route
  // must recognize the ack and report the job as still running.
  it('D20-C: reports 202/running when the agent acks queue admission', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    insertMock.mockReturnValueOnce(chainMock([{ id: jobId }]));
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ queued: true }),
    });

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        vmName: 'Accounting VM',
        consistencyType: 'application',
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({ backupJobId: jobId, status: 'running', queued: true });
    expect(applyBackupStartedAckMock).toHaveBeenCalledWith({ jobId, deviceId: DEVICE_ID, queued: true });
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
    expect(markBackupJobFailedIfInFlightMock).not.toHaveBeenCalled();
  });

  // D20-A/B: a queue-ack forwarded by an agent that hasn't picked up the
  // D20-B fix yet still arrives double-JSON-encoded.
  it('D20-A: recognizes a double-encoded queue-ack from a pre-fix agent', async () => {
    const jobId = '44444444-4444-4444-8444-444444444444';
    insertMock.mockReturnValueOnce(chainMock([{ id: jobId }]));
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify(JSON.stringify({ queued: true })),
    });

    const res = await app.request('/backup/hyperv/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        vmName: 'Accounting VM',
        consistencyType: 'application',
      }),
    });

    expect(res.status).toBe(202);
    expect(applyBackupStartedAckMock).toHaveBeenCalledWith({ jobId, deviceId: DEVICE_ID, queued: true });
  });

  // #6437: a real Hyper-V VM restore can run well past 10 minutes, so the
  // route must dispatch async (queueCommandForExecution) and return as soon
  // as the command is queued, instead of blocking the HTTP request on
  // executeCommand's 10-minute waitForCommandResult poll — which terminalised
  // any longer-running restore as failed regardless of the reaper's ceiling.
  describe('restore integrity', () => {
    const snapshotRow = () => {
      selectMock.mockReturnValueOnce(chainMock([{
        id: '55555555-5555-4555-8555-555555555555',
        providerSnapshotId: 'hyperv-accounting-1',
        metadata: { backupKind: 'hyperv_export' },
        configId: 'config-1',
      }]));
      queueDestinationConfigSelect();
    };
    const post = () => app.request('/backup/hyperv/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, snapshotId: '55555555-5555-4555-8555-555555555555', vmName: 'Recovered VM' }),
    });

    it('answers an integrity refusal and queues nothing', async () => {
      snapshotRow();
      integrityGate.gate.mockResolvedValueOnce({ ok: false, status: 409, body: { code: 'attestation_pending', error: 'wait' } });
      const res = await post();
      expect(res.status).toBe(409);
      expect(dispatchTrackedDbRestoreMock).not.toHaveBeenCalled();
      expect(integrityGate.gate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        snapshotDbId: '55555555-5555-4555-8555-555555555555', targetDeviceId: DEVICE_ID, commandType: 'HYPERV_RESTORE',
        executingDeviceId: DEVICE_ID,
      }));
    });

    it('queues a confirmed restore with the command id its authorization is bound to', async () => {
      snapshotRow();
      integrityGate.gate.mockResolvedValueOnce({ ok: true, commandId: 'reserved-command' });
      dispatchTrackedDbRestoreMock.mockResolvedValueOnce({ ok: true, command: { id: 'reserved-command', status: 'pending' }, restoreJobId: 'job-1' });
      const res = await post();
      expect(res.status).toBe(202);
      expect(dispatchTrackedDbRestoreMock.mock.lastCall?.[0]).toMatchObject({ commandId: 'reserved-command' });
    });
  });

  it('dispatches Hyper-V restore asynchronously instead of blocking on executeCommand', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
          {
            id: '55555555-5555-4555-8555-555555555555',
            providerSnapshotId: 'hyperv-accounting-1',
            metadata: { backupKind: 'hyperv_export' },
            configId: 'config-1',
          },
      ])
    );
    // D20b item D: the helper builds its READ provider from THIS command's
    // own payload (restoreProviderForCommand) the same way backup_restore
    // already does — resolveBackupProviderConfig looks up the destination
    // config the BACKUP wrote this snapshot to.
    queueDestinationConfigSelect();
    dispatchTrackedDbRestoreMock.mockResolvedValueOnce({
      ok: true,
      command: { id: 'command-1', status: 'sent' },
      restoreJobId: 'restore-job-1',
    });

    const res = await app.request('/backup/hyperv/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: '55555555-5555-4555-8555-555555555555',
        vmName: 'Recovered VM',
        generateNewId: true,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual(expect.objectContaining({
      commandId: 'command-1',
      restoreJobId: 'restore-job-1',
      status: 'sent',
      deviceId: DEVICE_ID,
      vmName: 'Recovered VM',
    }));
    // executeCommand must NOT be used for restore dispatch any more — it is
    // the synchronous, 10-minute-bounded path this fix removes.
    expect(executeCommandMock).not.toHaveBeenCalled();
    // #6974: dispatched through the restore_jobs-tracked helper so the
    // terminal result is persisted (commandResultHandlers.hyperv_restore).
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    const opts = dispatchTrackedDbRestoreMock.mock.lastCall?.[0] as any;
    expect(opts).toEqual(expect.objectContaining({
      orgId: ORG_ID,
      snapshotId: '55555555-5555-4555-8555-555555555555',
      deviceId: DEVICE_ID,
      userId: 'user-123',
      commandType: 'HYPERV_RESTORE',
      engine: 'hyperv',
    }));
    // The restore job id must be stamped into the command payload.
    expect(opts.buildPayload('restore-job-1')).toEqual({
      restoreJobId: 'restore-job-1',
      snapshotId: 'hyperv-accounting-1',
      vmName: 'Recovered VM',
      generateNewId: true,
      provider: 'local',
      providerConfigRef: { configId: 'config-1', orgId: ORG_ID },
    });
    expect(opts.buildPayload('restore-job-1')).not.toHaveProperty('providerConfig');
  });

  it('reports a 502 when Hyper-V restore fails to dispatch for a non-offline reason', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
          {
            id: '55555555-5555-4555-8555-555555555555',
            providerSnapshotId: 'hyperv-accounting-1',
            metadata: { backupKind: 'hyperv_export' },
            configId: 'config-1',
          },
      ])
    );
    queueDestinationConfigSelect();
    dispatchTrackedDbRestoreMock.mockResolvedValueOnce({ ok: false, error: 'Failed to enqueue command' });

    const res = await app.request('/backup/hyperv/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: '55555555-5555-4555-8555-555555555555',
        vmName: 'Recovered VM',
        generateNewId: true,
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to enqueue command' });
  });

  // Mirrors routes/backup/restore.ts / vmrestore.ts: a device that is offline
  // is a routine, expected dispatch outcome — not the same as a genuine
  // enqueue/infra failure — so it must map to 409, not the blanket 502.
  it('reports a 409 when the target device is offline', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
          {
            id: '55555555-5555-4555-8555-555555555555',
            providerSnapshotId: 'hyperv-accounting-1',
            metadata: { backupKind: 'hyperv_export' },
            configId: 'config-1',
          },
      ])
    );
    queueDestinationConfigSelect();
    dispatchTrackedDbRestoreMock.mockResolvedValueOnce({
      ok: false,
      error: 'Device is offline, cannot execute command',
    });

    const res = await app.request('/backup/hyperv/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: '55555555-5555-4555-8555-555555555555',
        vmName: 'Recovered VM',
        generateNewId: true,
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Device is offline, cannot execute command' });
  });

  it('reports a 409 with the update instruction when the device backup helper is too old', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
          {
            id: '55555555-5555-4555-8555-555555555555',
            providerSnapshotId: 'hyperv-accounting-1',
            metadata: { backupKind: 'hyperv_export' },
            configId: 'config-1',
          },
      ])
    );
    queueDestinationConfigSelect();
    dispatchTrackedDbRestoreMock.mockResolvedValueOnce({
      ok: false,
      error: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE,
    });

    const res = await app.request('/backup/hyperv/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: '55555555-5555-4555-8555-555555555555',
        vmName: 'Recovered VM',
        generateNewId: true,
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE });
  });

  // D20b item D: a snapshot that predates destination tracking (configId
  // NULL) must fail with a clear, distinct error — never silently dispatch a
  // restore the helper can't act on, and never guess the device's CURRENT
  // config (the snapshot's objects may live at a different destination).
  it('D20b: fails restore with a clear reason for a snapshot that predates destination tracking', async () => {
    selectMock.mockReturnValueOnce(
      chainMock([
          {
            id: '55555555-5555-4555-8555-555555555555',
            providerSnapshotId: 'hyperv-accounting-1',
            metadata: { backupKind: 'hyperv_export' },
            configId: null,
          },
      ])
    );

    const res = await app.request('/backup/hyperv/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: '55555555-5555-4555-8555-555555555555',
        vmName: 'Recovered VM',
        generateNewId: true,
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe('legacy_snapshot');
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('validates Hyper-V checkpoint action enum', async () => {
    const res = await app.request(`/backup/hyperv/checkpoints/${DEVICE_ID}/${VM_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ action: 'snapshot' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects cross-org Hyper-V discovery', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(404, 'resource_not_found')
    );

    const res = await app.request(`/backup/hyperv/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('dispatches VM state changes using targetState for the agent payload', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ vmName: 'Accounting VM' }]));
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ status: 'completed' }),
    });

    const res = await app.request(`/backup/hyperv/vm-state/${DEVICE_ID}/${VM_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ state: 'start' }),
    });

    expect(res.status).toBe(200);
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'HYPERV_VM_STATE',
      {
        vmName: 'Accounting VM',
        targetState: 'start',
      },
      expect.objectContaining({ userId: 'user-123' })
    );
  });
});
