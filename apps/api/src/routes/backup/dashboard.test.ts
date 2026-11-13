import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { dashboardRoutes } from './dashboard';
import type { SQL } from 'drizzle-orm';
import { backupDestinationObservation } from '../../services/connectionHealth/sources/backupDestination';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_DEVICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const FAILING_DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let permissionsState: any;

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'groupBy', 'limit', 'as']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(onFulfilled, onRejected);
  chain.catch = (onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(resolvedValue).catch(onRejected);
  return chain;
}

const selectMock = vi.fn(() => chainMock([]));
const resolveAllBackupAssignedDevicesMock = vi.fn();
const resolveBackupConfigForDeviceMock = vi.fn(async () => null as unknown);

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
  withDbTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    name: 'backup_configs.name',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
    isActive: 'backup_configs.is_active',
  },
  backupJobs: {
    id: 'backup_jobs.id',
    orgId: 'backup_jobs.org_id',
    deviceId: 'backup_jobs.device_id',
    configId: 'backup_jobs.config_id',
    status: 'backup_jobs.status',
    type: 'backup_jobs.type',
    startedAt: 'backup_jobs.started_at',
    completedAt: 'backup_jobs.completed_at',
    createdAt: 'backup_jobs.created_at',
    totalSize: 'backup_jobs.total_size',
    errorCount: 'backup_jobs.error_count',
    errorLog: 'backup_jobs.error_log',
    storageIdentity: 'backup_jobs.storage_identity',
  },
  backupStorageSessions: {
    jobId: 'backup_storage_sessions.job_id',
    scope: 'backup_storage_sessions.scope',
    resumedAt: 'backup_storage_sessions.resumed_at',
  },
  IN_FLIGHT_BACKUP_JOB_STATUSES: ['pending', 'running'] as const,
  backupSnapshots: {
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    configId: 'backup_snapshots.config_id',
    size: 'backup_snapshots.size',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
    displayName: 'devices.display_name',
    hostname: 'devices.hostname',
  },
  // `partial` counts as a restore point (#3000) — the status route reads this
  // to decide lastSuccessAt.
  RESTORABLE_BACKUP_JOB_STATUSES: ['completed', 'completed_with_errors', 'partial'],
  DEGRADED_BACKUP_JOB_STATUSES: ['completed_with_errors', 'partial'] as const,
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolveBackupConfigForDevice: (...args: unknown[]) => resolveBackupConfigForDeviceMock(...(args as [])),
  resolveAllBackupAssignedDevices: (...args: unknown[]) => resolveAllBackupAssignedDevicesMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
  lte: (column: unknown, value: unknown) => ({ op: 'lte', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  desc: (value: unknown) => ({ op: 'desc', value }),
  isNotNull: (column: unknown) => ({ op: 'isNotNull', column }),
  max: (column: unknown) => ({ op: 'max', column }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    strings,
    values,
    as: (alias: string) => ({ op: 'sql', strings, values, alias }),
  }), {
    // The backup_destination source (imported for the agreement test) builds literals at load.
    raw: (text: string) => ({ op: 'raw', text }),
  }),
}));

const getProviderCoverageMock = vi.fn(async () => new Map());
const getFirstPartyCoverageMock = vi.fn(async () => new Map());
const getProviderAttentionItemsMock = vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[]));

vi.mock('../../services/backupHealthReadModel', () => ({
  getProviderCoverageForDevices: (...a: unknown[]) => getProviderCoverageMock(...(a as [])),
  getFirstPartyCoverageForDevices: (...a: unknown[]) => getFirstPartyCoverageMock(...(a as [])),
  getProviderAttentionItems: (...a: unknown[]) => getProviderAttentionItemsMock(...(a as [])),
}));

const getStorageByProviderMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

vi.mock('../../services/backupStorageByProvider', () => ({
  getStorageByProvider: (...a: unknown[]) => getStorageByProviderMock(...(a as [])),
}));

const sumStoredSnapshotBytesMock = vi.fn(async (..._args: unknown[]) => ({ totalBytes: 0, count: 0 }));
const storedSnapshotBytesByProviderSinceMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

vi.mock('../../services/backupStoredBytes', () => ({
  sumStoredSnapshotBytes: (...a: unknown[]) => sumStoredSnapshotBytesMock(...(a as [])),
  storedSnapshotBytesByProviderSince: (...a: unknown[]) => storedSnapshotBytesByProviderSinceMock(...(a as [])),
}));

