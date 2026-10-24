/**
 * Wisp W06a Task 6 — nudge preference + partner urgent-capable routes,
 * exercised THROUGH the W02 hub (`wispRoutes`) so the inherited gates (auth →
 * wispEnabled() 404 → partner scope → ai_sessions:use → entitlement) are the
 * real chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WISP_NUDGE_PREFERENCE_DEFAULTS } from '@breeze/shared';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  hasEntitlement: vi.fn(async () => true),
  loadNudgePrefs: vi.fn(),
  upsertNudgePrefs: vi.fn(),
  loadUrgentCapableSeverities: vi.fn(),
  upsertUrgentCapableSeverities: vi.fn(),
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
vi.mock('../services/wisp/nudgePreferences', () => ({
  loadNudgePrefs: h.loadNudgePrefs,
  upsertNudgePrefs: h.upsertNudgePrefs,
  loadUrgentCapableSeverities: h.loadUrgentCapableSeverities,
  upsertUrgentCapableSeverities: h.upsertUrgentCapableSeverities,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));

import { wispRoutes } from './wisp';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const DEFAULTS = WISP_NUDGE_PREFERENCE_DEFAULTS;

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
const put = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(true);
  h.loadNudgePrefs.mockResolvedValue(DEFAULTS);
  h.loadUrgentCapableSeverities.mockResolvedValue([]);
});

describe('GET /wisp/nudge-preferences', () => {
  it('returns defaults when no row exists and does not insert', async () => {
    const res = await buildApp().request('/wisp/nudge-preferences');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { settings: { channels: { inApp: true, push: true }, quietOverride: 'never', digestCadenceMinutes: 240, briefTimeLocal: '08:00', briefTimezone: null, proactivity: 'normal' } },
    });
    expect(h.loadNudgePrefs).toHaveBeenCalledWith(USER);
    expect(h.upsertNudgePrefs).not.toHaveBeenCalled();
  });

  it('is 404 when wispEnabled() is false', async () => {
    h.wispEnabled.mockReturnValue(false);
    expect((await buildApp().request('/wisp/nudge-preferences')).status).toBe(404);
    expect(h.loadNudgePrefs).not.toHaveBeenCalled();
  });

  it('is refused for an organization-scope token (partner scope only)', async () => {
    const res = await buildApp({ scope: 'organization', partnerId: null, orgId: ORG }).request('/wisp/nudge-preferences');
    expect(res.status).toBe(403);
  });

  it('is refused without the wisp entitlement', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    const res = await buildApp().request('/wisp/nudge-preferences');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.loadNudgePrefs).not.toHaveBeenCalled();
  });
});

describe('PUT /wisp/nudge-preferences', () => {
  it('upserts for the authenticated user and echoes the stored row', async () => {
    h.upsertNudgePrefs.mockResolvedValue({ ...DEFAULTS, quietOverride: 'urgent_only' });
    const res = await put(buildApp(), '/wisp/nudge-preferences', { quietOverride: 'urgent_only' });
    expect(res.status).toBe(200);
    expect(h.upsertNudgePrefs).toHaveBeenCalledWith(USER, PARTNER, { quietOverride: 'urgent_only' });
    expect((await res.json()).data.settings.quietOverride).toBe('urgent_only');
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.nudge_preferences.update', resourceType: 'user', resourceId: USER, orgId: null,
    }));
  });

  it('rejects a smuggled userId (strict) and an empty body', async () => {
    const app = buildApp();
    expect((await put(app, '/wisp/nudge-preferences', { userId: 'other', quietOverride: 'never' })).status).toBe(400);
    expect((await put(app, '/wisp/nudge-preferences', {})).status).toBe(400);
    expect(h.upsertNudgePrefs).not.toHaveBeenCalled();
  });

  it('rejects digestCadenceMinutes 10 and a malformed brief time', async () => {
    const app = buildApp();
    expect((await put(app, '/wisp/nudge-preferences', { digestCadenceMinutes: 10 })).status).toBe(400);
    expect((await put(app, '/wisp/nudge-preferences', { briefTimeLocal: '25:00' })).status).toBe(400);
    expect(h.upsertNudgePrefs).not.toHaveBeenCalled();
  });

  it('accepts turning the brief off and the proactivity dial', async () => {
    h.upsertNudgePrefs.mockResolvedValue({ ...DEFAULTS, briefTimeLocal: null, proactivity: 'quiet' });
    const res = await put(buildApp(), '/wisp/nudge-preferences', { briefTimeLocal: null, proactivity: 'quiet' });
    expect(res.status).toBe(200);
    expect(h.upsertNudgePrefs).toHaveBeenCalledWith(USER, PARTNER, { briefTimeLocal: null, proactivity: 'quiet' });
  });
});

describe('GET /wisp/nudge-settings', () => {
  it('any partner member reads the urgent-capable set', async () => {
    h.loadUrgentCapableSeverities.mockResolvedValue(['high']);
    const res = await buildApp().request('/wisp/nudge-settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { settings: { urgentCapableSeverities: ['high'] } } });
    expect(h.loadUrgentCapableSeverities).toHaveBeenCalledWith(PARTNER);
  });
});

describe('PUT /wisp/nudge-settings', () => {
  it('is 403 partner_admin_required for a non-admin', async () => {
    const res = await put(buildApp(), '/wisp/nudge-settings', { urgentCapableSeverities: ['high'] });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('partner_admin_required');
    expect(h.upsertUrgentCapableSeverities).not.toHaveBeenCalled();
  });

  it('stores ["high"] for a partner admin and audits', async () => {
    h.upsertUrgentCapableSeverities.mockResolvedValue(['high']);
    const res = await put(buildApp(asPartnerAdmin), '/wisp/nudge-settings', { urgentCapableSeverities: ['high'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { settings: { urgentCapableSeverities: ['high'] } } });
    expect(h.upsertUrgentCapableSeverities).toHaveBeenCalledWith(PARTNER, ['high'], USER);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.nudge_settings.update', resourceType: 'partner', resourceId: PARTNER,
    }));
  });

  it('rejects an unknown severity and a smuggled key', async () => {
    const app = buildApp(asPartnerAdmin);
    expect((await put(app, '/wisp/nudge-settings', { urgentCapableSeverities: ['critical'] })).status).toBe(400);
    expect((await put(app, '/wisp/nudge-settings', { urgentCapableSeverities: ['high'], partnerId: 'x' })).status).toBe(400);
    expect(h.upsertUrgentCapableSeverities).not.toHaveBeenCalled();
  });
});
