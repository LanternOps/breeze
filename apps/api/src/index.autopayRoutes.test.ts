import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  auth: null as any, allowed: true, enabled: false,
  read: vi.fn(), partnerWrite: vi.fn(), orgWrite: vi.fn(),
  adminRows: [] as Array<{ id: string; autopayEnabled: boolean }>, update: vi.fn(),
  orgRows: [] as Array<{ partnerId: string }>,
}));
vi.mock('./services/redis', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/redis')>()), getRedis: () => null,
  isRedisAvailable: () => false, isBullMQAvailable: () => false,
}));
vi.mock('./middleware/globalRateLimit', async importOriginal => ({
  ...(await importOriginal<typeof import('./middleware/globalRateLimit')>()),
  globalRateLimit: () => async (_c: any, next: any) => next(),
}));
vi.mock('./middleware/partnerGuard', async importOriginal => ({
  ...(await importOriginal<typeof import('./middleware/partnerGuard')>()),
  partnerGuardWithExemptions: async (_c: any, next: any) => next(),
}));
vi.mock('./middleware/auth', async importOriginal => ({
  ...(await importOriginal<typeof import('./middleware/auth')>()),
  authMiddleware: async (c: any, next: any) => {
    if (!m.auth) {
      const { HTTPException } = await import('hono/http-exception');
      throw new HTTPException(401, { message: 'Not authenticated' });
    }
    c.set('auth', m.auth); await next();
  },
  requirePermission: () => async (c: any, next: any) => m.allowed ? next() : c.json({ error: 'Forbidden' }, 403),
  requireMfa: () => async (c: any, next: any) => m.auth?.token?.mfa ? next() : c.json({ code: 'MFA_REQUIRED' }, 403),
}));
vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof import('./db')>();
  return { ...actual, runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    db: { ...actual.db,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => m.orgRows }) }) }),
      update: (...args: unknown[]) => { m.update(...args); return { set: () => ({ where: () => ({ returning: async () => m.adminRows }) }) }; },
    },
  };
});
vi.mock('./services/autopay/billingPaymentSettings', async importOriginal => ({
  ...await importOriginal<typeof import('./services/autopay/billingPaymentSettings')>(),
  resolveBillingPaymentSettings: (...args: unknown[]) => m.read(...args),
  updatePartnerPaymentSettings: (...args: unknown[]) => m.partnerWrite(...args),
  updateOrgPaymentSettings: (...args: unknown[]) => m.orgWrite(...args),
}));
vi.mock('./services/autopay/autopayGate', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/autopay/autopayGate')>()),
  isAutopayEnabledForPartner: async () => m.enabled,
}));
vi.mock('./services/auditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/auditService')>()),
  createAuditLogAsync: vi.fn(), runWithAuditRequestTracking: async (next: () => Promise<void>) => { await next(); return true; },
}));
vi.mock('./services/auditEvents', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/auditEvents')>()), writeRouteAudit: vi.fn(),
}));
vi.mock('./services/auditOrgResolver', () => ({ resolveAuditOrgIdForPartner: async () => null }));
import { app } from './index';
const partnerId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const otherOrg = '44444444-4444-4444-8444-444444444444';
const partnerPath = '/api/v1/partner/billing/payment-settings';
const orgPath = `/api/v1/orgs/${orgId}/billing/payment-settings`;
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, { method, ...(body === undefined ? {} : {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) });
}
beforeEach(() => {
  vi.clearAllMocks(); m.allowed = true; m.enabled = false;
  m.auth = { scope: 'partner', partnerId, partnerOrgAccess: 'all', orgId: null,
    user: { id: partnerId, email: 'admin@example.test', isPlatformAdmin: false }, token: { mfa: true },
    principal: { kind: 'user_session' }, canAccessOrg: (id: string) => id === orgId, accessibleOrgIds: [orgId] };
  m.read.mockResolvedValue({ remindersEnabled: { value: false, source: 'default' } });
  m.partnerWrite.mockResolvedValue(undefined); m.orgWrite.mockResolvedValue(undefined);
  m.adminRows = [{ id: partnerId, autopayEnabled: true }];
  m.orgRows = [{ partnerId }];
});
describe('autopay routes through exported API application', () => {
  it('mounts both GET routes and returns the partner rollout flag', async () => {
    const partner = await request(partnerPath);
    expect(partner.status).toBe(200); expect(await partner.json()).toMatchObject({ autopayEnabled: false });
    const org = await request(orgPath);
    expect(org.status).toBe(200);
    const body = await org.json();
    expect(body.data).toEqual(body.effective);
    expect(body).toMatchObject({ autopayEnabled: false, values: { autopayCapEnabled: null },
      inherited: { remindersEnabled: { value: false, source: 'default' } } });
    expect(m.read).toHaveBeenNthCalledWith(2, expect.anything(), { partnerId, orgId });
    expect(m.read).toHaveBeenNthCalledWith(3, expect.anything(), { partnerId });
  });
  it('keeps reminders writable with rollout off for partner administrators', async () => {
    expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(200);
    expect((await request(orgPath, 'PUT', { reminderRepeatDays: null })).status).toBe(200);
    expect(m.partnerWrite).toHaveBeenCalledOnce(); expect(m.orgWrite).toHaveBeenCalledOnce();
    m.auth.scope = 'organization';
    expect((await request(partnerPath)).status).toBe(403);
  });
  it('rejects mixed autopay/reminder writes atomically until enabled', async () => {
    const response = await request(partnerPath, 'PUT', { remindersEnabled: true, autopayOffsetDays: 0 });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'autopay_not_enabled' });
    expect(m.partnerWrite).not.toHaveBeenCalled();
    m.enabled = true; expect((await request(partnerPath, 'PUT', { autopayOffsetDays: 0 })).status).toBe(200);
  });
  it.each([{ cardFeeBps: 0 }, { achFeeAmount: '0.00' }, { attestation: true }, { bogus: 1 }])('rejects forbidden fields %j', async body => {
    expect((await request(partnerPath, 'PUT', body)).status).toBe(400);
    expect((await request(orgPath, 'PUT', body)).status).toBe(400);
    expect(m.partnerWrite).not.toHaveBeenCalled(); expect(m.orgWrite).not.toHaveBeenCalled();
  });
  it('enforces authentication, permission, full-partner capability and org access', async () => {
    m.allowed = false; expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(403);
    m.allowed = true; m.auth.partnerOrgAccess = 'selected';
    expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(403);
    expect((await request(`/api/v1/orgs/${otherOrg}/billing/payment-settings`)).status).toBe(403);
    m.auth = null; expect((await request(partnerPath)).status).toBe(401);
    expect((await request(orgPath, 'PUT', { remindersEnabled: true })).status).toBe(401);
    expect(m.partnerWrite).not.toHaveBeenCalled(); expect(m.orgWrite).not.toHaveBeenCalled();
  });
  it('rejects malformed, absent and mismatched organization rows before a write', async () => {
    expect((await request('/api/v1/orgs/bad/billing/payment-settings')).status).toBe(400);
    m.orgRows = [];
    expect((await request(orgPath)).status).toBe(404);
    expect((await request(orgPath, 'PUT', { remindersEnabled: true })).status).toBe(404);
    m.orgRows = [{ partnerId: otherOrg }];
    expect((await request(orgPath)).status).toBe(404);
    expect(m.orgWrite).not.toHaveBeenCalled();
  });
  it('mounts rollout beneath the real platform-admin hub and MFA gate', async () => {
    const path = `/api/v1/admin/partners/${partnerId}/autopay`;
    expect((await request(path, 'PATCH', { autopayEnabled: true })).status).toBe(403);
    m.auth.user.isPlatformAdmin = true; m.auth.token.mfa = false;
    expect((await request(path, 'PATCH', { autopayEnabled: true })).status).toBe(403);
    m.auth.token.mfa = true;
    expect((await request(path, 'PATCH', { autopayEnabled: true })).status).toBe(200);
    expect(m.update).toHaveBeenCalledOnce();
  });
  it('surfaces service failures as server errors', async () => {
    m.partnerWrite.mockRejectedValueOnce(new Error('unavailable'));
    expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(500);
  });
});

