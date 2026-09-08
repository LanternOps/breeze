/**
 * Tests for GET /agent-versions/effective — issue #5285: the Devices list
 * "Agent Version" column needs each visible org's EFFECTIVE agent-version
 * target (its agentVersionPins.agent pin, or the globally promoted version
 * when unpinned) to colour-code rows, resolved ONCE per page load across
 * every visible org rather than once per device row.
 *
 * This route is a thin composition of two already-tested resolvers
 * (getOrgAgentVersionPinsBatch in agents/helpers.ts,
 * getPromotedAgentVersionForDisplay in services/promotedAgentVersion.ts), so
 * both are mocked here — this file pins the route's OWN contract: query
 * parsing, auth scoping (an orgId outside the caller's access is silently
 * dropped, never a 403 leak), and the pin-vs-promoted merge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn((..._scopes: string[]) => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../middleware/platformAdmin', () => ({
  platformAdminMiddleware: vi.fn(async (_c: any, next: any) => next()),
}));

const pinsMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../services/orgAgentVersionPins', () => ({
  getOrgAgentVersionPinsBatch: pinsMock.fn,
}));

const promotedMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../services/promotedAgentVersion', () => ({
  getPromotedAgentVersionForDisplay: promotedMock.fn,
  // Referenced elsewhere in agentVersions.ts (download route) — stub so the
  // module still loads.
  getPromotedComponentVersion: vi.fn(async () => null),
  getRegisteredComponentVersion: vi.fn(async () => null),
  PromotedVersionUnavailableError: class extends Error {},
}));

vi.mock('../services/binarySync', () => ({ syncFromGitHub: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/manifestSigning', () => ({
  getActivePublicKeys: vi.fn().mockResolvedValue([]),
  getActiveTrustKeyset: vi.fn().mockResolvedValue([]),
  ensureActiveSigningKey: vi.fn().mockResolvedValue({ keyId: 'test-key', publicKeyB64: '' }),
  signManifest: vi.fn().mockResolvedValue('test-signature'),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() },
}));

import { agentVersionRoutes } from './agentVersions';
import { authMiddleware } from '../middleware/auth';

function buildAuth(overrides: Partial<{
  scope: 'system' | 'partner' | 'organization';
  orgId: string | null;
  accessibleOrgIds: string[] | null;
}> = {}) {
  const scope = overrides.scope ?? 'partner';
  const accessibleOrgIds: string[] | null =
    'accessibleOrgIds' in overrides ? (overrides.accessibleOrgIds ?? null) : ['org-a', 'org-b'];
  return {
    user: { id: 'user-1', email: 't@example.com', name: 'Test', isPlatformAdmin: false },
    token: {},
    partnerId: 'partner-1',
    orgId: overrides.orgId ?? null,
    scope,
    accessibleOrgIds,
    canAccessOrg: (id: string) =>
      accessibleOrgIds === null ? true : accessibleOrgIds.includes(id),
  };
}

describe('GET /agent-versions/effective', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/agent-versions', agentVersionRoutes);
  });

  function setAuth(auth: ReturnType<typeof buildAuth>) {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', auth);
      return next();
    });
  }

  it('uses the org pin when one is set', async () => {
    setAuth(buildAuth());
    pinsMock.fn.mockResolvedValue({ 'org-a': { agent: '0.88.0', watchdog: null } });
    promotedMock.fn.mockResolvedValue('0.110.0');

    const res = await app.request('/agent-versions/effective?orgIds=org-a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ 'org-a': '0.88.0' });
  });

  it('falls back to the globally promoted version when the org has no pin', async () => {
    setAuth(buildAuth());
    pinsMock.fn.mockResolvedValue({ 'org-a': { agent: null, watchdog: null } });
    promotedMock.fn.mockResolvedValue('0.110.0');

    const res = await app.request('/agent-versions/effective?orgIds=org-a');
    const body = await res.json();
    expect(body.data).toEqual({ 'org-a': '0.110.0' });
  });

  it('resolves the promoted fallback ONCE regardless of how many orgs are requested', async () => {
    setAuth(buildAuth({ accessibleOrgIds: ['org-a', 'org-b', 'org-c'] }));
    pinsMock.fn.mockResolvedValue({
      'org-a': { agent: null, watchdog: null },
      'org-b': { agent: '0.90.0', watchdog: null },
      'org-c': { agent: null, watchdog: null },
    });
    promotedMock.fn.mockResolvedValue('0.110.0');

    const res = await app.request('/agent-versions/effective?orgIds=org-a,org-b,org-c');
    const body = await res.json();
    expect(body.data).toEqual({
      'org-a': '0.110.0',
      'org-b': '0.90.0',
      'org-c': '0.110.0',
    });
    expect(promotedMock.fn).toHaveBeenCalledTimes(1);
  });

  it('returns null for an org when neither a pin nor a promoted version exists (never synced)', async () => {
    setAuth(buildAuth());
    pinsMock.fn.mockResolvedValue({ 'org-a': { agent: null, watchdog: null } });
    promotedMock.fn.mockResolvedValue(null);

    const res = await app.request('/agent-versions/effective?orgIds=org-a');
    const body = await res.json();
    expect(body.data).toEqual({ 'org-a': null });
  });

  it('silently drops an orgId the caller cannot access, rather than erroring', async () => {
    setAuth(buildAuth({ accessibleOrgIds: ['org-a'] }));
    pinsMock.fn.mockResolvedValue({ 'org-a': { agent: '0.88.0', watchdog: null } });
    promotedMock.fn.mockResolvedValue('0.110.0');

    const res = await app.request('/agent-versions/effective?orgIds=org-a,org-forbidden');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ 'org-a': '0.88.0' });
    // The batch resolver is only ever asked about orgs the caller can access.
    expect(pinsMock.fn).toHaveBeenCalledWith(['org-a']);
  });

  it('returns an empty map without calling either resolver when no requested org is accessible', async () => {
    setAuth(buildAuth({ accessibleOrgIds: [] }));

    const res = await app.request('/agent-versions/effective?orgIds=org-a,org-b');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({});
    expect(pinsMock.fn).not.toHaveBeenCalled();
    expect(promotedMock.fn).not.toHaveBeenCalled();
  });

  it('system scope can access any requested org', async () => {
    setAuth(buildAuth({ scope: 'system', accessibleOrgIds: null }));
    pinsMock.fn.mockResolvedValue({ 'org-anything': { agent: '0.99.0', watchdog: null } });
    promotedMock.fn.mockResolvedValue(null);

    const res = await app.request('/agent-versions/effective?orgIds=org-anything');
    const body = await res.json();
    expect(body.data).toEqual({ 'org-anything': '0.99.0' });
  });

  it('rejects a request with no orgIds query param', async () => {
    setAuth(buildAuth());
    const res = await app.request('/agent-versions/effective');
    expect(res.status).toBe(400);
  });
});
