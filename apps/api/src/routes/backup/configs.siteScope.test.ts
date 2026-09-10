import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as any } }));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'set', 'values']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
    transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        select: (...args: unknown[]) => selectMock(...(args as [])),
        insert: (...args: unknown[]) => insertMock(...(args as [])),
        update: (...args: unknown[]) => updateMock(...(args as [])),
      }),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  assertOutsideHeldDbContext: vi.fn(),
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

vi.mock('../../services/backupSnapshotStorage', () => ({ checkBackupProviderCapabilities: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { configsRoutes } from './configs';
import { authMiddleware } from '../../middleware/auth';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function orgAuth(allowedSiteIds: string[] | undefined) {
  return {
    user: { id: 'user-1' },
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (id: string) => id === ORG_ID,
    token: { sub: 'user-1' },
  };
}

function app() {
  const instance = new Hono();
  instance.use('*', authMiddleware);
  instance.route('/backup', configsRoutes);
  return instance;
}

describe('backup configs site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /backup/configs denied 403, no insert', async (_label, allowedSiteIds) => {
    authRef.current = orgAuth(allowedSiteIds);
    const res = await app().request('/backup/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local backup', provider: 'local' }),
    });
    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('restricted caller: PATCH /backup/configs/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/backup/configs/${CONFIG_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /backup/configs/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/backup/configs/${CONFIG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /backup/configs/:id/test denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/backup/configs/${CONFIG_ID}/test`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST proceeds to insert', async () => {
    authRef.current = orgAuth(undefined);
    insertMock.mockReturnValue(chainMock([{
      id: CONFIG_ID, orgId: ORG_ID, name: 'Local backup', provider: 'local',
      isActive: true, isDefault: false, encryption: false, providerConfig: {},
      createdAt: new Date(), updatedAt: new Date(),
    }]));
    const res = await app().request('/backup/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local backup', provider: 'local' }),
    });
    expect(res.status).toBe(201);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });
});
