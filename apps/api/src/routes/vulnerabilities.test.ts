import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mutable grant set the configurable requirePermission mock reads from. Unlike
// the repo's usual pass-through mock, this one actually consults the set so the
// test faithfully verifies WHICH permission gates WHICH route.
const granted = new Set<string>();
// Mutable permissions object set by requirePermission (mirrors authMiddleware production behaviour).
const permissionsState: { allowedSiteIds?: string[] } = {};
// Rows returned by the db mock's `.orderBy(...)` terminal (GET /sync/status).
const vulnSourceRows: Array<Record<string, unknown>> = [];

vi.mock('../middleware/auth', () => ({
  authMiddleware: (c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      user: { id: 'u1', email: 't@example.test' },
      orgCondition: () => undefined,
      canAccessSite: () => true,
      // Denies both the legacy 'org-denied' marker (bulk-route row orgIds) and
      // the uuid-shaped DENIED_ORG used by the ?orgId= query-narrowing tests.
      canAccessOrg: (id: string) => id !== 'org-denied' && id !== 'de000000-0000-4000-8000-00000000dead',
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
        orderBy: vi.fn(() => Promise.resolve(vulnSourceRows)),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceVulnerabilities: { id: 'dv.id', orgId: 'dv.orgId', deviceId: 'dv.deviceId', status: 'dv.status', acceptedUntil: 'dv.acceptedUntil' },
  devices: { id: 'd.id', orgId: 'd.orgId', siteId: 'd.siteId' },
  vulnerabilities: {},
  vulnerabilitySources: {
    source: 'vs.source',
    lastSuccessfulSyncAt: 'vs.lastSuccessfulSyncAt',
    lastSyncStatus: 'vs.lastSyncStatus',
    lastSyncError: 'vs.lastSyncError',
    lastSyncSkippedCount: 'vs.lastSyncSkippedCount',
    cursor: 'vs.cursor',
    updatedAt: 'vs.updatedAt',
  },
}));

vi.mock('../services/vulnerabilityRemediation', () => ({
  remediateVulnerabilities: vi.fn(async () => ({ scheduled: 0, skipped: [] })),
}));
vi.mock('../services/vulnerabilityFleetQueries', () => ({
  fetchFleetFindingRows: vi.fn(async () => []),
  fetchCveCatalogRecord: vi.fn(async () => null),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../services/ticketService')>('../services/ticketService');
  return { ...actual, createTicket: vi.fn() };
});
vi.mock('../middleware/platformAdmin', () => ({ platformAdminMiddleware: (_c: any, next: any) => next() }));
vi.mock('../middleware/userRateLimit', () => ({ userRateLimit: () => (_c: any, next: any) => next() }));
vi.mock('../jobs/vulnerabilityJobs', () => ({
  enqueueVulnSourceSync: vi.fn(async () => 'job-1'),
  enqueueVulnCorrelation: vi.fn(async () => 'job-2'),
}));

import { vulnerabilityRoutes, vulnerabilitySyncRoutes } from './vulnerabilities';
import { fetchFleetFindingRows, fetchCveCatalogRecord } from '../services/vulnerabilityFleetQueries';
import type { FleetFindingRow } from '../services/vulnerabilityFleetAggregation';
import { createTicket, TicketServiceError } from '../services/ticketService';

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
    ticketNumber: null,
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

// Org-selector narrowing (?orgId= auto-injected by the web client): one org the
// mocked auth can access, one it denies (must match the canAccessOrg mock above).
const ORG_OK = '11111111-2222-3333-8444-555555555555';
const ORG_DENIED = 'de000000-0000-4000-8000-00000000dead';

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

describe('GET /vulnerabilities — kevOnly/patchAvailable params', () => {
  beforeEach(() => {
    granted.clear();
    delete permissionsState.allowedSiteIds;
    granted.add('devices:read');
    vi.mocked(db.select).mockReset();
  });

  it('accepts kevOnly/patchAvailable and still 200s', async () => {
    // db.select falls back to the default mock chain (resolves []), so an
    // empty fleet is fine — this asserts schema acceptance, not data flow.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as never);
    const res = await app().request('/vulnerabilities?kevOnly=true&patchAvailable=false');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    // Fleet list mirrors /software's truncation contract: items + hasMore.
    expect(body.hasMore).toBe(false);
  });

  it('400s on malformed boolean params', async () => {
    const res = await app().request('/vulnerabilities?kevOnly=1');
    expect(res.status).toBe(400);
  });

  it('accepts expiringWithinDays and rejects out-of-range / non-numeric values', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    } as never);
    const ok = await app().request('/vulnerabilities?status=accepted&expiringWithinDays=14');
    expect(ok.status).toBe(200);
    expect((await app().request('/vulnerabilities?expiringWithinDays=abc')).status).toBe(400);
    expect((await app().request('/vulnerabilities?expiringWithinDays=0')).status).toBe(400);
    expect((await app().request('/vulnerabilities?expiringWithinDays=366')).status).toBe(400);
  });

  it('accepts an accessible orgId (org-selector narrowing) and 403s a denied one', async () => {
    const where = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where }),
    } as never);
    const ok = await app().request(`/vulnerabilities?orgId=${ORG_OK}`);
    expect(ok.status).toBe(200);
    // The orgId must reach the WHERE clause — a bare 200 stays green even with
    // the eq(org_id) narrowing deleted (this route forwards via {...query}
    // spread, so nothing else pins the wiring).
    expect(JSON.stringify(where.mock.calls[0]?.[0])).toContain(ORG_OK);
    expect((await app().request(`/vulnerabilities?orgId=${ORG_DENIED}`)).status).toBe(403);
    expect((await app().request('/vulnerabilities?orgId=acme')).status).toBe(400);
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

