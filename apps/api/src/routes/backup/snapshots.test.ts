import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { snapshotsRoutes } from './snapshots';

const attachNamesMock = vi.hoisted(() => vi.fn(async (_orgId: string, rows: unknown[]) => rows));
vi.mock('./deviceNames', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deviceNames')>()),
  attachDeviceNames: (...args: [string, unknown[]]) => attachNamesMock(...args),
}));

const listDirMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/backupSnapshotBrowse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/backupSnapshotBrowse')>()),
  listSnapshotDirectory: (...args: unknown[]) => listDirMock(...args),
}));

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
let permissionsState: any;

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy', 'returning', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const authorizeResilienceResourcesMock = vi.fn();
let authState = {
  principal: { kind: 'user_session' as const },
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: '11111111-1111-4111-8111-111111111111' },
};

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    configId: 'backup_snapshots.config_id',
    jobId: 'backup_snapshots.job_id',
    timestamp: 'backup_snapshots.timestamp',
    size: 'backup_snapshots.size',
    fileCount: 'backup_snapshots.file_count',
    label: 'backup_snapshots.label',
    location: 'backup_snapshots.location',
    metadata: 'backup_snapshots.metadata',
    expiresAt: 'backup_snapshots.expires_at',
    legalHold: 'backup_snapshots.legal_hold',
    legalHoldReason: 'backup_snapshots.legal_hold_reason',
    isImmutable: 'backup_snapshots.is_immutable',
    immutableUntil: 'backup_snapshots.immutable_until',
    immutabilityEnforcement: 'backup_snapshots.immutability_enforcement',
    requestedImmutabilityEnforcement: 'backup_snapshots.requested_immutability_enforcement',
    immutabilityFallbackReason: 'backup_snapshots.immutability_fallback_reason',
    snapshotId: 'backup_snapshots.snapshot_id',
  },
  backupSnapshotFiles: {
    snapshotDbId: 'backup_snapshot_files.snapshot_db_id',
    sourcePath: 'backup_snapshot_files.source_path',
    size: 'backup_snapshot_files.size',
    modifiedAt: 'backup_snapshot_files.modified_at',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
  },
  organizations: {
    id: 'organizations.id',
    status: 'organizations.status',
  },
}));

const applyBackupSnapshotImmutabilityMock = vi.fn();
const checkBackupProviderCapabilitiesMock = vi.fn();
vi.mock('../../services/backupSnapshotStorage', () => ({
  applyBackupSnapshotImmutability: (...args: unknown[]) => applyBackupSnapshotImmutabilityMock(...(args as [])),
  checkBackupProviderCapabilities: (...args: unknown[]) => checkBackupProviderCapabilitiesMock(...(args as [])),
  backupLayoutManifestKey: (snapshotId: string) => `backups/${snapshotId}/layout.json`,
}));

const writeRouteAuditMock = vi.fn();
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
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
    if (permissionsState) {
      c.set('permissions', permissionsState);
    }
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';
import { ResilienceAuthorizationError } from '../../services/resilienceSiteAuthorization';

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_ID,
    orgId: ORG_ID,
    deviceId: 'device-1',
    configId: 'config-1',
    jobId: 'job-1',
    timestamp: new Date('2026-03-31T00:00:00.000Z'),
    size: 1024,
    fileCount: 3,
    label: 'Backup 2026-03-31',
    location: 'snapshots/provider-snap-1',
    expiresAt: new Date('2026-04-30T00:00:00.000Z'),
    metadata: {},
    legalHold: false,
    legalHoldReason: null,
    isImmutable: false,
    immutableUntil: null,
    immutabilityEnforcement: null,
    requestedImmutabilityEnforcement: null,
    immutabilityFallbackReason: null,
    snapshotId: 'provider-snap-1',
    ...overrides,
  };
}

