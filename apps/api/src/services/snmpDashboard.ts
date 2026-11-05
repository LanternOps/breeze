/**
 * The SNMP monitoring dashboard read, shared by GET /snmp/dashboard and the AI
 * tool `get_snmp_metrics` (full-control W09, #6779).
 *
 * Moved verbatim out of routes/snmp.ts. The caller resolves the org and the
 * template-visibility condition; this module only runs the aggregate queries,
 * narrowed to `allowedSiteIds` when the caller is site-restricted.
 */
import { desc, eq, gte, inArray, like, or, and, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets, snmpAlertThresholds, snmpDevices, snmpMetrics, snmpTemplates } from '../db/schema';
import { buildTopInterfaces } from './snmpDashboardTopInterfaces';

export async function loadSnmpDashboard(opts: {
  orgId: string | null | undefined;
  templateCondition: SQL | undefined;
  allowedSiteIds: string[] | undefined;
}) {
  const { orgId, templateCondition, allowedSiteIds } = opts;
  const orgFilter = orgId ? eq(snmpDevices.orgId, orgId) : undefined;
  const siteFilter = allowedSiteIds ? inArray(discoveredAssets.siteId, allowedSiteIds) : undefined;
  const snmpDeviceConditions = [orgFilter, siteFilter].filter((condition): condition is SQL => Boolean(condition));
  const snmpDeviceFilter = snmpDeviceConditions.length > 0 ? and(...snmpDeviceConditions) : undefined;

  // Device count
  const deviceCountQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(snmpDevices);
  const [deviceCount] = await (siteFilter
    ? deviceCountQuery.innerJoin(discoveredAssets, eq(snmpDevices.assetId, discoveredAssets.id)).where(snmpDeviceFilter)
    : deviceCountQuery.where(orgFilter));

  // Template count
  const [templateCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(snmpTemplates)
    .where(templateCondition);

  // Threshold count
  const thresholdCountBase = db
    .select({ count: sql<number>`count(*)` })
    .from(snmpAlertThresholds);
  const thresholdCountQuery = siteFilter
    ? thresholdCountBase
        .innerJoin(snmpDevices, eq(snmpAlertThresholds.deviceId, snmpDevices.id))
        .innerJoin(discoveredAssets, eq(snmpDevices.assetId, discoveredAssets.id))
        .where(snmpDeviceFilter)
    : orgFilter
      ? thresholdCountBase
          .innerJoin(snmpDevices, eq(snmpAlertThresholds.deviceId, snmpDevices.id))
          .where(orgFilter)
      : thresholdCountBase;
  const [thresholdCount] = await thresholdCountQuery;

  // Status counts
  const statusCountsQuery = db
    .select({
      status: snmpDevices.lastStatus,
      count: sql<number>`count(*)`
    })
    .from(snmpDevices);
  const statusCounts = await (siteFilter
    ? statusCountsQuery.innerJoin(discoveredAssets, eq(snmpDevices.assetId, discoveredAssets.id)).where(snmpDeviceFilter)
    : statusCountsQuery.where(orgFilter))
    .groupBy(snmpDevices.lastStatus);

  const status: Record<string, number> = {};
  for (const row of statusCounts) {
    status[row.status ?? 'unknown'] = Number(row.count);
  }

  // Template usage
  const templateUsageQuery = db
    .select({
      templateId: snmpDevices.templateId,
      name: snmpTemplates.name,
      deviceCount: sql<number>`count(*)`
    })
    .from(snmpDevices)
    .leftJoin(snmpTemplates, eq(snmpDevices.templateId, snmpTemplates.id));
  const templateUsage = await (siteFilter
    ? templateUsageQuery.innerJoin(discoveredAssets, eq(snmpDevices.assetId, discoveredAssets.id)).where(snmpDeviceFilter)
    : templateUsageQuery.where(orgFilter))
    .groupBy(snmpDevices.templateId, snmpTemplates.name);

  // Recent polls
  const recentPollsQuery = db
    .select({
      deviceId: snmpDevices.id,
      name: snmpDevices.name,
      lastPolledAt: snmpDevices.lastPolled,
      status: snmpDevices.lastStatus
    })
    .from(snmpDevices);
  const recentPolls = await (siteFilter
    ? recentPollsQuery.innerJoin(discoveredAssets, eq(snmpDevices.assetId, discoveredAssets.id)).where(snmpDeviceFilter)
    : recentPollsQuery.where(orgFilter))
    .orderBy(desc(snmpDevices.lastPolled))
    .limit(5);

  const interfaceWindowStart = new Date(Date.now() - 30 * 60 * 1000);
  const interfaceOidFilter = or(
    like(snmpMetrics.oid, '1.3.6.1.2.1.2.2.1.10%'),
    like(snmpMetrics.oid, '1.3.6.1.2.1.2.2.1.16%'),
    like(snmpMetrics.name, '%ifInOctets%'),
    like(snmpMetrics.name, '%ifOutOctets%')
  )!;
  const interfaceMetricFilter = and(
    ...[
      orgFilter,
      siteFilter,
      gte(snmpMetrics.timestamp, interfaceWindowStart),
      interfaceOidFilter
    ].filter((condition): condition is SQL => Boolean(condition))
  );

  const recentInterfaceMetricsQuery = db
    .select({
      deviceId: snmpMetrics.deviceId,
      deviceName: snmpDevices.name,
      oid: snmpMetrics.oid,
      name: snmpMetrics.name,
      value: snmpMetrics.value,
      timestamp: snmpMetrics.timestamp
    })
    .from(snmpMetrics)
    .innerJoin(snmpDevices, eq(snmpMetrics.deviceId, snmpDevices.id));
  const recentInterfaceMetrics = await (siteFilter
    ? recentInterfaceMetricsQuery.innerJoin(discoveredAssets, eq(snmpDevices.assetId, discoveredAssets.id)).where(interfaceMetricFilter)
    : recentInterfaceMetricsQuery.where(interfaceMetricFilter))
    .orderBy(desc(snmpMetrics.timestamp))
    .limit(3000);

  const topInterfaces = buildTopInterfaces(recentInterfaceMetrics, 5);

  return {
    data: {
      totals: {
        devices: Number(deviceCount?.count ?? 0),
        templates: Number(templateCount?.count ?? 0),
        thresholds: Number(thresholdCount?.count ?? 0)
      },
      status,
      templateUsage: templateUsage.map((t) => ({
        templateId: t.templateId,
        name: t.name ?? 'Unassigned',
        deviceCount: Number(t.deviceCount)
      })),
      topInterfaces,
      recentPolls: recentPolls.map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        lastPolledAt: p.lastPolledAt?.toISOString() ?? null,
        status: p.status ?? 'offline'
      }))
    }
  };
}
