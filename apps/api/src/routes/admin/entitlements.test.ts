import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class EntitlementLimitsError extends Error {
    issues: unknown;
    constructor(issues: unknown) { super('Invalid limits'); this.issues = issues; }
  }
  class EntitlementResolutionError extends Error {}
  const selectQueue: unknown[][] = [];
  function chain(result: unknown[]) {
    const c: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej)
    };
    for (const m of ['from', 'where', 'limit', 'orderBy']) c[m] = () => c;
    return c;
  }
  return {
    EntitlementLimitsError,
    EntitlementResolutionError,
    selectQueue,
    chain,
    getEntitlements: vi.fn(),
    upsertEntitlementRow: vi.fn(async () => undefined),
    revokeEntitlementRow: vi.fn(async () => true),
    invalidateEntitlementCache: vi.fn(),
    writeRouteAudit: vi.fn()
  };
});

vi.mock('../../services/entitlements', () => ({
  getEntitlements: h.getEntitlements,
  upsertEntitlementRow: h.upsertEntitlementRow,
  revokeEntitlementRow: h.revokeEntitlementRow,
  invalidateEntitlementCache: h.invalidateEntitlementCache,
  EntitlementLimitsError: h.EntitlementLimitsError,
  EntitlementResolutionError: h.EntitlementResolutionError
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      if (h.selectQueue.length === 0) throw new Error('unexpected db.select');
      return h.chain(h.selectQueue.shift()!);
    })
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn())
}));

vi.mock('../../middleware/auth', () => ({
  requireMfa: vi.fn(() => async (c: any, next: () => Promise<void>) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (auth.token?.mfa === false) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    await next();
  })
}));

import { Hono } from 'hono';
import { withSystemDbAccessContext } from '../../db';
import { entitlementsAdminRoutes } from './entitlements';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REASON = 'design partner comp, ticket 4411';

const auth = {
  user: { id: ADMIN_ID, email: 'admin@breeze.test', isPlatformAdmin: true },
  partnerId: PARTNER_A,
  scope: 'partner',
  token: { mfa: true }
};

function buildApp(authToInject: Record<string, unknown> = auth) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authToInject as never);
    await next();
  });
  app.route('/admin', entitlementsAdminRoutes);
  return app;
}

function resolvedWith(state: 'enabled' | 'disabled', source = 'plan') {
  const one = (key: string) => ({
    key, state, source, limits: null, expiresAt: null, graceUntil: null,
    reason: source === 'manual' ? REASON : null
  });
  return {
    plan: 'free',
    entitlements: {
      onboarding_supervisor: one('onboarding_supervisor'),
      verified_library: one('verified_library'),
      wisp: one('wisp')
    }
  };
}

const url = (partnerId = PARTNER_B, key = 'wisp') => `/admin/partners/${partnerId}/entitlements/${key}`;
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.revokeEntitlementRow.mockResolvedValue(true);
  h.upsertEntitlementRow.mockResolvedValue(undefined);
});