describe('snapshot routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    updateMock.mockReset();
    updateMock.mockImplementation(() => chainMock([]));
    permissionsState = undefined;
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      if (permissionsState) {
        c.set('permissions', permissionsState);
      }
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', snapshotsRoutes);
  });

  it('denies an explicit out-of-scope snapshot device filter for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([
      { id: 'device-in', siteId: SITE_A },
    ]));

    const res = await app.request('/backup/snapshots?deviceId=device-out', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('narrows snapshot lists to allowed source device sites for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock
      .mockReturnValueOnce(chainMock([
        { id: 'device-in', siteId: SITE_A },
        { id: 'device-out', siteId: SITE_B },
      ]))
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-in' })]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.deviceId)).toEqual(['device-in']);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('filters to bare-metal-restorable snapshots when requested (W04a)', async () => {
    const chain = chainMock([makeSnapshot({ bareMetalRestorable: true })]);
    selectMock.mockReturnValueOnce(chain);

    const res = await app.request('/backup/snapshots?bareMetalRestorable=true', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
    // and(...conditions) is called once with every pushed condition — the
    // bare-metal filter must be among them, not silently dropped.
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('keeps unrestricted snapshot list behavior unchanged', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({ deviceId: 'device-in' }),
      makeSnapshot({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deviceId: 'device-out' }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('returns the device-name-enriched snapshot rows (#7213)', async () => {
    attachNamesMock.mockImplementationOnce(async (_orgId, rows) =>
      (rows as Array<{ deviceId: string }>).map((r) => ({ ...r, deviceName: 'FRONT-DESK-01' })));
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-in' })]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data[0].deviceName).toBe('FRONT-DESK-01');
  });

  it('denies GET /snapshots/:id for a site-restricted caller when the source device is out-of-site', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).not.toHaveProperty('configId');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns GET /snapshots/:id for a site-restricted caller when the source device is in an allowed site', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-in' })]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(SNAPSHOT_ID);
  });

  it('keeps GET /snapshots/:id unchanged for an unrestricted caller', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(SNAPSHOT_ID);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('denies GET /snapshots/:id/browse for a site-restricted caller when the source device is out-of-site', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).not.toHaveProperty('data');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns GET /snapshots/:id/browse for a site-restricted caller when the source device is in an allowed site', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-in' })]));
    listDirMock.mockResolvedValueOnce({ entries: [], nextCursor: null });

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).snapshotId).toBe(SNAPSHOT_ID);
  });

  it('keeps GET /snapshots/:id/browse unchanged for an unrestricted caller', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]));
    listDirMock.mockResolvedValueOnce({ entries: [], nextCursor: null });

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).snapshotId).toBe(SNAPSHOT_ID);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  // D12: once backupResultPersistence.ts indexes the agent's stable
  // originalPath (e.g. C:\assure\src\x) instead of the transient VSS
  // shadow-copy device path, backup_snapshot_files.source_path for a Windows
  // run is a normal Windows path, not \\?\GLOBALROOT\Device\
  // HarddiskVolumeShadowCopyN\.... The browse tree must root it at the drive
  // letter, never at "?" (which is what splitting the raw shadow path would
  // have produced — normalizeSourcePath backslash-to-forward-slash turns
  // `\\?\GLOBALROOT\...` into `//?/GLOBALROOT/...`, whose first non-empty
  // segment is "?").
  it('lists one level per request and never reads the whole file index (#8230)', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]));
    listDirMock.mockResolvedValueOnce({
      entries: [{ name: 'C:', path: '/C:', type: 'directory' }],
      nextCursor: 'abc',
    });

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ name: 'C:', path: '/C:', type: 'directory' }]);
    expect(body.nextCursor).toBe('abc');
    expect(body.dir).toBe('');
    // Only the snapshot-row lookup hits db.select; the file index goes through
    // the bounded SQL lister.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(listDirMock).toHaveBeenCalledWith(expect.objectContaining({ segments: [], limit: 200, cursor: null }));
  });

  it('passes dir (Windows backslashes normalised), limit and cursor to the lister', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]));
    listDirMock.mockResolvedValueOnce({ entries: [], nextCursor: null });
    const cursor = Buffer.from('0:assure', 'utf8').toString('base64url');

    const res = await app.request(
      `/backup/snapshots/${SNAPSHOT_ID}/browse?dir=${encodeURIComponent('C:\\data')}&limit=50&cursor=${cursor}`,
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );

    expect(res.status).toBe(200);
    expect(listDirMock).toHaveBeenCalledWith(expect.objectContaining({
      segments: ['C:', 'data'],
      limit: 50,
      cursor: { rank: 0, name: 'assure' },
    }));
  });

  it('rejects an out-of-range limit and a malformed cursor with 400', async () => {
    for (const qs of ['limit=0', 'limit=100000', 'cursor=!!!notacursor']) {
      selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]));
      const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse?${qs}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });
      expect(res.status, qs).toBe(400);
    }
    expect(listDirMock).not.toHaveBeenCalled();
  });

  it('flags manifestUnavailable only for the root of a snapshot with a recorded fileCount but no index', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out', fileCount: 12 })]));
    listDirMock.mockResolvedValueOnce({ entries: [], nextCursor: null });
    const root = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    expect((await root.json()).manifestUnavailable).toBe(true);

    selectMock.mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out', fileCount: 12 })]));
    listDirMock.mockResolvedValueOnce({ entries: [], nextCursor: null });
    const sub = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse?dir=/C:`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    expect((await sub.json()).manifestUnavailable).toBe(false);
  });

  it('returns protection fields in snapshot responses', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        metadata: {
          snapshotProtection: {
            legalHoldSource: 'policy',
          },
        },
        legalHold: true,
        legalHoldReason: 'Regulatory matter',
        isImmutable: true,
        immutableUntil: new Date('2030-06-01T00:00:00.000Z'),
        immutabilityEnforcement: 'application',
      }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      legalHold: true,
      legalHoldReason: 'Regulatory matter',
      legalHoldSource: 'policy',
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: null,
      immutabilityFallbackReason: null,
      retentionBlockedReason: 'legal_hold',
    });
  });

  it('returns the bare-metal restorability verdict on snapshot responses', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        bareMetalRestorable: false,
        bareMetalReasons: ['LVM volumes are not supported'],
      }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      bareMetalRestorable: false,
      bareMetalReasons: ['LVM volumes are not supported'],
    });
  });

  it('exposes the layout manifest storage key so Restore-as-VM can offer the rebuild engine', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({ snapshotId: 'snap-ext-9', layoutManifest: { disks: [] }, bareMetalRestorable: true }),
      makeSnapshot({ id: 'snapshot-2', snapshotId: 'snap-ext-10', layoutManifest: null, bareMetalRestorable: true }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].layoutManifestKey).toBe('backups/snap-ext-9/layout.json');
    expect(body.data[1].layoutManifestKey).toBeNull();
    // the manifest body itself is not shipped on the list
    expect(body.data[0].layoutManifest).toBeUndefined();
  });

  it('exposes the layout platform so Restore-as-VM can match the rebuild host OS (W06d)', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({ snapshotId: 'snap-win', layoutManifest: { platform: 'windows', disks: [] } }),
      makeSnapshot({ id: 'snapshot-2', snapshotId: 'snap-lin', layoutManifest: { platform: 'linux', disks: [] } }),
      makeSnapshot({ id: 'snapshot-3', snapshotId: 'snap-old', layoutManifest: { disks: [] } }),
      makeSnapshot({ id: 'snapshot-4', snapshotId: 'snap-mac', layoutManifest: { platform: 'darwin' } }),
      makeSnapshot({ id: 'snapshot-5', snapshotId: 'snap-none', layoutManifest: null }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: { layoutPlatform: unknown }) => row.layoutPlatform)).toEqual([
      'windows',
      'linux',
      null,
      null,
      null,
    ]);
  });

  it('exposes each snapshot\'s integrity status so restore screens can label it', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({ integrityStatus: 'attested' }),
      makeSnapshot({ id: 'snapshot-2', snapshotId: 'snap-2', integrityStatus: 'unattested_legacy' }),
      makeSnapshot({ id: 'snapshot-3', snapshotId: 'snap-3' }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: { integrityStatus: unknown }) => row.integrityStatus)).toEqual([
      'attested',
      'unattested_legacy',
      'unattested_legacy',
    ]);
  });

  it('exposes the sizing fields of the stored hardware profile so Restore-as-VM cards can show CPU / memory / disk', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        hardwareProfile: {
          cpuModel: 'Xeon',
          cpuCores: 8,
          totalMemoryMB: 16384,
          disks: [
            { name: 'disk0', sizeBytes: 256 * 1024 ** 3, model: 'NVMe', partitions: [{ name: 'C:' }] },
            { name: 'disk1', sizeBytes: 1024 ** 4 },
          ],
          networkAdapters: [{ name: 'eth0', macAddress: '00:11:22:33:44:55' }],
          biosVersion: '1.2.3',
          isUefi: true,
          motherboard: 'Board',
        },
      }),
      makeSnapshot({ id: 'snapshot-2', snapshotId: 'snap-2', hardwareProfile: null }),
      makeSnapshot({ id: 'snapshot-3', snapshotId: 'snap-3', hardwareProfile: { cpuCores: 'eight', disks: 'none' } }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the sizing fields ride on the list — no NICs/MACs, BIOS or board strings.
    expect(body.data[0].hardwareProfile).toEqual({
      cpuCores: 8,
      totalMemoryMB: 16384,
      disks: [{ sizeBytes: 256 * 1024 ** 3 }, { sizeBytes: 1024 ** 4 }],
    });
    expect(body.data[1].hardwareProfile).toBeNull();
    expect(body.data[2].hardwareProfile).toEqual({ cpuCores: null, totalMemoryMB: null, disks: [] });
  });

  it('returns a null bare-metal verdict (never assessed) as null + empty reasons, not false', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({ bareMetalRestorable: null, bareMetalReasons: null }),
    ]));

    const res = await app.request('/backup/snapshots', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({
      bareMetalRestorable: null,
      bareMetalReasons: [],
    });
  });

  it('applies legal hold with a required reason', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ status: 'active' }]));
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot()]));
    updateMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        metadata: {
          snapshotProtection: {
            legalHoldSource: 'manual',
          },
        },
        legalHold: true,
        legalHoldReason: 'Litigation',
      }),
    ]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/legal-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'Litigation' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.legalHold).toBe(true);
    expect(body.legalHoldReason).toBe('Litigation');
    expect(body.legalHoldSource).toBe('manual');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'backup.snapshot.legal_hold.apply' }),
    );
  });

  it('refuses to apply a legal hold while the organization is being erased', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ status: 'purging' }]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/legal-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'Litigation' }),
    });

    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('releases legal hold via DELETE', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        metadata: {
          snapshotProtection: {
            legalHoldSource: 'manual',
          },
        },
        legalHold: true,
        legalHoldReason: 'Litigation',
      }),
    ]));
    updateMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        metadata: {
          snapshotProtection: {
            legalHoldSource: null,
          },
        },
        legalHold: false,
        legalHoldReason: null,
      }),
    ]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/legal-hold`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'Released' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.legalHold).toBe(false);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'backup.snapshot.legal_hold.release' }),
    );
  });

  it('rejects releasing provider-enforced immutability from the app', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        isImmutable: true,
        immutableUntil: new Date('2030-06-01T00:00:00.000Z'),
        immutabilityEnforcement: 'provider',
      }),
    ]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/immutability/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'No longer required' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('Provider-enforced immutability');
  });

  it('applies provider-enforced immutability when the storage provider supports it', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot()]))
      .mockReturnValueOnce(chainMock([makeSnapshot()]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'backups', region: 'us-east-1' } }]));
    updateMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        isImmutable: true,
        immutableUntil: new Date('2026-04-30T00:00:00.000Z'),
        immutabilityEnforcement: 'provider',
        requestedImmutabilityEnforcement: 'provider',
      }),
    ]));
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: true,
        error: null,
      },
    });
    applyBackupSnapshotImmutabilityMock.mockResolvedValueOnce({
      enforcement: 'provider',
      objectCount: 2,
    });

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/immutability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'Regulatory lock', immutableDays: 30, enforcement: 'provider' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isImmutable).toBe(true);
    expect(body.immutabilityEnforcement).toBe('provider');
    expect(body.requestedImmutabilityEnforcement).toBe('provider');
    expect(applyBackupSnapshotImmutabilityMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 's3',
      snapshotId: 'provider-snap-1',
      retainUntil: expect.any(Date),
    }));
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'backup.snapshot.immutability.apply.provider' }),
    );
  });

  it('rejects attempts to shorten an existing immutability window', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([
        makeSnapshot({
          isImmutable: true,
          immutableUntil: new Date('2030-06-01T00:00:00.000Z'),
          immutabilityEnforcement: 'application',
        }),
      ]))
      .mockReturnValueOnce(chainMock([
        makeSnapshot({
          isImmutable: true,
          immutableUntil: new Date('2030-06-01T00:00:00.000Z'),
          immutabilityEnforcement: 'application',
        }),
      ]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/immutability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'Try shorten', extendUntil: '2030-05-01T00:00:00.000Z', enforcement: 'application' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('extended forward');
  });

  it('rejects manual provider immutability when object lock is unavailable', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot()]))
      .mockReturnValueOnce(chainMock([makeSnapshot()]))
      .mockReturnValueOnce(chainMock([{ provider: 's3', providerConfig: { bucket: 'backups', region: 'us-east-1' } }]));
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: false,
        error: 'Bucket object lock is not enabled',
      },
    });

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/immutability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'Regulatory lock', immutableDays: 30, enforcement: 'provider' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('Bucket object lock is not enabled');
    expect(applyBackupSnapshotImmutabilityMock).not.toHaveBeenCalled();
  });
});
