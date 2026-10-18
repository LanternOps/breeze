import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({ limit: vi.fn(), auth: null as any, read: true, write: true, mfa: true, get: vi.fn(), start: vi.fn(), directoryUsers: vi.fn(), syncDirectory: vi.fn(), createAdmin: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, n: any) => { if (!m.auth) return c.json({ error: 'unauthorized' }, 401); c.set('auth', m.auth); return n(); },
  requireScope: (...s: string[]) => async (c: any, n: any) => (s.includes(c.get('auth').scope) ? n() : c.json({}, 403)),
  requirePermission: (_r: string, a: string) => async (c: any, n: any) => ((a === 'write' && !m.write) || (a === 'read' && !m.read) ? c.json({}, 403) : n()),
  requireMfa: () => async (c: any, n: any) => (m.mfa ? n() : c.json({}, 403)),
  withAuthDbAccessContext: (_a: unknown, f: () => unknown) => f(),
}));
vi.mock('./orgContacts', () => ({ canReachContactSite: (_a: unknown, site: string | null) => site === null }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: m.limit }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/contacts/import', () => ({ importDirectoryContact: vi.fn() }));
vi.mock('../services/callerVerification/directory', () => ({ directoryUsers: m.directoryUsers, syncDirectory: m.syncDirectory }));
vi.mock('../services/callerVerification/service', () => ({
  get: m.get, start: m.start, createAdministrative: m.createAdmin, cancel: vi.fn(), attest: vi.fn(), listForContact: vi.fn(), methodsForContact: vi.fn(), freshForTicket: vi.fn(),
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/auditService', () => ({ createAuditLog: vi.fn() }));

import { callerVerificationRoutes } from './callerVerification';
import { administrativeProofFor } from '../services/callerVerification/administrativeContext';
import { CallerVerificationValidationError } from '../services/callerVerification/errors';

const app = new Hono().route('/', callerVerificationRoutes);
const org = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const path = `/orgs/${org}/caller-verifications`;
const contactPath = `/orgs/${org}/contacts/${id}`;
const routes = [
  ['POST', path], ['POST', `${path}/administrative`], ['GET', `${path}/device-suggestions?contactId=${id}`], ['GET', `${path}/${id}`], ['POST', `${path}/${id}/cancel`], ['POST', `${path}/${id}/attest`],
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
  m.limit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 600000 });
});
afterEach(() => vi.unstubAllEnvs());

it('caps technician starts per user before any service work (#6354 W03)', async () => {
  m.limit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 600000 });
  const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId: id, method: 'sms', actionScope: 'any' }) });
  expect(response.status).toBe(429);
  expect(m.limit).toHaveBeenCalledWith(null, `caller-verification:start:${id}`, 10, 600);
  expect(m.start).not.toHaveBeenCalled();
});

it.each(routes)('%s %s authenticates first, then is dark, then permission protected', async (method, url) => {
  // Auth runs BEFORE the readiness gate: __tests__/routerAuthGate.contract.test.ts
  // requires every mounted route to answer an unauthenticated request with 401,
  // flag or no flag. Anonymous probes therefore learn nothing about the flag —
  // they are refused for the same reason on every route in the app.
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
  const auth = m.auth; m.auth = null;
  expect((await app.request(url, { method })).status).toBe(401);
  m.auth = auth;
  // Authenticated, flag off: 404 with the feature_disabled code.
  const dark = await app.request(url, { method });
  expect(dark.status).toBe(404);
  expect(await dark.json()).toMatchObject({ code: 'feature_disabled' });
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
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

// --- W05 administrative step-up route ----------------------------------------

const adminPath = `${path}/administrative`;
const reason = 'Confirmed employee offboarding with the authorized HR manager.';
const grant = '33333333-3333-4333-8333-333333333333';
const adminBody = { targetContactId: id, reason, stepUpGrantId: grant };
const post = (body: unknown) => app.request(adminPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const interactive = (patch: Record<string, unknown> = {}) => ({
  ...m.auth, principal: { kind: 'user_session' }, token: { sid: 'family-1', aep: 4, mep: 5 }, ...patch,
});

it('administrative: unauthenticated is 401 and a missing permission is 403 before any service work', async () => {
  m.auth = null;
  expect((await post(adminBody)).status).toBe(401);
  m.auth = interactive(); m.write = false;
  expect((await post(adminBody)).status).toBe(403);
  expect(m.createAdmin).not.toHaveBeenCalled();
});

it('administrative: malformed reason, extra session fields or a non-uuid grant are 400', async () => {
  m.auth = interactive();
  expect((await post({ ...adminBody, reason: 'too short' })).status).toBe(400);
  expect((await post({ ...adminBody, reason: 'x'.repeat(2001) })).status).toBe(400);
  expect((await post({ ...adminBody, sid: 'forged', authEpoch: 1 })).status).toBe(400);
  expect((await post({ ...adminBody, stepUpGrantId: 'nope' })).status).toBe(400);
  expect(m.createAdmin).not.toHaveBeenCalled();
});

it.each([
  ['an API key principal', { principal: { kind: 'api_key' } }],
  ['a missing sid', { token: { aep: 4, mep: 5 } }],
  ['a missing aep', { token: { sid: 'f', mep: 5 } }],
  ['a missing mep', { token: { sid: 'f', aep: 4 } }],
  ['a null token', { token: null }],
])('administrative: %s is refused 403 interactive_stepup_required without calling the service', async (_n, patch) => {
  m.auth = interactive(patch);
  const res = await post(adminBody);
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'interactive_stepup_required' });
  expect(m.createAdmin).not.toHaveBeenCalled();
});

it('administrative: runs the service inside a proof taken from the token, returns 201', async () => {
  m.auth = interactive();
  m.createAdmin.mockImplementation(async () => ({ id: 'v1', proof: administrativeProofFor(id) }));
  const res = await post(adminBody);
  expect(res.status).toBe(201);
  expect((await res.json()).data.proof).toEqual({ userId: id, sid: 'family-1', authEpoch: 4, mfaEpoch: 5 });
  expect(m.createAdmin).toHaveBeenCalledWith(expect.objectContaining({ userId: id }), { orgId: org, ...adminBody });
});

it.each([
  ['stepup_invalidated', 403], ['interactive_stepup_required', 403], ['attempt_cap', 429], ['invalid_reason', 400],
])('administrative: service error %s maps to HTTP %i', async (code, status) => {
  m.auth = interactive();
  m.createAdmin.mockRejectedValue(new CallerVerificationValidationError(code, 'x'));
  const res = await post(adminBody);
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ code });
});
