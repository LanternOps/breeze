import { beforeEach, describe, expect, it, vi } from 'vitest';

// The holding-org refusal reads the org; the db mocks below do not model it.
const { holdingOrg } = vi.hoisted(() => ({ holdingOrg: { value: false } }));
vi.mock('../../services/unassignedPool/protectedOrg', () => ({ isHoldingOrg: vi.fn(async () => holdingOrg.value) }));
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
const deleteMock = vi.fn(() => chainMock([]));
const writeRouteAuditMock = vi.fn();

vi.mock('../../db', () => ({
  hasDbAccessContext: () => false,
  withDbTransaction: (fn: () => Promise<unknown>) => fn(),
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
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
  c2cBackupJobs: { id: 'c2c_backup_jobs.id', orgId: 'c2c_backup_jobs.org_id', configId: 'c2c_backup_jobs.config_id' },
  c2cBackupItems: { id: 'c2c_backup_items.id', orgId: 'c2c_backup_items.org_id', configId: 'c2c_backup_items.config_id' },
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
    holdingOrg.value = false;
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

  // #6788: the route now maps the shared service's result codes. These pin the pre-refactor responses.
  const createBody = JSON.stringify({ connectionId: CONNECTION_ID, name: 'M365 mail', backupScope: 'mail' });
  const configRow = (over: Record<string, unknown> = {}) => ({
    id: STORAGE_CONFIG_ID, orgId: ORG_ID, connectionId: CONNECTION_ID, name: 'M365 mail', backupScope: 'mail', targetUsers: [],
    storageConfigId: null, schedule: null, retention: null, isActive: true,
    createdAt: new Date('2026-05-02T00:00:00.000Z'), updatedAt: new Date('2026-05-02T00:00:00.000Z'), ...over,
  });

  it('route: create in the holding org is the protected-org 409, before any lookup', async () => {
    holdingOrg.value = true;
    const res = await app.request('/c2c/configs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: createBody });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ORG_PROTECTED' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('route: create with a connection outside the org is 404 Connection not found', async () => {
    const res = await app.request('/c2c/configs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: createBody });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Connection not found' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('route: update of a config the org does not hold is 404 Config not found', async () => {
    const res = await app.request(`/c2c/configs/${STORAGE_CONFIG_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Config not found' });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('route: update returns the config and audits the changed fields', async () => {
    updateMock.mockReturnValueOnce(chainMock([configRow({ name: 'Renamed', isActive: false })]));
    const res = await app.request(`/c2c/configs/${STORAGE_CONFIG_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed', isActive: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: STORAGE_CONFIG_ID, name: 'Renamed', isActive: false, createdAt: '2026-05-02T00:00:00.000Z' });
    expect(body.orgId).toBeUndefined();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'c2c.config.update', resourceId: STORAGE_CONFIG_ID, details: { changedFields: ['name', 'isActive'] },
    }));
  });

  it('route: delete with no history deletes and audits', async () => {
    deleteMock.mockReturnValueOnce(chainMock([configRow()]));
    const res = await app.request(`/c2c/configs/${STORAGE_CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'c2c.config.delete', resourceId: STORAGE_CONFIG_ID, resourceName: 'M365 mail',
    }));
  });

  it('route: delete with item history only (no job) is also 409', async () => {
    selectMock.mockReturnValueOnce(chainMock([])).mockReturnValueOnce(chainMock([{ id: 'item-1' }]));
    const res = await app.request(`/c2c/configs/${STORAGE_CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  // #6788: c2c_backup_jobs and c2c_backup_items reference the config with no ON DELETE, so history refuses the delete.
  it('route: delete with history answers 409, not 500, and writes no audit row', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: 'job-1' }]));
    const res = await app.request(`/c2c/configs/${STORAGE_CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CONFIG_HAS_HISTORY' });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('route: a job created mid-delete (23503) also answers 409', async () => {
    deleteMock.mockReturnValueOnce({
      where: () => ({ returning: () => Promise.reject(Object.assign(new Error('fk'), { code: '23503', constraint_name: 'c2c_backup_items_config_id_fkey' })) }),
    } as never);
    const res = await app.request(`/c2c/configs/${STORAGE_CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CONFIG_HAS_HISTORY' });
  });

  it('route: a delete with no history and no matching row is a 404', async () => {
    const res = await app.request(`/c2c/configs/${STORAGE_CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
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
