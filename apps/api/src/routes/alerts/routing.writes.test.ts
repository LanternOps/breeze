import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for #1633 (write side): POST/PATCH/DELETE /alerts/routing-rules
// must not hard-require auth.orgId. A partner-scoped user has a null auth.orgId
// (the active org rides as the ?orgId= query param), so the old
// `if (!auth.orgId) 400 'orgId is required'` guard blocked them from
// creating/editing/deleting routing rules entirely. The handlers now resolve
// the org scope-aware (via resolveWriteOrgId), honouring an access-checked
// ?orgId= for partner/system callers — mirroring the list fix (#1643).

const { authRef, insertedRef, capturedWhere } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Pat Partner', email: 'pat@partner.example' },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: ['org-a', 'org-b'] as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  insertedRef: { current: undefined as Record<string, unknown> | undefined },
  capturedWhere: { current: undefined as unknown },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  // ALERTS_WRITE is exercised separately in routing.authz.test.ts; allow here.
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

const existingRowRef = { current: undefined as Record<string, unknown> | undefined };

vi.mock('../../db', () => {
  const builder: any = {
    // insert(...).values(...).returning()
    values: (vals: Record<string, unknown>) => {
      insertedRef.current = vals;
      return builder;
    },
    returning: () => Promise.resolve([{ id: 'new-rule', ...(insertedRef.current ?? {}) }]),
    // update(...).set(...).where(...).returning() and select().from().where().limit()
    set: () => builder,
    from: () => builder,
    where: (cond: unknown) => {
      capturedWhere.current = cond;
      return builder;
    },
    limit: () => Promise.resolve(existingRowRef.current ? [existingRowRef.current] : []),
    orderBy: () => Promise.resolve([]),
  };
  return {
    db: {
      insert: () => builder,
      update: () => builder,
      delete: () => ({ where: () => Promise.resolve(undefined) }),
      select: () => builder,
    },
  };
});
vi.mock('../../db/schema', () => ({
  notificationRoutingRules: { id: { name: 'id' }, orgId: { name: 'org_id' } },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { routingRoutes } from './routing';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', routingRoutes);
  return app;
}

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const CHANNEL_ID = '9a8b7c6d-2222-4333-8444-555566667777';
const validBody = { name: 'Critical routing', priority: 0, conditions: {}, channelIds: [CHANNEL_ID] };

describe('routing-rule writes — partner org resolution (#1633)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRef.current = undefined;
    capturedWhere.current = undefined;
    existingRowRef.current = undefined;
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Pat', email: 'pat@partner.example' },
      partnerId: 'p-1', orgId: null, accessibleOrgIds: ['org-a', 'org-b'], canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('POST: partner with explicit ?orgId= creates against that org (not 400)', async () => {
    const res = await makeApp().request('/alerts/routing-rules?orgId=org-a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(insertedRef.current?.orgId).toBe('org-a');
  });

  it('POST: partner with multiple accessible orgs and no ?orgId= is 400 ambiguous (not 500/crash)', async () => {
    const res = await makeApp().request('/alerts/routing-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/multiple organizations/);
  });

  it('POST: partner with exactly one accessible org and no ?orgId= disambiguates to it', async () => {
    authRef.current = {
      ...authRef.current,
      accessibleOrgIds: ['org-only'],
    } as typeof authRef.current;
    const res = await makeApp().request('/alerts/routing-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(insertedRef.current?.orgId).toBe('org-only');
  });

  it('POST: explicit ?orgId= the partner cannot access is 403 (cross-tenant rejected)', async () => {
    authRef.current = {
      ...authRef.current,
      canAccessOrg: (id: string) => id !== 'org-forbidden',
    } as typeof authRef.current;
    const res = await makeApp().request('/alerts/routing-rules?orgId=org-forbidden', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
  });

  it('PATCH: partner with ?orgId= scopes the lookup to that org (404 when rule absent, not 400)', async () => {
    existingRowRef.current = undefined; // rule not in that org
    const res = await makeApp().request(`/alerts/routing-rules/${RULE_ID}?orgId=org-a`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE: partner with ?orgId= deletes a rule in that org (not 400)', async () => {
    existingRowRef.current = { id: RULE_ID, orgId: 'org-a', name: 'r' };
    const res = await makeApp().request(`/alerts/routing-rules/${RULE_ID}?orgId=org-a`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { id: RULE_ID, deleted: true } });
  });

  it('org-scoped user: write pins to own org without needing ?orgId=', async () => {
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-2', name: 'Olive', email: 'olive@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
    const res = await makeApp().request('/alerts/routing-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(insertedRef.current?.orgId).toBe('org-1');
  });

  it('org-scoped user: an explicit ?orgId= matching their own org still succeeds', async () => {
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-2', name: 'Olive', email: 'olive@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
    const res = await makeApp().request('/alerts/routing-rules?orgId=org-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(insertedRef.current?.orgId).toBe('org-1');
  });

  it('org-scoped user: smuggling a different ?orgId= is 403 (cannot redirect the write cross-org)', async () => {
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-2', name: 'Olive', email: 'olive@org.example' },
      // canAccessOrg returns true even for the other org — the org-scope pin must
      // reject the mismatch on its own, not lean on canAccessOrg.
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
    const res = await makeApp().request('/alerts/routing-rules?orgId=org-2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
    expect(insertedRef.current).toBeUndefined();
  });

  it('system-scoped caller with ?orgId= writes against that org', async () => {
    authRef.current = {
      scope: 'system',
      user: { id: 'u-3', name: 'Sys', email: 'sys@breeze.local' },
      partnerId: null, orgId: null, accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
    const res = await makeApp().request('/alerts/routing-rules?orgId=org-x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(insertedRef.current?.orgId).toBe('org-x');
  });
});
