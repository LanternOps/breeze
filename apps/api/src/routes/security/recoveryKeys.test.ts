import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', hostname: 'devices.hostname', osType: 'devices.osType' },
  deviceRecoveryKeys: {
    id: 'drk.id', deviceId: 'drk.deviceId', orgId: 'drk.orgId', keyType: 'drk.keyType',
    volumeMount: 'drk.volumeMount', protectorId: 'drk.protectorId', encryptedKey: 'drk.encryptedKey',
    status: 'drk.status', escrowedAt: 'drk.escrowedAt', supersededAt: 'drk.supersededAt',
  },
  recoveryKeyAccessEvents: {
    id: 'rkae.id', keyId: 'rkae.keyId', deviceId: 'rkae.deviceId', orgId: 'rkae.orgId',
    userId: 'rkae.userId', userEmail: 'rkae.userEmail', action: 'rkae.action', createdAt: 'rkae.createdAt',
  },
}));

const { getUserPermissionsMock, writeRouteAuditMock, queueCommandMock, decryptForColumnMock, encryptFieldsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  queueCommandMock: vi.fn(async () => ({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })),
  decryptForColumnMock: vi.fn(() => '111111-222222-333333-444444-555555-666666-777777-888888'),
  encryptFieldsMock: vi.fn((_t: string, p: Record<string, unknown>) => ({ ...p, __encrypted: true })),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { ENCRYPTION_ROTATE_KEY: 'encryption_rotate_key', ENCRYPTION_COLLECT_KEYS: 'encryption_collect_keys' },
  queueCommand: queueCommandMock,
}));
vi.mock('../../services/secretCrypto', () => ({ decryptForColumn: decryptForColumnMock }));
vi.mock('../../services/sensitiveCommandPayload', () => ({ encryptSensitivePayloadFields: encryptFieldsMock }));

import { db } from '../../db';
import { recoveryKeysRoutes } from './recoveryKeys';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_KEY_ID = '44444444-4444-4444-8444-444444444444';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as any);
    await next();
  });
  app.route('/security', recoveryKeysRoutes);
  return app;
}

function mockDeviceSelect(overrides: Partial<{ siteId: string | null; osType: string }> = {}) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{
          id: DEVICE_ID,
          hostname: 'test-host',
          orgId: ORG_ID,
          siteId: overrides.siteId ?? null,
          osType: overrides.osType ?? 'windows',
        }]),
      }),
    }),
  } as any);
}

function mockKeysListSelect(keys: any[] = []) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(keys),
        }),
      }),
    }),
  } as any);
}

function mockAccessEventsSelect(events: any[] = []) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(events),
        }),
      }),
    }),
  } as any);
}

function mockKeyLookupSelect(key: any | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(key ? [key] : []),
      }),
    }),
  } as any);
}

function mockInsert() {
  const values = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValueOnce({ values } as any);
  return values;
}

const SAMPLE_KEY_ROW = {
  id: KEY_ID,
  deviceId: DEVICE_ID,
  orgId: ORG_ID,
  keyType: 'bitlocker',
  volumeMount: 'C:',
  protectorId: 'protector-1',
  encryptedKey: 'enc:blob',
  status: 'active',
  escrowedAt: new Date('2026-01-01'),
  supersededAt: null,
};

const PLAINTEXT_KEY = '111111-222222-333333-444444-555555-666666-777777-888888';

describe('recoveryKeysRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }, { resource: 'devices', action: 'execute' }],
      allowedSiteIds: undefined,
    });
  });

  it('list returns key metadata + access history without encryptedKey or plaintext', async () => {
    mockDeviceSelect();
    mockKeysListSelect([
      { id: KEY_ID, keyType: 'bitlocker', volumeMount: 'C:', protectorId: 'protector-1', status: 'active', escrowedAt: new Date('2026-01-01'), supersededAt: null },
    ]);
    mockAccessEventsSelect([
      { id: 'evt-1', keyId: KEY_ID, userEmail: 'test@example.com', action: 'revealed', createdAt: new Date('2026-01-02') },
    ]);
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('encryptedKey');
    expect(raw).not.toContain(PLAINTEXT_KEY);
    expect(body.data.device).toEqual({ id: DEVICE_ID, hostname: 'test-host', os: 'windows' });
    expect(body.data.keys).toHaveLength(1);
    expect(body.data.keys[0].id).toBe(KEY_ID);
    expect(body.data.accessHistory).toHaveLength(1);
    expect(body.data.accessHistory[0].keyId).toBe(KEY_ID);
  });

  it('reveal happy path returns decrypted key, writes ledger row + audit without plaintext', async () => {
    mockDeviceSelect();
    mockKeyLookupSelect(SAMPLE_KEY_ROW);
    const insertValues = mockInsert();
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/${KEY_ID}/reveal`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.recoveryKey).toBe(PLAINTEXT_KEY);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', userEmail: 'test@example.com', keyId: KEY_ID })
    );

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    const auditArg = writeRouteAuditMock.mock.calls[0]![1] as any;
    expect(auditArg.action).toBe('device.recovery_key.reveal');
    expect(JSON.stringify(auditArg.details)).not.toContain(PLAINTEXT_KEY);
  });

  it('reveal returns 404 when key id not found for device', async () => {
    mockDeviceSelect();
    mockKeyLookupSelect(null);
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/${OTHER_KEY_ID}/reveal`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('site-scope denial returns 403 for list', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: ['other-site'],
    });
    mockDeviceSelect({ siteId: 'site-1' });
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys`, { method: 'GET' });
    expect(res.status).toBe(403);
  });

  it('site-scope denial returns 403 for reveal', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: ['other-site'],
    });
    mockDeviceSelect({ siteId: 'site-1' });
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/${KEY_ID}/reveal`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('rotate windows defaults volumeMount to C: and queues command', async () => {
    mockDeviceSelect({ osType: 'windows' });
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    expect(queueCommandMock).toHaveBeenCalledWith(DEVICE_ID, 'encryption_rotate_key', { volumeMount: 'C:' }, 'user-1');
    const auditArg = writeRouteAuditMock.mock.calls[0]![1] as any;
    expect(auditArg.action).toBe('device.recovery_key.rotate');
  });

  it('rotate macos without credentials returns 400 and does not queue', async () => {
    mockDeviceSelect({ osType: 'macos' });
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('rotate macos with credentials encrypts payload and audit omits password', async () => {
    mockDeviceSelect({ osType: 'macos' });
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2' }),
    });
    expect(res.status).toBe(202);
    expect(encryptFieldsMock).toHaveBeenCalledWith('encryption_rotate_key', expect.objectContaining({ username: 'admin', password: 'hunter2' }));
    const queuedPayload = (queueCommandMock.mock.calls[0] as any[])[2];
    expect(queuedPayload).toEqual(expect.objectContaining({ __encrypted: true }));

    const auditArg = writeRouteAuditMock.mock.calls[0]![1] as any;
    expect(JSON.stringify(auditArg.details)).not.toContain('hunter2');
  });

  it('rotate linux returns 400 unsupported', async () => {
    mockDeviceSelect({ osType: 'linux' });
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('collect queues encryption_collect_keys and returns 202', async () => {
    mockDeviceSelect();
    const app = buildApp();

    const res = await app.request(`/security/encryption/devices/${DEVICE_ID}/recovery-keys/collect`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(queueCommandMock).toHaveBeenCalledWith(DEVICE_ID, 'encryption_collect_keys', {}, 'user-1');
    const body = await res.json();
    expect(body.data.status).toBe('queued');
    expect(body.data.commandId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });
});
