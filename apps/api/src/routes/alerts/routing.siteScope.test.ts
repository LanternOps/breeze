import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectQueue, insertValuesMock, updateSetMock, deleteWhereMock } = vi.hoisted(() => ({
  authRef: { current: {} as any },
  selectQueue: [] as unknown[][],
  insertValuesMock: vi.fn(),
  updateSetMock: vi.fn(),
  deleteWhereMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: (allowed?: string[]) => (siteId?: string | null) => !allowed || (!!siteId && allowed.includes(siteId)),
}));

vi.mock('../../db/schema', () => ({
  notificationRoutingRules: {
    id: 'rule.id', orgId: 'rule.orgId', partnerId: 'rule.partnerId', priority: 'rule.priority',
  },
  sites: { id: 'site.id', orgId: 'site.orgId' },
  organizations: { id: 'org.id', partnerId: 'org.partnerId' },
}));

vi.mock('../../db', () => {
  const makeSelect = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(selectQueue.shift() ?? []).then(resolve),
    };
    return chain;
  };
  const makeMutation = (capture: (value: unknown) => unknown, result: unknown[]) => {
    const chain: any = {
      values: (value: unknown) => { capture(value); return chain; },
      set: (value: unknown) => { capture(value); return chain; },
      where: (value: unknown) => { capture(value); return chain; },
      returning: () => Promise.resolve(result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => makeSelect()),
      insert: vi.fn(() => makeMutation(insertValuesMock, [{ id: 'created', name: 'Scoped route' }])),
      update: vi.fn(() => makeMutation(updateSetMock, [{ id: 'existing', name: 'Updated' }])),
      delete: vi.fn(() => makeMutation(deleteWhereMock, [])),
    },
  };
});

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: vi.fn(() => false),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'Partner-wide denied',
}));
vi.mock('./helpers', () => ({
  ensureOrgAccess: vi.fn(() => true),
  resolveWriteOrgId: vi.fn(() => ({ orgId: '11111111-1111-4111-8111-111111111111' })),
}));

import { routingRoutes } from './routing';
import { db } from '../../db';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ALLOWED_SITE = '22222222-2222-4222-8222-222222222222';
const DENIED_SITE = '33333333-3333-4333-8333-333333333333';
const RULE_ID = '44444444-4444-4444-8444-444444444444';
const CHANNEL_ID = '55555555-5555-4555-8555-555555555555';

function app() {
  const instance = new Hono();
  instance.route('/alerts', routingRoutes);
  return instance;
}

function createBody(siteIds: string[]) {
  return { name: 'Scoped route', priority: 1, conditions: { siteIds }, channelIds: [CHANNEL_ID] };
}

function existingRule(siteIds: string[]) {
  return { id: RULE_ID, orgId: ORG_ID, partnerId: null, name: 'Existing', conditions: { siteIds } };
}

describe('notification routing site authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    authRef.current = {
      scope: 'organization', orgId: ORG_ID, partnerId: null,
      allowedSiteIds: [ALLOWED_SITE], accessibleOrgIds: null,
      canAccessOrg: () => true, user: { id: 'user-1' },
    };
  });

  it('rejects mixed allowed and denied site conditions atomically before create', async () => {
    selectQueue.push([{ id: ALLOWED_SITE }, { id: DENIED_SITE }]);
    const res = await app().request('/alerts/routing-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody([ALLOWED_SITE, DENIED_SITE])),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects organization-wide conditions for a site-restricted caller before create', async () => {
    const res = await app().request('/alerts/routing-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...createBody([]), conditions: {} }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('allows matching-site conditions', async () => {
    selectQueue.push([{ id: ALLOWED_SITE }]);
    const res = await app().request('/alerts/routing-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody([ALLOWED_SITE])),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('preserves unrestricted creation while validating site ownership', async () => {
    authRef.current.allowedSiteIds = undefined;
    selectQueue.push([{ id: DENIED_SITE }]);
    const res = await app().request('/alerts/routing-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody([DENIED_SITE])),
    });
    expect(res.status).toBe(201);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('preserves unrestricted organization-wide routing creation', async () => {
    authRef.current.allowedSiteIds = undefined;
    const res = await app().request('/alerts/routing-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...createBody([]), conditions: {} }),
    });
    expect(res.status).toBe(201);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('rejects a site that does not belong to the owning organization', async () => {
    selectQueue.push([]);
    const res = await app().request('/alerts/routing-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody([DENIED_SITE])),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('filters persisted denied-site rules from list reads', async () => {
    selectQueue.push([existingRule([DENIED_SITE])], [{ id: DENIED_SITE }]);
    const res = await app().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('filters organization-wide rules from site-restricted list reads', async () => {
    selectQueue.push([existingRule([])]);
    const res = await app().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('rejects updating a persisted denied-site rule before writes', async () => {
    selectQueue.push([existingRule([DENIED_SITE])], [{ id: DENIED_SITE }]);
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Updated' }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects changing an allowed rule to denied-site conditions before writes', async () => {
    selectQueue.push([existingRule([ALLOWED_SITE])], [{ id: ALLOWED_SITE }], [{ id: DENIED_SITE }]);
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions: { siteIds: [DENIED_SITE] } }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects broadening an allowed rule to organization-wide conditions before writes', async () => {
    selectQueue.push([existingRule([ALLOWED_SITE])], [{ id: ALLOWED_SITE }]);
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions: {} }),
    });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects deleting a persisted denied-site rule before deletes', async () => {
    selectQueue.push([existingRule([DENIED_SITE])], [{ id: DENIED_SITE }]);
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('rejects updating or deleting a persisted organization-wide rule', async () => {
    selectQueue.push([existingRule([])]);
    const updateRes = await app().request(`/alerts/routing-rules/${RULE_ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Updated' }),
    });
    expect(updateRes.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();

    selectQueue.push([existingRule([])]);
    const deleteRes = await app().request(`/alerts/routing-rules/${RULE_ID}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(403);
    expect(db.delete).not.toHaveBeenCalled();
  });
});
