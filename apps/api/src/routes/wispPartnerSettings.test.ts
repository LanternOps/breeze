/**
 * Wisp W08 Task 6 (w00 A35) — the partner enable switch routes, exercised
 * THROUGH the W02 hub (`wispRoutes`) so the inherited gates (auth →
 * wispEnabled() 404 → partner scope → ai_sessions:use → entitlement) are the
 * real chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  hasEntitlement: vi.fn(async () => true),
  getPartnerSettings: vi.fn(),
  setPartnerEnabled: vi.fn(),
  reconcilePartnerDisabled: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
    requireScope: actual.requireScope,
    requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});
vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wispEnabled: () => h.wispEnabled(),
}));
vi.mock('../services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntitlement: h.hasEntitlement,
}));
vi.mock('../db', () => ({ db: {}, runAfterDbContextCommit: (_l: string, work: () => unknown) => { void work(); } }));
vi.mock('../services/wisp/partnerSettings', () => ({
  getPartnerSettings: h.getPartnerSettings,
  setPartnerEnabled: h.setPartnerEnabled,
  reconcilePartnerDisabled: h.reconcilePartnerDisabled,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));

import { wispRoutes } from './wisp';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, PartnerWideWriteDeniedError } from '../services/partnerWideAccess';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      scope: 'partner',
      partnerId: PARTNER,
      orgId: null,
      accessibleOrgIds: [ORG],
      partnerOrgAccess: 'selected',
      user: { id: USER, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
      token: { sid: 'sid', mfa: true },
      canAccessOrg: (id: string) => id === ORG,
      orgCondition: () => undefined,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/wisp', wispRoutes);
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: 'boom', message: err.message }, 500)));
  return app;
}
const asPartnerAdmin = { partnerOrgAccess: 'all' };
const put = (app: Hono, body: unknown) =>
  app.request('/wisp/partner-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(true);
  h.getPartnerSettings.mockResolvedValue({ enabled: true, urgentCapableSeverities: [] });
});

describe('GET /wisp/partner-settings', () => {
  it('any partner member with ai_sessions:use reads the switch (missing row = enabled)', async () => {
    const res = await buildApp().request('/wisp/partner-settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { enabled: true } });
    expect(h.getPartnerSettings).toHaveBeenCalledWith(PARTNER);
  });

  it('a disabled-but-entitled partner can still read the switch (that is how it is turned back on)', async () => {
    h.getPartnerSettings.mockResolvedValue({ enabled: false, urgentCapableSeverities: ['high'] });
    const res = await buildApp().request('/wisp/partner-settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { enabled: false } });
  });

  it('is 404 when wispEnabled() is false', async () => {
    h.wispEnabled.mockReturnValue(false);
    expect((await buildApp().request('/wisp/partner-settings')).status).toBe(404);
    expect(h.getPartnerSettings).not.toHaveBeenCalled();
  });

  it('is refused for an organization-scope token and without the entitlement', async () => {
    expect((await buildApp({ scope: 'organization', partnerId: null, orgId: ORG }).request('/wisp/partner-settings')).status).toBe(403);
    h.hasEntitlement.mockResolvedValue(false);
    expect((await buildApp().request('/wisp/partner-settings')).status).toBe(403);
    expect(h.getPartnerSettings).not.toHaveBeenCalled();
  });
});

describe('PUT /wisp/partner-settings', () => {
  it('is 403 partner_admin_required for a partner user without full org access; nothing written or audited', async () => {
    const res = await put(buildApp(), { enabled: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'partner_admin_required' });
    expect(h.setPartnerEnabled).not.toHaveBeenCalled();
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('a service-level refusal (PartnerWideWriteDeniedError) is the same 403', async () => {
    h.setPartnerEnabled.mockRejectedValue(new PartnerWideWriteDeniedError());
    const res = await put(buildApp(asPartnerAdmin), { enabled: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'partner_admin_required' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('a partner admin turns Wisp off: partner + author from auth, audited wisp.partner.enabled_changed', async () => {
    h.setPartnerEnabled.mockResolvedValue({ enabled: false });
    const res = await put(buildApp(asPartnerAdmin), { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { enabled: false } });
    expect(h.setPartnerEnabled).toHaveBeenCalledWith(expect.objectContaining({ partnerId: PARTNER, user: expect.objectContaining({ id: USER }) }), false);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: null,
      partnerId: PARTNER,
      action: 'wisp.partner.enabled_changed',
      resourceType: 'partner',
      resourceId: PARTNER,
      details: { enabled: false },
    });
  });

  it('a disabled-but-entitled partner can turn it back on (nothing in the hub refuses while the switch is off)', async () => {
    h.getPartnerSettings.mockResolvedValue({ enabled: false, urgentCapableSeverities: [] });
    h.setPartnerEnabled.mockResolvedValue({ enabled: true });
    const res = await put(buildApp(asPartnerAdmin), { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { enabled: true } });
  });

  it('rejects a smuggled partnerId, a non-boolean and an empty body (strict)', async () => {
    const app = buildApp(asPartnerAdmin);
    expect((await put(app, { enabled: false, partnerId: 'other' })).status).toBe(400);
    expect((await put(app, { enabled: 'no' })).status).toBe(400);
    expect((await put(app, {})).status).toBe(400);
    expect(h.setPartnerEnabled).not.toHaveBeenCalled();
  });
});
