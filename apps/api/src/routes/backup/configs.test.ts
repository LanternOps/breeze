import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { configsRoutes } from './configs';

const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const checkBackupProviderCapabilitiesMock = vi.fn();
const s3SendMock = vi.fn();

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
    orgId: 'backup_configs.org_id',
    name: 'backup_configs.name',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
  },
}));

vi.mock('../../services/backupSnapshotStorage', () => ({
  checkBackupProviderCapabilities: (...args: unknown[]) => checkBackupProviderCapabilitiesMock(...(args as [])),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      token: { sub: 'user-1' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class S3Client {
    send = s3SendMock;
  },
  PutObjectCommand: class PutObjectCommand {
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class DeleteObjectCommand {
    constructor(public input: unknown) {}
  },
}));

import { authMiddleware } from '../../middleware/auth';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    orgId: ORG_ID,
    name: 'Primary S3',
    type: 'file',
    provider: 's3',
    providerConfig: {
      bucket: 'backups',
      region: 'us-east-1',
      accessKey: 'key',
      secretKey: 'secret',
    },
    providerCapabilities: null,
    providerCapabilitiesCheckedAt: null,
    isActive: true,
    createdAt: new Date('2026-03-31T00:00:00.000Z'),
    updatedAt: new Date('2026-03-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('backup config routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReset();
    checkBackupProviderCapabilitiesMock.mockReset();
    s3SendMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    updateMock.mockImplementation(() => chainMock([]));
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', configsRoutes);
  });

  it('returns explicit object lock support on successful S3 config tests', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig()]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      providerCapabilities: {
        objectLock: {
          supported: true,
          error: null,
        },
      },
      providerCapabilitiesCheckedAt: new Date('2026-03-31T01:00:00.000Z'),
    })]));
    s3SendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: true,
        error: null,
      },
    });

    const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerCapabilities).toEqual({
      objectLock: {
        supported: true,
        checkedAt: expect.any(String),
        error: null,
      },
    });
    expect(body.config.providerCapabilities.objectLock.supported).toBe(true);
  });

  it('returns explicit unsupported object lock state for local configs', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig({
      provider: 'local',
      providerConfig: { path: '/tmp/backups' },
    })]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      provider: 'local',
      providerConfig: { path: '/tmp/backups' },
      providerCapabilities: {
        objectLock: {
          supported: false,
          error: 'Object lock is only supported for S3 providers',
        },
      },
      providerCapabilitiesCheckedAt: new Date('2026-03-31T01:00:00.000Z'),
    })]));
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: false,
        error: 'Object lock is only supported for S3 providers',
      },
    });

    const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerCapabilities.objectLock).toMatchObject({
      supported: false,
      error: 'Object lock is only supported for S3 providers',
    });
  });

  it('returns an explicit unsupported capability result when object lock cannot be verified', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig()]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      providerCapabilities: {
        objectLock: {
          supported: false,
          error: 'Access denied checking object lock configuration',
        },
      },
      providerCapabilitiesCheckedAt: new Date('2026-03-31T01:00:00.000Z'),
    })]));
    s3SendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: false,
        error: 'Access denied checking object lock configuration',
      },
    });

    const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerCapabilities.objectLock).toMatchObject({
      supported: false,
      error: 'Access denied checking object lock configuration',
    });
  });

  it('clears provider capabilities when config details change', async () => {
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      providerConfig: { bucket: 'archive' },
      providerCapabilities: null,
      providerCapabilitiesCheckedAt: null,
      updatedAt: new Date('2026-03-31T02:00:00.000Z'),
    })]));

    const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        details: { bucket: 'archive' },
      }),
    });

    expect(res.status).toBe(200);
    const updateSet = updateMock.mock.results[0]?.value?.set;
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: { bucket: 'archive' },
      providerCapabilities: null,
      providerCapabilitiesCheckedAt: null,
    }));
  });
});
