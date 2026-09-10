import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  createConfigPolicyMock,
  updateConfigPolicyMock,
  deleteConfigPolicyMock,
  dbSelectMock,
  getParentLinkFeatureTypesMock,
} = vi.hoisted(() => ({
  createConfigPolicyMock: vi.fn(),
  updateConfigPolicyMock: vi.fn(),
  deleteConfigPolicyMock: vi.fn(),
  dbSelectMock: vi.fn(),
  getParentLinkFeatureTypesMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    createConfigPolicy: createConfigPolicyMock,
    updateConfigPolicy: updateConfigPolicyMock,
    deleteConfigPolicy: deleteConfigPolicyMock,
    getParentLinkFeatureTypes: getParentLinkFeatureTypesMock,
  };
});

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({ invalidateRemoteAccessCache: vi.fn() }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => true),
}));

import { crudRoutes } from './crud';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';

function makeAuth(allowedSiteIds: string[] | undefined): any {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: { scope: 'organization' },
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
  };
}

function app(auth: any) {
  const instance = new Hono();
  instance.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  instance.route('/', crudRoutes);
  return instance;
}

describe('configuration policies CRUD — site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getParentLinkFeatureTypesMock.mockResolvedValue([]);
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST / denied 403, no service call', async (_label, allowedSiteIds) => {
    const res = await app(makeAuth(allowedSiteIds)).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'policy' }),
    });
    expect(res.status).toBe(403);
    expect(createConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('restricted caller: PATCH /:id denied 403, no service call', async () => {
    const res = await app(makeAuth(['s1'])).request(`/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(403);
    expect(updateConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /:id denied 403, no service call', async () => {
    const res = await app(makeAuth(['s1'])).request(`/${POLICY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(deleteConfigPolicyMock).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST proceeds', async () => {
    createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'policy' });
    const res = await app(makeAuth(undefined)).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'policy' }),
    });
    expect(res.status).toBe(201);
    expect(createConfigPolicyMock).toHaveBeenCalledTimes(1);
  });
});
