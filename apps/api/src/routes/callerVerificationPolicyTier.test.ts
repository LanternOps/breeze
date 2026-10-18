import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({ auth: null as any, getPolicyResponse: vi.fn(), allowAdmin: vi.fn(), dbWrite: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, n: any) => { c.set('auth', m.auth); return n(); },
  requireScope: () => async (_c: any, n: any) => n(),
  requirePermission: () => async (_c: any, n: any) => n(),
  requireMfa: () => async (_c: any, n: any) => n(),
  withAuthDbAccessContext: (_a: unknown, f: () => unknown) => f(),
}));
vi.mock('./orgContacts', () => ({ canReachContactSite: () => true }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/contacts/import', () => ({ importDirectoryContact: vi.fn() }));
vi.mock('../services/callerVerification/directory', () => ({ directoryUsers: vi.fn(), syncDirectory: vi.fn() }));
vi.mock('../services/callerVerification/service', () => ({}));
vi.mock('../services/partnerWideAccess', () => ({ canManagePartnerWidePolicies: () => true }));
// Org-existence lookups succeed; reaching the advisory lock / write means the clamp did not refuse first.
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] }) }) }),
    execute: () => { m.dbWrite(); throw new Error('db write must not be reached'); },
    update: () => { m.dbWrite(); throw new Error('db write must not be reached'); },
    insert: () => { m.dbWrite(); throw new Error('db write must not be reached'); },
  },
}));
vi.mock('../services/auditService', () => ({ createAuditLog: vi.fn() }));
vi.mock('../services/callerVerification/policy', async (original) => ({
  ...await original<typeof import('../services/callerVerification/policy')>(),
  getPolicyResponse: m.getPolicyResponse,
  allowAdministrativeDisableAfterWrite: m.allowAdmin,
}));

import { callerVerificationRoutes } from './callerVerification';

const app = new Hono().route('/', callerVerificationRoutes);
const org = '11111111-1111-4111-8111-111111111111';
const uid = '22222222-2222-4222-8222-222222222222';
const put = (path: string, body: unknown) => app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  m.auth = { scope: 'partner', user: { id: uid, email: 'a@b.c' }, partnerId: 'p', accessibleOrgIds: [org], allowedSiteIds: null, canAccessOrg: () => true };
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  delete process.env.CALLER_VERIFICATION_WORKSTATION_ENABLED;
  m.allowAdmin.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  [`/orgs/${org}/caller-verification-policy`, { requiredTierResetPassword: 3 }],
  [`/orgs/${org}/caller-verification-policy`, { requiredTierDisableUser: 3 }],
  ['/partner/caller-verification-policy', { requiredTierResetPassword: 3 }],
  ['/partner/caller-verification-policy', { requiredTierDisableUser: 3 }],
])('PUT %s %j is 400 tier_unachievable while the workstation tier is dark and administrative disable is off', async (path, body) => {
  const res = await put(path, body);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'tier_unachievable' });
  expect(m.dbWrite).not.toHaveBeenCalled();
});

it('GET policy returns the projection including maxAchievableTier', async () => {
  m.getPolicyResponse.mockResolvedValue({ maxAchievableTier: 2, row: null });
  m.auth = { ...m.auth, scope: 'partner' };
  const res = await app.request('/partner/caller-verification-policy');
  expect(res.status).toBe(200);
  expect((await res.json()).data.maxAchievableTier).toBe(2);
});

it.each([`/orgs/${org}/caller-verification-policy`, '/partner/caller-verification-policy'])(
  'PUT %s with disable_user tier 3 passes the clamp when administrative disable stays on (reaches the write)', async (path) => {
    m.allowAdmin.mockResolvedValue(true);
    m.auth = { ...m.auth, scope: 'partner' };
    await Promise.resolve(put(path, { requiredTierDisableUser: 3 })).catch(() => undefined);
    expect(m.allowAdmin).toHaveBeenCalledWith(path.startsWith('/partner') ? 'partner' : 'org', expect.any(String), { requiredTierDisableUser: 3 });
    expect(m.dbWrite).toHaveBeenCalled();
  });

it('PUT still refuses reset_password tier 3 when administrative disable is on and the workstation tier is dark', async () => {
  m.allowAdmin.mockResolvedValue(true);
  const res = await put('/partner/caller-verification-policy', { requiredTierResetPassword: 3 });
  expect(res.status).toBe(400);
  expect(m.dbWrite).not.toHaveBeenCalled();
});
