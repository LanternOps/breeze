import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const SNMP_DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const TEMPLATE_ID = '55555555-5555-5555-5555-555555555555';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    selectDistinctOn: vi.fn(),
  },
}));

// Field-map mock, house pattern from monitoring_assets_list.test.ts /
// discoveryAssetProbe.test.ts: keeps drizzle's real eq/and/gte/lt/sql building
// conditions over plain strings instead of pulling in the full schema module.
vi.mock('../db/schema', () => ({
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
  },
  snmpDevices: {
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    assetId: 'snmpDevices.assetId',
    templateId: 'snmpDevices.templateId',
    isActive: 'snmpDevices.isActive',
    createdAt: 'snmpDevices.createdAt',
  },
  snmpTemplates: {
    id: 'snmpTemplates.id',
    oids: 'snmpTemplates.oids',
  },
  snmpMetrics: {
    deviceId: 'snmpMetrics.deviceId',
    oid: 'snmpMetrics.oid',
    baseOid: 'snmpMetrics.baseOid',
    instance: 'snmpMetrics.instance',
    name: 'snmpMetrics.name',
    value: 'snmpMetrics.value',
    timestamp: 'snmpMetrics.timestamp',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ?.split(',')
      .map((id: string) => id.trim())
      .filter(Boolean);
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

import { MAX_INSTANCES_PER_OID, monitoringAssetMetricsRoutes } from './monitoringAssetMetrics';
import { db } from '../db';
import { MAX_RANGE_DAYS, MAX_POINTS_PER_SERIES, MAX_SERIES } from '../services/metricBucketing';

/** discoveredAssets lookup / snmpTemplates lookup shape: from().where().limit() */
function limitChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  };
}

/** snmpDevices lookup shape: from().where().orderBy().limit() */
function snmpDeviceChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  };
}

/** snmpMetrics bucketed-rows query shape: from().where().groupBy().orderBy() */
const pointsWhere = vi.fn();
const seriesLimit = vi.fn();

function metricsChain(rows: MetricRow[]) {
  const distinct = Array.from(new Map(rows.map((row) => [
    `${row.baseOid}|${row.instance}`, { baseOid: row.baseOid, instance: row.instance },
  ])).values());
  vi.mocked(db.selectDistinctOn).mockReturnValueOnce({
    from: () => ({ where: () => ({ orderBy: () => ({
      limit: (limit: number) => {
        seriesLimit(limit);
        return Promise.resolve(distinct.slice(0, limit));
      },
    }) }) }),
  } as any);
  return {
    from: () => ({
      where: (condition: SQL) => {
        pointsWhere(condition);
        // Mock schema fields are bound strings too; remove them before
        // matching the adjacent base-OID / instance parameter pairs.
        const params = new PgDialect().sqlToQuery(condition).params.filter(
          (value) => typeof value !== 'string' || !value.startsWith('snmpMetrics.'),
        );
        const retainedRows = rows.filter((row) => params.some((value, index) =>
          value === row.baseOid && params[index + 1] === row.instance));
        return {
          groupBy: () => ({ orderBy: () => Promise.resolve(retainedRows) }),
        };
      },
    }),
  };
}

type MetricRow = {
  baseOid: string;
  oid: string;
  instance: string;
  name: string;
  bucket: string;
  avgValue: string;
  maxValue: string;
};

function metricRow(overrides: Partial<MetricRow> & Pick<MetricRow, 'oid' | 'bucket' | 'avgValue' | 'maxValue'>): MetricRow {
  return {
    baseOid: overrides.oid,
    instance: '',
    name: 'metric',
    ...overrides,
  };
}

const assetRow = (overrides: Record<string, unknown> = {}) => ({
  id: ASSET_ID,
  orgId: ORG_ID,
  siteId: SITE_ALLOWED,
  ...overrides,
});

const snmpDeviceRow = (overrides: Record<string, unknown> = {}) => ({
  id: SNMP_DEVICE_ID,
  templateId: null,
  ...overrides,
});

