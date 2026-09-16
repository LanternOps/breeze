/**
 * GET /monitoring/assets/:id/metrics — bucketed SNMP metric history (spec §6.3).
 *
 * Its own module: routes/monitoring.ts is already 1,071 lines and this handler
 * is a self-contained read. Mounted as a second sub-router at /monitoring in
 * index.ts; `/assets/:id` cannot shadow `/assets/:id/metrics`, so mount order
 * does not matter.
 *
 * Every cap in services/metricBucketing.ts is load-bearing. snmp_metrics is a
 * row-per-sample table (the spec explicitly does NOT make it a hypertable in
 * this scope), and once W02's walks land, one 48-port switch writes ~138k rows
 * a day. An uncapped range here is a sequential scan with a tenant on the other
 * end of it.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { discoveredAssets, snmpDevices, snmpMetrics, snmpTemplates } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { resolveOrgIdForAsset, type AssetAuthContext } from '../services/assetAccessScope';
import {
  isCounterType,
  toResetAwareDeltas,
  validateRange,
  MAX_SERIES,
  type BucketChoice,
} from '../services/metricBucketing';

export const MAX_INSTANCES_PER_OID = 64;

export const monitoringAssetMetricsRoutes = new Hono();
monitoringAssetMetricsRoutes.use('*', authMiddleware);

const querySchema = z.object({
  oid: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(['auto', '1m', '5m', '1h', '1d']).optional(),
  delta: z.enum(['0', '1']).optional(),
  orgId: z.string().guid().optional(),
});

monitoringAssetMetricsRoutes.get(
  '/assets/:id/metrics',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', querySchema),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;
    const query = c.req.valid('query');

    const orgResult = await resolveOrgIdForAsset(auth, assetId, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const orgId = orgResult.orgId;
    if (!orgId) return c.json({ error: 'Could not determine organization context' }, 400);

    const [asset] = await db
      .select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId, siteId: discoveredAssets.siteId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgId)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);
    if (perms?.allowedSiteIds && (typeof asset.siteId !== 'string' || !canAccessSite(perms, asset.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const oids = query.oid.split(',').map((o) => o.trim()).filter(Boolean);
    if (oids.length === 0) return c.json({ error: 'oid is required' }, 400);
    if (oids.length > MAX_SERIES) {
      return c.json({ error: `At most ${MAX_SERIES} OIDs may be requested at once` }, 400);
    }

    const toMs = query.to ? Date.parse(query.to) : Date.now();
    const fromMs = query.from ? Date.parse(query.from) : toMs - 24 * 3600_000;
    const range = validateRange(fromMs, toMs, (query.bucket ?? 'auto') as BucketChoice);
    if (!range.ok) return c.json({ error: range.message }, 400);

    const [snmpDevice] = await db
      .select({ id: snmpDevices.id, templateId: snmpDevices.templateId })
      .from(snmpDevices)
      .where(and(eq(snmpDevices.assetId, asset.id), eq(snmpDevices.orgId, asset.orgId)))
      .orderBy(sql`${snmpDevices.isActive} desc`, sql`${snmpDevices.createdAt} desc`)
      .limit(1);
    if (!snmpDevice) return c.json({ error: 'This asset has no SNMP device' }, 404);

    // The template's per-OID `type` decides the aggregate: counters only ever
    // climb, so averaging them across a bucket invents values that never
    // existed; gauges are averaged.
    const counterOids = new Set<string>();
    if (snmpDevice.templateId) {
      const [template] = await db
        .select({ oids: snmpTemplates.oids })
        .from(snmpTemplates)
        .where(eq(snmpTemplates.id, snmpDevice.templateId))
        .limit(1);
      for (const entry of (template?.oids ?? []) as Array<{ oid?: string; type?: string }>) {
        if (entry.oid && isCounterType(entry.type)) counterOids.add(entry.oid);
      }
    }

    const seconds = range.seconds;
    // Epoch-floor bucketing: one expression for all four widths (date_trunc has
    // no 5-minute unit) and exactly aligned, which matters when the UI overlays
    // two series. The numeric regex drops string-valued OIDs (ifDescr is text)
    // rather than coercing them to NaN.
    // `sql.raw` for the width, not a bind parameter: Postgres matches a GROUP BY
    // expression to a SELECT expression STRUCTURALLY, and the same JS value bound
    // twice becomes two different placeholders ($1 and $5), so the planner sees
    // two different expressions and rejects the query with "column
    // snmp_metrics.timestamp must appear in the GROUP BY clause". `seconds` comes
    // from the closed set {60, 300, 3600, 86400} in services/metricBucketing.ts,
    // so it is never attacker-controlled text.
    const secondsSql = sql.raw(String(seconds));
    const bucketExpr = sql`to_timestamp(floor(extract(epoch from ${snmpMetrics.timestamp}) / ${secondsSql}) * ${secondsSql})`;
    const baseExpr = sql`coalesce(${snmpMetrics.baseOid}, ${snmpMetrics.oid})`;
    const instanceExpr = sql`coalesce(${snmpMetrics.instance}, '')`;

    const metricFilter = and(
      eq(snmpMetrics.deviceId, snmpDevice.id),
      gte(snmpMetrics.timestamp, new Date(fromMs)),
      lt(snmpMetrics.timestamp, new Date(toMs)),
      // `inArray`, not `= any($n)`: postgres.js binds an interpolated JS
      // array as a parenthesised scalar tuple `($1,$2,$3)`, and
      // `any(<tuple>)` is not valid SQL (42809 "op ANY/ALL (array) requires
      // array on right side"). inArray emits a plain IN list, which is what
      // the tuple binding actually is.
      or(inArray(baseExpr, oids), inArray(snmpMetrics.oid, oids))!,
      sql`${snmpMetrics.value} ~ '^-?[0-9]+([.][0-9]+)?$'`,
    );
    const perBaseCap = Math.max(1, Math.floor(MAX_SERIES / oids.length));
    // Widen the bounded lookahead so a large base can leave room for siblings.
    const candidates = await db
      .selectDistinctOn([baseExpr, instanceExpr], {
        baseOid: sql<string>`${baseExpr}`,
        instance: sql<string>`${instanceExpr}`,
      })
      .from(snmpMetrics)
      .where(metricFilter)
      .orderBy(baseExpr, instanceExpr)
      .limit(MAX_SERIES * oids.length + 1);
    const selected: typeof candidates = [];
    const instanceCounts = new Map<string, number>();
    let truncatedSeries = false;
    for (const candidate of candidates) {
      const count = instanceCounts.get(candidate.baseOid) ?? 0;
      if (selected.length >= MAX_SERIES || count >= perBaseCap) {
        truncatedSeries = true;
        continue;
      }
      selected.push(candidate);
      instanceCounts.set(candidate.baseOid, count + 1);
    }
    if (truncatedSeries) {
      console.warn('[MonitoringAssetMetrics] truncated series', {
        assetId, seriesCount: selected.length, cap: perBaseCap,
      });
    }

    const rows = selected.length === 0 ? [] : await db
      .select({
        baseOid: baseExpr as unknown as ReturnType<typeof sql<string>>,
        oid: snmpMetrics.oid,
        instance: instanceExpr as unknown as ReturnType<typeof sql<string>>,
        name: sql<string>`min(${snmpMetrics.name})`,
        bucket: bucketExpr as unknown as ReturnType<typeof sql<string>>,
        avgValue: sql<string>`avg((${snmpMetrics.value})::double precision)`,
        maxValue: sql<string>`max((${snmpMetrics.value})::double precision)`,
      })
      .from(snmpMetrics)
      .where(and(
        metricFilter,
        or(...selected.map(({ baseOid, instance }) => and(
          eq(baseExpr, baseOid), eq(instanceExpr, instance),
        ))),
      ))
      .groupBy(baseExpr, snmpMetrics.oid, instanceExpr, bucketExpr)
      .orderBy(bucketExpr);

    type Series = { oid: string; instance: string; name: string; points: Array<[string, number]> };
    const seriesByKey = new Map<string, Series>();
    for (const row of rows) {
      const key = `${row.oid}|${row.instance}`;
      const series = seriesByKey.get(key) ?? { oid: row.oid, instance: row.instance, name: row.name, points: [] };
      const raw = counterOids.has(row.baseOid) ? row.maxValue : row.avgValue;
      const value = Number(raw);
      if (Number.isFinite(value)) {
        series.points.push([new Date(row.bucket).toISOString(), value]);
      }
      seriesByKey.set(key, series);
    }

    const wantDeltas = query.delta === '1';
    const series = Array.from(seriesByKey.values())
      .slice(0, MAX_SERIES)
      .map((s) => ({ ...s, points: wantDeltas ? toResetAwareDeltas(s.points) : s.points }));

    return c.json({
      series,
      truncatedSeries,
      bucket: range.bucket,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
  },
);
