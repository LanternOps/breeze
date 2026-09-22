import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({ queue: [] as unknown[][], read: vi.fn(), import: vi.fn(), update: vi.fn(), execute: vi.fn(), locks: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      let rows: unknown[] | undefined;
      const q: any = {
        from: () => q, where: () => q, limit: () => q, for: () => q,
        then: (resolve: (v: unknown) => unknown) => { rows ??= m.queue.shift() ?? []; return Promise.resolve(rows).then(resolve); },
      };
      return q;
    },
    update: () => ({ set: (value: unknown) => ({ where: async (predicate: unknown) => m.update(value, predicate) }) }),
    execute: m.execute,
  },
}));
vi.mock('../../middleware/auth', () => ({ withAuthDbAccessContext: async (_auth: unknown, fn: () => unknown) => fn() }));
vi.mock('../m365ControlPlane/readActionService', () => ({ executeM365ReadAction: m.read }));
vi.mock('../contacts/import', () => ({ importDirectoryContact: m.import }));
vi.mock('./locks', () => ({ withSubjectLocks: async (_db: unknown, ids: unknown, fn: () => unknown) => { m.locks(ids); return fn(); } }));

import { directoryUsers, syncDirectory } from './directory';
import type { AuthContext } from '../../middleware/auth';

const org = '11111111-1111-4111-8111-111111111111';
const tenant = '22222222-2222-4222-8222-222222222222';
const oid = '33333333-3333-4333-8333-333333333333';
const c = { id: '44444444-4444-4444-8444-444444444444', orgId: org, tenantId: tenant, status: 'active' };
const auth = { scope: 'organization', user: { id: oid }, canAccessOrg: (id: string) => id === org } as unknown as AuthContext;

beforeEach(() => {
  vi.clearAllMocks();
  m.queue = [];
  m.read.mockResolvedValue({ ok: true, kind: 'collection', items: [{ id: oid, userPrincipalName: 'alex@example.com', displayName: 'Alex' }], truncated: false });
  m.import.mockResolvedValue({ id: oid });
});

it('projects verified tenant and W04 envelope payload', async () => {
  m.queue.push([c], [c]);
  expect(await directoryUsers(auth, org, 'alex')).toEqual({
    available: true, truncated: false, users: [{ entraTenantId: tenant, entraOid: oid, upn: 'alex@example.com', displayName: 'Alex' }],
  });
  expect(m.read).toHaveBeenCalledWith(auth, { type: 'm365.user.list', search: 'alex', pageSize: 50 }, org);
});

it('reports missing connection without Graph', async () => {
  m.queue.push([]);
  expect(await directoryUsers(auth, org, 'alex')).toEqual({ available: false, users: [], truncated: false });
  expect(m.read).not.toHaveBeenCalled();
});

it.each([{ ...auth, allowedSiteIds: ['site'] }, { ...auth, canAccessOrg: () => false }])('refuses restricted access', async (restricted) => {
  await expect(directoryUsers(restricted as AuthContext, org, 'alex')).rejects.toMatchObject({ code: 'not_found' });
  expect(m.read).not.toHaveBeenCalled();
});

it('rejects a tenant change during search', async () => {
  m.queue.push([c], [{ ...c, tenantId: oid }]);
  await expect(directoryUsers(auth, org, 'alex')).rejects.toMatchObject({ code: 'directory_changed' });
});

it('rejects a malformed directory response', async () => {
  m.queue.push([c]);
  m.read.mockResolvedValue({ ok: true, kind: 'collection', items: [{ id: 'not-a-uuid' }], truncated: false });
  await expect(directoryUsers(auth, org, 'alex')).rejects.toMatchObject({ code: 'directory_unavailable', message: 'Invalid directory response' });
});

it('reconciles only absent identities under shared locks and preserves consumed history', async () => {
  const missing = '66666666-6666-4666-8666-666666666666';
  m.queue.push([c], [c], [c], [{ id: missing, entraOid: missing }, { id: oid, entraOid: oid }]);
  expect(await syncDirectory(auth, org, [{ contactId: oid, entraOid: oid }])).toEqual({ imported: 1, revoked: 1, complete: true });
  expect(m.import).toHaveBeenCalledWith(auth, { orgId: org, contactId: oid, directoryObjectId: oid, expectedTenantId: tenant }, 'directory_sync');
  expect(m.update).toHaveBeenCalledTimes(1);
  expect(m.locks).toHaveBeenCalledWith([missing]);
  const sqls = m.execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q));
  const revoke = sqls.find((q) => q.sql.includes('UPDATE caller_verifications'))!;
  expect(revoke.sql).toContain('consumed_at IS NULL');
  expect(revoke.params).toEqual([org, missing, missing]);
});

it('does not reconcile partial pages', async () => {
  m.queue.push([c], [c]);
  m.read.mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: true });
  expect(await syncDirectory(auth, org, [])).toEqual({ imported: 0, revoked: 0, complete: false });
  expect(m.update).not.toHaveBeenCalled();
});

it('refuses a mapping absent from the snapshot before importing anything', async () => {
  m.queue.push([c], [c]);
  await expect(syncDirectory(auth, org, [{ contactId: oid, entraOid: '77777777-7777-4777-8777-777777777777' }])).rejects.toMatchObject({ code: 'directory_unavailable' });
  expect(m.import).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});

it.each(['graph', 'import', 'tenant'] as const)('never reconciles after %s failure', async (failure) => {
  m.queue.push([c], [c], [failure === 'tenant' ? { ...c, tenantId: oid } : c]);
  if (failure === 'graph') m.read.mockResolvedValue({ ok: false, message: 'private provider detail' });
  if (failure === 'import') m.import.mockRejectedValue(new Error('write failed'));
  await expect(syncDirectory(auth, org, [{ contactId: oid, entraOid: oid }])).rejects.toThrow();
  expect(m.update).not.toHaveBeenCalled();
});

it('sanitizes upstream search failures', async () => {
  m.queue.push([c]);
  m.read.mockResolvedValue({ ok: false, message: 'secret upstream response' });
  await expect(directoryUsers(auth, org, 'alex')).rejects.toMatchObject({ code: 'directory_unavailable', message: 'Directory read unavailable' });
});
