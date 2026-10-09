import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mssqlRoutes } from './mssql';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_DB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
const resolveBackupConfigForDeviceMock = vi.fn();
const resolveAllBackupAssignedDevicesMock = vi.fn();
const applyBackupCommandResultToJobMock = vi.fn();
const markBackupJobFailedIfInFlightMock = vi.fn();
const applyBackupStartedAckMock = vi.fn();

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

// D20b item A/D: resolveBackupWriteCommandDestination / resolveBackupProviderConfig
// (services/backupProviderConfig.ts) run for real against the mocked db, so
// every on-demand backup/restore/verify request now needs a backup_configs
// row queued for the destination-resolution select.
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
    update: vi.fn(() => chainMock([])),
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
    siteId: 'devices.site_id',
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
    configId: 'backup_snapshots.config_id',
  },
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
    encryption: 'backup_configs.encryption',
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
  executeCommandWithSystemPrecheck: (...args: unknown[]) => {
    executeCommandWithSystemPrecheckSpy(...args);
    return executeCommandMock(...(args as []));
  },
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
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

vi.mock('../../services/featureConfigResolver', () => ({
  resolveAllBackupAssignedDevices: (...args: unknown[]) => resolveAllBackupAssignedDevicesMock(...(args as [])),
  resolveBackupConfigForDevice: (...args: unknown[]) => resolveBackupConfigForDeviceMock(...(args as [])),
  effectiveBackupModes: (entry: { selectionSpecs: Array<{ backupMode: string }> | null; settings: { backupMode: string } | null }) =>
    entry.selectionSpecs
      ? entry.selectionSpecs.map((spec) => spec.backupMode)
      : entry.settings
        ? [entry.settings.backupMode]
        : [],
}));

vi.mock('../../services/backupResultPersistence', () => ({
  applyBackupCommandResultToJob: (...args: unknown[]) => applyBackupCommandResultToJobMock(...(args as [])),
  markBackupJobFailedIfInFlight: (...args: unknown[]) => markBackupJobFailedIfInFlightMock(...(args as [])),
}));

// D20-C: keep the REAL isBackupQueuedAck/isBackupStartedAck predicates (pure,
// no DB) and mock only the DB-touching applyBackupStartedAck.
vi.mock('../../services/backupProgress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/backupProgress')>();
  return {
    ...actual,
    applyBackupStartedAck: (...args: unknown[]) => applyBackupStartedAckMock(...(args as [])),
  };
});

vi.mock('../../services/resilienceSiteAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/resilienceSiteAuthorization')>();
  return {
    ...actual,
    authorizeResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...args),
  };
});

import { authMiddleware } from '../../middleware/auth';
import { ResilienceAuthorizationError } from '../../services/resilienceSiteAuthorization';
import { BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE } from '../../services/backupReadHelperGate';
import { BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE } from '../../services/backupWriteHelperGate';

