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
vi.mock('../services/vulnerabilityFleetQueries', () => ({
  fetchFleetFindingRows: vi.fn(async () => []),
  fetchCveCatalogRecord: vi.fn(async () => null),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../middleware/platformAdmin', () => ({ platformAdminMiddleware: (_c: any, next: any) => next() }));
vi.mock('../middleware/userRateLimit', () => ({ userRateLimit: () => (_c: any, next: any) => next() }));
vi.mock('../jobs/vulnerabilityJobs', () => ({
  enqueueVulnSourceSync: vi.fn(async () => 'job-1'),
  enqueueVulnCorrelation: vi.fn(async () => 'job-2'),
}));

import { vulnerabilityRoutes, vulnerabilitySyncRoutes } from './vulnerabilities';
import { fetchFleetFindingRows, fetchCveCatalogRecord } from '../services/vulnerabilityFleetQueries';
import type { FleetFindingRow } from '../services/vulnerabilityFleetAggregation';

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

function fleetRow(overrides: Partial<FleetFindingRow> = {}): FleetFindingRow {
  return {
    deviceVulnerabilityId: 'dv-1',
    deviceId: 'dev-1',
    orgId: 'org-1',
    status: 'open',
    riskScore: 75,
    detectedAt: '2026-06-01T00:00:00.000Z',
    acceptedUntil: null,
    ticketId: null,
    softwareInventoryId: 'sw-1',
    softwareName: 'Google Chrome',
    softwareVendor: 'Google LLC',
    softwareVersion: '126.0.1',
    deviceName: 'WS-01',
    deviceOsType: 'windows',
    orgName: 'Acme',
    cveId: 'CVE-2026-0001',
    vulnerabilityId: 'v-1',
    severity: 'critical',
    cvssScore: 9.1,
    epssScore: 0.4,
    knownExploited: true,
    patchAvailable: true,
    ...overrides,
  };
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

import { enqueueVulnCorrelation } from '../jobs/vulnerabilityJobs';
import { writeRouteAudit } from '../services/auditEvents';

describe('POST /vulnerabilities/sync/correlate (admin manual trigger)', () => {
  function syncApp() {
    const a = new Hono();
    // Mounted deeper than the main router, exactly as in index.ts.
    a.route('/vulnerabilities/sync', vulnerabilitySyncRoutes);
    return a;
  }

  beforeEach(() => {
    vi.mocked(enqueueVulnCorrelation).mockClear();
    vi.mocked(writeRouteAudit).mockClear();
  });

  it('enqueues a correlation job and writes the manual_correlate audit', async () => {
    const res = await syncApp().request('/vulnerabilities/sync/correlate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enqueued: true, jobId: 'job-2' });
    expect(vi.mocked(enqueueVulnCorrelation)).toHaveBeenCalledTimes(1);
    // The audit action string is load-bearing (forensic trail) — assert it exactly.
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'vulnerability.manual_correlate', resourceType: 'vulnerability_source' }),
    );
  });
});

describe('GET /vulnerabilities/software (fleet work queue)', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('403s without devices:read', async () => {
    granted.clear();
    const res = await app().request('/vulnerabilities/software');
    expect(res.status).toBe(403);
  });

  it('groups findings and returns items + hasMore', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', deviceId: 'dev-2', softwareName: 'google chrome ' }),
    ]);
    const res = await app().request('/vulnerabilities/software');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      groupKey: 'sw:google chrome|google llc',
      kind: 'software',
      deviceCount: 2,
    });
  });

  it('passes status through and forwards allowedSiteIds from the permissions context', async () => {
    permissionsState.allowedSiteIds = ['site-1'];
    const res = await app().request('/vulnerabilities/software?status=accepted');
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith({
      status: 'accepted',
      allowedSiteIds: ['site-1'],
    });
  });

  it('applies severity/kevOnly/patchAvailable/search filters', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', softwareName: 'Zoom', softwareVendor: 'Zoom', severity: 'low', knownExploited: false, patchAvailable: false, cveId: 'CVE-2026-2' }),
    ]);
    const res = await app().request('/vulnerabilities/software?severity=critical&kevOnly=true&patchAvailable=true&search=chrome');
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('Google Chrome');
  });

  it('400s on an invalid boolean param', async () => {
    const res = await app().request('/vulnerabilities/software?kevOnly=yes');
    expect(res.status).toBe(400);
  });
});

describe('GET /vulnerabilities/stats', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('403s without devices:read', async () => {
    granted.clear();
    const res = await app().request('/vulnerabilities/stats');
    expect(res.status).toBe(403);
  });

  it('fetches ALL statuses and returns the four stat numbers', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(), // open critical KEV patch-ready
      fleetRow({ deviceVulnerabilityId: 'dv-2', status: 'accepted', acceptedUntil: new Date(Date.now() + 5 * 864e5).toISOString() }),
    ]);
    const res = await app().request('/vulnerabilities/stats');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all' }),
    );
    expect(body).toEqual({
      criticalOpen: 1,
      kevCveCount: 1,
      kevDeviceCount: 1,
      patchReadyFindingCount: 1,
      acceptedExpiringSoon: 1,
    });
  });
});