describe('GET /vulnerabilities/sync/status (admin sync health, #2427)', () => {
  function syncApp() {
    const a = new Hono();
    a.route('/vulnerabilities/sync', vulnerabilitySyncRoutes);
    return a;
  }

  // Columns the handler asked for, captured from the real `.select({...})` call.
  let projection: string[] = [];

  beforeEach(() => {
    vulnSourceRows.length = 0;
    projection = [];
    // Earlier describes mockReset/mockReturnValue the shared db.select — install
    // our own chain (with the orderBy terminal this route uses).
    //
    // Crucially this mock HONORS the projection: it returns only the columns the
    // route actually selected. A mock that ignores `.select({...})` and echoes a
    // canned row would pass even if the route never selected the new column at
    // all — i.e. it would test the mock, not the code (that vacuous version of
    // this test survived deleting lastSyncSkippedCount from the route).
    vi.mocked(db.select).mockReset();
    vi.mocked(db.select).mockImplementation(((cols: Record<string, unknown>) => {
      projection = Object.keys(cols ?? {});
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
          orderBy: vi.fn(() =>
            Promise.resolve(
              vulnSourceRows.map((row) =>
                Object.fromEntries(projection.map((key) => [key, row[key]])),
              ),
            ),
          ),
        })),
      };
    }) as any);
  });

  it('selects lastSyncSkippedCount from vulnerability_sources', async () => {
    await syncApp().request('/vulnerabilities/sync/status');
    // Pins the projection itself: without this, dropping the column from the
    // route's select() still returns 200 and the shape assertions below pass.
    expect(projection).toContain('lastSyncSkippedCount');
  });

  it('returns per-source sync health including lastSyncSkippedCount', async () => {
    vulnSourceRows.push({
      source: 'msrc',
      lastSuccessfulSyncAt: '2026-07-13T09:00:00.000Z',
      lastSyncStatus: 'ok',
      lastSyncError: null,
      lastSyncSkippedCount: 3,
      cursor: '2026-Jul',
      updatedAt: '2026-07-13T09:00:00.000Z',
    });

    const res = await syncApp().request('/vulnerabilities/sync/status');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({
      source: 'msrc',
      lastSyncStatus: 'ok',
      lastSyncSkippedCount: 3,
    });
  });

  it('reads vulnerability_sources under a system db context (forced RLS, no tenant policies)', async () => {
    const { runOutsideDbContext, withSystemDbAccessContext } = await import('../db');
    vi.mocked(runOutsideDbContext).mockClear();
    vi.mocked(withSystemDbAccessContext).mockClear();

    const res = await syncApp().request('/vulnerabilities/sync/status');

    expect(res.status).toBe(200);
    expect(vi.mocked(runOutsideDbContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withSystemDbAccessContext)).toHaveBeenCalledTimes(1);
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

  it('applies the expiringWithinDays window to accepted findings', async () => {
    const soon = new Date(Date.now() + 5 * 864e5).toISOString();
    const far = new Date(Date.now() + 60 * 864e5).toISOString();
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow({ deviceVulnerabilityId: 'dv-soon', status: 'accepted', acceptedUntil: soon }),
      fleetRow({ deviceVulnerabilityId: 'dv-far', deviceId: 'dev-2', status: 'accepted', acceptedUntil: far }),
    ]);
    const res = await app().request('/vulnerabilities/software?status=accepted&expiringWithinDays=14');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the finding expiring inside the window survives; the group counts reflect that.
    expect(body.items).toHaveLength(1);
    expect(body.items[0].deviceCount).toBe(1);
  });

  it('400s on a non-numeric expiringWithinDays', async () => {
    const res = await app().request('/vulnerabilities/software?expiringWithinDays=soon');
    expect(res.status).toBe(400);
  });

  it('forwards orgId (web org selector) into the fleet query', async () => {
    const res = await app().request(`/vulnerabilities/software?orgId=${ORG_OK}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_OK }),
    );
  });

  it('403s an orgId outside the caller accessible set', async () => {
    const res = await app().request(`/vulnerabilities/software?orgId=${ORG_DENIED}`);
    expect(res.status).toBe(403);
    expect(vi.mocked(fetchFleetFindingRows)).not.toHaveBeenCalled();
  });

  it('400s a non-uuid orgId', async () => {
    const res = await app().request('/vulnerabilities/software?orgId=acme');
    expect(res.status).toBe(400);
  });
});

describe('GET /vulnerabilities/software/:groupKey (drawer payload)', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('404s for an unknown group', async () => {
    const res = await app().request(`/vulnerabilities/software/${encodeURIComponent('sw:nope|')}`);
    expect(res.status).toBe(404);
  });

  it('400s on a key without the sw:/os: prefix', async () => {
    const res = await app().request('/vulnerabilities/software/garbage');
    expect(res.status).toBe(400);
  });

  it('returns group + cves + findings for a URL-encoded key, across ALL statuses', async () => {
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', deviceId: 'dev-2', status: 'accepted', cveId: 'CVE-2026-0002', vulnerabilityId: 'v-2' }),
    ]);
    const res = await app().request(`/vulnerabilities/software/${encodeURIComponent('sw:google chrome|google llc')}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all' }),
    );
    const body = await res.json();
    expect(body.group.groupKey).toBe('sw:google chrome|google llc');
    expect(body.cves).toHaveLength(2);
    expect(body.findings).toHaveLength(2);
    expect(body.findings[0]).toMatchObject({ deviceVulnerabilityId: expect.any(String), deviceName: expect.any(String) });
  });

  it('forwards orgId and 403s a denied org', async () => {
    const key = encodeURIComponent('sw:google chrome|google llc');
    await app().request(`/vulnerabilities/software/${key}?orgId=${ORG_OK}`);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all', orgId: ORG_OK }),
    );
    const denied = await app().request(`/vulnerabilities/software/${key}?orgId=${ORG_DENIED}`);
    expect(denied.status).toBe(403);
  });
});

