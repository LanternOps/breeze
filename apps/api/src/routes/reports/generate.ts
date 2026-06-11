import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, gte, lte, inArray, type SQL } from 'drizzle-orm';
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
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { ensureOrgAccess } from './helpers';
import { generateReportSchema } from './schemas';

export const generateRoutes = new Hono();

generateRoutes.use('*', authMiddleware);

async function resolveSiteAllowedDeviceIds(orgId: string, perms: UserPermissions | undefined): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId))
    .map((d) => d.id);
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function filtersFor(config: Record<string, unknown>): Record<string, unknown> {
  return (config.filters as Record<string, unknown> | undefined) ?? {};
}

function emptyRowsReport() {
  return { rows: [], rowCount: 0 };
}

function addAllowedSiteCondition(conditions: SQL[], perms: UserPermissions | undefined): boolean {
  if (!perms?.allowedSiteIds) return false;
  if (perms.allowedSiteIds.length === 0) return true;
  conditions.push(inArray(devices.siteId, perms.allowedSiteIds));
  return false;
}

async function siteScopeRequestAllowed(
  orgId: string,
  config: Record<string, unknown>,
  perms: UserPermissions | undefined
): Promise<boolean> {
  if (!perms?.allowedSiteIds) return true;

  const filters = filtersFor(config);
  const siteIds = asStringArray(filters.siteIds);
  if (siteIds?.some((siteId) => !canAccessSite(perms, siteId))) {
    return false;
  }

  const deviceIds = asStringArray(filters.deviceIds);
  if (deviceIds && deviceIds.length > 0) {
    const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);
    if (deviceIds.some((deviceId) => !allowedDeviceIds?.includes(deviceId))) {
      return false;
    }
  }

  return true;
}

// POST /reports/generate - Generate ad-hoc report
generateRoutes.post(
  '/generate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_EXPORT.resource, PERMISSIONS.REPORTS_EXPORT.action),
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
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
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
    const perms = c.get('permissions') as UserPermissions | undefined;

    if (!(await siteScopeRequestAllowed(orgId!, config, perms))) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }

    switch (data.type) {
      case 'device_inventory':
        reportData = await generateDeviceInventoryReport(orgId!, config, perms);
        break;
      case 'software_inventory':
        reportData = await generateSoftwareInventoryReport(orgId!, config, perms);
        break;
      case 'alert_summary':
        reportData = await generateAlertSummaryReport(orgId!, config, perms);
        break;
      case 'compliance':
        reportData = await generateComplianceReport(orgId!, config, perms);
        break;
      case 'performance':
        reportData = await generatePerformanceReport(orgId!, config, perms);
        break;
      case 'executive_summary':
        reportData = await generateExecutiveSummaryReport(orgId!, config, perms);
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

async function generateDeviceInventoryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
  const conditions: SQL[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  if (addAllowedSiteCondition(conditions, perms)) {
    return emptyRowsReport();
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

async function generateSoftwareInventoryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
  const conditions: SQL[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.deviceIds && Array.isArray(filters.deviceIds) && filters.deviceIds.length > 0) {
    conditions.push(inArray(devices.id, filters.deviceIds));
  }

  if (addAllowedSiteCondition(conditions, perms)) {
    return emptyRowsReport();
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

async function generateAlertSummaryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
  const conditions: SQL[] = [eq(alerts.orgId, orgId)];

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

  const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);
  if (allowedDeviceIds) {
    if (allowedDeviceIds.length === 0) {
      return { rows: [], rowCount: 0, summary: {} };
    }
    conditions.push(inArray(alerts.deviceId, allowedDeviceIds));
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

async function generateComplianceReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
  const conditions: SQL[] = [eq(devices.orgId, orgId)];

  const filters = config.filters as Record<string, unknown> | undefined;
  if (filters?.siteIds && Array.isArray(filters.siteIds) && filters.siteIds.length > 0) {
    conditions.push(inArray(devices.siteId, filters.siteIds));
  }

  if (addAllowedSiteCondition(conditions, perms)) {
    return {
      rows: [],
      rowCount: 0,
      summary: {
        totalDevices: 0,
        compliantDevices: 0,
        nonCompliantDevices: 0,
        complianceRate: 100
      }
    };
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

async function generatePerformanceReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
  const deviceConditions: SQL[] = [eq(devices.orgId, orgId)];
  if (addAllowedSiteCondition(deviceConditions, perms)) {
    return emptyRowsReport();
  }

  const orgDevices = await db
    .select({ id: devices.id, hostname: devices.hostname })
    .from(devices)
    .where(and(...deviceConditions));

  const deviceIds = orgDevices.map(d => d.id);

  if (deviceIds.length === 0) {
    return { rows: [], rowCount: 0 };
  }

  const conditions: SQL[] = [inArray(deviceMetrics.deviceId, deviceIds)];

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

async function generateExecutiveSummaryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
  const dateRange = config.dateRange as Record<string, string> | undefined;
  const deviceConditions: SQL[] = [eq(devices.orgId, orgId)];
  const emptyDeviceScope = addAllowedSiteCondition(deviceConditions, perms);
  const deviceWhereCondition = and(...deviceConditions);

  // Device stats
  const deviceStats = emptyDeviceScope
    ? [{ total: 0, online: 0, offline: 0 }]
    : await db
      .select({
        total: sql<number>`count(*)`,
        online: sql<number>`sum(case when ${devices.status} = 'online' then 1 else 0 end)`,
        offline: sql<number>`sum(case when ${devices.status} = 'offline' then 1 else 0 end)`
      })
      .from(devices)
      .where(deviceWhereCondition);

  // Alert stats
  const alertConditions: SQL[] = [eq(alerts.orgId, orgId)];
  if (dateRange?.start) {
    alertConditions.push(gte(alerts.triggeredAt, new Date(dateRange.start)));
  }
  if (dateRange?.end) {
    alertConditions.push(lte(alerts.triggeredAt, new Date(dateRange.end)));
  }

  const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);
  if (allowedDeviceIds) {
    alertConditions.push(inArray(alerts.deviceId, allowedDeviceIds));
  }

  const alertStats = allowedDeviceIds?.length === 0
    ? [{ total: 0, critical: 0, high: 0, resolved: 0 }]
    : await db
      .select({
        total: sql<number>`count(*)`,
        critical: sql<number>`sum(case when ${alerts.severity} = 'critical' then 1 else 0 end)`,
        high: sql<number>`sum(case when ${alerts.severity} = 'high' then 1 else 0 end)`,
        resolved: sql<number>`sum(case when ${alerts.status} = 'resolved' then 1 else 0 end)`
      })
      .from(alerts)
      .where(and(...alertConditions));

  // OS distribution
  const osDistribution = emptyDeviceScope
    ? []
    : await db
      .select({
        osType: devices.osType,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(deviceWhereCondition)
      .groupBy(devices.osType);

  // Site breakdown
  const siteBreakdown = emptyDeviceScope
    ? []
    : await db
      .select({
        siteName: sites.name,
        deviceCount: sql<number>`count(*)`
      })
      .from(devices)
      .innerJoin(sites, eq(devices.siteId, sites.id))
      .where(deviceWhereCondition)
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
