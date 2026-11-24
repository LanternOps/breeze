import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #8318 wave T2 — GET /devices/:id/tpm-baseline and POST
// /devices/:id/tpm-baseline/mismatch. The scope, interactive-session and MFA
// gates are the REAL implementations (partial middleware mock); the service is
// mocked: tpmBaselineReview.integration.test.ts drives it against real
// PostgreSQL and Redis.

const { enable2faState, authState, reviewMock, viewMock, deviceMock, detectMock, epochsMock } = vi.hoisted(() => ({
  enable2faState: { value: true },
  authState: {
    principalKind: 'user_session' as string,
    mfa: true as boolean,
    sid: 'sid-1' as string | undefined,
    scope: 'partner' as 'partner' | 'organization' | 'system',
  },
  reviewMock: vi.fn(),
  viewMock: vi.fn(),
  deviceMock: vi.fn(),
  detectMock: vi.fn(async () => ({ written: false, why: 'key_not_shared' })),
  epochsMock: vi.fn(async () => ({ authEpoch: 4, mfaEpoch: 5 }) as { authEpoch: number; mfaEpoch: number } | null),
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return { ...actual, get ENABLE_2FA() { return enable2faState.value; } };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        principal: { kind: authState.principalKind, id: 'principal-1' },
        token: { mfa: authState.mfa, sid: authState.sid, scope: authState.scope },
        user: { id: 'user-123', email: 'tech@example.com', name: 'Tech' },
        scope: authState.scope,
        orgId: authState.scope === 'organization' ? 'org-123' : null,
        partnerId: 'partner-1',
        partnerOrgAccess: 'all',
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (orgId: string) => orgId === 'org-123',
      });
      return next();
    }),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      const denied = (c.req.header('x-deny') ?? '').split(',');
      if (denied.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
      const sites = c.req.header('x-sites');
      c.set('permissions', {
        permissions: [],
        partnerId: 'partner-1',
        orgId: null,
        roleId: 'role-1',
        scope: 'partner',
        ...(sites !== undefined ? { allowedSiteIds: sites ? sites.split(',') : [] } : {}),
      });
      return next();
    }),
  };
});

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: deviceMock,
}));
vi.mock('../../services/authEpochs', () => ({ getUserEpochs: epochsMock }));
vi.mock('../../services/tpmBaseline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/tpmBaseline')>()),
  reviewTpmKeyMismatch: reviewMock,
  readTpmBaselineView: viewMock,
}));
vi.mock('../../services/reinstallCandidates', () => ({ detectAfterKeyBaseline: detectMock }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { tpmBaselineRoutes } from './tpmBaseline';

const DEVICE = '33333333-3333-4333-8333-333333333333';
const GRANT = '11111111-1111-4111-8111-111111111111';
const VERSION = 'V'.repeat(43);
const VIEW = { tpmAvailable: true, attested: true, attestedAt: '2027-02-01T10:00:00.000Z', mismatch: { heldAt: '2027-02-02T10:00:00.000Z', version: VERSION } };

let app: Hono;
beforeEach(() => {
  vi.clearAllMocks();
  enable2faState.value = true;
  Object.assign(authState, { principalKind: 'user_session', mfa: true, sid: 'sid-1', scope: 'partner' });
  epochsMock.mockResolvedValue({ authEpoch: 4, mfaEpoch: 5 });
  reviewMock.mockResolvedValue({ ok: true, action: 'accept', orgId: 'org-123' });
  viewMock.mockResolvedValue(VIEW);
  deviceMock.mockResolvedValue({ id: DEVICE, orgId: 'org-123', siteId: 'site-1' });
  app = new Hono();
  app.route('/', tpmBaselineRoutes);
});

describe('GET /devices/:id/tpm-baseline', () => {
  const get = (headers: Record<string, string> = {}, id = DEVICE) => app.request(`/${id}/tpm-baseline`, { headers });

  it('returns the key state view, no hash, for an org or partner reader', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(viewMock).toHaveBeenCalledWith(DEVICE);
    authState.scope = 'organization';
    expect((await get()).status).toBe(200);
  });

  it('needs devices:read', async () => {
    expect((await get({ 'x-deny': 'devices:read' })).status).toBe(403);
    expect(viewMock).not.toHaveBeenCalled();
  });

  it('is a 404 for a device the caller cannot reach and a 403 outside their sites', async () => {
    deviceMock.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
    expect((await get({ 'x-sites': 'site-2' })).status).toBe(403);
    expect(viewMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed id', async () => {
    expect((await get({}, 'not-a-uuid')).status).toBe(400);
  });
});

describe('POST /devices/:id/tpm-baseline/mismatch', () => {
  const post = (payload: unknown, headers: Record<string, string> = {}) => app.request(`/${DEVICE}/tpm-baseline/mismatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

  it('accepts with the step-up the route built, then searches for the new key', async () => {
    const res = await post({ action: 'accept', version: VERSION, stepUpGrant: GRANT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'accept' });
    expect(reviewMock).toHaveBeenCalledWith(expect.objectContaining({
      actor: { userId: 'user-123' },
      deviceId: DEVICE,
      action: 'accept',
      version: VERSION,
      stepUp: { kind: 'grant', grantId: GRANT, auth: expect.objectContaining({ user: expect.objectContaining({ id: 'user-123' }) }), binding: { authEpoch: 4, mfaEpoch: 5, sid: 'sid-1' } },
    }));
    expect(detectMock).toHaveBeenCalledWith(DEVICE);
  });

  it('dismisses with no step-up and no search', async () => {
    reviewMock.mockResolvedValue({ ok: true, action: 'dismiss', orgId: 'org-123' });
    expect((await post({ action: 'dismiss', version: VERSION })).status).toBe(200);
    expect(reviewMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'dismiss', stepUp: { kind: 'not_required' } }));
    expect(epochsMock).not.toHaveBeenCalled();
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('passes the site restriction and an audit builder with no key hash', async () => {
    await post({ action: 'accept', version: VERSION, stepUpGrant: GRANT }, { 'x-sites': 'site-1' });
    const call = reviewMock.mock.calls[0]![0];
    expect(call.canAccessSite('site-1')).toBe(true);
    expect(call.canAccessSite('site-2')).toBe(false);
    const row = call.audit('device.tpm_baseline.mismatch_accepted', 'org-123');
    expect(row).toMatchObject({ orgId: 'org-123', action: 'device.tpm_baseline.mismatch_accepted', resourceId: DEVICE, actorType: 'user' });
    expect(JSON.stringify(row.details)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('only with two-factor authentication off is the accept step-up not required', async () => {
    enable2faState.value = false;
    await post({ action: 'accept', version: VERSION });
    expect(reviewMock).toHaveBeenCalledWith(expect.objectContaining({ stepUp: { kind: 'not_required' } }));
  });

  it('answers a refusal with its status and code, and searches nothing', async () => {
    reviewMock.mockResolvedValue({ ok: false, status: 409, code: 'mismatch_changed', message: 'changed' });
    const res = await post({ action: 'accept', version: VERSION, stepUpGrant: GRANT });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'changed', code: 'mismatch_changed' });
    expect(detectMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an organization user', () => { authState.scope = 'organization'; }],
    ['an API key', () => { authState.principalKind = 'api_key'; }],
    ['a session without MFA', () => { authState.mfa = false; }],
  ])('refuses %s before the service', async (_name, arrange) => {
    arrange();
    const res = await post({ action: 'accept', version: VERSION, stepUpGrant: GRANT });
    expect(res.status).toBe(403);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it.each(['devices:write', 'devices:delete'])('needs %s', async (perm) => {
    expect((await post({ action: 'dismiss', version: VERSION }, { 'x-deny': perm })).status).toBe(403);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown action', { action: 'replace', version: VERSION }],
    ['a malformed version', { action: 'dismiss', version: 'short' }],
    ['no version', { action: 'dismiss' }],
    ['an extra field', { action: 'dismiss', version: VERSION, ekSha256: 'a'.repeat(64) }],
    ['a malformed grant', { action: 'accept', version: VERSION, stepUpGrant: 'nope' }],
  ])('refuses %s', async (_name, payload) => {
    expect((await post(payload)).status).toBe(400);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it('answers 503 when the session epochs cannot be read for an accept', async () => {
    epochsMock.mockResolvedValue(null);
    expect((await post({ action: 'accept', version: VERSION, stepUpGrant: GRANT })).status).toBe(503);
  });
});
