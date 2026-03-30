import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { bmrRoutes, bmrPublicRoutes } from './bmr';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TOKEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../services', () => ({}));

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
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    size: 'backup_snapshots.size',
    fileCount: 'backup_snapshots.file_count',
    hardwareProfile: 'backup_snapshots.hardware_profile',
    systemStateManifest: 'backup_snapshots.system_state_manifest',
  },
  restoreJobs: {
    id: 'restore_jobs.id',
  },
  devices: {
    id: 'devices.id',
    hostname: 'devices.hostname',
    osType: 'devices.os_type',
  },
}));

vi.mock('../../db/schema/recoveryTokens', () => ({
  recoveryTokens: {
    id: 'recovery_tokens.id',
    orgId: 'recovery_tokens.org_id',
    deviceId: 'recovery_tokens.device_id',
    snapshotId: 'recovery_tokens.snapshot_id',
    tokenHash: 'recovery_tokens.token_hash',
    restoreType: 'recovery_tokens.restore_type',
    targetConfig: 'recovery_tokens.target_config',
    status: 'recovery_tokens.status',
    createdAt: 'recovery_tokens.created_at',
    expiresAt: 'recovery_tokens.expires_at',
    usedAt: 'recovery_tokens.used_at',
  },
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
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../../middleware/auth';

describe('bmr routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    insertMock.mockReset();
    insertMock.mockImplementation(() => chainMock([]));
    updateMock.mockReset();
    updateMock.mockImplementation(() => chainMock([]));
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
    app.route('/backup', bmrPublicRoutes);
    app.route('/backup', bmrRoutes);
  });

  it('creates a recovery token', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, orgId: ORG_ID, deviceId: DEVICE_ID }]));
    insertMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      expiresAt: new Date('2026-03-30T00:00:00.000Z'),
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));

    const res = await app.request('/backup/bmr/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        expiresInHours: 24,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(TOKEN_ID);
    expect(body.token.startsWith('brz_rec_')).toBe(true);
  });

  it('returns token metadata without the hash', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      status: 'active',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      expiresAt: new Date('2026-03-30T00:00:00.000Z'),
      usedAt: null,
    }]));

    const res = await app.request(`/backup/bmr/token/${TOKEN_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(TOKEN_ID);
    expect(body.tokenHash).toBeUndefined();
  });

  it('revokes a recovery token', async () => {
    updateMock.mockReturnValueOnce(chainMock([{ id: TOKEN_ID }]));

    const res = await app.request(`/backup/bmr/token/${TOKEN_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: TOKEN_ID, status: 'revoked' });
  });

  it('authenticates a valid recovery token', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        targetConfig: { diskLayout: 'auto' },
        status: 'active',
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        expiresAt: new Date('2026-04-01T00:00:00.000Z'),
      }]))
      .mockReturnValueOnce(chainMock([{
        id: SNAPSHOT_ID,
        snapshotId: 'snap-ext-001',
        size: 1234,
        fileCount: 12,
        hardwareProfile: { cpuCores: 4 },
        systemStateManifest: { drivers: 3 },
      }]))
      .mockReturnValueOnce(chainMock([{
        id: DEVICE_ID,
        hostname: 'srv-01',
        osType: 'windows',
      }]));
    updateMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'brz_rec_valid_token' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokenId).toBe(TOKEN_ID);
    expect(body.device.hostname).toBe('srv-01');
    expect(body.snapshot.id).toBe(SNAPSHOT_ID);
  });

  it('rejects an expired recovery token', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      targetConfig: null,
      status: 'active',
      createdAt: new Date('2026-03-28T00:00:00.000Z'),
      expiresAt: new Date('2026-03-28T01:00:00.000Z'),
    }]));
    updateMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'brz_rec_expired_token' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Token has expired');
  });
});