it('starts a real NODE_ENV=test API unless running under Vitest', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(source).toContain('if (!process.env.VITEST) {');
});
it('org settings reject mixed writes atomically and return enabled updates', async () => {
  const response = await request(orgPath, 'PUT', { remindersEnabled: true, autopayOffsetDays: 0 });
  expect(response.status).toBe(404);
  expect(m.orgWrite).not.toHaveBeenCalled();
  m.enabled = true;
  const updated = await request(orgPath, 'PUT', { autopayOffsetDays: 0 });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual({ data: await m.read() });
  expect(m.orgWrite).toHaveBeenCalledOnce();
});
it('org settings enforce scope, permission and MFA before writing', async () => {
  m.auth.token.mfa = false;
  expect((await request(orgPath, 'PUT', { remindersEnabled: true })).status).toBe(403);
  m.auth.token.mfa = true; m.allowed = false;
  expect((await request(orgPath)).status).toBe(403);
  expect((await request(orgPath, 'PUT', { remindersEnabled: true })).status).toBe(403);
  m.allowed = true; m.auth.scope = 'organization';
  expect((await request(orgPath)).status).toBe(403);
  expect((await request(orgPath, 'PUT', { remindersEnabled: true })).status).toBe(403);
  expect(m.orgWrite).not.toHaveBeenCalled();
});