describe('admin entitlements routes', () => {
  it('GET returns plan, resolved set and raw rows', async () => {
    const rawRow = { id: 'r1', partnerId: PARTNER_B, featureKey: 'wisp', state: 'enabled', source: 'manual', limits: null, reason: REASON };
    h.selectQueue.push([{ id: PARTNER_B }], [rawRow]);
    h.getEntitlements.mockResolvedValue(resolvedWith('enabled', 'manual'));
    const res = await buildApp().request(`/admin/partners/${PARTNER_B}/entitlements`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBe('free');
    expect(body.resolved.map((e: { key: string }) => e.key)).toEqual(['onboarding_supervisor', 'verified_library', 'wisp']);
    expect(body.resolved[2]).toMatchObject({ key: 'wisp', label: 'Wisp', state: 'enabled', source: 'manual' });
    expect(body.rows).toEqual([rawRow]);
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('PUT grants: upsertEntitlementRow called with source manual, updatedBy = caller, then audit partner.entitlement.granted with from/to and partnerId attribution', async () => {
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements
      .mockResolvedValueOnce(resolvedWith('disabled'))
      .mockResolvedValueOnce(resolvedWith('enabled', 'manual'));
    const limits = { maxGrants: 3, budgetCentsPerDayCeiling: 100, minFloorTickMinutes: 30 };
    const res = await buildApp().request(url(), json('PUT', {
      state: 'enabled', limits, expiresAt: '2027-02-01T00:00:00.000Z', reason: REASON
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ key: 'wisp', state: 'enabled', source: 'manual' });
    expect(h.upsertEntitlementRow).toHaveBeenCalledWith({
      partnerId: PARTNER_B, featureKey: 'wisp', source: 'manual', state: 'enabled', limits,
      expiresAt: new Date('2027-02-01T00:00:00.000Z'), reason: REASON, updatedBy: ADMIN_ID
    });
    expect(h.invalidateEntitlementCache).toHaveBeenCalledWith(PARTNER_B);
    expect(h.writeRouteAudit).toHaveBeenCalledTimes(1);
    const [, event] = h.writeRouteAudit.mock.calls[0]!;
    expect(event).toMatchObject({
      orgId: null, partnerId: PARTNER_B, action: 'partner.entitlement.granted',
      resourceType: 'partner_entitlement', resourceId: PARTNER_B,
      details: {
        partnerId: PARTNER_B, featureKey: 'wisp', from: 'disabled', to: 'enabled', source: 'manual',
        reason: REASON, expiresAt: '2027-02-01T00:00:00.000Z', limitsPresent: true
      }
    });
    // Never the limits value itself (open container).
    expect(JSON.stringify(event)).not.toContain('budgetCentsPerDayCeiling');
  });

  it('PUT with MFA unsatisfied → 403 MFA required, no write', async () => {
    const res = await buildApp({ ...auth, token: { mfa: false } }).request(url(), json('PUT', { state: 'enabled', reason: REASON }));
    expect(res.status).toBe(403);
    expect(h.upsertEntitlementRow).not.toHaveBeenCalled();
  });

  it('PUT unknown featureKey → 400, no write', async () => {
    const res = await buildApp().request(url(PARTNER_B, 'ai_for_office'), json('PUT', { state: 'enabled', reason: REASON }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown feature key', featureKey: 'ai_for_office' });
    expect(h.upsertEntitlementRow).not.toHaveBeenCalled();
  });

  it('PUT body with `source` → 400 (strict), no write', async () => {
    const res = await buildApp().request(url(), json('PUT', { state: 'enabled', reason: REASON, source: 'billing' }));
    expect(res.status).toBe(400);
    expect(h.upsertEntitlementRow).not.toHaveBeenCalled();
  });

  it('PUT reason shorter than 10 chars → 400', async () => {
    const res = await buildApp().request(url(), json('PUT', { state: 'enabled', reason: '  short  ' }));
    expect(res.status).toBe(400);
    expect(h.upsertEntitlementRow).not.toHaveBeenCalled();
  });

  it('invalid limits → 400, no write, no audit', async () => {
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements.mockResolvedValueOnce(resolvedWith('disabled'));
    h.upsertEntitlementRow.mockRejectedValueOnce(new h.EntitlementLimitsError([{ path: ['maxGrants'] }]));
    const res = await buildApp().request(url(), json('PUT', { state: 'enabled', limits: { maxGrants: -1 }, reason: REASON }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid limits', issues: [{ path: ['maxGrants'] }] });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  // The system-context WRITE itself is proven against real Postgres in
  // partnerEntitlementsRls.integration.test.ts (caller context = partner A,
  // target = partner B); here the service is mocked, so only attribution.
  it('audit carries the target partner, not the caller\'s own partner', async () => {
    // Caller's own JWT is partner-scoped to A; the target is B.
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements.mockResolvedValue(resolvedWith('enabled', 'manual'));
    const res = await buildApp().request(url(PARTNER_B), json('PUT', { state: 'disabled', reason: REASON }));
    expect(res.status).toBe(200);
    expect(h.upsertEntitlementRow).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER_B, limits: null, expiresAt: null }));
    const [, event] = h.writeRouteAudit.mock.calls[0]!;
    expect(event.partnerId).toBe(PARTNER_B);
    expect(event.details.partnerId).toBe(PARTNER_B);
    expect(event.details.limitsPresent).toBe(false);
  });

  it('DELETE revokes the manual row → audit partner.entitlement.revoked; 404 when nothing live', async () => {
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements
      .mockResolvedValueOnce(resolvedWith('enabled', 'manual'))
      .mockResolvedValueOnce(resolvedWith('disabled'));
    const res = await buildApp().request(url(), json('DELETE', { reason: REASON }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ key: 'wisp', state: 'disabled', source: 'plan' });
    expect(h.revokeEntitlementRow).toHaveBeenCalledWith({ partnerId: PARTNER_B, featureKey: 'wisp', source: 'manual', reason: REASON });
    const [, event] = h.writeRouteAudit.mock.calls[0]!;
    expect(event).toMatchObject({
      action: 'partner.entitlement.revoked', partnerId: PARTNER_B,
      details: { from: 'enabled', to: 'disabled', source: 'manual', reason: REASON, featureKey: 'wisp' }
    });

    vi.clearAllMocks();
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements.mockResolvedValue(resolvedWith('disabled'));
    h.revokeEntitlementRow.mockResolvedValueOnce(false);
    const miss = await buildApp().request(url(), json('DELETE', { reason: REASON }));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: 'No live manual entitlement' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('DELETE with MFA unsatisfied → 403, no revoke', async () => {
    const res = await buildApp({ ...auth, token: { mfa: false } }).request(url(), json('DELETE', { reason: REASON }));
    expect(res.status).toBe(403);
    expect(h.revokeEntitlementRow).not.toHaveBeenCalled();
  });

  it('partner not found → 404 on PUT', async () => {
    h.selectQueue.push([]);
    const res = await buildApp().request(url(), json('PUT', { state: 'enabled', reason: REASON }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Partner not found' });
    expect(h.upsertEntitlementRow).not.toHaveBeenCalled();
    expect(h.getEntitlements).not.toHaveBeenCalled();
  });

  it('non-uuid partnerId → 400', async () => {
    const res = await buildApp().request(url('not-a-uuid'), json('PUT', { state: 'enabled', reason: REASON }));
    expect(res.status).toBe(400);
  });

  it('PUT: a failed read-back AFTER the write still audits (to = granted state) and returns 200', async () => {
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements
      .mockResolvedValueOnce(resolvedWith('disabled'))
      .mockRejectedValueOnce(new h.EntitlementResolutionError('db blip'));
    const res = await buildApp().request(url(), json('PUT', { state: 'enabled', reason: REASON }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null, warning: 'Saved; the resolved state could not be read back' });
    expect(h.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(h.writeRouteAudit.mock.calls[0]![1].details).toMatchObject({ from: 'disabled', to: 'enabled' });
  });

  it('DELETE: a failed read-back AFTER the revoke still audits (to = null) and returns 200', async () => {
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements
      .mockResolvedValueOnce(resolvedWith('enabled', 'manual'))
      .mockRejectedValueOnce(new h.EntitlementResolutionError('db blip'));
    const res = await buildApp().request(url(), json('DELETE', { reason: REASON }));
    expect(res.status).toBe(200);
    expect(h.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(h.writeRouteAudit.mock.calls[0]![1]).toMatchObject({
      action: 'partner.entitlement.revoked', details: { from: 'enabled', to: null }
    });
  });

  it('PUT with an expiresAt in the past → 400, no write', async () => {
    const res = await buildApp().request(url(), json('PUT', {
      state: 'enabled', reason: REASON, expiresAt: '2020-01-01T00:00:00.000Z'
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'expiresAt must be in the future' });
    expect(h.upsertEntitlementRow).not.toHaveBeenCalled();
  });

  it('resolver unavailable → 503 with Retry-After, no write', async () => {
    h.selectQueue.push([{ id: PARTNER_B }]);
    h.getEntitlements.mockRejectedValueOnce(new h.EntitlementResolutionError('db down'));
    const res = await buildApp().request(url(), json('PUT', { state: 'enabled', reason: REASON }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(h.upsertEntitlementRow).not.toHaveBeenCalled();
  });
});
