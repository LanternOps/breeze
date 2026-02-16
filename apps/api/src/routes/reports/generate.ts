import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceSoftware,
  deviceMetrics,
  deviceHardware,
  alerts,
  alertRules,
  sites
} from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { ensureOrgAccess } from './helpers';
import { generateReportSchema } from './schemas';

export const generateRoutes = new Hono();

generateRoutes.use('*', authMiddleware);

// POST /reports/generate - Generate ad-hoc report
generateRoutes.post(
  '/generate',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', generateReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    // Generate report data based on type
    let reportData: unknown;
    const config = data.config || {};

    switch (data.type) {
      case 'device_inventory':
        reportData = await generateDeviceInventoryReport(orgId!, config);
        break;
      case 'software_inventory':
        reportData = await generateSoftwareInventoryReport(orgId!, config);
        break;
      case 'alert_summary':
        reportData = await generateAlertSummaryReport(orgId!, config);
        break;
      case 'compliance':
        reportData = await generateComplianceReport(orgId!, config);
        break;
      case 'performance':
        reportData = await generatePerformanceReport(orgId!, config);
        break;
      case 'executive_summary':
        reportData = await generateExecutiveSummaryReport(orgId!, config);
        break;
      default:
        return c.json({ error: 'Invalid report type' }, 400);
    }

    writeRouteAudit(c, {
      orgId: orgId ?? auth.orgId,
      action: 'report.generate.adhoc',
      resourceType: 'report',
      details: { type: data.type, format: data.format }
    });

    return c.json({
      type: data.type,
      format: data.format,
      generatedAt: new Date().toISOString(),
      data: reportData
    });
  }
);

// ============================================
// REPORT GENERATION HELPERS
// ============================================

async function generateDeviceInventoryReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  if (filters?.osTypes && Array.isArray(filters.osTypes) && filters.osTypes.length > 0) {
    conditions.push(inArray(devices.osType, filters.osTypes));
  }

  const whereCondition = and(...conditions);

  const data = await db
    .select({
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      enrolledAt: devices.enrolledAt,
      cpuModel: deviceHardware.cpuModel,
      ramTotalMb: deviceHardware.ramTotalMb,
      diskTotalGb: deviceHardware.diskTotalGb,
      serialNumber: deviceHardware.serialNumber
    })
    .from(devices)
    .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
    .where(whereCondition)
    .orderBy(devices.hostname);

  return { rows: data, rowCount: data.length };
}

async function generateSoftwareInventoryReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.deviceIds && Array.isArray(filters.deviceIds) && filters.deviceIds.length > 0) {
    conditions.push(inArray(devices.id, filters.deviceIds));
  }

  const whereCondition = and(...conditions);

  const data = await db
    .select({
      softwareName: deviceSoftware.name,
      version: deviceSoftware.version,
      publisher: deviceSoftware.publisher,
      installDate: deviceSoftware.installDate,
      deviceHostname: devices.hostname
    })
    .from(deviceSoftware)
    .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
    .where(whereCondition)
    .orderBy(deviceSoftware.name, devices.hostname);

  return { rows: data, rowCount: data.length };
}

async function generateAlertSummaryReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(alerts.orgId, orgId)];

  const dateRange = config.dateRange as Record<string, string> | undefined;
  if (dateRange?.start) {
    conditions.push(gte(alerts.triggeredAt, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    conditions.push(lte(alerts.triggeredAt, new Date(dateRange.end)));
  }

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.severity && Array.isArray(filters.severity) && filters.severity.length > 0) {
    conditions.push(inArray(alerts.severity, filters.severity));
  }

  const whereCondition = and(...conditions);

  const data = await db
    .select({
      title: alerts.title,
      severity: alerts.severity,
      status: alerts.status,
      triggeredAt: alerts.triggeredAt,
      acknowledgedAt: alerts.acknowledgedAt,
      resolvedAt: alerts.resolvedAt,
      deviceHostname: devices.hostname,
      ruleName: alertRules.name
    })
    .from(alerts)
    .leftJoin(devices, eq(alerts.deviceId, devices.id))
    .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
    .where(whereCondition)
    .orderBy(desc(alerts.triggeredAt));

  // Summary stats
  const summary = await db
    .select({
      severity: alerts.severity,
      count: sql<number>`count(*)`
    })
    .from(alerts)
    .where(whereCondition)
    .groupBy(alerts.severity);

  return {
    rows: data,
    rowCount: data.length,
    summary: Object.fromEntries(summary.map(s => [s.severity, Number(s.count)]))
  };
}

