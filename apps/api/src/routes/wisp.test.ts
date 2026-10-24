import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  hasPerm: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOk: vi.fn(() => true),
  publishEvent: vi.fn(async () => 'evt-1'),
  hasEntitlement: vi.fn(async () => true),
  grantSettingsBounds: vi.fn(async () => ({ budgetCentsPerDayMax: 1000, minFloorTickMinutes: 15 })),
  svc: {
    createGrant: vi.fn(),
    refreshGrant: vi.fn(),
    revokeGrant: vi.fn(),
    listGrants: vi.fn(),
    previewGrantCeiling: vi.fn(),
    updateGrantSettings: vi.fn(),
    userPauseGrant: vi.fn(),
    userResumeGrant: vi.fn(),
  },
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
    requireScope: actual.requireScope,
    requirePermission: (resource: string, action: string) => async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (h.hasPerm(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
    requireMfa: () => async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (h.mfaOk() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
  };
});
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wispEnabled: () => h.wispEnabled(),
}));
vi.mock('../services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntitlement: h.hasEntitlement,
}));
vi.mock('../db', () => ({
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { void work(); },
}));
vi.mock('../services/eventBus', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  publishEvent: h.publishEvent,
}));
vi.mock('../services/wisp/budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wisp/budget')>()),
  grantSettingsBounds: h.grantSettingsBounds,
}));
vi.mock('../services/wisp/grants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/wisp/grants')>();
  return { ...actual, ...h.svc };
});

import { wispRoutes } from './wisp';
import { GrantLimitReachedError, WispGrantError } from '../services/wisp/grants';
import { EntitlementResolutionError } from '../services/entitlements';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const STEP_UP = '55555555-5555-4555-8555-555555555555';

const grant = (o: Record<string, unknown> = {}) => ({
  id: GRANT_ID, partnerId: PARTNER, orgId: null, grantorUserId: USER, grantee: 'wisp', currentRevisionId: 'r1',
  status: 'active', pausedReason: null, expiresAt: new Date('2027-04-01T00:00:00Z'), budgetCentsPerDay: 200, floorTickMinutes: 30,
  // Fields that must never reach the wire even if a service leaked them:
  factorProof: { method: 'step_up' }, ceilingSnapshot: { orgIds: [ORG] }, ...o,
});

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      scope: 'partner',
      partnerId: PARTNER,
      orgId: null,
      accessibleOrgIds: [ORG],
      partnerOrgAccess: 'all',
      user: { id: USER, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
      token: { sid: 'sid', mfa: true },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/wisp', wispRoutes);
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: 'boom' }, 500)));
  return app;
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.hasPerm.mockReturnValue(true);
  h.mfaOk.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(true);
  h.grantSettingsBounds.mockResolvedValue({ budgetCentsPerDayMax: 1000, minFloorTickMinutes: 15 });
});

