/**
 * Real-Postgres proof for the two pieces of Network Device Page Truth (#5988)
 * whose correctness lives entirely in SQL/CAS predicates that a mocked unit
 * suite cannot exercise (spec §5, §6.3):
 *
 *  1. The bucketed metric-history query in routes/monitoringAssetMetrics.ts —
 *     services/metricBucketing.ts is pure and already unit-tested, but the
 *     epoch-floor `to_timestamp`/`extract(epoch ...)` bucket expression, the
 *     `= any(text[])` OID membership check, and the numeric-value regex that
 *     filters text-valued OIDs (e.g. ifDescr) out of the aggregate are all
 *     raw `sql` fragments that only a real Postgres planner can validate.
 *
 *  2. applyProbeResult's compare-and-swap in services/assetProbe.ts — every
 *     unit suite (assetProbe.test.ts, discoveryAssetProbe.test.ts) mocks
 *     `../db` wholesale, so the UPDATE ... WHERE predicate itself (in
 *     particular the site-move guard) has never run against a real row.
 */
import './setup';

import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const orgId = c.req.header('x-org-id');
    c.set('auth', {
      user: { id: 'network-truth-actor' },
      scope: 'organization',
      partnerId: null,
      orgId,
      accessibleOrgIds: orgId ? [orgId] : [],
      canAccessOrg: (candidate: string) => candidate === orgId,
    });
    c.set('permissions', { allowedSiteIds: undefined });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { Hono } from 'hono';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { discoveredAssets, snmpDevices, snmpMetrics, snmpTemplates } from '../../db/schema';
import { monitoringAssetMetricsRoutes } from '../../routes/monitoringAssetMetrics';
import { applyProbeResult, buildProbeCommandId } from '../../services/assetProbe';
import { deriveCollection } from '../../services/snmpCollectionState';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const app = new Hono();
app.route('/monitoring', monitoringAssetMetricsRoutes);

const COUNTER_OID = '1.3.6.1.2.1.2.2.1.10.1'; // ifInOctets — climbs, so bucketed with max
const GAUGE_OID = '1.3.6.1.2.1.2.2.1.5.1'; // ifSpeed-ish — bucketed with avg
const TEXT_OID = '1.3.6.1.2.1.2.2.1.2.1'; // ifDescr — text-valued, must not surface as a series

const NUMERIC = /^-?\d+(\.\d+)?$/;

