import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for Finding #6 (MEDIUM): escalation-policy mutations must gate on
// ALERTS_WRITE in addition to scope tier.

const { authRef, grantedRef, insertedRef, updateSetRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null as string | null,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  grantedRef: { current: new Set<string>() },
  insertedRef: { current: undefined as Record<string, unknown> | undefined },
  updateSetRef: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!grantedRef.current.has(`${resource}:${action}`)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
}));

// db mock: a minimal insert/update/delete builder so the partner-wide gating
// tests below can exercise POST (real insert) and PUT/DELETE (real update
///delete against a row resolved via the mocked getEscalationPolicyWithOrgCheck)
// without a real database. The Finding #6 tests above never reach these calls
// (they 403 on the permission gate first), so they are unaffected.
vi.mock('../../db', () => {
  const builder: any = {
    values: (vals: Record<string, unknown>) => {
      insertedRef.current = vals;
      return builder;
    },
    set: (vals: Record<string, unknown>) => {
      updateSetRef.current = vals;
      return builder;
    },
    where: () => builder,
    returning: () => {
      if (insertedRef.current) {
        return Promise.resolve([{ id: 'new-policy', createdAt: new Date(), updatedAt: new Date(), ...(insertedRef.current ?? {}) }]);
      }
      return Promise.resolve([{ id: 'policy-1', ...(updateSetRef.current ?? {}) }]);
    },
  };
  return {
    db: {
      // Emulate a partner-only eligible user; service SQL controls visibility.
      execute: async (query: any) => new PgDialect().sqlToQuery(query).sql.includes('partner_users')
        ? [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'MSP technician' },
          { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Other technician' }] : [],
      insert: () => builder,
      update: () => builder,
      delete: () => ({ where: () => Promise.resolve(undefined) }),
    },
  };
});
vi.mock('../../services/delivery/railOwnership', () => ({ partnerIdForOrg: vi.fn(async () => '99999999-9999-4999-8999-999999999999') }));
vi.mock('../../db/schema', () => ({ escalationPolicies: {} }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getEscalationPolicyWithOrgCheck: vi.fn(),
}));

import { policiesRoutes } from './policies';
import * as helpers from './helpers';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', policiesRoutes);
  return app;
}

const POLICY_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ALERTS_WRITE = 'alerts:write';

