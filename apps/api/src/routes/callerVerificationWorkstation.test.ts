import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  auth: null as any, read: true, suggestions: vi.fn(), contact: vi.fn(), get: vi.fn(),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, n: any) => { if (!m.auth) return c.json({ error: 'unauthorized' }, 401); c.set('auth', m.auth); return n(); },
  requireScope: (...s: string[]) => async (c: any, n: any) => (s.includes(c.get('auth').scope) ? n() : c.json({}, 403)),
  requirePermission: (_r: string, a: string) => async (c: any, n: any) => (a === 'read' && !m.read ? c.json({}, 403) : n()),
  requireMfa: () => async (_c: any, n: any) => n(),
  withAuthDbAccessContext: (_a: unknown, f: () => unknown) => f(),
}));
vi.mock('./orgContacts', () => ({ canReachContactSite: (_a: unknown, site: string | null) => site === null }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/contacts/import', () => ({ importDirectoryContact: vi.fn() }));
vi.mock('../services/callerVerification/directory', () => ({ directoryUsers: vi.fn(), syncDirectory: vi.fn() }));
vi.mock('../services/callerVerification/service', () => ({
  get: m.get, start: vi.fn(), cancel: vi.fn(), attest: vi.fn(), listForContact: vi.fn(), methodsForContact: vi.fn(), freshForTicket: vi.fn(),
}));
vi.mock('../services/callerVerification/access', () => ({ reachableContact: m.contact }));
vi.mock('../services/callerVerification/deviceSuggestions', () => ({ deviceSuggestions: m.suggestions }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/auditService', () => ({ createAuditLog: vi.fn() }));

import { callerVerificationRoutes } from './callerVerification';
import { CallerVerificationValidationError } from '../services/callerVerification/errors';

const app = new Hono().route('/', callerVerificationRoutes);
const org = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const url = (contactId = contact) => `/orgs/${org}/caller-verifications/device-suggestions?contactId=${contactId}`;

beforeEach(() => {
  vi.clearAllMocks();
  m.read = true;
  m.auth = { scope: 'organization', user: { id: contact, name: 'Tech' }, partnerId: null, accessibleOrgIds: [org], allowedSiteIds: null, canAccessOrg: () => true };
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  m.contact.mockResolvedValue({ id: contact, siteId: null });
  m.suggestions.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

it('authenticates first, then is dark, then needs org read — and never reaches the service', async () => {
  const auth = m.auth;
  m.auth = null;
  expect((await app.request(url())).status).toBe(401);
  m.auth = auth;
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
  const dark = await app.request(url());
  expect(dark.status).toBe(404);
  expect(await dark.json()).toMatchObject({ code: 'feature_disabled' });
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  m.read = false;
  expect((await app.request(url())).status).toBe(403);
  expect(m.suggestions).not.toHaveBeenCalled();
});

it('is matched before the /:id route', async () => {
  expect((await app.request(url())).status).toBe(200);
  expect(m.get).not.toHaveBeenCalled();
});

it('validates the contact id', async () => {
  expect((await app.request(url('bad'))).status).toBe(400);
  expect((await app.request(`/orgs/${org}/caller-verifications/device-suggestions`)).status).toBe(400);
  expect(m.suggestions).not.toHaveBeenCalled();
});

it('hides other orgs and unreachable sites as 404', async () => {
  m.contact.mockRejectedValueOnce(new CallerVerificationValidationError('not_found', 'Contact not found'));
  expect((await app.request(url())).status).toBe(404);
  m.contact.mockResolvedValueOnce({ id: contact, siteId: '33333333-3333-4333-8333-333333333333' });
  expect((await app.request(url())).status).toBe(404);
  expect(m.suggestions).not.toHaveBeenCalled();
});

it('returns the data envelope with mixed per-device readiness', async () => {
  const rows = [
    { deviceId: '44444444-4444-4444-8444-444444444444', hostname: 'ready', username: 'alex', hasBinding: false, available: true },
    { deviceId: '55555555-5555-4555-8555-555555555555', hostname: 'old', username: 'alex', hasBinding: true, available: false, unavailableReason: 'helper_outdated' },
  ];
  m.suggestions.mockResolvedValueOnce(rows);
  const response = await app.request(url());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: rows });
  expect(m.suggestions).toHaveBeenCalledWith(expect.objectContaining({ userId: contact, scope: 'organization' }), org, contact);
});