describe('network device page truth — real-Postgres SQL (#5988)', () => {
  describe('bucketed metric history (spec §6.3)', () => {
    it('aggregates counters with max, gauges with avg, and drops text-valued OIDs instead of emitting NaN', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id, name: 'Truth Org' });
      const site = await createSite({ orgId: org.id, name: 'Truth Site' });

      const adminDb = getTestDb() as any;
      const [asset] = await adminDb.insert(discoveredAssets).values({
        orgId: org.id,
        siteId: site.id,
        ipAddress: '198.51.100.40',
        hostname: 'truth-switch',
        assetType: 'switch',
        approvalStatus: 'approved',
        isOnline: true,
        discoveryMethods: ['snmp'],
      }).returning();

      const [template] = await adminDb.insert(snmpTemplates).values({
        orgId: org.id,
        name: 'Truth Template',
        vendor: 'generic',
        deviceType: 'switch',
        oids: [
          { oid: COUNTER_OID, name: 'ifInOctets', type: 'Counter64' },
          { oid: GAUGE_OID, name: 'ifSpeed', type: 'Gauge32' },
          { oid: TEXT_OID, name: 'ifDescr', type: 'OctetString' },
        ],
      }).returning();

      const [snmpDevice] = await adminDb.insert(snmpDevices).values({
        orgId: org.id,
        assetId: asset.id,
        name: 'truth-switch snmp',
        ipAddress: '198.51.100.40',
        snmpVersion: '2c',
        port: 161,
        pollingInterval: 300,
        templateId: template.id,
        isActive: true,
      }).returning();

      // Three 5-minute buckets: [12:00,12:05), [12:05,12:10), [12:10,12:15).
      const bucket0 = (s: string) => new Date(`2026-06-18T12:00:${s}Z`);
      const bucket1 = (s: string) => new Date(`2026-06-18T12:05:${s}Z`);
      const bucket2 = (s: string) => new Date(`2026-06-18T12:10:${s}Z`);

      async function metric(oid: string, name: string, value: string, timestamp: Date) {
        await adminDb.insert(snmpMetrics).values({
          orgId: org.id,
          deviceId: snmpDevice.id,
          oid,
          name,
          value,
          valueType: NUMERIC.test(value) ? 'number' : 'string',
          timestamp,
        });
      }

      // COUNTER — bucket0 max=20, bucket1 max=30, bucket2 max=50.
      await metric(COUNTER_OID, 'ifInOctets', '10', bucket0('10.000'));
      await metric(COUNTER_OID, 'ifInOctets', '20', bucket0('40.000'));
      await metric(COUNTER_OID, 'ifInOctets', '30', bucket1('20.000'));
      await metric(COUNTER_OID, 'ifInOctets', '5', bucket2('05.000'));
      await metric(COUNTER_OID, 'ifInOctets', '50', bucket2('55.000'));

      // GAUGE — bucket0 avg=15, bucket1 avg=40, bucket2 avg=20.
      await metric(GAUGE_OID, 'ifSpeed', '10', bucket0('15.000'));
      await metric(GAUGE_OID, 'ifSpeed', '20', bucket0('45.000'));
      await metric(GAUGE_OID, 'ifSpeed', '40', bucket1('30.000'));
      await metric(GAUGE_OID, 'ifSpeed', '10', bucket2('10.000'));
      await metric(GAUGE_OID, 'ifSpeed', '30', bucket2('50.000'));

      // TEXT — non-numeric values; must be filtered entirely by the numeric
      // regex, not coerced to NaN/null.
      await metric(TEXT_OID, 'ifDescr', 'GigabitEthernet0/1', bucket0('20.000'));
      await metric(TEXT_OID, 'ifDescr', 'GigabitEthernet0/1', bucket1('20.000'));

      const context: DbAccessContext = {
        scope: 'organization',
        orgId: org.id,
        accessibleOrgIds: [org.id],
        accessiblePartnerIds: [],
        userId: null,
      };

      const oidParam = [COUNTER_OID, GAUGE_OID, TEXT_OID].join(',');
      const url = `/monitoring/assets/${asset.id}/metrics`
        + `?oid=${encodeURIComponent(oidParam)}`
        + `&from=${encodeURIComponent('2026-06-18T12:00:00.000Z')}`
        + `&to=${encodeURIComponent('2026-06-18T12:15:00.000Z')}`
        + `&bucket=5m`;

      // `Promise.resolve(...)`: Hono's app.request is typed
      // `Response | Promise<Response>`, and withDbAccessContext requires a
      // thenable.
      const response = await withDbAccessContext(context, () => Promise.resolve(app.request(url, {
        headers: { 'x-org-id': org.id },
      })));

      expect(response.status).toBe(200);
      const body = await response.json() as {
        series: Array<{ oid: string; points: Array<[string, number]> }>;
        bucket: string;
      };
      expect(body.bucket).toBe('5m');

      const counterSeries = body.series.find((s) => s.oid === COUNTER_OID);
      expect(counterSeries, 'counter series must be present').toBeTruthy();
      expect(counterSeries!.points).toHaveLength(3);
      expect(counterSeries!.points.map(([, v]) => v)).toEqual([20, 30, 50]);

      const gaugeSeries = body.series.find((s) => s.oid === GAUGE_OID);
      expect(gaugeSeries, 'gauge series must be present').toBeTruthy();
      expect(gaugeSeries!.points).toHaveLength(3);
      expect(gaugeSeries!.points.map(([, v]) => v)).toEqual([15, 40, 20]);

      // The text-valued OID must not survive as a series with NaN/null
      // points — the raw SQL numeric-value regex drops those rows entirely,
      // so no entry should exist for it at all.
      const textSeries = body.series.find((s) => s.oid === TEXT_OID);
      expect(textSeries).toBeUndefined();
      expect(body.series.every((s) => s.points.every(([, v]) => Number.isFinite(v)))).toBe(true);
    });
  });

  describe('per-OID collection health (spec §6.2)', () => {
    it('picks the newest row per series even when one OID owns thousands of historical rows', async () => {
      // REGRESSION (PR #6002 review). The route used to select
      // `ORDER BY (base_oid, instance, timestamp DESC) LIMIT 2000` on the
      // theory that 2,000 rows covers 64 base OIDs. LIMIT truncates the GLOBAL
      // result after ordering, not per group — so once the alphabetically-first
      // series alone exceeds the budget (~7 days at a 5-minute interval, and
      // this wave raises retention to 30 days) every OTHER OID arrives with
      // zero rows and deriveCollection calls a perfectly healthy OID 'stale'.
      //
      // Only real Postgres can catch this: the unit suite mocks `db` wholesale
      // and hand-feeds deriveCollection already-correct input.
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id, name: 'Collection Org' });
      const site = await createSite({ orgId: org.id, name: 'Collection Site' });
      const adminDb = getTestDb() as any;

      const [asset] = await adminDb.insert(discoveredAssets).values({
        orgId: org.id,
        siteId: site.id,
        ipAddress: '198.51.100.41',
        hostname: 'collection-switch',
        assetType: 'switch',
        approvalStatus: 'approved',
        isOnline: true,
        discoveryMethods: ['snmp'],
      }).returning();

      // 'A...' sorts before 'Z...', so the noisy OID is the one that used to
      // eat the whole LIMIT.
      const NOISY_OID = '1.3.6.1.2.1.1.1.0';
      const QUIET_OID = '1.3.6.1.2.1.99.9.9.0';

      const [template] = await adminDb.insert(snmpTemplates).values({
        orgId: org.id,
        name: 'Collection Template',
        vendor: 'generic',
        deviceType: 'switch',
        oids: [
          { oid: NOISY_OID, name: 'noisy', type: 'Gauge32' },
          { oid: QUIET_OID, name: 'quiet', type: 'Gauge32' },
        ],
      }).returning();

      const polledAt = new Date();
      const [snmpDevice] = await adminDb.insert(snmpDevices).values({
        orgId: org.id,
        assetId: asset.id,
        name: 'collection-switch snmp',
        ipAddress: '198.51.100.41',
        snmpVersion: '2c',
        port: 161,
        pollingInterval: 300,
        templateId: template.id,
        isActive: true,
        lastPolled: polledAt,
        lastStatus: 'online',
      }).returning();

      // 2,100 rows for the noisy OID — more than the old 2,000-row budget.
      const noisyRows = Array.from({ length: 2100 }, (_, i) => ({
        orgId: org.id,
        deviceId: snmpDevice.id,
        oid: NOISY_OID,
        baseOid: NOISY_OID,
        instance: '',
        name: 'noisy',
        value: String(i),
        valueType: 'number',
        timestamp: new Date(polledAt.getTime() - (2100 - i) * 1000),
      }));
      for (let i = 0; i < noisyRows.length; i += 300) {
        await adminDb.insert(snmpMetrics).values(noisyRows.slice(i, i + 300));
      }

      // ONE fresh row for the quiet OID. Under the old query this row never
      // reached deriveCollection at all.
      await adminDb.insert(snmpMetrics).values({
        orgId: org.id,
        deviceId: snmpDevice.id,
        oid: QUIET_OID,
        baseOid: QUIET_OID,
        instance: '',
        name: 'quiet',
        value: '42',
        valueType: 'number',
        timestamp: polledAt,
      });

      const baseExpr = sql`coalesce(${snmpMetrics.baseOid}, ${snmpMetrics.oid})`;
      const instanceExpr = sql`coalesce(${snmpMetrics.instance}, '')`;

      const context: DbAccessContext = {
        scope: 'organization',
        orgId: org.id,
        accessibleOrgIds: [org.id],
        accessiblePartnerIds: [],
        userId: null,
      };

      const latestMetrics: Array<Record<string, any>> = await withDbAccessContext(context, () => (db as any)
        .selectDistinctOn([baseExpr, instanceExpr], {
          id: snmpMetrics.id,
          oid: snmpMetrics.oid,
          baseOid: snmpMetrics.baseOid,
          instance: snmpMetrics.instance,
          name: snmpMetrics.name,
          value: snmpMetrics.value,
          valueType: snmpMetrics.valueType,
          error: snmpMetrics.error,
          timestamp: snmpMetrics.timestamp,
        })
        .from(snmpMetrics)
        .where(eq(snmpMetrics.deviceId, snmpDevice.id))
        .orderBy(baseExpr, instanceExpr, desc(snmpMetrics.timestamp)));

      // Exactly one row per series, regardless of how deep the history goes.
      expect(latestMetrics).toHaveLength(2);
      const byOid = new Map(latestMetrics.map((r) => [r.oid as string, r]));
      expect(byOid.get(QUIET_OID)?.value).toBe('42');
      expect(byOid.get(NOISY_OID)?.value).toBe('2099');

      const collection = deriveCollection({
        templateId: template.id,
        templateOids: [
          { oid: NOISY_OID, name: 'noisy', type: 'Gauge32' },
          { oid: QUIET_OID, name: 'quiet', type: 'Gauge32' },
        ],
        snmpDevice: {
          isActive: true,
          lastStatus: 'online',
          lastPolled: polledAt,
          pollingInterval: 300,
          consecutiveFailures: 0,
        },
        metrics: latestMetrics as any,
      });

      // The whole point: the quiet OID must NOT be reported as stale.
      const quiet = collection.oids.find((o) => o.baseOid === QUIET_OID);
      expect(quiet?.state).toBe('collecting');
      const noisy = collection.oids.find((o) => o.baseOid === NOISY_OID);
      expect(noisy?.state).toBe('collecting');
    });
  });

  describe('probe correlation (spec §5)', () => {
    it('rejects a probe result whose site no longer matches the asset and leaves last_probe_status pending', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id, name: 'Probe Org' });
      const siteOriginal = await createSite({ orgId: org.id, name: 'Original Site' });
      const siteMoved = await createSite({ orgId: org.id, name: 'Moved Site' });

      const adminDb = getTestDb() as any;
      const assetId = randomUUID();
      const commandId = buildProbeCommandId(assetId);
      const [asset] = await adminDb.insert(discoveredAssets).values({
        id: assetId,
        orgId: org.id,
        siteId: siteOriginal.id,
        ipAddress: '198.51.100.50',
        hostname: 'probe-truth-asset',
        assetType: 'switch',
        approvalStatus: 'approved',
        lastProbeStatus: 'pending',
        lastProbeRef: commandId,
      }).returning();

      // Simulate the asset having moved sites after the probe was dispatched
      // but before the agent's result arrived.
      await adminDb.update(discoveredAssets)
        .set({ siteId: siteMoved.id })
        .where(eq(discoveredAssets.id, asset.id));

      const applied = await withSystemDbAccessContext(() => applyProbeResult({
        commandId,
        assetId: asset.id,
        expectedIp: '198.51.100.50',
        expectedSiteId: siteOriginal.id, // the ORIGINAL site, now stale
        status: 'ok',
        responseMs: 12,
        error: null,
      }));

      expect(applied).toBe(false);

      const [row] = await adminDb
        .select({ lastProbeStatus: discoveredAssets.lastProbeStatus, lastProbeResponseMs: discoveredAssets.lastProbeResponseMs })
        .from(discoveredAssets)
        .where(eq(discoveredAssets.id, asset.id));
      expect(row?.lastProbeStatus).toBe('pending');
      expect(row?.lastProbeResponseMs).toBeNull();
    });
  });
});