describe('GET /monitoring/assets/:id/metrics', () => {
  let app: Hono;

  beforeEach(() => {
    vi.resetAllMocks();
    app = new Hono();
    app.route('/monitoring', monitoringAssetMetricsRoutes);
  });

  const get = (query: string, headers: Record<string, string> = {}) =>
    app.request(`/monitoring/assets/${ASSET_ID}/metrics${query}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token', ...headers },
    });

  it('returns 404 for an asset in another org', async () => {
    // Organization-scope auth filters the asset lookup's WHERE by auth.orgId,
    // so a cross-tenant asset id never matches — simulate that at the mock
    // boundary with zero rows, exactly what that WHERE clause would produce.
    vi.mocked(db.select).mockReturnValueOnce(limitChain([]) as any);

    const res = await get('?oid=1.3.6.1.2.1.1.1.0');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Asset not found');
  });

  it("returns 403 for a site-restricted caller outside the asset's site", async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow({ siteId: SITE_DENIED })]) as any);

    const res = await get('?oid=1.3.6.1.2.1.1.1.0', { 'x-restrict-site': SITE_ALLOWED });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Access to this site denied');
  });

  it('returns 404 when the asset has no SNMP device', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(snmpDeviceChain([]) as any);

    const res = await get('?oid=1.3.6.1.2.1.1.1.0');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('This asset has no SNMP device');
  });

  it('returns 400 naming the range cap for a 91-day range', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);

    const fromMs = Date.parse('2026-01-01T00:00:00.000Z');
    const toMs = fromMs + (MAX_RANGE_DAYS + 1) * 86_400_000;
    const res = await get(
      `?oid=1.3.6.1.2.1.1.1.0&from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}`,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(`Requested range exceeds the ${MAX_RANGE_DAYS}-day cap`);
  });

  it('returns 400 naming the point cap for bucket=1m over 30 days', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);

    const fromMs = Date.parse('2026-01-01T00:00:00.000Z');
    const toMs = fromMs + 30 * 86_400_000;
    const expectedPoints = Math.ceil((toMs - fromMs) / 1000 / 60);
    const res = await get(
      `?oid=1.3.6.1.2.1.1.1.0&from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}&bucket=1m`,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      `Bucket 1m over this range yields ${expectedPoints} points, above the ${MAX_POINTS_PER_SERIES}-point cap; widen the bucket or shorten the range`,
    );
  });

  it('returns 400 when more than the OID cap is requested', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);

    const tooManyOids = Array.from({ length: MAX_SERIES + 1 }, (_, i) => `1.3.6.1.2.1.${i}`).join(',');
    const res = await get(`?oid=${tooManyOids}`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(`At most ${MAX_SERIES} OIDs may be requested at once`);
  });

  it('groups rows into one series per (oid, instance) with [ts, value] points', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(snmpDeviceChain([snmpDeviceRow()]) as any);
    // No templateId -> no template lookup query; only avg (gauge default) is used.
    vi.mocked(db.select).mockReturnValueOnce(metricsChain([
      metricRow({
        oid: '1.3.6.1.2.1.2.2.1.10.1', baseOid: '1.3.6.1.2.1.2.2.1.10', instance: '1',
        bucket: '2026-09-15T10:00:00.000Z', avgValue: '100', maxValue: '100',
      }),
      metricRow({
        oid: '1.3.6.1.2.1.2.2.1.10.1', baseOid: '1.3.6.1.2.1.2.2.1.10', instance: '1',
        bucket: '2026-09-15T10:05:00.000Z', avgValue: '150', maxValue: '150',
      }),
      metricRow({
        oid: '1.3.6.1.2.1.2.2.1.10.2', baseOid: '1.3.6.1.2.1.2.2.1.10', instance: '2',
        bucket: '2026-09-15T10:00:00.000Z', avgValue: '300', maxValue: '300',
      }),
    ]) as any);

    const res = await get('?oid=1.3.6.1.2.1.2.2.1.10');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.series).toHaveLength(2);
    expect(body.truncatedSeries).toBe(false);

    const port1 = body.series.find((s: any) => s.instance === '1');
    const port2 = body.series.find((s: any) => s.instance === '2');
    expect(port1.oid).toBe('1.3.6.1.2.1.2.2.1.10.1');
    expect(port1.points).toEqual([
      ['2026-09-15T10:00:00.000Z', 100],
      ['2026-09-15T10:05:00.000Z', 150],
    ]);
    expect(port2.oid).toBe('1.3.6.1.2.1.2.2.1.10.2');
    expect(port2.points).toEqual([['2026-09-15T10:00:00.000Z', 300]]);
  });

  it('uses max for a counter template entry and avg for a gauge', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(snmpDeviceChain([snmpDeviceRow({ templateId: TEMPLATE_ID })]) as any);
    vi.mocked(db.select).mockReturnValueOnce(limitChain([{
      oids: [
        { oid: '1.3.6.1.2.1.2.2.1.10', type: 'Counter32' },
        { oid: '1.3.6.1.4.1.9999.1.1', type: 'Gauge32' },
      ],
    }]) as any);
    vi.mocked(db.select).mockReturnValueOnce(metricsChain([
      metricRow({
        oid: '1.3.6.1.2.1.2.2.1.10', bucket: '2026-09-15T10:00:00.000Z',
        avgValue: '120.5', maxValue: '300',
      }),
      metricRow({
        oid: '1.3.6.1.4.1.9999.1.1', bucket: '2026-09-15T10:00:00.000Z',
        avgValue: '42.5', maxValue: '55',
      }),
    ]) as any);

    const res = await get('?oid=1.3.6.1.2.1.2.2.1.10,1.3.6.1.4.1.9999.1.1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.series).toHaveLength(2);
    expect(body.truncatedSeries).toBe(false);

    const counterSeries = body.series.find((s: any) => s.oid === '1.3.6.1.2.1.2.2.1.10');
    const gaugeSeries = body.series.find((s: any) => s.oid === '1.3.6.1.4.1.9999.1.1');
    // Counter: max (300), NOT avg (120.5) — averaging a monotonically climbing
    // counter across a bucket would invent a value that never existed.
    expect(counterSeries.points).toEqual([['2026-09-15T10:00:00.000Z', 300]]);
    // Gauge: avg (42.5), NOT max (55).
    expect(gaugeSeries.points).toEqual([['2026-09-15T10:00:00.000Z', 42.5]]);
  });

  it('returns reset-aware deltas when delta=1', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(snmpDeviceChain([snmpDeviceRow({ templateId: TEMPLATE_ID })]) as any);
    vi.mocked(db.select).mockReturnValueOnce(limitChain([{
      oids: [{ oid: '1.3.6.1.2.1.2.2.1.10', type: 'Counter32' }],
    }]) as any);
    vi.mocked(db.select).mockReturnValueOnce(metricsChain([
      metricRow({ oid: '1.3.6.1.2.1.2.2.1.10', bucket: '2026-09-15T10:00:00.000Z', avgValue: '990', maxValue: '1000' }),
      metricRow({ oid: '1.3.6.1.2.1.2.2.1.10', bucket: '2026-09-15T10:05:00.000Z', avgValue: '1490', maxValue: '1500' }),
      // Device rebooted / counter wrapped between the 2nd and 3rd bucket:
      // the raw counter value DROPS from 1500 to 200.
      metricRow({ oid: '1.3.6.1.2.1.2.2.1.10', bucket: '2026-09-15T10:10:00.000Z', avgValue: '190', maxValue: '200' }),
    ]) as any);

    const res = await get('?oid=1.3.6.1.2.1.2.2.1.10&delta=1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.series).toHaveLength(1);
    // Pre-delta max-aggregated points would be [1000, 1500, 200]. Reset-aware
    // deltas: 1500-1000=500 (normal), then 200 < 1500 (reset) so the new raw
    // value itself (200) is taken as the delta, not a negative number. The
    // first raw point is consumed as the baseline and never emitted.
    expect(body.series[0].points).toEqual([
      ['2026-09-15T10:05:00.000Z', 500],
      ['2026-09-15T10:10:00.000Z', 200],
    ]);
  });

  it.each([0, MAX_INSTANCES_PER_OID, MAX_INSTANCES_PER_OID + 10])(
    'bounds the points query for %i instances and reports truncation', async (count) => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(snmpDeviceChain([snmpDeviceRow()]) as any);
    const rows = Array.from({ length: count }, (_, i) =>
      metricRow({
        oid: `1.3.6.1.2.1.2.2.1.10.${i + 1}`,
        baseOid: '1.3.6.1.2.1.2.2.1.10',
        instance: String(i + 1),
        bucket: '2026-09-15T10:00:00.000Z',
        avgValue: String(i + 1),
        maxValue: String(i + 1),
      }));
    vi.mocked(db.select).mockReturnValueOnce(metricsChain(rows) as any);

    const res = await get('?oid=1.3.6.1.2.1.2.2.1.10');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(MAX_INSTANCES_PER_OID).toBe(64);
    expect(body.series).toHaveLength(Math.min(count, MAX_SERIES, MAX_INSTANCES_PER_OID));
    expect(db.selectDistinctOn).toHaveBeenCalledTimes(1);
    expect(seriesLimit).toHaveBeenCalledWith(MAX_SERIES + 1);
    expect(body.truncatedSeries).toBe(count > MAX_SERIES || count > MAX_INSTANCES_PER_OID);
    if (count === 0) {
      expect(pointsWhere).not.toHaveBeenCalled();
      expect(db.select).toHaveBeenCalledTimes(2);
      return;
    }
    expect(pointsWhere).toHaveBeenCalledTimes(1);
    const pointsQuery = new PgDialect().sqlToQuery(pointsWhere.mock.calls[0]![0]);
    for (let i = 1; i <= MAX_SERIES; i++) expect(pointsQuery.params).toContain(String(i));
    for (let i = MAX_SERIES + 1; i <= count; i++) {
      expect(pointsQuery.params).not.toContain(String(i));
    }
  });

  it('caps instances per base OID so one large table does not starve a sibling', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bases = ['1.3.6.1.2.1.2.2.1.10', '1.3.6.1.2.1.2.2.1.16'];
    const perBaseCap = Math.max(1, Math.floor(MAX_SERIES / bases.length));
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(snmpDeviceChain([snmpDeviceRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(metricsChain(bases.flatMap((baseOid, index) =>
      Array.from({ length: index === 0 ? 70 : 5 }, (_, i) => metricRow({
        oid: `${baseOid}.${i + 1}`, baseOid, instance: String(i + 1),
        bucket: '2026-09-15T10:00:00.000Z', avgValue: '1', maxValue: '1',
      })))) as any);

    const res = await get(`?oid=${bases.join(',')}`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.series.filter((s: any) => s.oid.startsWith(`${bases[1]}.`))).toHaveLength(5);
    expect(body.series.filter((s: any) => s.oid.startsWith(`${bases[0]}.`))).toHaveLength(perBaseCap);
    expect(body.truncatedSeries).toBe(true);
    expect(seriesLimit).toHaveBeenCalledWith(MAX_SERIES * bases.length + 1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      assetId: ASSET_ID, seriesCount: perBaseCap + 5, cap: perBaseCap,
    }));
    warn.mockRestore();
  });

  it('matches an instance oid as well as a base oid', async () => {
    vi.mocked(db.select).mockReturnValueOnce(limitChain([assetRow()]) as any);
    vi.mocked(db.select).mockReturnValueOnce(snmpDeviceChain([snmpDeviceRow({ templateId: TEMPLATE_ID })]) as any);
    vi.mocked(db.select).mockReturnValueOnce(limitChain([{
      oids: [{ oid: '1.3.6.1.2.1.2.2.1.10', type: 'Counter32' }],
    }]) as any);
    // The client requested the fully-qualified INSTANCE oid directly (not the
    // base column oid) — the row's own `oid` equals what was requested, and
    // `baseOid` still maps back to the template's base column for counter
    // classification.
    vi.mocked(db.select).mockReturnValueOnce(metricsChain([
      metricRow({
        oid: '1.3.6.1.2.1.2.2.1.10.7', baseOid: '1.3.6.1.2.1.2.2.1.10', instance: '7',
        bucket: '2026-09-15T10:00:00.000Z', avgValue: '500', maxValue: '900',
      }),
    ]) as any);

    const res = await get('?oid=1.3.6.1.2.1.2.2.1.10.7');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.series).toHaveLength(1);
    expect(body.series[0].oid).toBe('1.3.6.1.2.1.2.2.1.10.7');
    expect(body.series[0].instance).toBe('7');
    // Still classified as a counter via baseOid, so max (900) wins over avg (500).
    expect(body.series[0].points).toEqual([['2026-09-15T10:00:00.000Z', 900]]);
  });
});
