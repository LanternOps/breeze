import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { snapshotsRoutes } from './snapshots';

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
let authState = {
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
}));

const applyBackupSnapshotImmutabilityMock = vi.fn();
const checkBackupProviderCapabilitiesMock = vi.fn();
vi.mock('../../services/backupSnapshotStorage', () => ({
  applyBackupSnapshotImmutability: (...args: unknown[]) => applyBackupSnapshotImmutabilityMock(...(args as [])),
  checkBackupProviderCapabilities: (...args: unknown[]) => checkBackupProviderCapabilitiesMock(...(args as [])),
}));

const writeRouteAuditMock = vi.fn();
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

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
    expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
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

  it('denies GET /snapshots/:id for a site-restricted caller when the source device is out-of-site', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]))
      .mockReturnValueOnce(chainMock([{ siteId: SITE_B }]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).not.toHaveProperty('configId');
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('returns GET /snapshots/:id for a site-restricted caller when the source device is in an allowed site', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-in' })]))
      .mockReturnValueOnce(chainMock([{ siteId: SITE_A }]));

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
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]))
      .mockReturnValueOnce(chainMock([{ siteId: SITE_B }]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).not.toHaveProperty('data');
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('returns GET /snapshots/:id/browse for a site-restricted caller when the source device is in an allowed site', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-in' })]))
      .mockReturnValueOnce(chainMock([{ siteId: SITE_A }]))
      .mockReturnValueOnce(chainMock([{ sourcePath: 'C:/data/file.txt', size: 10, modifiedAt: null }]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).snapshotId).toBe(SNAPSHOT_ID);
  });

  it('keeps GET /snapshots/:id/browse unchanged for an unrestricted caller', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([makeSnapshot({ deviceId: 'device-out' })]))
      .mockReturnValueOnce(chainMock([{ sourcePath: 'C:/data/file.txt', size: 10, modifiedAt: null }]));

    const res = await app.request(`/backup/snapshots/${SNAPSHOT_ID}/browse`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).snapshotId).toBe(SNAPSHOT_ID);
    expect(selectMock).toHaveBeenCalledTimes(2);
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

  it('applies legal hold with a required reason', async () => {
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
