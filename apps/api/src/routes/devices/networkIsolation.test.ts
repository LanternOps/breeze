import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the interactive-session and MFA implementations real. In particular,
// disabling 2FA must not turn API keys into human containment principals.
const h = vi.hoisted(() => ({
  twoFactor: { enabled: true },
  start: vi.fn(), release: vi.fn(), extend: vi.fn(), acknowledge: vi.fn(),
  codes: vi.fn(), list: vi.fn(),
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../routes/auth/schemas')>()),
  get ENABLE_2FA() { return h.twoFactor.enabled; },
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  runAfterDbContextCommit: vi.fn(),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/auth')>()),
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (c.req.header('x-no-auth') === 'true') return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', {
      principal: { kind: c.req.header('x-principal') ?? 'user_session', id: 'principal-test' },
      token: { mfa: c.req.header('x-no-mfa') !== 'true' },
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'operator@example.test', name: 'Operator' },
      scope: c.req.header('x-scope') ?? 'organization',
      orgId: '22222222-2222-4222-8222-222222222222', partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (id: string) => id === '22222222-2222-4222-8222-222222222222',
    });
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (c.req.header('x-no-permission') === 'true') return c.json({ error: 'Permission denied' }, 403);
    c.set('permissions', {
      permissions: [{ resource, action }], scope: 'organization',
      partnerId: null, orgId: '22222222-2222-4222-8222-222222222222', roleId: 'role-test',
      ...(c.req.header('x-deny-site') === 'true' ? { allowedSiteIds: ['site-other'] } : {}),
    });
    return next();
  }),
}));

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/networkIsolation/service', () => ({
  startNetworkIsolation: h.start,
  releaseNetworkIsolation: h.release,
  extendNetworkIsolation: h.extend,
  acknowledgeNetworkIsolation: h.acknowledge,
  getBreakGlassCodes: h.codes,
  listDeviceIsolations: h.list,
}));

import { networkIsolationRoutes } from './networkIsolation';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { requirePermission } from '../../middleware/auth';

const declaredPermissionCalls = [...vi.mocked(requirePermission).mock.calls];

const DEVICE = '33333333-3333-4333-8333-333333333333';
const EPISODE = '44444444-4444-4444-8444-444444444444';
const INCIDENT = '55555555-5555-4555-8555-555555555555';
const ORG = '22222222-2222-4222-8222-222222222222';
const episode = { id: EPISODE, deviceId: DEVICE, orgId: ORG, generation: 1, state: 'requested' };
const startBody = { incidentId: INCIDENT, reason: 'Contain confirmed compromise' };

const endpoints = [
  { name: 'start', method: 'POST', suffix: '', body: startBody, service: h.start, status: 201 },
  { name: 'release', method: 'POST', suffix: `/${EPISODE}/release`, body: { reason: 'Remediation complete' }, service: h.release, status: 200 },
  { name: 'extend', method: 'POST', suffix: `/${EPISODE}/extend`, body: { ttlHours: 96 }, service: h.extend, status: 200 },
  { name: 'acknowledge', method: 'POST', suffix: `/${EPISODE}/acknowledge`, body: {}, service: h.acknowledge, status: 200 },
  { name: 'codes', method: 'GET', suffix: `/${EPISODE}/break-glass-code`, body: undefined, service: h.codes, status: 200 },
  { name: 'list', method: 'GET', suffix: '', body: undefined, service: h.list, status: 200 },
] as const;

