import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for #1633: /alerts/routing-rules must resolve the org scope-aware
// (honor ?orgId for partner-scoped users whose auth.orgId is null), mirroring the
// escalation-policies route — instead of always 400ing on auth.orgId.

const { authRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Partner Admin', email: 'admin@breeze.local' },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: ['org-1', 'org-2'] as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  },
  // #1633 tests exercise org resolution, not the permission gate — always allow.
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

// Minimal awaitable Drizzle chain: every builder method returns the same chain,
// and awaiting it resolves to `rows`. Enough to get past the resolution layer.
const rowsRef = { current: [] as unknown[] };
function chain(): any {
  const c: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'insert', 'values', 'returning', 'set', 'update', 'delete']) {
    c[m] = vi.fn(() => c);
  }
  c.then = (resolve: any, reject: any) => Promise.resolve(rowsRef.current).then(resolve, reject);
  return c;
}
vi.mock('../../db', () => ({ db: chain() }));
vi.mock('../../db/schema', () => ({ notificationRoutingRules: { orgId: 'orgId', priority: 'priority', id: 'id' } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { routingRoutes } from './routing';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', routingRoutes);
  return app;
}

const ORG = 'aa0e43c8-1111-4222-8333-444455556666';
const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';

function setAuth(partial: Partial<typeof authRef.current>) {
  authRef.current = { ...authRef.current, ...partial } as typeof authRef.current;
}

describe('routing-rules org resolution (#1633)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rowsRef.current = [];
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Partner Admin', email: 'admin@breeze.local' },
      partnerId: 'p-1', orgId: null, accessibleOrgIds: ['org-1', 'org-2'], canAccessOrg: () => true,
    };
  });

  // The headline bug: a partner-scoped user (orgId null) passing ?orgId no longer 400s.
  it('GET partner-scoped with an accessible ?orgId does not 400', async () => {
    const res = await makeApp().request(`/alerts/routing-rules?orgId=${ORG}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('GET partner-scoped without ?orgId lists across accessible orgs (no 400)', async () => {
    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
  });

  it('GET partner-scoped with no accessible orgs returns empty', async () => {
    setAuth({ accessibleOrgIds: [] });
    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('GET partner-scoped with an ?orgId outside scope is 403', async () => {
    setAuth({ canAccessOrg: () => false });
    const res = await makeApp().request(`/alerts/routing-rules?orgId=${ORG}`);
    expect(res.status).toBe(403);
  });

  it('GET organization-scoped still filters by the auth org', async () => {
    setAuth({ scope: 'organization', orgId: 'org-1', accessibleOrgIds: null });
    const res = await makeApp().request('/alerts/routing-rules');
    expect(res.status).toBe(200);
  });

  // Writes: partner with multiple orgs and no ?orgId is genuinely ambiguous → 400
  // (distinct message), but a single accessible org or an explicit ?orgId resolves.
  it('POST partner-scoped without ?orgId and multiple orgs is 400-ambiguous', async () => {
    const res = await makeApp().request('/alerts/routing-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r', priority: 0, conditions: {}, channelIds: [RULE_ID] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/multiple organizations/i);
  });

  it('POST partner-scoped with an ?orgId outside scope is 403', async () => {
    setAuth({ canAccessOrg: () => false });
    const res = await makeApp().request(`/alerts/routing-rules?orgId=${ORG}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r', priority: 0, conditions: {}, channelIds: [RULE_ID] }),
    });
    expect(res.status).toBe(403);
  });

  it('POST partner-scoped with an accessible ?orgId resolves and creates', async () => {
    rowsRef.current = [{ id: RULE_ID, name: 'r' }];
    const res = await makeApp().request(`/alerts/routing-rules?orgId=${ORG}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'r', priority: 0, conditions: {}, channelIds: [RULE_ID] }),
    });
    expect(res.status).toBe(201);
  });
});
