import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mutable grant set the configurable requirePermission mock reads from. Unlike
// the repo's usual pass-through mock, this one actually consults the set so the
// test faithfully verifies WHICH permission gates WHICH route.
const granted = new Set<string>();
// Mutable permissions object set by requirePermission (mirrors authMiddleware production behaviour).
const permissionsState: { allowedSiteIds?: string[] } = {};

vi.mock('../middleware/auth', () => ({
  authMiddleware: (c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      user: { id: 'u1', email: 't@example.test' },
      orgCondition: () => undefined,
      canAccessSite: () => true,
    });
    return next();
  },
  requireScope: () => (_c: any, next: any) => next(),
  requireMfa: () => (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => (c: any, next: any) => {
    if (granted.has(`${resource}:${action}`) || granted.has('*:*')) {
      // Mirror prod: requirePermission populates the `permissions` context variable.
      c.set('permissions', { ...permissionsState });
      return next();
    }
    return c.json({ error: 'Forbidden' }, 403);
  },
}));

// db.select(...).from(...).where(...).limit(...) resolves to [] so any handler
// that survives the gate hits "not found" (404) — proving the gate ALLOWED.
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceVulnerabilities: { id: 'dv.id', orgId: 'dv.orgId', deviceId: 'dv.deviceId', status: 'dv.status' },
  devices: { id: 'd.id', orgId: 'd.orgId', siteId: 'd.siteId' },
  vulnerabilities: {},
}));

vi.mock('../services/vulnerabilityRemediation', () => ({
  remediateVulnerabilities: vi.fn(async () => ({ scheduled: 0, skipped: [] })),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../middleware/platformAdmin', () => ({ platformAdminMiddleware: (_c: any, next: any) => next() }));
vi.mock('../middleware/userRateLimit', () => ({ userRateLimit: () => (_c: any, next: any) => next() }));
vi.mock('../jobs/vulnerabilityJobs', () => ({ enqueueVulnSourceSync: vi.fn(async () => 'job-1') }));

import { vulnerabilityRoutes } from './vulnerabilities';

const ID = '11111111-1111-1111-8111-111111111111';

function app() {
  const a = new Hono();
  a.route('/vulnerabilities', vulnerabilityRoutes);
  return a;
}

async function post(path: string, body: unknown) {
  return app().request(`/vulnerabilities${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const future = new Date(Date.now() + 7 * 864e5).toISOString();

beforeEach(() => {
  granted.clear();
  // Reset site-restriction state (unrestricted by default).
  delete permissionsState.allowedSiteIds;
  // Reaching any route requires the router-level devices:read gate.
  granted.add('devices:read');
});

describe('vulnerability accept-risk / reopen RBAC', () => {
  it('403s accept-risk for a devices:write caller without vulnerabilities:accept_risk', async () => {
    granted.add('devices:write');
    const res = await post(`/${ID}/accept-risk`, { reason: 'x', acceptedUntil: future });
    expect(res.status).toBe(403);
  });

  it('allows accept-risk past the gate for a vulnerabilities:accept_risk holder (404 on empty db)', async () => {
    granted.add('vulnerabilities:accept_risk');
    const res = await post(`/${ID}/accept-risk`, { reason: 'x', acceptedUntil: future });
    expect(res.status).toBe(404); // passed the gate, finding not found
  });

  it('403s reopen for a devices:write caller without vulnerabilities:accept_risk', async () => {
    granted.add('devices:write');
    const res = await post(`/${ID}/reopen`, {});
    expect(res.status).toBe(403);
  });

  it('allows reopen past the gate for a vulnerabilities:accept_risk holder (404 on empty db)', async () => {
    granted.add('vulnerabilities:accept_risk');
    const res = await post(`/${ID}/reopen`, {});
    expect(res.status).toBe(404);
  });

  it('keeps mitigate on devices:write (passes the gate, 404 on empty db)', async () => {
    granted.add('devices:write');
    const res = await post(`/${ID}/mitigate`, { note: 'compensating control' });
    expect(res.status).toBe(404);
  });
});

import { db } from '../db';

describe('vulnerability fleet GET / — site-axis narrowing', () => {
  function fleetApp() {
    const a = new Hono();
    a.route('/vulnerabilities', vulnerabilityRoutes);
    return a;
  }

  beforeEach(() => {
    granted.clear();
    delete permissionsState.allowedSiteIds;
    granted.add('devices:read');
    vi.mocked(db.select).mockReset();
  });

  it('returns empty fleet for site-restricted caller with empty allowedSiteIds (fail-closed)', async () => {
    permissionsState.allowedSiteIds = [];
    // listVulnerabilities short-circuits before querying when allowedSiteIds is empty.
    const res = await fleetApp().request('/vulnerabilities');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    // db.select should not have been called (early return path).
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('queries allowed device ids by site then filters deviceVulnerabilities for a site-restricted caller', async () => {
    permissionsState.allowedSiteIds = ['site-1'];
    const selectMock = vi.mocked(db.select);

    // First call: resolve device IDs in the allowed site.
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'dev-abc' }]),
      }),
    } as never);
    // Second call: query deviceVulnerabilities (returns empty → no findings).
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const res = await fleetApp().request('/vulnerabilities');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    // Both the device-id resolution query and the vulnerabilities query were issued.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('skips site narrowing for unrestricted caller (no allowedSiteIds)', async () => {
    // No allowedSiteIds set → no device-id resolution query.
    const selectMock = vi.mocked(db.select);
    // Only one select: deviceVulnerabilities (no site device-id lookup).
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const res = await fleetApp().request('/vulnerabilities');
    expect(res.status).toBe(200);
    // Only one db.select call: the deviceVulnerabilities query, no site-device lookup.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
