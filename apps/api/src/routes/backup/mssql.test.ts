import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mssqlRoutes } from './mssql';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_DB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../services', () => ({}));

const executeCommandMock = vi.fn();
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

describe('mssql routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    executeCommandMock.mockReset();
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
        providerConfig: { path: '/tmp/backups' },
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

  it('restores MSSQL from snapshot metadata instead of a local backup path', async () => {
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
        provider: 'local',
        providerConfig: { path: '/tmp/backups' },
      }),
      expect.objectContaining({ userId: 'user-123' })
    );
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
        providerConfig: { path: '/tmp/backups' },
      }),
      expect.objectContaining({ userId: 'user-123' })
    );
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
