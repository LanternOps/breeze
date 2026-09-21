import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = vi.hoisted(() => ({ auth: null as any, read: true, write: true, mfa: true, get: vi.fn(), start: vi.fn(), directoryUsers: vi.fn(), syncDirectory: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authMiddleware: async (c: any, n: any) => { if (!m.auth) return c.json({ error: 'unauthorized' }, 401); c.set('auth', m.auth); return n(); },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireScope: (...s: string[]) => async (c: any, n: any) => (s.includes(c.get('auth').scope) ? n() : c.json({}, 403)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requirePermission: (_r: string, a: string) => async (c: any, n: any) => ((a === 'write' && !m.write) || (a === 'read' && !m.read) ? c.json({}, 403) : n()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireMfa: () => async (c: any, n: any) => (m.mfa ? n() : c.json({}, 403)),
  withAuthDbAccessContext: (_a: unknown, f: () => unknown) => f(),
}));
vi.mock('./orgContacts', () => ({ canReachContactSite: (_a: unknown, site: string | null) => site === null }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: async () => ({ allowed: true, remaining: 9, resetAt: Date.now() + 600000 }) }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/contacts/import', () => ({ importDirectoryContact: vi.fn() }));
vi.mock('../services/callerVerification/directory', () => ({ directoryUsers: m.directoryUsers, syncDirectory: m.syncDirectory }));
vi.mock('../services/callerVerification/service', () => ({
  get: m.get, start: m.start, cancel: vi.fn(), attest: vi.fn(), listForContact: vi.fn(), methodsForContact: vi.fn(), freshForTicket: vi.fn(),
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/auditService', () => ({ createAuditLog: vi.fn() }));

import { callerVerificationRoutes } from './callerVerification';

const app = new Hono().route('/', callerVerificationRoutes);
const org = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const path = `/orgs/${org}/caller-verifications`;
const contactPath = `/orgs/${org}/contacts/${id}`;
const routes = [
  ['POST', path], ['GET', `${path}/${id}`], ['POST', `${path}/${id}/cancel`], ['POST', `${path}/${id}/attest`],
  ['GET', `${contactPath}/caller-verifications`], ['GET', `${contactPath}/caller-verifications/methods`],
  ['POST', `${contactPath}/caller-verification-bindings`], ['DELETE', `${contactPath}/caller-verification-bindings/${id}`],
  ['POST', `${contactPath}/caller-verification-destinations/${id}/attest`], ['POST', `${contactPath}/caller-verifications/fence-override`],
  ['GET', `/orgs/${org}/tickets/${id}/caller-verification`],
  ['GET', `/orgs/${org}/caller-verification-policy`], ['PUT', `/orgs/${org}/caller-verification-policy`],
  ['GET', '/partner/caller-verification-policy'], ['PUT', '/partner/caller-verification-policy'],
  ['GET', `/orgs/${org}/caller-verification-directory-users?search=alex`], ['POST', `/orgs/${org}/caller-verification-directory-sync`],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  m.read = true; m.write = true; m.mfa = true;
  m.auth = { scope: 'organization', user: { id, name: 'Tech' }, partnerId: null, accessibleOrgIds: [org], allowedSiteIds: null, canAccessOrg: () => true };
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

it.each(routes)('%s %s is dark before auth, then auth and permission protected', async (method, url) => {
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
  expect((await app.request(url, { method })).status).toBe(404);
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  const auth = m.auth; m.auth = null;
  expect((await app.request(url, { method })).status).toBe(401);
  m.auth = auth;
  if (method === 'GET') m.read = false; else m.write = false;
  expect((await app.request(url, { method })).status).toBe(403);
  if (method !== 'GET') { m.write = true; m.mfa = false; expect((await app.request(url, { method })).status).toBe(403); }
});

it('passes only validated start input and returns 202', async () => {
  m.start.mockResolvedValue({ id });
  const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: id, method: 'callback_attestation', actionScope: 'any' }) });
  expect(response.status).toBe(202);
  expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ userId: id, displayName: 'Tech' }), expect.objectContaining({ orgId: org, contactId: id }));
  m.get.mockResolvedValue({ id });
  expect((await app.request(`${path}/${id}`)).status).toBe(200);
  expect((await app.request(`${path}/not-a-uuid`)).status).toBe(400);
});

it('requires write plus MFA and validates start bodies', async () => {
  const request = () => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: id, method: 'callback_attestation', actionScope: 'any' }) });
  m.write = false; expect((await request()).status).toBe(403);
  m.write = true; m.mfa = false; expect((await request()).status).toBe(403);
  m.mfa = true;
  expect((await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
  expect(m.start).not.toHaveBeenCalled();
});

it('maps service refusals to HTTP statuses without leaking internals', async () => {
  const { CallerVerificationValidationError, CallerVerificationRequiredError } = await import('../services/callerVerification/errors');
  m.get.mockRejectedValueOnce(new CallerVerificationValidationError('not_found', 'Verification not found'));
  expect((await app.request(`${path}/${id}`)).status).toBe(404);
  m.get.mockRejectedValueOnce(new CallerVerificationValidationError('attempt_cap', 'cap'));
  expect((await app.request(`${path}/${id}`)).status).toBe(429);
  m.get.mockRejectedValueOnce(new CallerVerificationValidationError('destination_changed', 'x'));
  expect((await app.request(`${path}/${id}`)).status).toBe(400);
  m.get.mockRejectedValueOnce(new CallerVerificationRequiredError({ orgId: org, contactId: null, action: 'reset_password', requiredTier: 2, reason: 'no_fresh_verification', latest: null }));
  const conflict = await app.request(`${path}/${id}`);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: 'caller_verification_required', requiresCallerVerification: { reason: 'no_fresh_verification' } });
});

it('directory search validates the term and forwards the auth context', async () => {
  m.directoryUsers.mockResolvedValue({ available: false, users: [], truncated: false });
  expect((await app.request(`/orgs/${org}/caller-verification-directory-users?search=a"b`)).status).toBe(400);
  const ok = await app.request(`/orgs/${org}/caller-verification-directory-users?search=alex`);
  expect(ok.status).toBe(200);
  expect(m.directoryUsers).toHaveBeenCalledWith(m.auth, org, 'alex');
  m.syncDirectory.mockResolvedValue({ imported: 0, revoked: 0, complete: true });
  const sync = await app.request(`/orgs/${org}/caller-verification-directory-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mappings: [{ contactId: id, entraOid: 'nope' }] }) });
  expect(sync.status).toBe(400);
  expect(m.syncDirectory).not.toHaveBeenCalled();
});