describe('human network-isolation routes', () => {
  let app: Hono;
  const request = (endpoint: (typeof endpoints)[number], headers: Record<string, string> = {}, body: unknown = endpoint.body) =>
    app.request(`/devices/${DEVICE}/network-isolation${endpoint.suffix}`, {
      method: endpoint.method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(endpoint.method !== 'GET' ? { body: JSON.stringify(body) } : {}),
    });

  const noEffects = () => {
    for (const endpoint of endpoints) expect(endpoint.service).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.twoFactor.enabled = true;
    vi.mocked(getDeviceWithOrgCheck).mockReset().mockResolvedValue({
      id: DEVICE, orgId: ORG, siteId: 'site-allowed', hostname: 'device-test',
    } as never);
    h.start.mockReset().mockResolvedValue({ episode, commandId: 'command-test' });
    h.release.mockReset().mockResolvedValue({ episode: { ...episode, state: 'release_requested' }, commandId: 'release-test' });
    h.extend.mockReset().mockResolvedValue({ episode: { ...episode, generation: 2 } });
    h.acknowledge.mockReset().mockResolvedValue({ episode: { ...episode, state: 'released' } });
    h.codes.mockReset().mockResolvedValue({ generation: 1, current: 'ABCDEFG2', next: 'HIJKLMN3', currentValidUntil: new Date('2026-10-31T13:00:00Z') });
    h.list.mockReset().mockResolvedValue({ episodes: [episode], startEligibility: { allowed: false, reason: 'feature_disabled' } });
    app = new Hono();
    app.route('/devices', networkIsolationRoutes);
  });

  it.each(endpoints)('$name delegates the canonical device and episode with the authenticated actor', async (endpoint) => {
    const res = await request(endpoint);
    expect(res.status).toBe(endpoint.status);
    expect(endpoint.service).toHaveBeenCalledTimes(1);
    const args = endpoint.service.mock.calls[0]!;
    expect(args[0]).toMatchObject({ principal: { kind: 'user_session' }, orgId: ORG });
    expect(args[1]).toBe(DEVICE);
    if (endpoint.name !== 'start' && endpoint.name !== 'list') expect(args[2]).toBe(EPISODE);
    if (endpoint.name === 'start') {
      expect(args[2]).toEqual(startBody);
      expect(args[3]).toMatchObject({ requestedByKind: 'user' });
    }
    if (endpoint.name === 'release') {
      expect(args[3]).toEqual({ reason: 'Remediation complete' });
      expect(args[4]).toMatchObject({ kind: 'console' });
    }
    if (endpoint.name === 'extend') expect(args[3]).toBe(96);
  });

  it('declares devices:execute rather than ordinary device writes', () => {
    expect(declaredPermissionCalls).toContainEqual([PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action]);
  });

  for (const [name, headers, status] of [
    ['unauthenticated', { 'x-no-auth': 'true' }, 401],
    ['without execute permission', { 'x-no-permission': 'true' }, 403],
    ['without MFA', { 'x-no-mfa': 'true' }, 403],
    ['outside permitted scopes', { 'x-scope': 'device' }, 403],
    ['outside permitted sites', { 'x-deny-site': 'true' }, 403],
  ] as const) {
    it.each(endpoints)(`$name refuses ${name} before any service effect`, async (endpoint) => {
      const res = await request(endpoint, headers);
      expect(res.status).toBe(status);
      noEffects();
    });
  }

  it.each(endpoints)('$name refuses API keys even with ENABLE_2FA=false', async (endpoint) => {
    h.twoFactor.enabled = false;
    const res = await request(endpoint, { 'x-principal': 'api_key', 'x-no-mfa': 'true' });
    expect(res.status).toBe(403);
    expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
    noEffects();
  });

  it.each(endpoints)('$name conceals missing and cross-org devices', async (endpoint) => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null);
    expect((await request(endpoint)).status).toBe(404);
    noEffects();
  });

  it.each([
    { reason: 'Missing incident' },
    { ...startBody, ttlHours: 721 },
    { ...startBody, reason: '   ' },
    { ...startBody, allow: [{ kind: 'cidr', cidr: '192.0.2.0/24' }] },
    { ...startBody, createIncident: { title: 'Duplicate binding', severity: 'p1' } },
  ])('rejects invalid start input before service ($reason)', async (body) => {
    expect((await request(endpoints[0], {}, body)).status).toBe(400);
    noEffects();
  });

  it.each([{}, { reason: '' }, { reason: 'x', generation: 4 }])('rejects invalid release input %j', async (body) => {
    expect((await request(endpoints[1], {}, body)).status).toBe(400);
    noEffects();
  });

  it.each([{}, { ttlHours: 0 }, { ttlHours: 721 }, { ttlHours: 2.5 }])('rejects invalid extend input %j', async (body) => {
    expect((await request(endpoints[2], {}, body)).status).toBe(400);
    noEffects();
  });

  it.each(['device.isolation.request', 'device.isolation.release', 'device.isolation.extend'])('audits %s without the secret or code', async (action) => {
    const endpoint = endpoints[action.endsWith('request') ? 0 : action.endsWith('release') ? 1 : action.endsWith('extend') ? 2 : 4]!;
    await request(endpoint);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action, orgId: ORG, resourceType: 'device', resourceId: DEVICE,
    }));
    const serialized = JSON.stringify(vi.mocked(writeRouteAudit).mock.calls.map((call) => call[1]));
    expect(serialized).not.toContain('ABCDEFG2');
    expect(serialized).not.toContain('HIJKLMN3');
    expect(serialized).not.toContain('breakGlassSecret');
  });

  it('passes request context to the service that audits the break-glass view', async () => {
    await request(endpoints[4]);
    expect(h.codes.mock.calls[0]?.[3]).toHaveProperty('req');
  });

  it('returns start eligibility for the release-capable device view while the flag is off', async () => {
    const res = await request(endpoints[5]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ startEligibility: { allowed: false, reason: 'feature_disabled' } });
  });
});
