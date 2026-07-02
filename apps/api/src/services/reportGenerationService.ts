import { and, eq, sql, desc, gte, lte, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  deviceSoftware,
  deviceMetrics,
  deviceHardware,
  alerts,
  alertRules,
  sites,
  organizations,
  reportRuns
} from '../db/schema';
import { canAccessSite, type UserPermissions } from './permissions';
import type { ExecutiveSummary } from '@breeze/shared';

export type ReportType =
  | 'device_inventory'
  | 'software_inventory'
  | 'alert_summary'
  | 'compliance'
  | 'performance'
  | 'executive_summary'
  | 'security_compliance_posture';

export type ReportResult = {
  rows?: unknown[];
  rowCount?: number;
  summary?: Record<string, unknown>;
  generatedAt?: string;
  /** Slim baseline from the previous completed run of the same report, copied
   * into the snapshot at generation time so trend deltas ("79, up from 74")
   * render from the stored result alone. Only `summary` is copied — never
   * `previous` — so baselines don't chain. */
  previous?: { generatedAt: string | null; summary?: Record<string, unknown> };
};

/** Baseline from the most recent completed run of this report, if it captured
 * a summary. Call BEFORE marking the new run completed.
 *
 * Projects only `result->summary` / `result->>generatedAt` instead of the full
 * `result` JSONB (which can be many MB — it includes every row) and never
 * throws: this sits in the success path of both generation call sites, so a
 * lookup failure must degrade to "no baseline" rather than fail an otherwise
 * good run. */
export async function previousBaselineFor(reportId: string): Promise<ReportResult['previous']> {
  try {
    const [prior] = await db
      .select({
        summary: sql<Record<string, unknown> | null>`${reportRuns.result}->'summary'`,
        generatedAt: sql<string | null>`${reportRuns.result}->>'generatedAt'`,
        completedAt: reportRuns.completedAt,
      })
      .from(reportRuns)
      .where(and(eq(reportRuns.reportId, reportId), eq(reportRuns.status, 'completed')))
      .orderBy(desc(reportRuns.completedAt))
      .limit(1);
    if (!prior?.summary || typeof prior.summary !== 'object') return undefined;
    return {
      generatedAt: prior.generatedAt ?? prior.completedAt?.toISOString() ?? null,
      summary: prior.summary,
    };
  } catch (err) {
    console.error('[reports] previous-baseline lookup failed', { reportId }, err);
    return undefined;
  }
}

export async function resolveSiteAllowedDeviceIds(orgId: string, perms: UserPermissions | undefined): Promise<string[] | null> {
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

export async function siteScopeRequestAllowed(
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

  const postureSiteIds = asStringArray(config.sites);
  if (postureSiteIds?.some((siteId) => !canAccessSite(perms, siteId))) {
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

export async function generateDeviceInventoryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
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

export async function generateSoftwareInventoryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
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

export async function generateAlertSummaryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
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

export async function generateComplianceReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
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

export async function generatePerformanceReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
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

export async function generateExecutiveSummaryReport(orgId: string, config: Record<string, unknown>, perms?: UserPermissions) {
  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

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
      org: { id: orgId, name: orgRow?.name ?? '' },
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
    } satisfies ExecutiveSummary,
    generatedAt: new Date().toISOString()
  };
}

/** Dispatch to the matching report generator by type. */
export async function generateReport(
  type: ReportType,
  orgId: string,
  config: Record<string, unknown>,
  perms?: UserPermissions
): Promise<ReportResult> {
  switch (type) {
    case 'device_inventory':
      return generateDeviceInventoryReport(orgId, config, perms);
    case 'software_inventory':
      return generateSoftwareInventoryReport(orgId, config, perms);
    case 'alert_summary':
      return generateAlertSummaryReport(orgId, config, perms);
    case 'compliance':
      return generateComplianceReport(orgId, config, perms);
    case 'performance':
      return generatePerformanceReport(orgId, config, perms);
    case 'executive_summary':
      return generateExecutiveSummaryReport(orgId, config, perms);
    case 'security_compliance_posture': {
      const { generateSecurityCompliancePostureReport } = await import('./securityComplianceReport');
      return generateSecurityCompliancePostureReport(orgId, config, perms);
    }
    default:
      throw new Error(`Invalid report type: ${type}`);
  }
}
