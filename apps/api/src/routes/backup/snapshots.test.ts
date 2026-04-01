import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { snapshotsRoutes } from './snapshots';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SNAPSHOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', snapshotsRoutes);
  });

  it('returns protection fields in snapshot responses', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        legalHold: true,
        legalHoldReason: 'Regulatory matter',
        isImmutable: true,
        immutableUntil: new Date('2026-06-01T00:00:00.000Z'),
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
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: null,
      immutabilityFallbackReason: null,
    });
  });

  it('applies legal hold with a required reason', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeSnapshot()]));
    updateMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
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
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'backup.snapshot.legal_hold.apply' }),
    );
  });

  it('rejects releasing provider-enforced immutability from the app', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      makeSnapshot({
        isImmutable: true,
        immutableUntil: new Date('2026-06-01T00:00:00.000Z'),
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