describe('GET /vulnerabilities/devices/:deviceId/software', () => {
  beforeEach(() => {
    granted.clear();
    granted.add('devices:read');
    delete permissionsState.allowedSiteIds;
    vi.mocked(db.select).mockReset();
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
  });

  it('groups a device’s findings by software and returns stats + tagged findings', async () => {
    // assertDeviceSiteAccess: device lookup returns a row (site accessible).
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ siteId: 'site-1' }]) }),
      }),
    } as never);
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow({ deviceVulnerabilityId: 'a', deviceId: ID, cveId: 'CVE-1', softwareInventoryId: 'sw1', softwareName: 'Google Chrome', softwareVendor: '', severity: 'critical', patchAvailable: true, status: 'open' }),
      fleetRow({ deviceVulnerabilityId: 'b', deviceId: ID, cveId: 'CVE-2', softwareInventoryId: 'sw1', softwareName: 'Google Chrome', softwareVendor: '', severity: 'medium', patchAvailable: true, knownExploited: false, status: 'open' }),
      fleetRow({ deviceVulnerabilityId: 'c', deviceId: ID, cveId: 'CVE-3', softwareInventoryId: null, deviceOsType: 'windows', severity: 'high', patchAvailable: false, knownExploited: false, status: 'open' }),
    ]);

    const res = await app().request(`/vulnerabilities/devices/${ID}/software?status=open`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(2); // Chrome + Windows OS
    const chrome = body.groups.find((g: any) => g.name === 'Google Chrome');
    expect(chrome.cveCount).toBe(2);
    expect(chrome.patchReadyFindingCount).toBe(2);
    expect(body.stats.openTotal).toBe(3);
    expect(body.stats.critical).toBe(1);
    expect(body.stats.patchReadyFindingCount).toBe(2);
    expect(body.findings.every((f: any) => typeof f.groupKey === 'string')).toBe(true);
    // Documented invariant of this layer: cvssVector is never surfaced here (it's
    // catalog-only detail, not part of the device drill-down shape). Also pin the
    // finding's groupKey to buildGroupKey's Chrome key so a regression in the
    // grouping logic shows up as a targeted assertion, not just a count check.
    const findingA = body.findings.find((f: any) => f.id === 'a');
    expect(findingA.cvssVector).toBeNull();
    expect(findingA.groupKey).toBe('sw:google chrome|');
    // fetchFleetFindingRows was called with the deviceId narrow.
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(expect.objectContaining({ deviceId: ID, status: 'open' }));
  });

  it('404s when the device is not in the caller’s tenant/site scope', async () => {
    // Default db.select mock: .limit() resolves [] → device not found.
    const res = await app().request(`/vulnerabilities/devices/${ID}/software`);
    expect(res.status).toBe(404);
  });

  it('ignores the auto-injected ?orgId= (a stale org selector must not blank a cross-org device tab)', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ siteId: 'site-1' }]) }),
      }),
    } as never);
    const res = await app().request(`/vulnerabilities/devices/${ID}/software?orgId=${ORG_OK}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.not.objectContaining({ orgId: expect.anything() }),
    );
  });
});

describe('GET /vulnerabilities/devices/:deviceId', () => {
  beforeEach(() => {
    granted.clear();
    granted.add('devices:read');
    delete permissionsState.allowedSiteIds;
    vi.mocked(db.select).mockReset();
  });

  // This route spreads the validated query straight into listVulnerabilities
  // ({...query, deviceId}), so it is the one place an orgId added to the shared
  // listQuerySchema would silently narrow a per-device lookup. Pins that zod
  // strips the auto-injected param before the spread — see the schema comment
  // at orgIdQuerySchema.
  it('strips the auto-injected ?orgId= before the {...query} spread', async () => {
    const listWhere = vi.fn().mockResolvedValue([]);
    vi.mocked(db.select)
      // assertDeviceSiteAccess: device lookup (site accessible).
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ siteId: 'site-1' }]) }),
        }),
      } as never)
      // listVulnerabilities: the findings query whose WHERE we inspect.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: listWhere }),
      } as never);
    const res = await app().request(`/vulnerabilities/devices/${ID}?orgId=${ORG_OK}`);
    expect(res.status).toBe(200);
    expect(listWhere).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(listWhere.mock.calls[0]?.[0])).not.toContain(ORG_OK);
  });
});

describe('GET /vulnerabilities/:cveId/devices (CVE drawer payload)', () => {
  beforeEach(() => {
    vi.mocked(fetchFleetFindingRows).mockReset().mockResolvedValue([]);
    vi.mocked(fetchCveCatalogRecord).mockReset().mockResolvedValue(null);
  });

  it('400s on a non-CVE-shaped id', async () => {
    const res = await app().request('/vulnerabilities/not-a-cve/devices');
    expect(res.status).toBe(400);
  });

  it('404s when the CVE is not in the catalog', async () => {
    const res = await app().request('/vulnerabilities/CVE-2026-0001/devices');
    expect(res.status).toBe(404);
  });

  it('returns the catalog record + fleet findings for the CVE (case-insensitive match)', async () => {
    vi.mocked(fetchCveCatalogRecord).mockResolvedValue({
      cveId: 'CVE-2026-0001',
      description: 'Bad bug',
      references: ['https://example.test/advisory'],
      cvssVersion: '3.1',
      cvssVector: 'CVSS:3.1/AV:N',
      cvssScore: 9.1,
      epssScore: 0.4,
      knownExploited: true,
      patchAvailable: true,
      severity: 'critical',
      publishedAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: null,
    });
    vi.mocked(fetchFleetFindingRows).mockResolvedValue([
      fleetRow(),
      fleetRow({ deviceVulnerabilityId: 'dv-2', cveId: 'CVE-2026-9999', vulnerabilityId: 'v-9' }), // other CVE — excluded
    ]);
    const res = await app().request('/vulnerabilities/cve-2026-0001/devices');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cve.cveId).toBe('CVE-2026-0001');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].deviceVulnerabilityId).toBe('dv-1');
  });

  it('forwards orgId into the fleet query and 403s a denied org (before the catalog lookup)', async () => {
    vi.mocked(fetchCveCatalogRecord).mockResolvedValueOnce({
      cveId: 'CVE-2026-0001',
      description: 'Bad bug',
      references: [],
      cvssVersion: '3.1',
      cvssVector: 'CVSS:3.1/AV:N',
      cvssScore: 9.1,
      epssScore: 0.4,
      knownExploited: true,
      patchAvailable: true,
      severity: 'critical',
      publishedAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: null,
    });
    const ok = await app().request(`/vulnerabilities/CVE-2026-0001/devices?orgId=${ORG_OK}`);
    expect(ok.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all', orgId: ORG_OK }),
    );
    const denied = await app().request(`/vulnerabilities/CVE-2026-0001/devices?orgId=${ORG_DENIED}`);
    expect(denied.status).toBe(403);
    // The gate runs BEFORE the catalog lookup: only the allowed request reached it.
    expect(vi.mocked(fetchCveCatalogRecord)).toHaveBeenCalledTimes(1);
  });
});

/**
 * Stub the db.select chain for a bulk-write route.
 *
 * loadFindingsForBulkWrite issues TWO selects (findings, then the site-gate
 * devices lookup). The /tickets route issues TWO MORE after that when it has
 * accessible findings: a device-name lookup (hostname/displayName) and a
 * system-context CVE-id catalog lookup used to build each per-org ticket
 * description server-side. Pass `deviceNameRows`/`cveRows` for /tickets; omit
 * them for accept-risk / mitigate (which only consume the first two).
 */
function mockBulkSelects(
  findingRows: unknown[],
  deviceRows: unknown[],
  deviceNameRows?: unknown[],
  cveRows?: unknown[],
) {
  const selectMock = vi.mocked(db.select);
  selectMock.mockReset();
  const resolveWhere = (rows: unknown[]) =>
    ({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) }) as never;
  selectMock.mockReturnValueOnce(resolveWhere(findingRows));
  selectMock.mockReturnValueOnce(resolveWhere(deviceRows));
  if (deviceNameRows !== undefined) {
    selectMock.mockReturnValueOnce(resolveWhere(deviceNameRows));
  }
  if (cveRows !== undefined) {
    selectMock.mockReturnValueOnce(resolveWhere(cveRows));
  }
}

const DV1 = '11111111-1111-1111-8111-111111111111';
const DV2 = '22222222-2222-2222-8222-222222222222';

describe('POST /vulnerabilities/bulk/accept-risk', () => {
  beforeEach(() => {
    vi.mocked(writeRouteAudit).mockClear();
  });

  it('403s without vulnerabilities:accept_risk', async () => {
    const res = await post('/bulk/accept-risk', { deviceVulnerabilityIds: [DV1], reason: 'x', acceptedUntil: future });
    expect(res.status).toBe(403);
  });

  it('400s on validation failures (empty ids, >200 ids, past acceptedUntil)', async () => {
    granted.add('vulnerabilities:accept_risk');
    expect((await post('/bulk/accept-risk', { deviceVulnerabilityIds: [], reason: 'x', acceptedUntil: future })).status).toBe(400);
    expect((await post('/bulk/accept-risk', {
      deviceVulnerabilityIds: Array.from({ length: 201 }, () => DV1),
      reason: 'x',
      acceptedUntil: future,
    })).status).toBe(400);
    expect((await post('/bulk/accept-risk', {
      deviceVulnerabilityIds: [DV1],
      reason: 'x',
      acceptedUntil: new Date(Date.now() - 864e5).toISOString(),
    })).status).toBe(400);
  });

  it('updates valid findings, skips unknown ids per-item, audits each success', async () => {
    granted.add('vulnerabilities:accept_risk');
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-1', deviceId: 'dev-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
    );
    const res = await post('/bulk/accept-risk', { deviceVulnerabilityIds: [DV1, DV2], reason: 'compensating control', acceptedUntil: future });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      succeeded: 1,
      skipped: [{ id: DV2, reason: 'not_found' }],
    });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'vulnerability.accept_risk', resourceId: DV1 }),
    );
  });

  it('reports success:false when every item is skipped', async () => {
    granted.add('vulnerabilities:accept_risk');
    mockBulkSelects([], []);
    const res = await post('/bulk/accept-risk', { deviceVulnerabilityIds: [DV1], reason: 'x', acceptedUntil: future });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.skipped).toHaveLength(1);
  });
});

describe('POST /vulnerabilities/bulk/mitigate', () => {
  it('403s for a caller without devices:write', async () => {
    const res = await post('/bulk/mitigate', { deviceVulnerabilityIds: [DV1], note: 'firewalled' });
    expect(res.status).toBe(403);
  });

  it('mitigates valid findings with per-item audit', async () => {
    granted.add('devices:write');
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-1', deviceId: 'dev-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
    );
    vi.mocked(writeRouteAudit).mockClear();
    const res = await post('/bulk/mitigate', { deviceVulnerabilityIds: [DV1], note: 'firewalled' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, succeeded: 1, skipped: [] });
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'vulnerability.mitigate', resourceId: DV1 }),
    );
  });

  // Parity with bulk/accept-risk: validation bounds + all-skipped outcome.
  it('400s on validation failures (empty ids, >200 ids)', async () => {
    granted.add('devices:write');
    expect((await post('/bulk/mitigate', { deviceVulnerabilityIds: [], note: 'x' })).status).toBe(400);
    expect((await post('/bulk/mitigate', {
      deviceVulnerabilityIds: Array.from({ length: 201 }, () => DV1),
      note: 'x',
    })).status).toBe(400);
  });

  it('reports success:false when every item is skipped', async () => {
    granted.add('devices:write');
    mockBulkSelects([], []);
    const res = await post('/bulk/mitigate', { deviceVulnerabilityIds: [DV1], note: 'firewalled' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.skipped).toHaveLength(1);
  });
});

import { remediateVulnerabilities } from '../services/vulnerabilityRemediation';

describe('POST /vulnerabilities/remediate — all-skipped surfacing', () => {
  beforeEach(() => {
    vi.mocked(remediateVulnerabilities).mockReset();
  });

  // SF#2: when nothing is scheduled but items were skipped, the route reports
  // success:false AND a `message` naming the distinct skip reasons, so the
  // client shows the real cause instead of a generic failure toast.
  it('returns success:false plus a message when scheduled is 0 and items are skipped', async () => {
    granted.add('devices:execute');
    vi.mocked(remediateVulnerabilities).mockResolvedValue({
      scheduled: 0,
      skipped: [
        { id: DV1, reason: 'no_available_patch' },
        { id: DV2, reason: 'patch_not_approved' },
      ],
    });
    const res = await post('/remediate', { deviceVulnerabilityIds: [DV1, DV2] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.scheduled).toBe(0);
    expect(typeof body.message).toBe('string');
    // Human labels for the distinct skip codes appear in the summary.
    expect(body.message).toContain('no available patch');
    expect(body.message).toContain('patch not approved');
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

  it('fetches ALL statuses and returns the stat numbers plus detection activity', async () => {
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
      totalFindings: 2,
      lastDetectedAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('forwards orgId so the stat cards scope to the selected org', async () => {
    const res = await app().request(`/vulnerabilities/stats?orgId=${ORG_OK}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetchFleetFindingRows)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'all', orgId: ORG_OK }),
    );
  });

  it('403s an orgId outside the caller accessible set', async () => {
    const res = await app().request(`/vulnerabilities/stats?orgId=${ORG_DENIED}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /vulnerabilities/tickets', () => {
  const DV_ORG2 = '33333333-3333-3333-8333-333333333333';

  beforeEach(() => {
    vi.mocked(createTicket).mockReset();
    vi.mocked(writeRouteAudit).mockClear();
  });

  it('403s without tickets:write', async () => {
    const res = await post('/tickets', { deviceVulnerabilityIds: [DV1], title: 'Patch Chrome' });
    expect(res.status).toBe(403);
  });

  it('400s on validation failures (missing title, >200 ids)', async () => {
    granted.add('tickets:write');
    expect((await post('/tickets', { deviceVulnerabilityIds: [DV1] })).status).toBe(400);
    expect((await post('/tickets', {
      deviceVulnerabilityIds: Array.from({ length: 201 }, () => DV1),
      title: 'x',
    })).status).toBe(400);
  });

  it('splits a cross-org selection into one ticket per org and stamps ticket_id', async () => {
    granted.add('tickets:write');
    mockBulkSelects(
      [
        { id: DV1, orgId: 'org-1', deviceId: 'dev-1', vulnerabilityId: 'v-1', status: 'open' },
        { id: DV2, orgId: 'org-1', deviceId: 'dev-1', vulnerabilityId: 'v-1', status: 'open' },
        { id: DV_ORG2, orgId: 'org-2', deviceId: 'dev-2', vulnerabilityId: 'v-2', status: 'open' },
      ],
      [
        { id: 'dev-1', siteId: 'site-1' },
        { id: 'dev-2', siteId: 'site-2' },
      ],
      // device-name lookup + CVE catalog lookup (the two new server-side selects
      // that build each per-org ticket description).
      [
        { id: 'dev-1', hostname: 'host-1', displayName: 'WS-01' },
        { id: 'dev-2', hostname: 'host-2', displayName: 'WS-02' },
      ],
      [
        { id: 'v-1', cveId: 'CVE-2026-0001' },
        { id: 'v-2', cveId: 'CVE-2026-0002' },
      ],
    );
    vi.mocked(createTicket)
      .mockResolvedValueOnce({ id: 't-1' } as never)
      .mockResolvedValueOnce({ id: 't-2' } as never);

    const res = await post('/tickets', {
      deviceVulnerabilityIds: [DV1, DV2, DV_ORG2],
      title: 'Patch Chrome fleet-wide',
      note: 'Coordinate with the affected teams.',
      priority: 'high',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tickets).toEqual([
      { ticketId: 't-1', orgId: 'org-1', findingCount: 2 },
      { ticketId: 't-2', orgId: 'org-2', findingCount: 1 },
    ]);
    expect(vi.mocked(createTicket)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createTicket)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', subject: 'Patch Chrome fleet-wide', priority: 'high', source: 'manual' }),
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'vulnerability.ticket_create', resourceType: 'ticket', resourceId: 't-1' }),
    );
  });

  it('skips findings in an org the caller cannot access', async () => {
    granted.add('tickets:write');
    // The finding passes the org(RLS)+site gate (valid), so the two per-org
    // description selects DO run before the byOrg canAccessOrg check rejects it.
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-denied', deviceId: 'dev-1', vulnerabilityId: 'v-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
      [{ id: 'dev-1', hostname: 'host-1', displayName: 'WS-01' }],
      [{ id: 'v-1', cveId: 'CVE-2026-0001' }],
    );
    const res = await post('/tickets', { deviceVulnerabilityIds: [DV1], title: 'x' });
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.tickets).toEqual([]);
    expect(body.skipped).toEqual([{ id: DV1, reason: 'org_access_denied' }]);
    expect(vi.mocked(createTicket)).not.toHaveBeenCalled();
  });

  it('maps a TicketServiceError into per-item skips (ticket_create_failed) without failing the batch', async () => {
    granted.add('tickets:write');
    mockBulkSelects(
      [{ id: DV1, orgId: 'org-1', deviceId: 'dev-1', vulnerabilityId: 'v-1', status: 'open' }],
      [{ id: 'dev-1', siteId: 'site-1' }],
      [{ id: 'dev-1', hostname: 'host-1', displayName: 'WS-01' }],
      [{ id: 'v-1', cveId: 'CVE-2026-0001' }],
    );
    vi.mocked(createTicket).mockRejectedValue(new TicketServiceError('Organization not found', 404));
    const res = await post('/tickets', { deviceVulnerabilityIds: [DV1], title: 'x' });
    const body = await res.json();
    expect(body.success).toBe(false);
    // Dynamic TicketServiceError prose collapses to the stable skip code.
    expect(body.skipped).toEqual([{ id: DV1, reason: 'ticket_create_failed' }]);
  });

  // C1 REGRESSION GUARD (critical cross-tenant leak fix): the server now builds
  // each per-org ticket's description ITSELF from ONLY that org's rows. Prove
  // org A's description references org A's device/CVE and NEVER org B's, and vice
  // versa — the old client-supplied `description` enumerated every org's data and
  // was passed verbatim into every ticket, leaking hostnames/CVEs across tenants.
  it('C1: per-org ticket description contains only that org\'s device names and CVEs (no cross-tenant leak)', async () => {
    granted.add('tickets:write');
    mockBulkSelects(
      [
        { id: DV1, orgId: 'org-1', deviceId: 'dev-a', vulnerabilityId: 'v-a', status: 'open' },
        { id: DV_ORG2, orgId: 'org-2', deviceId: 'dev-b', vulnerabilityId: 'v-b', status: 'open' },
      ],
      [
        { id: 'dev-a', siteId: 'site-1' },
        { id: 'dev-b', siteId: 'site-2' },
      ],
      [
        { id: 'dev-a', hostname: 'host-a', displayName: 'WS-ALPHA' },
        { id: 'dev-b', hostname: 'host-b', displayName: 'WS-BRAVO' },
      ],
      [
        { id: 'v-a', cveId: 'CVE-2026-AAAA' },
        { id: 'v-b', cveId: 'CVE-2026-BBBB' },
      ],
    );
    vi.mocked(createTicket)
      .mockResolvedValueOnce({ id: 't-a' } as never)
      .mockResolvedValueOnce({ id: 't-b' } as never);

    const res = await post('/tickets', {
      deviceVulnerabilityIds: [DV1, DV_ORG2],
      title: 'Remediate fleet',
    });
    expect(res.status).toBe(200);

    // Map each createTicket call's org to the description the server built for it.
    const descByOrg = new Map<string, string>();
    for (const [payload] of vi.mocked(createTicket).mock.calls) {
      descByOrg.set((payload as { orgId: string }).orgId, (payload as { description: string }).description);
    }

    const orgADesc = descByOrg.get('org-1')!;
    const orgBDesc = descByOrg.get('org-2')!;
    expect(orgADesc).toBeDefined();
    expect(orgBDesc).toBeDefined();

    // Org A's ticket carries ONLY org A's device + CVE.
    expect(orgADesc).toContain('WS-ALPHA');
    expect(orgADesc).toContain('CVE-2026-AAAA');
    expect(orgADesc).not.toContain('WS-BRAVO');
    expect(orgADesc).not.toContain('CVE-2026-BBBB');

    // Org B's ticket carries ONLY org B's device + CVE.
    expect(orgBDesc).toContain('WS-BRAVO');
    expect(orgBDesc).toContain('CVE-2026-BBBB');
    expect(orgBDesc).not.toContain('WS-ALPHA');
    expect(orgBDesc).not.toContain('CVE-2026-AAAA');
  });

  // SF#1: all-skipped /tickets surfaces WHY via a `message` (not a silent
  // success:false). Every id is unknown → not_found; no ticket is created.
  it('SF#1: returns success:false plus a message summarizing skip reasons when nothing is ticketed', async () => {
    granted.add('tickets:write');
    // Empty findings → every id skipped as not_found; the two per-org selects
    // never run (no accessible findings), so only the first select is consumed.
    mockBulkSelects([], []);
    const res = await post('/tickets', { deviceVulnerabilityIds: [DV1, DV2], title: 'x' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.tickets).toEqual([]);
    expect(typeof body.message).toBe('string');
    // Message summarizes the distinct skip reasons using the human label.
    expect(body.message).toContain('finding not found');
  });
});