describe('backup dashboard routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    permissionsState = undefined;
    app = new Hono();
    app.use('*', async (c: any, next) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        partnerId: null,
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (candidateOrgId: string) => candidateOrgId === ORG_ID,
        token: { sub: 'user-123' },
      });
      if (permissionsState) {
        c.set('permissions', permissionsState);
      }
      await next();
    });
    app.route('/backup', dashboardRoutes);
  });

  it('narrows dashboard per-device rows to allowed sites for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      { deviceId: OTHER_DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-2' },
    ]);
    selectMock
      .mockReturnValueOnce(chainMock([
        { id: DEVICE_ID, siteId: SITE_A },
        { id: OTHER_DEVICE_ID, siteId: SITE_B },
      ]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ completed: 1, failed: 0, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([
        makeRecentJob({ deviceId: DEVICE_ID, deviceName: 'Allowed Device' }),
        makeRecentJob({ id: 'job-out', deviceId: OTHER_DEVICE_ID, deviceName: 'Other Device' }),
      ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.policies).toBe(1);
    expect(body.data.coverage.protectedDevices).toBe(1);
    expect(body.data.latestJobs.map((job: any) => job.deviceId)).toEqual([DEVICE_ID]);
  });

  it('serializes storageProviders so the Overview panel is not stuck on its empty state (#2562)', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    const rows = [{ id: 'backblaze', name: 'Backblaze B2', usedBytes: 4096, snapshots: 2, configs: 1 }];
    getStorageByProviderMock.mockResolvedValueOnce(rows);

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.storageProviders).toEqual(rows);
    // Unrestricted caller: no site narrowing.
    expect(getStorageByProviderMock).toHaveBeenCalledWith(ORG_ID, null);
  });

  it('passes the site-scoped device list to the storage-by-provider read', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock.mockReturnValueOnce(chainMock([
      { id: DEVICE_ID, siteId: SITE_A },
      { id: OTHER_DEVICE_ID, siteId: SITE_B },
    ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    expect(getStorageByProviderMock).toHaveBeenCalledWith(ORG_ID, [DEVICE_ID]);
  });

  it('reports Storage Used as stored bytes from the stored-bytes service (#9631)', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    sumStoredSnapshotBytesMock.mockResolvedValueOnce({ totalBytes: 669, count: 5 });

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.storage).toEqual({ totalBytes: 669, snapshots: 5 });
    expect(sumStoredSnapshotBytesMock).toHaveBeenCalledWith({
      op: 'and',
      conditions: [{ op: 'eq', column: 'backup_snapshots.org_id', value: ORG_ID }, undefined],
    });
  });

  it('narrows Storage Used to the site-scoped device list (#9631)', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock.mockReturnValueOnce(chainMock([
      { id: DEVICE_ID, siteId: SITE_A },
      { id: OTHER_DEVICE_ID, siteId: SITE_B },
    ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    expect(sumStoredSnapshotBytesMock).toHaveBeenCalledWith({
      op: 'and',
      conditions: [
        { op: 'eq', column: 'backup_snapshots.org_id', value: ORG_ID },
        { op: 'inArray', column: 'backup_snapshots.device_id', values: [DEVICE_ID] },
      ],
    });
  });

  it('starts the storage trend at the stored bytes captured before the window (#9631)', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const dayKey = today.toISOString().slice(0, 10);
    storedSnapshotBytesByProviderSinceMock.mockResolvedValueOnce([
      { provider: 's3', day: null, bytes: 100 },
      { provider: 's3', day: dayKey, bytes: 19 },
    ]);

    const res = await app.request('/backup/usage-history?days=3');

    expect(res.status).toBe(200);
    const body = await res.json();
    const totals = body.data.points.map((point: { totalBytes: number }) => point.totalBytes);
    // Two earlier days hold the pre-window level; today adds the new uploads.
    expect(totals).toEqual([100, 100, 119]);
    expect(body.data.providers).toEqual(['s3']);
    const [where, since] = storedSnapshotBytesByProviderSinceMock.mock.calls[0]!;
    expect(where).toEqual({
      op: 'and',
      conditions: [{ op: 'eq', column: 'backup_snapshots.org_id', value: ORG_ID }, undefined],
    });
    expect((since as Date).toISOString().slice(0, 10)).toBe(
      new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    );
  });

  it('narrows the storage trend to the site-scoped device list like Storage Used (#9631)', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([
      { id: DEVICE_ID, siteId: SITE_A },
      { id: OTHER_DEVICE_ID, siteId: SITE_B },
    ]));

    const res = await app.request('/backup/usage-history?days=3');

    expect(res.status).toBe(200);
    expect(storedSnapshotBytesByProviderSinceMock.mock.calls[0]![0]).toEqual({
      op: 'and',
      conditions: [
        { op: 'eq', column: 'backup_snapshots.org_id', value: ORG_ID },
        { op: 'inArray', column: 'backup_snapshots.device_id', values: [DEVICE_ID] },
      ],
    });
  });

  it('reads no storage trend for a site-restricted caller who can see no devices', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([{ id: OTHER_DEVICE_ID, siteId: SITE_B }]));

    const res = await app.request('/backup/usage-history?days=3');

    expect(res.status).toBe(200);
    expect(storedSnapshotBytesByProviderSinceMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.points.every((point: { totalBytes: number }) => point.totalBytes === 0)).toBe(true);
  });

  it('adds dataAccounting to dashboard latestJobs', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ completed: 1, failed: 1, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([
        makeRecentJob({
          id: 'job-inc', status: 'completed', backupMode: 'file',
          totalSize: 1000, referencedSize: 900, baseSnapshotId: 'snap-base',
        }),
        makeRecentJob({
          id: 'job-bad', status: 'failed', backupMode: 'file',
          totalSize: 2000, transferredSize: 1500, baseSnapshotId: null, fullBackupReason: 'base_expired',
        }),
      ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.latestJobs[0].dataAccounting).toMatchObject({ uploadedBytes: 100, reusedBytes: 900, runKind: 'incremental' });
    expect(data.latestJobs[1].dataAccounting).toMatchObject({
      uploadedBytes: null,
      processedBytes: 1500,
      runKind: 'full',
      fullRunReason: 'base_expired',
    });
  });

  it('adds failureCategory to dashboard latestJobs', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ completed: 1, failed: 1, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([
        makeRecentJob({ id: 'job-bad', status: 'failed', errorLog: 'failed to upload file to s3: SlowDown' }),
        makeRecentJob({ id: 'job-ok', status: 'completed', errorLog: null }),
      ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.latestJobs[0].failureCategory).toBe('storage');
    expect(data.latestJobs[1]).toHaveProperty('failureCategory', null);
    expect(data.latestJobs[0]).toHaveProperty('failureCause', null);
    expect(data.latestJobs[1]).toHaveProperty('failureCause', null);
  });

  it('adds failureCause to dashboard latestJobs when the text establishes one', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 1, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([
        makeRecentJob({ id: 'job-403', status: 'failed', errorLog: 'file upload failed: storage session: storage answered status 403' }),
      ]));

    const { data } = await (await app.request('/backup/dashboard')).json();
    expect(data.latestJobs[0]).toMatchObject({ failureCategory: 'storage', failureCause: 'storage_access_denied' });
  });

  // #11768 / #11772: one destination failing for every device is one statement,
  // not N, and it is the shared evaluator's verdict (backupDestinationHealth.ts).
  describe('destination-level attention item', () => {
    const CONFIG_ID = '99999999-9999-4999-8999-999999999999';
    const OTHER_CONFIG_ID = '88888888-8888-4888-8888-888888888888';
    const STORE_403 = 'system state publish failed: upload system state artifact registry/SYSTEM: storage session: storage answered status 403';
    const IDENTITY = 's3::s3.example.test::primary';
    // What the sealed column's decoder hands back: credentials opened beside
    // the destination. Only the derived identity may leave the route.
    const openedConfig = (bucket: string) => ({
      endpoint: 'https://s3.example.test', bucket, accessKey: 'AKIAPLAINACCESS', secretKey: 'plain-secret-key',
    });
    const CONFIG_ROWS = [
      { id: CONFIG_ID, provider: 's3', providerConfig: openedConfig('primary') },
      { id: OTHER_CONFIG_ID, provider: 's3', providerConfig: openedConfig('primary') },
    ];
    const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);
    const recently = () => hoursAgo(2);

    // One row serves both reads: the ranked per-device query (rn, device names)
    // and the destination evidence query (storage identity). The config's
    // current identity comes from a third read of the opened provider_config.
    let seq = 0;
    const row = (over: Record<string, unknown>) => {
      seq += 1;
      return {
        deviceId: DEVICE_ID,
        status: 'failed',
        errorLog: STORE_403,
        completedAt: recently(),
        createdAt: new Date(recently().getTime() - seq),
        rn: 1,
        deviceName: 'Device',
        deviceHostname: 'host',
        configId: CONFIG_ID,
        configName: 'Primary S3',
        storageIdentity: IDENTITY,
        ...over,
      };
    };

    async function dashboardWith(rankedRows: unknown[], evidenceRows: unknown[] = rankedRows, configRows: unknown[] = CONFIG_ROWS) {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      selectMock
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ completed: 0, failed: 0, running: 0, pending: 0 }]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock(rankedRows))
        .mockReturnValueOnce(chainMock(evidenceRows))
        .mockReturnValueOnce(chainMock(configRows));
      return (await (await app.request('/backup/dashboard')).json()).data;
    }

    it('derives the current identity from provider_config opened through its sealed column', async () => {
      const failing = [row({ deviceId: 'd1' }), row({ deviceId: 'd2' })];
      expect((await dashboardWith(failing)).attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(true);
      // The same jobs, but the config now points at another bucket: they are not its evidence.
      const moved = [{ id: CONFIG_ID, provider: 's3', providerConfig: openedConfig('moved') }];
      expect((await dashboardWith(failing, failing, moved)).attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(false);
    });

    it('opens provider_config only for the org\'s configs with a destination fault, and never returns it', async () => {
      await dashboardWith([
        row({ deviceId: 'd1' }),
        row({ deviceId: 'd2' }),
        row({ deviceId: 'd3', configId: OTHER_CONFIG_ID, configName: 'Other', status: 'completed', errorLog: null }),
      ]);
      expect(selectMock).toHaveBeenCalledTimes(9);
      const selection = (selectMock.mock.calls[8] as unknown as [Record<string, unknown>])[0];
      expect(selection).toEqual({ id: 'backup_configs.id', provider: 'backup_configs.provider', providerConfig: 'backup_configs.provider_config' });
      const where = (selectMock.mock.results[8]!.value as { where: { mock: { calls: unknown[][] } } }).where.mock.calls[0]![0] as SQL;
      // The mocked schema's columns are strings, so collect the condition's bound values by walking it.
      const params: unknown[] = [];
      const seen = new Set<unknown>();
      const walk = (node: unknown) => {
        if (node === null || typeof node !== 'object' || seen.has(node)) {
          if (typeof node === 'string') params.push(node);
          return;
        }
        seen.add(node);
        for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value);
      };
      walk(where);
      expect(params).toContain(ORG_ID);
      expect(params).toContain(CONFIG_ID);
      expect(params).not.toContain(OTHER_CONFIG_ID);

      const data = await dashboardWith([row({ deviceId: 'd1' }), row({ deviceId: 'd2' })]);
      const out = JSON.stringify(data);
      expect(out).not.toContain('plain-secret-key');
      expect(out).not.toContain('AKIAPLAINACCESS');
    });

    it('skips the provider_config read when no destination has a fault', async () => {
      await dashboardWith([row({ deviceId: 'd1', status: 'completed', errorLog: null }), row({ deviceId: 'd2', errorLog: 'backup helper exited unexpectedly' })]);
      expect(selectMock).toHaveBeenCalledTimes(8);
    });

    it('a failed provider_config read keeps the per-device items and flags the degraded state', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      const failing = chainMock([]);
      failing.where = vi.fn(() => Promise.reject(new Error('config read failed')));
      const rows = [row({ deviceId: 'd1' }), row({ deviceId: 'd2' })];
      selectMock
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ completed: 0, failed: 0, running: 0, pending: 0 }]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock(rows))
        .mockReturnValueOnce(chainMock(rows))
        .mockReturnValueOnce(failing);
      const res = await app.request('/backup/dashboard');
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.attentionItems.map((i: any) => i.id).sort()).toEqual(['backup-failing-d1', 'backup-failing-d2']);
      expect(data.attentionError).toBe(true);
    });

    it('emits one critical item for three devices failing a store 403, before the per-device items', async () => {
      const data = await dashboardWith([
        row({ deviceId: 'd1' }),
        row({ deviceId: 'd2' }),
        row({ deviceId: 'd3' }),
      ]);

      const destination = data.attentionItems.filter((i: any) => i.kind === 'destination_failing');
      expect(destination).toHaveLength(1);
      expect(destination[0]).toMatchObject({
        id: `backup-destination-${CONFIG_ID}`,
        severity: 'critical',
        configId: CONFIG_ID,
        destinationName: 'Primary S3',
        failureCategory: 'storage',
        failureCause: 'storage_access_denied',
        failingDevices: 3,
        totalDevices: 3,
      });
      expect(Object.keys(destination[0]).sort()).toEqual([
        'configId', 'description', 'destinationName', 'failingDevices', 'failureCategory', 'failureCause',
        'id', 'kind', 'severity', 'title', 'totalDevices',
      ]);
      expect(data.attentionItems[0].kind).toBe('destination_failing');
      // The per-device items stay.
      expect(data.attentionItems.filter((i: any) => String(i.id).startsWith('backup-failing-'))).toHaveLength(3);
    });

    it('counts N of M over every device with an outcome on the destination', async () => {
      const data = await dashboardWith([
        row({ deviceId: 'd1' }),
        row({ deviceId: 'd2' }),
        row({ deviceId: 'd3', status: 'completed', errorLog: null }),
      ]);
      const item = data.attentionItems.find((i: any) => i.kind === 'destination_failing');
      expect(item).toMatchObject({ failingDevices: 2, totalDevices: 3 });
    });

    it('does not emit for one failing device among healthy ones', async () => {
      const data = await dashboardWith([row({ deviceId: 'd1' }), row({ deviceId: 'd2', status: 'completed', errorLog: null })]);
      expect(data.attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(false);
    });

    it('ignores failures older than the 72 h lookback and non-storage failures', async () => {
      const old = hoursAgo(73);
      const data = await dashboardWith([
        row({ deviceId: 'd1', completedAt: old, createdAt: old }),
        row({ deviceId: 'd2', completedAt: old, createdAt: old }),
        row({ deviceId: 'd3', errorLog: 'backup helper exited unexpectedly' }),
        row({ deviceId: 'd4', errorLog: 'backup helper exited unexpectedly' }),
      ]);
      expect(data.attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(false);
    });

    it('includes a failure just inside the lookback', async () => {
      const inside = hoursAgo(71);
      const data = await dashboardWith([
        row({ deviceId: 'd1', completedAt: inside, createdAt: inside }),
        row({ deviceId: 'd2', completedAt: inside, createdAt: new Date(inside.getTime() - 1) }),
      ]);
      expect(data.attentionItems.find((i: any) => i.kind === 'destination_failing')).toMatchObject({ failingDevices: 2 });
    });

    it('keeps destinations apart', async () => {
      // Two failing devices, but one per destination, each beside a healthy one.
      const data = await dashboardWith([
        row({ deviceId: 'd1' }),
        row({ deviceId: 'd3', status: 'completed', errorLog: null }),
        row({ deviceId: 'd2', configId: OTHER_CONFIG_ID, configName: 'Other' }),
        row({ deviceId: 'd4', configId: OTHER_CONFIG_ID, configName: 'Other', status: 'completed', errorLog: null }),
      ]);
      expect(data.attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(false);
    });

    it('ignores failures written before the destination was re-pointed', async () => {
      const data = await dashboardWith([
        row({ deviceId: 'd1', storageIdentity: 's3::s3.example.test::old-bucket' }),
        row({ deviceId: 'd2', storageIdentity: 's3::s3.example.test::old-bucket' }),
      ]);
      expect(data.attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(false);
    });

    it('a device that went offline after a refusal still counts as failing', async () => {
      const data = await dashboardWith([
        row({ deviceId: 'd1', completedAt: hoursAgo(5), createdAt: hoursAgo(5) }),
        row({ deviceId: 'd1', errorLog: '[stale-backup-reaper] Device went offline during backup' }),
        row({ deviceId: 'd2' }),
      ]);
      expect(data.attentionItems.find((i: any) => i.kind === 'destination_failing')).toMatchObject({ failingDevices: 2, totalDevices: 2 });
    });

    it('counts only devices the site-restricted user can access', async () => {
      permissionsState = { allowedSiteIds: [SITE_A] };
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      const rows = [
        row({ deviceId: 'd1' }),
        row({ deviceId: 'd2', status: 'completed', errorLog: null }),
        row({ deviceId: 'x1' }),
        row({ deviceId: 'x2' }),
        row({ deviceId: 'x3' }),
      ];
      selectMock
        .mockReturnValueOnce(chainMock([
          { id: 'd1', siteId: SITE_A },
          { id: 'd2', siteId: SITE_A },
          { id: 'x1', siteId: SITE_B },
          { id: 'x2', siteId: SITE_B },
          { id: 'x3', siteId: SITE_B },
        ]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ completed: 0, failed: 0, running: 0, pending: 0 }]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock(rows))
        .mockReturnValueOnce(chainMock(rows))
        .mockReturnValueOnce(chainMock(CONFIG_ROWS));
      const { data } = await (await app.request('/backup/dashboard')).json();
      // One allowed failing device: the three failures on the other site must not tip it over.
      expect(data.attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(false);
    });

    it('keeps the destination item first under the item cap, ordered by failing devices', async () => {
      const many = Array.from({ length: 25 }, (_, n) => row({ deviceId: `m${n}`, completedAt: new Date(Date.now() - 1000 * n), createdAt: new Date(Date.now() - 1000 * n) }));
      const data = await dashboardWith([
        ...many,
        row({ deviceId: 's1', configId: OTHER_CONFIG_ID, configName: 'Other' }),
        row({ deviceId: 's2', configId: OTHER_CONFIG_ID, configName: 'Other' }),
      ]);
      expect(data.attentionItems).toHaveLength(20);
      expect(data.attentionItems[0]).toMatchObject({ configId: CONFIG_ID, failingDevices: 25 });
      expect(data.attentionItems[1]).toMatchObject({ configId: OTHER_CONFIG_ID, failingDevices: 2 });
    });

    it('does not blame the destination for Breeze API refusals or ended sessions', async () => {
      const data = await dashboardWith([
        row({ deviceId: 'd1', errorLog: 'storage session: mint refused with status 403' }),
        row({ deviceId: 'd2', errorLog: 'storage session: renew refused with status 404' }),
        row({ deviceId: 'd3', errorLog: 'storage session: renew rejected with status 410' }),
      ]);
      expect(data.attentionItems.some((i: any) => i.kind === 'destination_failing')).toBe(false);
    });

    it('states no cause when the failing devices do not agree on a majority', async () => {
      const data = await dashboardWith([
        row({ deviceId: 'd1' }),
        row({ deviceId: 'd2', errorLog: 'storage session: storage answered status 404' }),
        row({ deviceId: 'd3', errorLog: 'storage session: multipart:create failed with status 502 after 4 attempts' }),
      ]);
      const item = data.attentionItems.find((i: any) => i.kind === 'destination_failing');
      expect(item).toMatchObject({ failingDevices: 3, failureCause: null });
    });

    it('does not claim a cause for a store 5xx beyond the operation failing', async () => {
      const data = await dashboardWith([
        row({ deviceId: 'd1', errorLog: 'storage session: multipart:create failed with status 502 after 4 attempts' }),
        row({ deviceId: 'd2', errorLog: 'storage session: multipart:create failed with status 502 after 4 attempts' }),
      ]);
      const item = data.attentionItems.find((i: any) => i.kind === 'destination_failing');
      expect(item.failureCause).toBe('storage_operation_failed');
    });

    it('a failed evidence read keeps the per-device items and flags the degraded state', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      const failing = chainMock([]);
      failing.where = vi.fn(() => Promise.reject(new Error('evidence read failed')));
      selectMock
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ count: 0 }]))
        .mockReturnValueOnce(chainMock([{ completed: 0, failed: 0, running: 0, pending: 0 }]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock([]))
        .mockReturnValueOnce(chainMock([row({ deviceId: 'd1' })]))
        .mockReturnValueOnce(failing);
      const res = await app.request('/backup/dashboard');
      expect(res.status).toBe(200);
      const { data } = await res.json();
      // The per-device item computed before the destination read survives it.
      expect(data.attentionItems.map((i: any) => i.id)).toEqual(['backup-failing-d1']);
      expect(data.attentionError).toBe(true);
    });

    // #11772 acceptance: the dashboard item and the connection-health incident
    // agree for the same fixture.
    it('agrees with the backup_destination health source on the same fixture', async () => {
      const fixtures: Array<[string, Array<Record<string, unknown>>]> = [
        ['refused', [row({ deviceId: 'd1' }), row({ deviceId: 'd2' }), row({ deviceId: 'd3', status: 'completed', errorLog: null })]],
        ['one of three', [row({ deviceId: 'd1' }), row({ deviceId: 'd2', status: 'completed', errorLog: null }), row({ deviceId: 'd3', status: 'completed', errorLog: null })]],
        ['single device refused', [row({ deviceId: 'd1' })]],
        ['5xx', [row({ deviceId: 'd1', errorLog: 'storage session: storage answered status 503' }), row({ deviceId: 'd2', errorLog: 'storage session: storage answered status 503' })]],
        ['old identity', [row({ deviceId: 'd1', storageIdentity: 'x' }), row({ deviceId: 'd2', storageIdentity: 'x' })]],
        ['recovered among failing', [
          row({ deviceId: 'd1', completedAt: hoursAgo(10), createdAt: hoursAgo(10) }),
          row({ deviceId: 'd1', status: 'completed', errorLog: null }),
          row({ deviceId: 'd2', completedAt: hoursAgo(9), createdAt: hoursAgo(9) }),
          row({ deviceId: 'd3', completedAt: hoursAgo(8), createdAt: hoursAgo(8) }),
        ]],
        ['refusal beside an offline-only device', [
          row({ deviceId: 'd1' }),
          row({ deviceId: 'd2', errorLog: '[stale-backup-reaper] Device went offline during backup' }),
        ]],
        ['fan-out run with one refused job', (() => {
          const run = hoursAgo(3);
          return [
            row({ deviceId: 'd1', status: 'completed', errorLog: null, createdAt: run }),
            row({ deviceId: 'd1', createdAt: run, errorLog: 'storage session: storage answered status 503' }),
            row({ deviceId: 'd2', errorLog: 'storage session: storage answered status 503' }),
          ];
        })()],
      ];
      for (const [name, rows] of fixtures) {
        const data = await dashboardWith(rows);
        const item = data.attentionItems.find((i: any) => i.kind === 'destination_failing');
        const obs = backupDestinationObservation({
          id: CONFIG_ID, orgId: ORG_ID, partnerId: ORG_ID, name: 'Primary S3', isActive: true, createdAt: hoursAgo(24 * 30),
          currentStorageIdentity: IDENTITY,
          jobs: rows.map((r) => ({
            deviceId: r.deviceId as string, status: r.status as string, errorLog: r.errorLog as string | null,
            createdAt: r.createdAt as Date, completedAt: r.completedAt as Date, storageIdentity: r.storageIdentity as string,
          })),
        }, new Date());
        expect(Boolean(item), name).toBe(obs.state === 'broken');
        if (item) {
          expect(obs.detail, name).toMatch(new RegExp(`^${item.failingDevices} of ${item.totalDevices} devices? failing`));
          const conditionByCause: Record<string, string> = { storage_access_denied: 'destination_access_denied', storage_not_found: 'destination_not_found' };
          expect(obs.condition, name).toBe(conditionByCause[item.failureCause] ?? 'destination_failing');
          expect(obs.severity, name).toBe(conditionByCause[item.failureCause] ? 'permanent' : 'transient');
        }
      }
    });
  });

  it('keeps unrestricted dashboard behavior unchanged', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      { deviceId: OTHER_DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-2' },
    ]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ completed: 1, failed: 1, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([
        makeRecentJob({ deviceId: DEVICE_ID, deviceName: 'Allowed Device' }),
        makeRecentJob({ id: 'job-out', deviceId: OTHER_DEVICE_ID, deviceName: 'Other Device' }),
      ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.policies).toBe(2);
    expect(body.data.latestJobs).toHaveLength(2);
    // 5 base aggregation queries + 2 for the attention-items ranked-jobs lookup
    // (subquery build + the awaited select over it) + 1 for the destination
    // evidence (#11772). Storage Used comes from the stored-bytes service
    // (#9631), mocked here.
    expect(selectMock).toHaveBeenCalledTimes(8);
    expect(body.data.attentionItems).toEqual([]);
  });

  it('flags a device whose recent backups are failing in attentionItems', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 2 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 2, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(chainMock([
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'failed',
          errorLog: 'Disk quota exceeded',
          completedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: new Date('2026-07-14T09:55:00.000Z'),
          rn: 1,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'failed',
          errorLog: null,
          completedAt: new Date('2026-07-13T10:00:00.000Z'),
          createdAt: new Date('2026-07-13T09:55:00.000Z'),
          rn: 2,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
      ])); // ranked-jobs rows

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attentionItems).toHaveLength(1);
    expect(body.data.attentionItems[0]).toMatchObject({
      id: `backup-failing-${FAILING_DEVICE_ID}`,
      severity: 'critical',
    });
    expect(body.data.attentionItems[0].title).toContain('2 consecutive backup failures');
    expect(body.data.attentionItems[0].description).toContain('Disk quota exceeded');
    // Happy path: the list computed successfully, so no degraded signal.
    expect(body.data.attentionError).toBe(false);
  });

  // #9543: the agent's deliberate "reparse points were not backed up" note is
  // informational; it must not stand in for (or bury) the failure reason.
  it('keeps skipped reparse points out of an attention item reason', async () => {
    const reparseNote =
      '159 reparse point(s) were not backed up (junctions and mount points are skipped, not followed; 159 other): ' +
      'C:\\a.exe (other reparse point, tag 0x8000001B); C:\\b.exe (other reparse point, tag 0x8000001B); ' +
      'C:\\c.exe (other reparse point, tag 0x8000001B); C:\\d.exe (other reparse point, tag 0x8000001B); ' +
      'C:\\e.exe (other reparse point, tag 0x8000001B) (+154 more)';
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 2 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 2, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(chainMock([
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'failed',
          errorLog: `backup stopped; ${reparseNote}`,
          completedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: new Date('2026-07-14T09:55:00.000Z'),
          rn: 1,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
      ])); // ranked-jobs rows

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attentionItems).toHaveLength(1);
    expect(body.data.attentionItems[0].description).toMatch(/^backup stopped · Last unsuccessful /);
    expect(body.data.attentionItems[0].description).not.toContain('reparse');
  });

  // #11026: rows persisted before the server stopped storing it can still carry
  // the note that a file list did not fit in the result. It is never the reason.
  it('keeps the recoverable index drop note out of an attention item reason', async () => {
    const indexNote = 'snapshot file index omitted (17950 entries): the result exceeded the 4934464 byte server result budget, so per-file restore browsing is unavailable for this snapshot';
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 2 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 2, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(chainMock([
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'failed',
          errorLog: `backup stopped || bounded: ${indexNote}`,
          completedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: new Date('2026-07-14T09:55:00.000Z'),
          rn: 1,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
      ])); // ranked-jobs rows

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attentionItems[0].description).toMatch(/^backup stopped · Last unsuccessful /);
    expect(body.data.attentionItems[0].description).not.toContain('snapshot file index');
  });

  // #3000: a device whose latest backup landed `partial` (a real snapshot, but
  // a disproportionate share of the data missing) must reach attentionItems.
  // Before the partial status existed such a run was indistinguishable from a
  // clean one, so nothing keyed on job status ever fired for it.
  it('flags a device whose latest backup is partial in attentionItems', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 1 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 0, partial: 1, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(chainMock([
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'partial',
          errorLog: '21 of 22 files failed to upload',
          completedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: new Date('2026-07-14T09:55:00.000Z'),
          rn: 1,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
      ])); // ranked-jobs rows

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attentionItems).toHaveLength(1);
    // A single partial run is a warning, not yet critical, and the copy must
    // not call it a failure.
    expect(body.data.attentionItems[0]).toMatchObject({
      id: `backup-failing-${FAILING_DEVICE_ID}`,
      severity: 'warning',
    });
    expect(body.data.attentionItems[0].title).toContain('only partially completed');
    expect(body.data.attentionItems[0].description).toContain('21 of 22 files failed to upload');
    // The counter must be SERIALIZED, not merely computed. Omitting it from the
    // response body made the web success-rate fix inert while every unit test
    // still passed, because the web test hand-mocked a shape the API never sent.
    expect(body.data.jobsLast24h).toMatchObject({ completed: 0, failed: 0, partial: 1 });
  });

  // #5396: `completed` now means every file was read. A latest run that missed
  // files under the threshold (completed_with_errors) is a restore point, but
  // an operator must see it — as its own warning, never as a failure streak.
  it('flags a device whose latest backup completed with file errors, and serializes the counter', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 1 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 0, completedWithErrors: 1, failed: 1, partial: 0, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(chainMock([
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'completed_with_errors',
          errorLog: '1 file(s) could not be read during collection: perm-denied.txt: permission denied',
          completedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: new Date('2026-07-14T09:55:00.000Z'),
          rn: 1,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'failed',
          errorLog: 'provider unreachable',
          completedAt: new Date('2026-07-13T10:00:00.000Z'),
          createdAt: new Date('2026-07-13T09:55:00.000Z'),
          rn: 2,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
      ])); // ranked-jobs rows

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attentionItems).toHaveLength(1);
    expect(body.data.attentionItems[0]).toMatchObject({
      id: `backup-failing-${FAILING_DEVICE_ID}`,
      severity: 'warning',
    });
    expect(body.data.attentionItems[0].title).toContain('completed with file errors');
    expect(body.data.attentionItems[0].title).not.toContain('consecutive');
    expect(body.data.attentionItems[0].description).toContain('perm-denied.txt');
    expect(body.data.jobsLast24h).toMatchObject({ completed: 0, completedWithErrors: 1, failed: 1 });
  });

  // Two consecutive partial runs are two degraded-but-usable restore points.
  // They must not escalate to `critical` the way two hard failures do.
  it('does not escalate consecutive partial runs to critical severity', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    const partialRow = (rn: number, day: string) => ({
      deviceId: FAILING_DEVICE_ID,
      status: 'partial',
      errorLog: 'most files failed to upload',
      completedAt: new Date(`2026-07-${day}T10:00:00.000Z`),
      createdAt: new Date(`2026-07-${day}T09:55:00.000Z`),
      rn,
      deviceName: 'Finance Laptop',
      deviceHostname: 'fin-laptop-01',
    });
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ count: 0 }]))
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 0, partial: 2, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([partialRow(1, '14'), partialRow(2, '13')]));

    const res = await app.request('/backup/dashboard');
    const body = await res.json();

    expect(body.data.attentionItems).toHaveLength(1);
    expect(body.data.attentionItems[0].severity).toBe('warning');
    expect(body.data.attentionItems[0].title).toContain('consecutive unsuccessful backups');
    expect(body.data.attentionItems[0].title).not.toContain('failures');
  });

  // A cancelled job is a user action, not a fault: it must NOT raise attention.
  it('does not flag a device whose latest backup was cancelled', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 1 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 0, partial: 0, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(chainMock([
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'cancelled',
          errorLog: null,
          completedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: new Date('2026-07-14T09:55:00.000Z'),
          rn: 1,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
      ])); // ranked-jobs rows

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attentionItems).toEqual([]);
  });

  it('surfaces a degraded attentionError flag when the attention-items query fails (not a silent all-clear)', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);

    // A chain whose terminal orderBy() rejects simulates a transient DB error
    // inside resolveAttentionItems. Intermediate builders still resolve so only
    // the awaited select throws.
    const failingRankedRows = (() => {
      const chain: Record<string, any> = {};
      for (const method of ['from', 'where', 'leftJoin', 'limit', 'as']) {
        chain[method] = vi.fn(() => Object.assign(Promise.resolve([]), chain));
      }
      chain.orderBy = vi.fn(() => Promise.reject(new Error('connection terminated unexpectedly')));
      chain.then = (f: any, r: any) => Promise.resolve([]).then(f, r);
      chain.catch = (r: any) => Promise.resolve([]).catch(r);
      return chain;
    })();

    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 1 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 0, failed: 1, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(failingRankedRows); // awaited ranked-jobs select rejects

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request('/backup/dashboard');

    // The dashboard must NOT 500 for one failed sub-query...
    expect(res.status).toBe(200);
    const body = await res.json();
    // ...but it must NOT imply an all-clear either. Empty items + degraded flag.
    expect(body.data.attentionItems).toEqual([]);
    expect(body.data.attentionError).toBe(true);
    errSpy.mockRestore();
  });

  it('does not flag a device whose latest backup succeeded even after a prior failure', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // configCount
      .mockReturnValueOnce(chainMock([{ count: 2 }])) // jobCount
      .mockReturnValueOnce(chainMock([{ count: 0 }])) // snapshotCount
      .mockReturnValueOnce(chainMock([{ completed: 1, failed: 1, running: 0, pending: 0 }])) // last24hStats
      .mockReturnValueOnce(chainMock([])) // recentJobsRaw
      .mockReturnValueOnce(chainMock([])) // ranked-jobs subquery build (value unused)
      .mockReturnValueOnce(chainMock([
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'completed',
          errorLog: null,
          completedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: new Date('2026-07-14T09:55:00.000Z'),
          rn: 1,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
        {
          deviceId: FAILING_DEVICE_ID,
          status: 'failed',
          errorLog: 'Disk quota exceeded',
          completedAt: new Date('2026-07-13T10:00:00.000Z'),
          createdAt: new Date('2026-07-13T09:55:00.000Z'),
          rn: 2,
          deviceName: 'Finance Laptop',
          deviceHostname: 'fin-laptop-01',
        },
      ])); // ranked-jobs rows

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attentionItems).toEqual([]);
  });

  describe('GET /status/:deviceId — lastJob VSS metadata (#3027)', () => {
    function mockStatusQueries(job: Record<string, unknown>) {
      resolveBackupConfigForDeviceMock.mockResolvedValueOnce(null);
      selectMock
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]))
        .mockReturnValueOnce(chainMock([job]));
    }

    function makeJob(overrides: Record<string, unknown> = {}) {
      return {
        id: 'job-vss',
        status: 'completed',
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        completedAt: new Date('2026-04-01T00:10:00.000Z'),
        errorLog: null,
        vssMetadata: null,
        ...overrides,
      };
    }

    it('includes vssMetadata in the lastJob projection', async () => {
      // Regression: the projection returned only {id,status,createdAt,completedAt},
      // so the device tab's VSS panel could never render — showVssStatus was
      // permanently false regardless of what the agent reported.
      mockStatusQueries(makeJob({
        vssMetadata: {
          shadowCopyId: 'set-1',
          writers: [{ name: 'NTDS', state: 'failed' }],
          unprotectedVolumes: ['D:\\'],
        },
      }));

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.lastJob.vssMetadata).toEqual({
        shadowCopyId: 'set-1',
        writers: [{ name: 'NTDS', state: 'failed' }],
        unprotectedVolumes: ['D:\\'],
      });
    });

    it('returns null (not undefined) when the run recorded no VSS metadata', async () => {
      // The UI gates on `!= null`, so the key has to be present and explicitly
      // null rather than dropped from the JSON body.
      mockStatusQueries(makeJob());

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.lastJob).toHaveProperty('vssMetadata');
      expect(body.data.lastJob.vssMetadata).toBeNull();
    });

    it('status lastJob carries dataAccounting', async () => {
      mockStatusQueries(makeJob({
        status: 'completed',
        backupMode: 'system_image',
        totalSize: 1000,
        referencedSize: 0,
        baseSnapshotId: 'snap-base',
      }));

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.lastJob.dataAccounting).toMatchObject({
        uploadedBytes: 1000,
        runKind: 'full',
        fullRunReason: 'nothing_reused',
      });
    });

    it('status lastJob and lastFailure carry failureCategory', async () => {
      mockStatusQueries(makeJob({ status: 'failed', errorLog: 'backup helper exited unexpectedly' }));

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.lastJob.failureCategory).toBe('agent');
      expect(data.lastFailureCategory).toBe('agent');
      expect(data.lastJob.failureCause).toBe('helper_stopped');
      expect(data.lastFailureCause).toBe('helper_stopped');
    });

    it('classifies lastFailure from the failed run when a later run succeeded', async () => {
      resolveBackupConfigForDeviceMock.mockResolvedValueOnce(null);
      selectMock
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]))
        .mockReturnValueOnce(chainMock([
          makeJob({ id: 'job-ok', status: 'completed', createdAt: new Date('2026-04-02T00:00:00.000Z') }),
          makeJob({ id: 'job-bad', status: 'failed', errorLog: 'Agent not connected' }),
        ]));

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.lastJob.failureCategory).toBeNull();
      expect(data.lastFailureCategory).toBe('device_offline');
    });

    it('reports null failure categories for a device with no failed run', async () => {
      mockStatusQueries(makeJob());

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      const { data } = await res.json();
      expect(data.lastJob).toHaveProperty('failureCategory', null);
      expect(data).toHaveProperty('lastFailureCategory', null);
    });

    it('includes errorLog — the ONLY channel a total VSS failure has', async () => {
      // When the shadow copy could not be created there is no vssMetadata at
      // all, so the degradation rides the warning into error_log. Without this
      // the device tab showed a clean green backup for a run that read every
      // file off the live volume.
      mockStatusQueries(makeJob({
        vssMetadata: null,
        errorLog: 'VSS shadow copy could not be created, so every path was read from the live volume',
      }));

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.lastJob.errorLog).toContain('read from the live volume');
    });
  });

  describe('GET /status/:deviceId — which run is "last"', () => {
    // created_at is the row-INSERT clock. The profile fan-out writes an entire
    // occurrence's jobs in one transaction, so they share it to the microsecond
    // and `ORDER BY created_at DESC` is not a total order. Each case below feeds
    // the route rows in the order a created_at-only sort could legitimately
    // return them, and asserts the route still picks the right run.
    function mockJobRows(rows: Array<Record<string, unknown>>) {
      resolveBackupConfigForDeviceMock.mockResolvedValueOnce(null);
      selectMock
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]))
        .mockReturnValueOnce(chainMock(rows));
    }

    function run(overrides: Record<string, unknown> = {}) {
      return {
        id: 'job-run',
        status: 'completed',
        startedAt: new Date('2026-08-05T06:35:00.000Z'),
        createdAt: new Date('2026-08-05T06:32:11.829738Z'),
        completedAt: new Date('2026-08-05T06:50:00.000Z'),
        errorLog: null,
        vssMetadata: null,
        ...overrides,
      };
    }

    it('breaks an identical created_at tie in favour of the later started_at', async () => {
      const sameCreatedAt = new Date('2026-08-05T06:32:11.829738Z');
      mockJobRows([
        run({
          id: 'job-older',
          createdAt: sameCreatedAt,
          startedAt: new Date('2026-08-05T06:32:20.000Z'),
          completedAt: new Date('2026-08-05T06:33:00.000Z'),
        }),
        run({
          id: 'job-newer',
          createdAt: sameCreatedAt,
          startedAt: new Date('2026-08-05T06:40:00.000Z'),
          completedAt: new Date('2026-08-05T06:55:00.000Z'),
          vssMetadata: { shadowCopyId: 'set-9', writers: [] },
        }),
      ]);

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.lastJob.id).toBe('job-newer');
      // The whole point of the defect: the VSS panel renders only off the
      // chosen lastJob's metadata, so picking the loser blanks it.
      expect(body.data.lastJob.vssMetadata).toEqual({ shadowCopyId: 'set-9', writers: [] });
    });

    it('does not let a never-started pending job displace a real completed run', async () => {
      mockJobRows([
        run({
          id: 'job-pending',
          status: 'pending',
          startedAt: null,
          createdAt: new Date('2026-08-05T07:00:00.000Z'),
          completedAt: null,
        }),
        run({
          id: 'job-completed',
          startedAt: new Date('2026-08-05T06:35:00.000Z'),
          createdAt: new Date('2026-08-05T06:32:00.000Z'),
          completedAt: new Date('2026-08-05T06:50:00.000Z'),
          vssMetadata: { shadowCopyId: 'set-1', writers: [] },
        }),
      ]);

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.lastJob.id).toBe('job-completed');
      expect(body.data.lastJob.vssMetadata).toEqual({ shadowCopyId: 'set-1', writers: [] });
      expect(body.data.lastSuccessAt).toBe('2026-08-05T06:50:00.000Z');
    });

    it('still reports a pending job when the device has never run one', async () => {
      // NULLS LAST only demotes — it must never turn a queued-only device into
      // "no backup jobs at all".
      mockJobRows([
        run({ id: 'p1', status: 'pending', startedAt: null, createdAt: new Date('2026-08-05T06:00:00.000Z'), completedAt: null }),
        run({ id: 'p2', status: 'pending', startedAt: null, createdAt: new Date('2026-08-05T07:00:00.000Z'), completedAt: null }),
      ]);

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      const body = await res.json();
      expect(body.data.lastJob.id).toBe('p2');
      expect(body.data.lastSuccessAt).toBeNull();
    });

    it('asks the database for the same order it applies in memory', async () => {
      mockJobRows([run()]);
      const jobsChain = selectMock.mock.results[1]?.value ?? null;

      await app.request(`/backup/status/${DEVICE_ID}`);

      const chain = jobsChain ?? (selectMock.mock.results[1]!.value as Record<string, any>);
      const orderTerms = chain.orderBy.mock.calls[0];
      expect(orderTerms).toHaveLength(3);
      // started_at first, and explicitly NULLS LAST — a bare DESC would be
      // NULLS FIRST in Postgres and float every queued job to the top.
      expect(JSON.stringify(orderTerms[0])).toContain('nulls last');
      expect(JSON.stringify(orderTerms[0])).toContain('backup_jobs.started_at');
      expect(orderTerms[1]).toEqual({ op: 'desc', value: 'backup_jobs.created_at' });
      expect(orderTerms[2]).toEqual({ op: 'desc', value: 'backup_jobs.id' });
    });
  });

  describe('GET /status/:deviceId — activeJobs (#11027)', () => {
    function inFlight(overrides: Record<string, unknown> = {}) {
      return {
        id: 'job-x',
        status: 'running',
        backupMode: 'file',
        backupType: 'file',
        createdAt: new Date('2026-11-05T10:00:00.000Z'),
        startedAt: new Date('2026-11-05T10:01:00.000Z'),
        completedAt: null,
        totalSize: 400,
        transferredSize: 100,
        fileCount: 10,
        totalFiles: 40,
        lastProgressAt: new Date('2026-11-05T10:05:00.000Z'),
        lastKeepaliveAt: new Date('2026-11-05T10:06:00.000Z'),
        errorLog: null,
        vssMetadata: null,
        ...overrides,
      };
    }

    it('status returns activeJobs running-first with resumedAt', async () => {
      resolveBackupConfigForDeviceMock.mockResolvedValueOnce(null);
      const sessionsChain = chainMock([
        { jobId: 'job-running', resumedAt: new Date('2026-11-05T10:02:00.000Z') },
      ]);
      selectMock
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]))
        .mockReturnValueOnce(chainMock([
          // Created later and never started: a second mode queued behind the
          // running one on the same device (#11012's shape).
          inFlight({
            id: 'job-pending',
            status: 'pending',
            backupMode: 'system_image',
            backupType: 'system_image',
            createdAt: new Date('2026-11-05T10:00:00.000Z'),
            startedAt: null,
            totalSize: null,
            transferredSize: null,
            lastProgressAt: null,
            lastKeepaliveAt: new Date('2026-11-05T10:06:00.000Z'),
          }),
          inFlight({ id: 'job-running', transferredSize: 0 }),
          inFlight({ id: 'job-done', status: 'completed', completedAt: new Date('2026-11-04T10:00:00.000Z'), startedAt: new Date('2026-11-04T09:00:00.000Z') }),
        ]))
        .mockReturnValueOnce(sessionsChain);

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.activeJobs.map((j: { id: string }) => j.id)).toEqual(['job-running', 'job-pending']);
      expect(data.activeJobs[0]).toMatchObject({
        status: 'running',
        backupMode: 'file',
        totalSize: 400,
        transferredSize: 0,
        fileCount: 10,
        totalFiles: 40,
        startedAt: '2026-11-05T10:01:00.000Z',
        lastKeepaliveAt: '2026-11-05T10:06:00.000Z',
        resumedAt: '2026-11-05T10:02:00.000Z',
      });
      expect(data.activeJobs[1]).toMatchObject({ status: 'pending', startedAt: null, resumedAt: null });

      // One grouped query, scoped to the active ids and to resumed write sessions.
      const where = JSON.stringify(sessionsChain.where.mock.calls[0]);
      expect(where).toContain('backup_storage_sessions.job_id');
      expect(where).toContain('job-running');
      expect(where).toContain('job-pending');
      expect(where).not.toContain('job-done');
      expect(where).toContain('snapshot_write');
      expect(where).toContain('isNotNull');
      expect(sessionsChain.groupBy).toHaveBeenCalledWith('backup_storage_sessions.job_id');
    });

    it('orders same-status jobs by startedAt then createdAt ascending', async () => {
      resolveBackupConfigForDeviceMock.mockResolvedValueOnce(null);
      selectMock
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]))
        .mockReturnValueOnce(chainMock([
          inFlight({ id: 'p-late', status: 'pending', startedAt: null, createdAt: new Date('2026-11-05T11:00:00.000Z') }),
          inFlight({ id: 'p-early', status: 'pending', startedAt: null, createdAt: new Date('2026-11-05T09:00:00.000Z') }),
          inFlight({ id: 'r-late', startedAt: new Date('2026-11-05T10:30:00.000Z') }),
          inFlight({ id: 'r-early', startedAt: new Date('2026-11-05T10:10:00.000Z') }),
        ]))
        .mockReturnValueOnce(chainMock([]));

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      const { data } = await res.json();
      expect(data.activeJobs.map((j: { id: string }) => j.id)).toEqual(['r-early', 'r-late', 'p-early', 'p-late']);
    });

    it('status returns empty activeJobs and skips the session query when nothing is in flight', async () => {
      resolveBackupConfigForDeviceMock.mockResolvedValueOnce(null);
      selectMock
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]))
        .mockReturnValueOnce(chainMock([
          inFlight({ id: 'job-done', status: 'completed', completedAt: new Date('2026-11-04T10:00:00.000Z') }),
        ]));

      const res = await app.request(`/backup/status/${DEVICE_ID}`);

      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.activeJobs).toEqual([]);
      // device lookup + job history only — no backup_storage_sessions read.
      expect(selectMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('provider-aware coverage', () => {
    it('lists an assigned device with no fresh backup under overdueDevices', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
        { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      ]);
      getFirstPartyCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: false, health: 'critical', status: 'failed', lastSuccessAt: null }]]),
      );
      getProviderCoverageMock.mockResolvedValueOnce(new Map());

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.overdueDevices).toEqual([
        expect.objectContaining({ id: DEVICE_ID, lastBackup: null }),
      ]);
    });

    it('drops a device from overdueDevices when a provider backup covers it', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
        { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      ]);
      getFirstPartyCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: false, health: 'critical', status: 'failed', lastSuccessAt: null }]]),
      );
      getProviderCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: true, health: 'healthy' }]]),
      );

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.overdueDevices).toEqual([]);
    });

    it('counts a provider-covered device as protected', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      getProviderCoverageMock.mockResolvedValueOnce(
        new Map([[DEVICE_ID, { covered: true, health: 'healthy' }]]),
      );

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.coverage.protectedDevices).toBe(1);
    });

    it('appends critical provider rows to attentionItems with a provider: id', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      getProviderAttentionItemsMock.mockResolvedValueOnce([
        { id: 'provider:row-1', title: 'ACME-SRV02: external backup needs attention', description: 'ACME-SRV02 (Acme North) — failed', severity: 'critical' },
      ]);

      const body = await (await app.request('/backup/dashboard')).json();

      expect(body.data.attentionItems).toContainEqual(
        expect.objectContaining({ id: 'provider:row-1', severity: 'critical' }),
      );
    });

    it('passes the site-allowed device ids to the provider attention query', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      permissionsState = { allowedSiteIds: [SITE_A] };
      selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]));

      await app.request('/backup/dashboard');

      expect(getProviderAttentionItemsMock.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: [DEVICE_ID] });
    });

    it('survives a read-model failure without 500ing the dashboard', async () => {
      resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([]);
      getProviderCoverageMock.mockRejectedValueOnce(new Error('boom'));
      getProviderAttentionItemsMock.mockRejectedValueOnce(new Error('boom'));

      const res = await app.request('/backup/dashboard');

      expect(res.status).toBe(200);
      const body = await res.json();
      // Degraded, but never an implied all-clear.
      expect(body.data.attentionError).toBe(true);
    });
  });
});

function makeRecentJob(overrides: Record<string, unknown> = {}) {
  const job = {
    id: 'job-in',
    type: 'manual',
    deviceId: DEVICE_ID,
    configId: 'config-1',
    status: 'completed',
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    totalSize: null,
    errorCount: null,
    errorLog: null,
  };
  return {
    job: { ...job, ...overrides },
    deviceName: overrides.deviceName ?? 'Device',
    deviceHostname: 'device-host',
    configName: 'Primary Backup',
  };
}