async function generateComplianceReport(orgId: string, config: Record<string, unknown>) {
  const conditions: ReturnType<typeof eq>[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  const whereCondition = and(...conditions);

  // Get device compliance status
  const deviceList = await db
    .select({
      hostname: devices.hostname,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(whereCondition)
    .orderBy(devices.hostname);

  // Determine compliance status for each device
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const rows = deviceList.map(device => ({
    ...device,
    isCompliant: device.status !== 'decommissioned' &&
      device.lastSeenAt != null &&
      new Date(device.lastSeenAt) > sevenDaysAgo,
    issues: [
      device.status === 'offline' ? 'Device offline' : null,
      device.lastSeenAt && new Date(device.lastSeenAt) < sevenDaysAgo ? 'Not seen in 7+ days' : null
    ].filter(Boolean)
  }));

  const compliantCount = rows.filter(r => r.isCompliant).length;

  return {
    rows,
    rowCount: rows.length,
    summary: {
      totalDevices: rows.length,
      compliantDevices: compliantCount,
      nonCompliantDevices: rows.length - compliantCount,
      complianceRate: rows.length > 0 ? Math.round((compliantCount / rows.length) * 100) : 100
    }
  };
}

async function generatePerformanceReport(orgId: string, config: Record<string, unknown>) {
  const orgDevices = await db
    .select({ id: devices.id, hostname: devices.hostname })
    .from(devices)
    .where(eq(devices.orgId, orgId));

  const deviceIds = orgDevices.map(d => d.id);

  if (deviceIds.length === 0) {
    return { rows: [], rowCount: 0 };
  }

  const conditions: ReturnType<typeof eq>[] = [inArray(deviceMetrics.deviceId, deviceIds)];

  const dateRange = config.dateRange as Record<string, string> | undefined;
  if (dateRange?.start) {
    conditions.push(gte(deviceMetrics.timestamp, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    conditions.push(lte(deviceMetrics.timestamp, new Date(dateRange.end)));
  }

  const whereCondition = and(...conditions);

  // Get aggregated metrics per device
  const data = await db
    .select({
      deviceId: deviceMetrics.deviceId,
      hostname: devices.hostname,
      avgCpu: sql<number>`avg(${deviceMetrics.cpuPercent})`,
      maxCpu: sql<number>`max(${deviceMetrics.cpuPercent})`,
      avgRam: sql<number>`avg(${deviceMetrics.ramPercent})`,
      maxRam: sql<number>`max(${deviceMetrics.ramPercent})`,
      avgDisk: sql<number>`avg(${deviceMetrics.diskPercent})`,
      maxDisk: sql<number>`max(${deviceMetrics.diskPercent})`
    })
    .from(deviceMetrics)
    .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
    .where(whereCondition)
    .groupBy(deviceMetrics.deviceId, devices.hostname)
    .orderBy(devices.hostname);

  const rows = data.map(d => ({
    hostname: d.hostname,
    avgCpu: Math.round(d.avgCpu * 10) / 10,
    maxCpu: Math.round(d.maxCpu * 10) / 10,
    avgRam: Math.round(d.avgRam * 10) / 10,
    maxRam: Math.round(d.maxRam * 10) / 10,
    avgDisk: Math.round(d.avgDisk * 10) / 10,
    maxDisk: Math.round(d.maxDisk * 10) / 10
  }));

  return { rows, rowCount: rows.length };
}

async function generateExecutiveSummaryReport(orgId: string, config: Record<string, unknown>) {
  const dateRange = config.dateRange as Record<string, string> | undefined;

  // Device stats
  const deviceStats = await db
    .select({
      total: sql<number>`count(*)`,
      online: sql<number>`sum(case when ${devices.status} = 'online' then 1 else 0 end)`,
      offline: sql<number>`sum(case when ${devices.status} = 'offline' then 1 else 0 end)`
    })
    .from(devices)
    .where(eq(devices.orgId, orgId));

  // Alert stats
  const alertConditions: ReturnType<typeof eq>[] = [eq(alerts.orgId, orgId)];
  if (dateRange?.start) {
    alertConditions.push(gte(alerts.triggeredAt, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    alertConditions.push(lte(alerts.triggeredAt, new Date(dateRange.end)));
  }

  const alertStats = await db
    .select({
      total: sql<number>`count(*)`,
      critical: sql<number>`sum(case when ${alerts.severity} = 'critical' then 1 else 0 end)`,
      high: sql<number>`sum(case when ${alerts.severity} = 'high' then 1 else 0 end)`,
      resolved: sql<number>`sum(case when ${alerts.status} = 'resolved' then 1 else 0 end)`
    })
    .from(alerts)
    .where(and(...alertConditions));

  // OS distribution
  const osDistribution = await db
    .select({
      osType: devices.osType,
      count: sql<number>`count(*)`
    })
    .from(devices)
    .where(eq(devices.orgId, orgId))
    .groupBy(devices.osType);

  // Site breakdown
  const siteBreakdown = await db
    .select({
      siteName: sites.name,
      deviceCount: sql<number>`count(*)`
    })
    .from(devices)
    .innerJoin(sites, eq(devices.siteId, sites.id))
    .where(eq(devices.orgId, orgId))
    .groupBy(sites.name)
    .orderBy(desc(sql`count(*)`));

  return {
    summary: {
      devices: {
        total: Number(deviceStats[0]?.total ?? 0),
        online: Number(deviceStats[0]?.online ?? 0),
        offline: Number(deviceStats[0]?.offline ?? 0),
        healthPercentage: deviceStats[0]?.total
          ? Math.round((Number(deviceStats[0]?.online ?? 0) / Number(deviceStats[0]?.total)) * 100)
          : 100
      },
      alerts: {
        total: Number(alertStats[0]?.total ?? 0),
        critical: Number(alertStats[0]?.critical ?? 0),
        high: Number(alertStats[0]?.high ?? 0),
        resolved: Number(alertStats[0]?.resolved ?? 0),
        resolutionRate: alertStats[0]?.total
          ? Math.round((Number(alertStats[0]?.resolved ?? 0) / Number(alertStats[0]?.total)) * 100)
          : 100
      },
      osDistribution: Object.fromEntries(osDistribution.map(o => [o.osType, Number(o.count)])),
      siteBreakdown: siteBreakdown.map(s => ({ site: s.siteName, count: Number(s.deviceCount) }))
    },
    generatedAt: new Date().toISOString()
  };
}
