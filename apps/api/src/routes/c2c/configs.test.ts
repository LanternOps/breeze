import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { c2cConfigsRoutes } from './configs';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STORAGE_CONFIG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
}));

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
const writeRouteAuditMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: vi.fn(() => chainMock([])),
  },
}));

vi.mock('../../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
  },
  c2cConnections: {
    id: 'c2c_connections.id',
    orgId: 'c2c_connections.org_id',
  },
  c2cBackupConfigs: {
    id: 'c2c_backup_configs.id',
    orgId: 'c2c_backup_configs.org_id',
    connectionId: 'c2c_backup_configs.connection_id',
    name: 'c2c_backup_configs.name',
    backupScope: 'c2c_backup_configs.backup_scope',
    targetUsers: 'c2c_backup_configs.target_users',
    storageConfigId: 'c2c_backup_configs.storage_config_id',
    schedule: 'c2c_backup_configs.schedule',
    retention: 'c2c_backup_configs.retention',
    isActive: 'c2c_backup_configs.is_active',
    createdAt: 'c2c_backup_configs.created_at',
    updatedAt: 'c2c_backup_configs.updated_at',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  requirePermission: vi.fn(() => (c: any, next: any) => {
    if (permissionGate.deny) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => {
    if (mfaGate.deny) {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  }),
}));

const authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
  accessibleOrgIds: [ORG_ID],
  canAccessOrg: (orgId: string): boolean => orgId === ORG_ID,
  orgCondition: () => undefined,
};

describe('c2c config routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', authState as any);
      return next();
    });
    app.route('/c2c', c2cConfigsRoutes);
  });

  it('requires explicit write permission and MFA for config creation', async () => {
    permissionGate.deny = true;
    const deniedPermission = await app.request('/c2c/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        name: 'M365 mail',
        backupScope: 'mail',
      }),
    });
    expect(deniedPermission.status).toBe(403);

    permissionGate.deny = false;
    mfaGate.deny = true;
    const deniedMfa = await app.request('/c2c/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        name: 'M365 mail',
        backupScope: 'mail',
      }),
    });
    expect(deniedMfa.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects create when storage config is not in the scoped org', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: CONNECTION_ID }]))
      .mockReturnValueOnce(chainMock([]));

    const res = await app.request('/c2c/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        name: 'M365 mail',
        backupScope: 'mail',
        storageConfigId: STORAGE_CONFIG_ID,
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Storage config not found' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates config when storage config belongs to the scoped org', async () => {
    const now = new Date('2026-05-02T00:00:00.000Z');
    selectMock
      .mockReturnValueOnce(chainMock([{ id: CONNECTION_ID }]))
      .mockReturnValueOnce(chainMock([{ id: STORAGE_CONFIG_ID }]));
    insertMock.mockReturnValueOnce(chainMock([{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      orgId: ORG_ID,
      connectionId: CONNECTION_ID,
      name: 'M365 mail',
      backupScope: 'mail',
      targetUsers: [],
      storageConfigId: STORAGE_CONFIG_ID,
      schedule: null,
      retention: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }]));

    const res = await app.request('/c2c/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        name: 'M365 mail',
        backupScope: 'mail',
        storageConfigId: STORAGE_CONFIG_ID,
      }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).storageConfigId).toBe(STORAGE_CONFIG_ID);
  });

  it('rejects update when storage config is not in the scoped org', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/c2c/configs/dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageConfigId: STORAGE_CONFIG_ID }),
    });

    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