describe('mssql routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    executeCommandMock.mockReset();
    executeCommandWithSystemPrecheckSpy.mockReset();
    authDbContexts.seq = 0;
    authDbContexts.stack = [];
    authDbContexts.committed = new Set();
    queueCommandForExecutionMock.mockReset();
    dispatchTrackedDbRestoreMock.mockReset();
    integrityGate.gate.mockResolvedValue({ ok: true });
    integrityGate.check.mockResolvedValue({ ok: true, authorizationReason: null });
    integrityGate.record.mockResolvedValue('authorization-1');
    resolveBackupConfigForDeviceMock.mockReset();
    resolveAllBackupAssignedDevicesMock.mockReset();
    applyBackupCommandResultToJobMock.mockReset();
    markBackupJobFailedIfInFlightMock.mockReset();
    applyBackupStartedAckMock.mockReset();
    authState = {
      principal: { kind: 'user_session' },
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', mssqlRoutes);
  });

  describe('restore integrity', () => {
    const snapshotRow = () => {
      selectMock.mockReturnValueOnce(chainMock([{
        id: 'snapshot-db-1',
        deviceId: 'source-device',
        providerSnapshotId: 'provider-snapshot-1',
        metadata: { backupKind: 'mssql_database', instance: 'MSSQLSERVER', backupFileName: 'AppDb.bak' },
        configId: 'config-1',
      }]));
      queueDestinationConfigSelect();
    };
    const post = (body: Record<string, unknown> = {}) => app.request('/backup/mssql/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, snapshotId: SNAPSHOT_DB_ID, targetDatabase: 'AppDb_Restore', ...body }),
    });

    it('answers a step-up request and queues nothing', async () => {
      snapshotRow();
      integrityGate.gate.mockResolvedValueOnce({ ok: false, status: 403, body: { code: 'STEP_UP_REQUIRED', error: 'confirm' } });
      const res = await post({ stepUpGrant: '66666666-6666-4666-8666-666666666666' });
      expect(res.status).toBe(403);
      expect(dispatchTrackedDbRestoreMock).not.toHaveBeenCalled();
      expect(integrityGate.gate).toHaveBeenCalledWith(expect.anything(), {
        orgId: ORG_ID,
        snapshotDbId: 'snapshot-db-1',
        targetDeviceId: DEVICE_ID,
        commandType: 'MSSQL_RESTORE',
        stepUpGrant: '66666666-6666-4666-8666-666666666666',
        confirmUnattestedRestore: undefined,
        executingDeviceId: DEVICE_ID,
      });
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

  it('denies a source-site MSSQL restore before metadata or command side effects', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request('/backup/mssql/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_DB_ID,
        targetDatabase: 'RecoveredDb',
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
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

  it('returns only MSSQL-protected Windows discovery targets', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      {
        deviceId: 'device-1',
        configId: 'config-1',
        settings: { backupMode: 'mssql' },
      },
      {
        deviceId: 'device-2',
        configId: 'config-2',
        settings: { backupMode: 'file' },
      },
      {
        deviceId: 'device-3',
        configId: null,
        settings: { backupMode: 'mssql' },
      },
    ]);
    selectMock.mockReturnValueOnce(chainMock([
      {
        id: 'device-1',
        displayName: 'SQL Host',
        hostname: 'sql-host',
        osType: 'windows',
        status: 'online',
      },
    ]));

    const res = await app.request('/backup/mssql/discovery-targets', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(resolveAllBackupAssignedDevicesMock).toHaveBeenCalledWith(ORG_ID);
    expect((await res.json()).data).toEqual([
      expect.objectContaining({
        id: 'device-1',
        displayName: 'SQL Host',
        eligible: true,
      }),
    ]);
  });

  it('dispatches MSSQL discovery for a device', async () => {
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

  // D20-F: with the stdout double-encoded (any agent still on a pre-D20-B
  // build), the upsert used to never run at all — a single JSON.parse yielded
  // the object TEXT as a string, `data?.instances` was undefined on a string,
  // and GET /mssql/instances stayed empty forever for that device.
  it('D20-F: persists sqlInstances from a double-encoded discovery payload (pre-fix agent)', async () => {
    const instances = [{
      name: 'MSSQLSERVER',
      version: '16.0.1000',
      edition: 'Standard',
      port: 1433,
      authType: 'windows',
      databases: ['AppDb'],
      status: 'online',
    }];
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify(JSON.stringify({ instances })),
    });

    const res = await app.request(`/backup/mssql/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.instances).toEqual(instances);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  // D20b item C: execMSSQLDiscover (agent/cmd/breeze-backup/exec_hyperv.go)
  // does `marshalResult(instances, err)` on a bare []SQLInstance slice — the
  // wire payload is a JSON ARRAY, never `{"instances":[...]}`. Before the
  // fix `data?.instances` was always undefined for an array, so the upsert
  // silently never ran and GET /mssql/instances stayed empty forever even
  // though this route's own response looked correct (it just echoed `data`
  // straight back). This is the REAL agent payload shape (proven live);
  // the object-wrapped shape in the tests above is a legacy/defensive
  // fallback the route also still accepts.
  it('D20b: persists sqlInstances from the real bare-array discovery payload', async () => {
    const instances = [{
      name: 'SQLEXPRESS',
      version: '17.0.1000.7',
      port: 49995,
      authType: 'windows',
      databases: null,
      status: 'online',
    }];
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify(instances),
    });

    const res = await app.request(`/backup/mssql/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(instances);
    expect(insertMock).toHaveBeenCalledTimes(1);
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
    insertMock.mockReturnValueOnce(chainMock([{ id: 'job-1' }]));
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({
      configId: 'config-1',
      featureLinkId: 'feature-1',
    });
    queueDestinationConfigSelect();
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
    expect(executeCommandMock.mock.calls[0]?.[2]).not.toHaveProperty('providerConfig');
    expect(executeCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'MSSQL_BACKUP',
      expect.objectContaining({
        // D20-E: the command payload must carry jobId so
        // handleProviderBackedBackupResult (services/commandResultHandlers.ts)
        // can correlate the REAL terminal result — that arrives as a second,
        // unsolicited command_result frame after a queue-admission ack — back
        // to this backup_jobs row.
        jobId: 'job-1',
        // D20b item A: same provider/providerConfig/storageEncryption shape
        // backupWorker.ts attaches to a profile-scheduled mssql_backup — the
        // helper only builds a manager from THIS payload when it has no
        // agent.yaml backup config, which is the normal state for every
        // policy-managed device.
        configId: 'config-1',
        provider: 'local',
        providerConfigRef: { configId: 'config-1', orgId: ORG_ID },
        storageEncryption: { required: false, mode: 'disabled' },
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

  // The helper's write session is minted when the command is DELIVERED, on
  // the delivery path's own connection, and only for a backup job that
  // connection can see. A job inserted in the request transaction is still
  // uncommitted when executeCommand pushes the command, so delivery found no
  // live job and sent the storage destination instead of a write session.
  it('commits the backup job before dispatching the backup, and dispatches holding no context', async () => {
    let insertedIn: number | null = null;
    insertMock.mockImplementationOnce(() => {
      insertedIn = openAuthContext();
      return chainMock([{ id: 'job-1' }]);
    });
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({ configId: 'config-1', featureLinkId: 'feature-1' });
    queueDestinationConfigSelect({ provider: 's3', providerConfig: { endpoint: 'https://storage.example.com', bucket: 'b', accessKeyId: 'AKIA', secretAccessKey: 'secret' } });
    let dispatchState: { open: number | null; jobCommitted: boolean } | null = null;
    executeCommandMock.mockImplementationOnce(async () => {
      dispatchState = { open: openAuthContext(), jobCommitted: insertedIn !== null && authDbContexts.committed.has(insertedIn) };
      return { status: 'completed', stdout: JSON.stringify({ queued: true }) };
    });
    let ackIn: number | null = null;
    applyBackupStartedAckMock.mockImplementationOnce(async () => { ackIn = openAuthContext(); });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
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
      'MSSQL_BACKUP',
      expect.objectContaining({ jobId: 'job-1' }),
      expect.objectContaining({ userId: 'user-123', expectedOrgId: ORG_ID }),
    );
    // Recording the device's reply writes the job again, in a fresh context.
    expect(ackIn).not.toBeNull();
    expect(ackIn).not.toBe(insertedIn);
  });

  it('writes a failed result into a context of its own after the dispatch', async () => {
    insertMock.mockReturnValueOnce(chainMock([{ id: 'job-1' }]));
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({ configId: 'config-1', featureLinkId: 'feature-1' });
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'helper crashed', stdout: 'not json' });
    let markedIn: number | null = null;
    markBackupJobFailedIfInFlightMock.mockImplementationOnce(async () => { markedIn = openAuthContext(); });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
    });

    expect(res.status).toBe(500);
    expect(markBackupJobFailedIfInFlightMock).toHaveBeenCalledWith('job-1', expect.any(String));
    expect(markedIn).not.toBeNull();
  });

  it('records the destination storage identity on the on-demand job it creates', async () => {
    const jobInsert = chainMock([{ id: 'job-1' }]);
    insertMock.mockReturnValueOnce(jobInsert);
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({ configId: 'config-1', featureLinkId: 'feature-1' });
    queueDestinationConfigSelect({ provider: 's3', providerConfig: { endpoint: 'https://Storage.Example.com:9443', bucket: 'Backups', accessKeyId: 'AKIA', secretAccessKey: 'secret' } });
    executeCommandMock.mockResolvedValueOnce({ status: 'completed', stdout: JSON.stringify({ queued: true }) });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
    });

    expect(res.status).toBe(202);
    // The snapshot persisted from this job copies the job's identity; without
    // it, restores of the snapshot cannot be served through a storage session.
    expect(jobInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      backupType: 'database',
      storageIdentity: 's3::storage.example.com:9443::Backups',
    }));
  });

  it('answers 409 and fails the job with the update message when the helper cannot write through a storage session', async () => {
    insertMock.mockReturnValueOnce(chainMock([{ id: '44444444-4444-4444-8444-444444444444' }]));
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({ configId: 'config-1', featureLinkId: 'feature-1' });
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({ status: 'failed', error: BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
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
  it('D20b: fails the MSSQL backup dispatch when the destination config no longer resolves', async () => {
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({
      configId: 'config-1',
      featureLinkId: 'feature-1',
    });
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
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
  // (proven live against agent 0.112.5). The route must recognize the ack and
  // report the job as still running rather than failing it.
  it('reports 202/running (not a parse failure) when the agent acks queue admission', async () => {
    insertMock.mockReturnValueOnce(chainMock([{ id: 'job-1' }]));
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({
      configId: 'config-1',
      featureLinkId: 'feature-1',
    });
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ queued: true }),
    });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({ backupJobId: 'job-1', status: 'running', queued: true });
    expect(applyBackupStartedAckMock).toHaveBeenCalledWith({
      jobId: 'job-1',
      deviceId: DEVICE_ID,
      queued: true,
    });
    // Never treated as a completed-but-malformed terminal result.
    expect(applyBackupCommandResultToJobMock).not.toHaveBeenCalled();
    expect(markBackupJobFailedIfInFlightMock).not.toHaveBeenCalled();
  });

  it('reports 202/running for a legacy {"started":true} ack too', async () => {
    insertMock.mockReturnValueOnce(chainMock([{ id: 'job-1' }]));
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({
      configId: 'config-1',
      featureLinkId: 'feature-1',
    });
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify({ started: true }),
    });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({ backupJobId: 'job-1', status: 'running', queued: false });
    expect(applyBackupStartedAckMock).toHaveBeenCalledWith({
      jobId: 'job-1',
      deviceId: DEVICE_ID,
      queued: false,
    });
  });

  // D20-A/B: a queue-ack forwarded by an agent that hasn't picked up the
  // D20-B fix yet still arrives double-JSON-encoded. The route must recognize
  // it as an ack via the SAME tolerant parser used everywhere else, not just
  // the single-encoded (post-fix) shape.
  it('recognizes a double-encoded queue-ack from a pre-fix agent', async () => {
    insertMock.mockReturnValueOnce(chainMock([{ id: 'job-1' }]));
    resolveBackupConfigForDeviceMock.mockResolvedValueOnce({
      configId: 'config-1',
      featureLinkId: 'feature-1',
    });
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({
      status: 'completed',
      stdout: JSON.stringify(JSON.stringify({ queued: true })),
    });

    const res = await app.request('/backup/mssql/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, instance: 'MSSQLSERVER', database: 'AppDb' }),
    });

    expect(res.status).toBe(202);
    expect(applyBackupStartedAckMock).toHaveBeenCalledWith({
      jobId: 'job-1',
      deviceId: DEVICE_ID,
      queued: true,
    });
  });

  // #6437: a real MSSQL restore can run well past 10 minutes, so the route
  // must dispatch async (queueCommandForExecution) and return as soon as the
  // command is queued, instead of blocking the HTTP request on
  // executeCommand's 10-minute waitForCommandResult poll — which terminalised
  // any longer-running restore as failed regardless of the reaper's ceiling.
  it('dispatches MSSQL restore asynchronously instead of blocking on executeCommand', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
        id: 'snapshot-db-1',
        providerSnapshotId: 'provider-snapshot-1',
        metadata: {
          backupKind: 'mssql_database',
          instance: 'MSSQLSERVER',
          backupFileName: 'AppDb_full_20260331.bak',
        },
        configId: 'config-1',
    }]));
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

    const res = await app.request('/backup/mssql/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_DB_ID,
        targetDatabase: 'AppDb_Restore',
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual(expect.objectContaining({
      commandId: 'command-1',
      restoreJobId: 'restore-job-1',
      status: 'sent',
      deviceId: DEVICE_ID,
      targetDatabase: 'AppDb_Restore',
    }));
    // executeCommand must NOT be used for restore dispatch any more — it is
    // the synchronous, 10-minute-bounded path this fix removes.
    expect(executeCommandMock).not.toHaveBeenCalled();
    // #6974: dispatched through the restore_jobs-tracked helper so the
    // terminal result is persisted (commandResultHandlers.mssql_restore).
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    const opts = dispatchTrackedDbRestoreMock.mock.lastCall?.[0] as any;
    expect(opts).toEqual(expect.objectContaining({
      orgId: ORG_ID,
      snapshotId: 'snapshot-db-1',
      deviceId: DEVICE_ID,
      userId: 'user-123',
      commandType: 'MSSQL_RESTORE',
      engine: 'mssql',
    }));
    // The restore job id must be stamped into the command payload.
    expect(opts.buildPayload('restore-job-1')).toEqual(expect.objectContaining({
      restoreJobId: 'restore-job-1',
      instance: 'MSSQLSERVER',
      snapshotId: 'provider-snapshot-1',
      backupFileName: 'AppDb_full_20260331.bak',
      targetDatabase: 'AppDb_Restore',
      provider: 'local',
      providerConfigRef: { configId: 'config-1', orgId: ORG_ID },
    }));
    expect(opts.buildPayload('restore-job-1')).not.toHaveProperty('providerConfig');
  });

  it('reports a 502 when MSSQL restore fails to dispatch for a non-offline reason', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
        id: 'snapshot-db-1',
        providerSnapshotId: 'provider-snapshot-1',
        metadata: {
          backupKind: 'mssql_database',
          instance: 'MSSQLSERVER',
          backupFileName: 'AppDb_full_20260331.bak',
        },
        configId: 'config-1',
    }]));
    queueDestinationConfigSelect();
    dispatchTrackedDbRestoreMock.mockResolvedValueOnce({ ok: false, error: 'Failed to enqueue command' });

    const res = await app.request('/backup/mssql/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_DB_ID,
        targetDatabase: 'AppDb_Restore',
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to enqueue command' });
  });

  // Mirrors routes/backup/restore.ts / vmrestore.ts: a device that is offline
  // is a routine, expected dispatch outcome — not the same as a genuine
  // enqueue/infra failure — so it must map to 409, not the blanket 502.
  it('reports a 409 when the target device is offline', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
        id: 'snapshot-db-1',
        providerSnapshotId: 'provider-snapshot-1',
        metadata: {
          backupKind: 'mssql_database',
          instance: 'MSSQLSERVER',
          backupFileName: 'AppDb_full_20260331.bak',
        },
        configId: 'config-1',
    }]));
    queueDestinationConfigSelect();
    dispatchTrackedDbRestoreMock.mockResolvedValueOnce({
      ok: false,
      error: 'Device is offline, cannot execute command',
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

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Device is offline, cannot execute command' });
  });

  it('reports a 409 with the update instruction when the device backup helper is too old', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
        id: 'snapshot-db-1',
        providerSnapshotId: 'provider-snapshot-1',
        metadata: {
          backupKind: 'mssql_database',
          instance: 'MSSQLSERVER',
          backupFileName: 'AppDb_full_20260331.bak',
        },
        configId: 'config-1',
    }]));
    queueDestinationConfigSelect();
    dispatchTrackedDbRestoreMock.mockResolvedValueOnce({
      ok: false,
      error: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE,
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

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE });
  });

  // D20b item D: a snapshot that predates destination tracking (configId
  // NULL) must fail with a clear, distinct error — never silently dispatch
  // a restore the helper can't act on, and never guess the device's CURRENT
  // config (the snapshot's objects may live at a different destination).
  it('D20b: fails restore with a clear reason for a snapshot that predates destination tracking', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      providerSnapshotId: 'provider-snapshot-1',
      metadata: {
        backupKind: 'mssql_database',
        instance: 'MSSQLSERVER',
        backupFileName: 'AppDb_full_20260331.bak',
      },
      configId: null,
    }]));

    const res = await app.request('/backup/mssql/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_DB_ID,
        targetDatabase: 'AppDb_Restore',
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe('legacy_snapshot');
    expect(executeCommandMock).not.toHaveBeenCalled();
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
      configId: 'config-1',
    }]));
    queueDestinationConfigSelect();
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
        provider: 'local',
        providerConfigRef: { configId: 'config-1', orgId: ORG_ID },
      }),
      expect.objectContaining({ userId: 'user-123' })
    );
    expect(executeCommandMock.mock.lastCall?.[2]).not.toHaveProperty('providerConfig');
  });

  it('answers 409 with the update instruction when the device backup helper cannot verify', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: SNAPSHOT_DB_ID,
      deviceId: DEVICE_ID,
      providerSnapshotId: 'provider-snapshot-1',
      metadata: { backupKind: 'mssql_database', instance: 'MSSQLSERVER', backupFileName: 'AppDb_full_20260331.bak' },
      configId: 'config-1',
    }]));
    queueDestinationConfigSelect();
    executeCommandMock.mockResolvedValueOnce({ status: 'failed', error: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE });

    const res = await app.request(`/backup/mssql/verify/${SNAPSHOT_DB_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE });
  });

  it('rejects cross-org device discovery', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(404, 'resource_not_found')
    );

    const res = await app.request(`/backup/mssql/discover/${DEVICE_ID}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });
});
