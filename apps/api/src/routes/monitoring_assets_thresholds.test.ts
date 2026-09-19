import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  deviceSoftware: {},
  deviceChangeLog: {},
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
  },
  networkMonitors: { assetId: 'networkMonitors.assetId', orgId: 'networkMonitors.orgId', isActive: 'networkMonitors.isActive' },
  snmpDevices: { id: 'snmpDevices.id', orgId: 'snmpDevices.orgId', assetId: 'snmpDevices.assetId' },
  snmpMetrics: {},
  snmpTemplates: { id: 'snmpTemplates.id' },
  snmpAlertThresholds: {
    id: 'snmpAlertThresholds.id',
    deviceId: 'snmpAlertThresholds.deviceId',
    oid: 'snmpAlertThresholds.oid',
    operator: 'snmpAlertThresholds.operator',
    threshold: 'snmpAlertThresholds.threshold',
    severity: 'snmpAlertThresholds.severity',
    message: 'snmpAlertThresholds.message',
    isActive: 'snmpAlertThresholds.isActive',
  },
  serviceProcessCheckResults: {},
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const siteHeader = c.req.header('x-restrict-site');
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    if (siteHeader) {
      c.set('permissions', { allowedSiteIds: siteHeader === '__empty__' ? [] : siteHeader.split(',') });
    }
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn(() => true) }));

import { monitoringRoutes } from './monitoring';
import { db } from '../db';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_HIDDEN = 'bbbbbbbb-0000-0000-0000-000000000002';
const THRESHOLD_ID = '44444444-4444-4444-4444-444444444444';

/** `db.select().from().where().limit()` — the asset lookup. */
function mockAssetLookup(rows: unknown[]) {
  const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where }),
  } as any);
  return where;
}

/** `db.select().from().innerJoin().where()` — the thresholds join. */
function mockThresholdQuery(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where }),
    }),
  } as any);
  return where;
}

const request = (headers: Record<string, string> = {}) =>
  monitoringApp().request(`/monitoring/assets/${ASSET_ID}/thresholds`, {
    headers: { Authorization: 'Bearer token', ...headers },
  });

let app: Hono;
function monitoringApp() {
  return app;
}

describe('GET /monitoring/assets/:id/thresholds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    app = new Hono();
    app.route('/monitoring', monitoringRoutes);
  });

  it('returns the thresholds armed on the asset’s SNMP device', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED }]);
    mockThresholdQuery([
      {
        id: THRESHOLD_ID,
        oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
        operator: 'lt',
        threshold: '10',
        severity: 'high',
        message: 'Toner low',
        isActive: true,
      },
    ]);

    const res = await request();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: THRESHOLD_ID,
      oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
      operator: 'lt',
      threshold: '10',
      severity: 'high',
      message: 'Toner low',
      isActive: true,
    });
  });

  it('scopes both the asset lookup and joined SNMP thresholds to the caller’s org', async () => {
    const assetWhere = mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED }]);
    const thresholdsWhere = mockThresholdQuery([]);

    const res = await request();

    expect(res.status).toBe(200);
    const assetPredicate = JSON.stringify(assetWhere.mock.calls[0]?.[0]);
    expect(assetPredicate).toContain('discoveredAssets.orgId');
    expect(assetPredicate).toContain(ORG_ID);
    const thresholdsPredicate = JSON.stringify(thresholdsWhere.mock.calls[0]?.[0]);
    expect(thresholdsPredicate).toContain('snmpDevices.orgId');
    expect(thresholdsPredicate).toContain(ORG_ID);
  });

  it('returns an empty list when the asset has no SNMP device', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED }]);
    mockThresholdQuery([]);

    const res = await request();

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('404s for an asset outside the caller’s org', async () => {
    // The org predicate is part of the WHERE, so a cross-org asset returns no row.
    mockAssetLookup([]);

    const res = await request();

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Asset not found');
    // The thresholds query must never run for an asset we could not resolve.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('404s (opaque, matching a missing asset) when the caller has no access to the asset’s site (#5777)', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_HIDDEN }]);

    const res = await request({ 'x-restrict-site': SITE_ALLOWED });

    // Must be byte-identical to the "asset outside the caller's org" 404
    // above — an out-of-ceiling asset must not be distinguishable from a
    // missing one (existence oracle, #5777).
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Asset not found');
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('404s (opaque) for a site-restricted caller when the asset has no site at all (#5777)', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: null }]);

    const res = await request({ 'x-restrict-site': SITE_ALLOWED });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Asset not found');
  });
});