describe('escalation policies authz (Finding #6)', () => {
  it('denies policy reads without alerts:read', async () => {
    const response = await makeApp().request('/alerts/policies');
    expect(response.status).toBe(403);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('403 on POST /alerts/policies without ALERTS_WRITE', async () => {
    const res = await makeApp().request('/alerts/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'p' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on DELETE /alerts/policies/:id without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('passes the permission gate on POST when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request('/alerts/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });

  it('passes the permission gate on DELETE when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, { method: 'DELETE' });
    expect(res.status).not.toBe(403);
  });
});

// ============================================================
// Partner-wide escalation policies (#2130)
// ============================================================
//
// Partner-wide rows (orgId NULL, partnerId = owning partner) are administrable
// only with canManagePartnerWidePolicies(auth) — system scope, or partner
// scope with partnerOrgAccess 'all'. getEscalationPolicyWithOrgCheck is
// dual-axis (mocked here per-test): a partner-scope caller on the matching
// partner can LOAD the row; the 403 for PUT/DELETE comes from the
// capability gate in the route itself, not from the lookup.
// partnerWideAccess.ts is a dependency-free leaf and intentionally NOT mocked.

describe('partner-wide escalation policies (#2130)', () => {
  const PARTNER_ID = '99999999-9999-4999-8999-999999999999';

  function setPartnerAuth(partnerOrgAccess: 'all' | 'selected' | 'none') {
    grantedRef.current = new Set<string>([ALERTS_WRITE]);
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'Partner Admin', email: 'admin@msp.example' },
      partnerId: PARTNER_ID,
      partnerOrgAccess,
      orgId: null,
      accessibleOrgIds: ['org-1'],
      canAccessOrg: () => true,
    } as typeof authRef.current;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    insertedRef.current = undefined;
    updateSetRef.current = undefined;
  });

  it('denies partner-wide create without full partner org access', async () => {
    setPartnerAuth('selected');
    const res = await makeApp().request('/alerts/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', name: 'Fleet escalation', steps: [{ delayMinutes: 5, channelIds: ['9a8b7c6d-2222-4333-8444-555566667777'] }] }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/full partner org access/);
    expect(insertedRef.current).toBeUndefined();
  });

  it('creates a partner-wide policy with full partner org access ({ orgId: null, partnerId })', async () => {
    setPartnerAuth('all');
    const res = await makeApp().request('/alerts/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', name: 'Fleet escalation', steps: [{ delayMinutes: 5, channelIds: ['9a8b7c6d-2222-4333-8444-555566667777'] }] }),
    });
    expect(res.status).toBe(201);
    expect(insertedRef.current?.orgId).toBeNull();
    expect(insertedRef.current?.partnerId).toBe(PARTNER_ID);
  });

  it('denies PUT of a partner-wide policy without the partner-wide capability', async () => {
    setPartnerAuth('selected');
    vi.mocked(helpers.getEscalationPolicyWithOrgCheck).mockResolvedValue({
      id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet escalation', steps: [],
    } as never);

    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/full partner org access/);
  });

  it('allows PUT of a partner-wide policy with full partner org access', async () => {
    setPartnerAuth('all');
    vi.mocked(helpers.getEscalationPolicyWithOrgCheck).mockResolvedValue({
      id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet escalation', steps: [],
    } as never);

    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(updateSetRef.current?.name).toBe('Renamed');
  });

  it('denies DELETE of a partner-wide policy without the partner-wide capability', async () => {
    setPartnerAuth('none');
    vi.mocked(helpers.getEscalationPolicyWithOrgCheck).mockResolvedValue({
      id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet escalation', steps: [],
    } as never);

    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/full partner org access/);
  });

  it('allows DELETE of a partner-wide policy with full partner org access', async () => {
    setPartnerAuth('all');
    vi.mocked(helpers.getEscalationPolicyWithOrgCheck).mockResolvedValue({
      id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Fleet escalation', steps: [],
    } as never);

    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

describe('caller scope for escalation user targets', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
  const NEW_USER = 'aaaaaaaa-0000-4000-8000-000000000002';
  const steps = [{ delayMinutes: 5, channelIds: [], userIds: [USER] }];
  beforeEach(() => {
    vi.clearAllMocks();
    insertedRef.current = undefined;
    updateSetRef.current = undefined;
    grantedRef.current = new Set([ALERTS_WRITE]);
    authRef.current = { scope: 'organization', orgId: ORG, partnerId: null,
      user: { id: 'u-1', name: 'Org admin', email: 'admin@org.example' },
      accessibleOrgIds: [ORG], canAccessOrg: id => id === ORG };
    vi.mocked(helpers.getEscalationPolicyWithOrgCheck).mockResolvedValue({
      id: POLICY_ID, orgId: ORG, partnerId: null, name: 'Existing', steps,
    } as never);
  });
  it.each(['organization', 'partner', 'system'])('checks partner user targets on create for %s callers', async scope => {
    authRef.current.scope = scope;
    const res = await makeApp().request('/alerts/policies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG, name: 'On-call', steps }),
    });
    expect(res.status).toBe(scope === 'organization' ? 400 : 201);
    if (scope === 'organization') expect(insertedRef.current).toBeUndefined();
    else expect(insertedRef.current?.steps).toEqual(steps);
  });
  it.each([false, true])('preserves previously configured partner users on org updates (steps included=%s)', async includeSteps => {
    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', ...(includeSteps ? { steps } : {}) }),
    });
    expect(res.status).toBe(200);
    expect(updateSetRef.current?.name).toBe('Renamed');
    if (includeSteps) expect(updateSetRef.current?.steps).toEqual(steps);
  });
  it('rejects newly added partner users on org updates before writing', async () => {
    vi.mocked(helpers.getEscalationPolicyWithOrgCheck).mockResolvedValue({
      id: POLICY_ID, orgId: ORG, partnerId: null, name: 'Existing',
      steps: [{ ...steps[0], userIds: [NEW_USER] }],
    } as never);
    const res = await makeApp().request(`/alerts/policies/${POLICY_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: [{ ...steps[0], userIds: [NEW_USER, USER] }] }),
    });
    expect(res.status).toBe(400);
    expect(updateSetRef.current).toBeUndefined();
  });
});