describe('wisp routes — flag gate', () => {
  it('every route is 404 when wispEnabled() is false', async () => {
    h.wispEnabled.mockReturnValue(false);
    const app = buildApp();
    const responses = await Promise.all([
      app.request('/wisp/grants'),
      app.request(`/wisp/grants/preview`),
      post(app, '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP }),
      post(app, `/wisp/grants/${GRANT_ID}/refresh`, { stepUpGrantId: STEP_UP }),
      post(app, `/wisp/grants/${GRANT_ID}/revoke`),
      post(app, `/wisp/grants/${GRANT_ID}/pause`),
      post(app, `/wisp/grants/${GRANT_ID}/resume`),
      patch(app, `/wisp/grants/${GRANT_ID}/settings`, { floorTickMinutes: 60 }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
    for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('wisp routes — entitlement gate (W04: requireEntitlement(\'wisp\'))', () => {
  const requests = (app: Hono) => [
    app.request('/wisp/grants'),
    app.request('/wisp/grants/preview'),
    post(app, '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP }),
    post(app, `/wisp/grants/${GRANT_ID}/refresh`, { stepUpGrantId: STEP_UP }),
    post(app, `/wisp/grants/${GRANT_ID}/revoke`),
    post(app, `/wisp/grants/${GRANT_ID}/pause`),
    post(app, `/wisp/grants/${GRANT_ID}/resume`),
    patch(app, `/wisp/grants/${GRANT_ID}/settings`, { floorTickMinutes: 60 }),
  ];

  it('every grant route is 403 entitlement_required when the partner lacks wisp, before any service call', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    const responses = await Promise.all(requests(buildApp()));
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
    }
    expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER, 'wisp');
    for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
  });

  it('flag off wins: not entitled AND flag off is 404, never 403, and the resolver is not consulted', async () => {
    h.wispEnabled.mockReturnValue(false);
    h.hasEntitlement.mockResolvedValue(false);
    const responses = await Promise.all(requests(buildApp()));
    expect(responses.map((r) => r.status)).toEqual(responses.map(() => 404));
    expect(h.hasEntitlement).not.toHaveBeenCalled();
  });

  it('resolver failure is 503 entitlement_check_failed + Retry-After', async () => {
    const { EntitlementResolutionError } = await import('../services/entitlements');
    h.hasEntitlement.mockRejectedValue(new EntitlementResolutionError(PARTNER, new Error('down')));
    const res = await buildApp().request('/wisp/grants');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toMatchObject({ code: 'entitlement_check_failed' });
  });

  it('an organization-scoped token is refused by requireScope, not by the entitlement gate', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    const res = await buildApp({ scope: 'organization', orgId: ORG, partnerId: null }).request('/wisp/grants');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('entitlement_required');
    expect(h.hasEntitlement).not.toHaveBeenCalled();
  });
});

describe('POST /wisp/grants', () => {
  it('is 403 for an organization-scoped token', async () => {
    const res = await post(buildApp({ scope: 'organization', orgId: ORG }), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(403);
    expect(h.svc.createGrant).not.toHaveBeenCalled();
  });

  it('is 403 without ai_sessions:use', async () => {
    h.hasPerm.mockImplementation((r, a) => !(r === 'ai_sessions' && a === 'use'));
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(403);
    expect(h.svc.createGrant).not.toHaveBeenCalled();
  });

  it('is 403 MFA_REQUIRED without a satisfied MFA session', async () => {
    h.mfaOk.mockReturnValue(false);
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('maps step_up_required to 403 STEP_UP_REQUIRED', async () => {
    h.svc.createGrant.mockRejectedValue(new WispGrantError('step_up_required', 'step up'));
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('maps already_active to 409 and org_out_of_reach / partner_mismatch to 404', async () => {
    h.svc.createGrant.mockRejectedValueOnce(new WispGrantError('already_active', 'dup'));
    expect((await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP })).status).toBe(409);
    h.svc.createGrant.mockRejectedValueOnce(new WispGrantError('org_out_of_reach', 'nope'));
    expect((await post(buildApp(), '/wisp/grants', { orgId: ORG, stepUpGrantId: STEP_UP })).status).toBe(404);
    h.svc.createGrant.mockRejectedValueOnce(new WispGrantError('partner_mismatch', 'nope'));
    expect((await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP })).status).toBe(404);
  });

  it('maps grantor_* to 409 with the code', async () => {
    h.svc.createGrant.mockRejectedValueOnce(new WispGrantError('grantor_access_lost', 'lost'));
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'GRANTOR_ACCESS_LOST' });
  });

  it('maps GrantLimitReachedError to 409 GRANT_LIMIT_REACHED', async () => {
    h.svc.createGrant.mockRejectedValue(new GrantLimitReachedError(PARTNER, 2, 2));
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This partner already has 2 active Wisp grants (plan limit 2).', code: 'GRANT_LIMIT_REACHED' });
  });

  // Same bodies as W01's requireEntitlement('wisp'), so W04 mounting the middleware changes no client contract.
  it('maps entitlement_required to 403 with the W01 body', async () => {
    h.svc.createGrant.mockRejectedValue(new WispGrantError('entitlement_required', 'Wisp is not enabled for this partner.'));
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
  });

  it('maps entitlement_check_failed to 503 + Retry-After with the W01 body', async () => {
    h.svc.createGrant.mockRejectedValue(new WispGrantError('entitlement_check_failed', 'Entitlements unavailable.'));
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ code: 'entitlement_check_failed', error: 'Entitlement check temporarily unavailable', featureKey: 'wisp' });
  });

  it('returns 201 with a DTO that has no factorProof/ceilingSnapshot keys, scoped to the caller\'s partner', async () => {
    h.svc.createGrant.mockResolvedValue(grant());
    const res = await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('factorProof');
    expect(body).not.toHaveProperty('ceilingSnapshot');
    expect(body).toMatchObject({ id: GRANT_ID, status: 'active', expiresAt: '2027-04-01T00:00:00.000Z', budgetCentsPerDay: 200 });
    expect(h.svc.createGrant).toHaveBeenCalledWith(expect.objectContaining({ scope: { partnerId: PARTNER, orgId: null }, stepUpGrantId: STEP_UP }));
  });

  it('publishes wisp.grant.created once with { grantId, partnerId, orgId, grantorUserId }', async () => {
    h.svc.createGrant.mockResolvedValue(grant({ orgId: ORG }));
    await post(buildApp(), '/wisp/grants', { orgId: ORG, stepUpGrantId: STEP_UP });
    expect(h.publishEvent).toHaveBeenCalledTimes(1);
    expect(h.publishEvent).toHaveBeenCalledWith(
      'wisp.grant.created', ORG, { grantId: GRANT_ID, partnerId: PARTNER, orgId: ORG, grantorUserId: USER }, 'wisp',
    );
  });

  it('a partner-wide grant event routes on the partner id (the bus is org-keyed) and carries orgId null', async () => {
    h.svc.createGrant.mockResolvedValue(grant());
    await post(buildApp(), '/wisp/grants', { orgId: null, stepUpGrantId: STEP_UP });
    expect(h.publishEvent).toHaveBeenCalledWith(
      'wisp.grant.created', PARTNER, { grantId: GRANT_ID, partnerId: PARTNER, orgId: null, grantorUserId: USER }, 'wisp',
    );
  });

  it('rejects a body without stepUpGrantId (400)', async () => {
    const res = await post(buildApp(), '/wisp/grants', { orgId: null });
    expect(res.status).toBe(400);
  });
});

describe('GET /wisp/grants', () => {
  it('view=partner is 403 when canManagePartnerWidePolicies is false', async () => {
    h.svc.listGrants.mockRejectedValue(new WispGrantError('forbidden', 'no'));
    const res = await buildApp({ partnerOrgAccess: 'selected' }).request('/wisp/grants?view=partner');
    expect(res.status).toBe(403);
  });

  it('defaults to view=mine and returns DTOs', async () => {
    h.svc.listGrants.mockResolvedValue([grant()]);
    const res = await buildApp().request('/wisp/grants');
    expect(res.status).toBe(200);
    const body = await res.json() as { grants: Array<Record<string, unknown>> };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).not.toHaveProperty('factorProof');
    expect(h.svc.listGrants).toHaveBeenCalledWith(expect.objectContaining({ view: 'mine' }));
  });
});

describe('GET /wisp/grants/preview', () => {
  it('returns { scope, ceilingSnapshot, ceilingHash } with a 64-hex ceilingHash', async () => {
    const preview = {
      scope: { partnerId: PARTNER, orgId: ORG },
      ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds: [ORG], siteIds: null, toolAllowlist: null, deniedTools: [] },
      ceilingHash: 'a'.repeat(64),
    };
    h.svc.previewGrantCeiling.mockResolvedValue(preview);
    const res = await buildApp().request(`/wisp/grants/preview?orgId=${ORG}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ceilingHash: string };
    expect(body).toEqual(preview);
    expect(body.ceilingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.svc.previewGrantCeiling).toHaveBeenCalledWith(expect.objectContaining({ scope: { partnerId: PARTNER, orgId: ORG } }));
  });

  it('a malformed orgId is 400', async () => {
    expect((await buildApp().request('/wisp/grants/preview?orgId=nope')).status).toBe(400);
  });
});

describe('POST /wisp/grants/:id/{refresh,revoke}', () => {
  it('revoke with a non-uuid id is 404, not a 22P02', async () => {
    const res = await post(buildApp(), '/wisp/grants/not-a-uuid/revoke');
    expect(res.status).toBe(404);
    expect(h.svc.revokeGrant).not.toHaveBeenCalled();
  });

  it('revoke returns { success: true }', async () => {
    h.svc.revokeGrant.mockResolvedValue(undefined);
    const res = await post(buildApp(), `/wisp/grants/${GRANT_ID}/revoke`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('refresh returns the DTO; not_found maps to 404', async () => {
    h.svc.refreshGrant.mockResolvedValueOnce(grant({ currentRevisionId: 'r2' }));
    const ok = await post(buildApp(), `/wisp/grants/${GRANT_ID}/refresh`, { stepUpGrantId: STEP_UP });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ currentRevisionId: 'r2' });
    h.svc.refreshGrant.mockRejectedValueOnce(new WispGrantError('not_found', 'gone'));
    expect((await post(buildApp(), `/wisp/grants/${GRANT_ID}/refresh`, { stepUpGrantId: STEP_UP })).status).toBe(404);
  });
});

describe('PATCH /wisp/grants/:id/settings', () => {
  it('{ floorTickMinutes: 60 } → 200; { } → 400; { floorTickMinutes: 10 } → 400; forbidden → 403', async () => {
    h.svc.updateGrantSettings.mockResolvedValueOnce(grant({ floorTickMinutes: 60 }));
    const ok = await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, { floorTickMinutes: 60 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ floorTickMinutes: 60 });
    expect((await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, {})).status).toBe(400);
    expect((await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, { floorTickMinutes: 10 })).status).toBe(400);
    expect((await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, { floorTickMinutes: 60, extra: 1 })).status).toBe(400);
    h.svc.updateGrantSettings.mockRejectedValueOnce(new WispGrantError('forbidden', 'no'));
    expect((await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, { floorTickMinutes: 60 })).status).toBe(403);
  });

  it('passes the partner\'s plan bounds (W05 grantSettingsBounds) to updateGrantSettings', async () => {
    h.grantSettingsBounds.mockResolvedValueOnce({ budgetCentsPerDayMax: 2500, minFloorTickMinutes: 30 });
    h.svc.updateGrantSettings.mockResolvedValueOnce(grant({ budgetCentsPerDay: 2000 }));
    const res = await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, { budgetCentsPerDay: 2000 });
    expect(res.status).toBe(200);
    expect(h.grantSettingsBounds).toHaveBeenCalledWith(PARTNER);
    expect(h.svc.updateGrantSettings).toHaveBeenCalledWith(expect.objectContaining({
      grantId: GRANT_ID,
      patch: { budgetCentsPerDay: 2000 },
      bounds: { budgetCentsPerDayMax: 2500, minFloorTickMinutes: 30 },
    }));
  });

  it('an unresolvable entitlement read for the bounds → 503 entitlement_check_failed, nothing updated', async () => {
    h.grantSettingsBounds.mockRejectedValueOnce(new EntitlementResolutionError(PARTNER, new Error('db down')));
    const res = await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, { budgetCentsPerDay: 300 });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toMatchObject({ code: 'entitlement_check_failed', featureKey: 'wisp' });
    expect(h.svc.updateGrantSettings).not.toHaveBeenCalled();
  });

  it('settings_out_of_bounds → 400 SETTINGS_OUT_OF_BOUNDS', async () => {
    h.svc.updateGrantSettings.mockRejectedValueOnce(new WispGrantError('settings_out_of_bounds', 'too much'));
    const res = await patch(buildApp(), `/wisp/grants/${GRANT_ID}/settings`, { budgetCentsPerDay: 999999 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'SETTINGS_OUT_OF_BOUNDS' });
  });
});

describe('POST /wisp/grants/:id/{pause,resume} (w00 A29)', () => {
  it('pause returns the DTO and publishes nothing', async () => {
    h.svc.userPauseGrant.mockResolvedValue(grant({ status: 'paused', pausedReason: 'user_paused' }));
    const res = await post(buildApp(), `/wisp/grants/${GRANT_ID}/pause`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'paused', pausedReason: 'user_paused' });
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('resume → 409 NOT_USER_PAUSED for a system pause', async () => {
    h.svc.userResumeGrant.mockRejectedValue(new WispGrantError('not_user_paused', 'system pause'));
    const res = await post(buildApp(), `/wisp/grants/${GRANT_ID}/resume`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NOT_USER_PAUSED' });
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('resume publishes wisp.grant.resumed once', async () => {
    h.svc.userResumeGrant.mockResolvedValue(grant());
    const res = await post(buildApp(), `/wisp/grants/${GRANT_ID}/resume`);
    expect(res.status).toBe(200);
    expect(h.publishEvent).toHaveBeenCalledTimes(1);
    expect(h.publishEvent).toHaveBeenCalledWith(
      'wisp.grant.resumed', PARTNER, { grantId: GRANT_ID, partnerId: PARTNER, orgId: null, grantorUserId: USER }, 'wisp',
    );
  });
});
