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
  alertRules
} from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { ensureOrgAccess, getOrgIdsForAuth } from './helpers';
import { dataQuerySchema } from './schemas';

export const dataRoutes = new Hono();

dataRoutes.use('*', authMiddleware);

// GET /reports/data/device-inventory - Device inventory data
dataRoutes.get(
  '/data/device-inventory',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: [], total: 0 });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      conditions.push(eq(devices.siteId, query.siteId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const limit = Math.min(1000, Number.parseInt(query.limit ?? '100', 10) || 100);
    const offset = Number.parseInt(query.offset ?? '0', 10) || 0;

    // Get device inventory with hardware info
    const deviceList = await db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        osVersion: devices.osVersion,
        architecture: devices.architecture,
        agentVersion: devices.agentVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        enrolledAt: devices.enrolledAt,
        tags: devices.tags,
        siteId: devices.siteId,
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb,
        manufacturer: deviceHardware.manufacturer,
        model: deviceHardware.model,
        serialNumber: deviceHardware.serialNumber
      })
      .from(devices)
      .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
      .where(whereCondition)
      .orderBy(desc(devices.lastSeenAt))
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);

    return c.json({
      data: deviceList,
      total: Number(countResult[0]?.count ?? 0)
    });
  }
);

// GET /reports/data/software-inventory - Software across all devices
dataRoutes.get(
  '/data/software-inventory',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: [], total: 0 });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      conditions.push(eq(devices.siteId, query.siteId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const limit = Math.min(1000, Number.parseInt(query.limit ?? '100', 10) || 100);
    const offset = Number.parseInt(query.offset ?? '0', 10) || 0;

    // Get software inventory with device info
    const softwareList = await db
      .select({
        id: deviceSoftware.id,
        name: deviceSoftware.name,
        version: deviceSoftware.version,
        publisher: deviceSoftware.publisher,
        installDate: deviceSoftware.installDate,
        isSystem: deviceSoftware.isSystem,
        deviceId: deviceSoftware.deviceId,
        deviceHostname: devices.hostname
      })
      .from(deviceSoftware)
      .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
      .where(whereCondition)
      .orderBy(deviceSoftware.name)
      .limit(limit)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceSoftware)
      .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
      .where(whereCondition);

    // Get aggregated software summary
    const softwareSummary = await db
      .select({
        name: deviceSoftware.name,
        version: deviceSoftware.version,
        deviceCount: sql<number>`count(distinct ${deviceSoftware.deviceId})`
      })
      .from(deviceSoftware)
      .innerJoin(devices, eq(deviceSoftware.deviceId, devices.id))
      .where(whereCondition)
      .groupBy(deviceSoftware.name, deviceSoftware.version)
      .orderBy(desc(sql`count(distinct ${deviceSoftware.deviceId})`))
      .limit(50);

    return c.json({
      data: softwareList,
      summary: softwareSummary,
      total: Number(countResult[0]?.count ?? 0)
    });
  }
);

// GET /reports/data/alerts-summary - Alert statistics
dataRoutes.get(
  '/data/alerts-summary',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: { bySeverity: {}, byStatus: {}, byDay: [], topRules: [] }, total: 0 });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(alerts.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(alerts.orgId, orgIds));
    }

    if (query.startDate) {
      conditions.push(gte(alerts.triggeredAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(alerts.triggeredAt, new Date(query.endDate)));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get counts by severity
    const bySeverity = await db
      .select({
        severity: alerts.severity,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(whereCondition)
      .groupBy(alerts.severity);

    // Get counts by status
    const byStatus = await db
      .select({
        status: alerts.status,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(whereCondition)
      .groupBy(alerts.status);

    // Get alerts by day (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const byDay = await db
      .select({
        date: sql<string>`date_trunc('day', ${alerts.triggeredAt})::date`,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(
        conditions.length > 0
          ? and(...conditions, gte(alerts.triggeredAt, thirtyDaysAgo))
          : gte(alerts.triggeredAt, thirtyDaysAgo)
      )
      .groupBy(sql`date_trunc('day', ${alerts.triggeredAt})`)
      .orderBy(sql`date_trunc('day', ${alerts.triggeredAt})`);

    // Get top alerting rules
    const topRules = await db
      .select({
        ruleId: alerts.ruleId,
        ruleName: alertRules.name,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .where(whereCondition)
      .groupBy(alerts.ruleId, alertRules.name)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(whereCondition);

    return c.json({
      data: {
        bySeverity: Object.fromEntries(bySeverity.map(r => [r.severity, Number(r.count)])),
        byStatus: Object.fromEntries(byStatus.map(r => [r.status, Number(r.count)])),
        byDay: byDay.map(r => ({ date: r.date, count: Number(r.count) })),
        topRules: topRules.map(r => ({ ruleId: r.ruleId, ruleName: r.ruleName, count: Number(r.count) }))
      },
      total: Number(countResult[0]?.count ?? 0)
    });
  }
);

// GET /reports/data/compliance - Compliance summary
dataRoutes.get(
  '/data/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: { overview: {}, byOsType: [], agentVersions: [], issues: [] } });
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      conditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      conditions.push(eq(devices.siteId, query.siteId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total device count
    const totalDevices = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);

    // Get devices by status
    const byStatus = await db
      .select({
        status: devices.status,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(whereCondition)
      .groupBy(devices.status);

    // Get devices by OS type
    const byOsType = await db
      .select({
        osType: devices.osType,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(whereCondition)
      .groupBy(devices.osType);

    // Get agent version distribution
    const agentVersions = await db
      .select({
        version: devices.agentVersion,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(whereCondition)
      .groupBy(devices.agentVersion)
      .orderBy(desc(sql`count(*)`));

    // Calculate compliance metrics
    const total = Number(totalDevices[0]?.count ?? 0);
    const onlineCount = byStatus.find(s => s.status === 'online')?.count ?? 0;
    const offlineCount = byStatus.find(s => s.status === 'offline')?.count ?? 0;
    const maintenanceCount = byStatus.find(s => s.status === 'maintenance')?.count ?? 0;

    // Get devices not seen in last 7 days (stale devices)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const staleDevices = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(
        conditions.length > 0
          ? and(...conditions, lte(devices.lastSeenAt, sevenDaysAgo))
          : lte(devices.lastSeenAt, sevenDaysAgo)
      );

    // Identify potential compliance issues
    const issues = [];

    const staleCount = Number(staleDevices[0]?.count ?? 0);
    if (staleCount > 0) {
      issues.push({
        type: 'stale_devices',
        severity: 'warning',
        count: staleCount,
        message: `${staleCount} device(s) haven't checked in for 7+ days`
      });
    }

    if (agentVersions.length > 1) {
      const latestVersion = agentVersions[0]?.version;
      const outdatedCount = agentVersions
        .filter(v => v.version !== latestVersion)
        .reduce((sum, v) => sum + Number(v.count), 0);

      if (outdatedCount > 0) {
        issues.push({
          type: 'outdated_agents',
          severity: 'info',
          count: outdatedCount,
          message: `${outdatedCount} device(s) running outdated agent versions`
        });
      }
    }

    const complianceScore = total > 0 ? Math.round(((Number(onlineCount) + Number(maintenanceCount)) / total) * 100) : 100;

    return c.json({
      data: {
        overview: {
          totalDevices: total,
          onlineDevices: Number(onlineCount),
          offlineDevices: Number(offlineCount),
          maintenanceDevices: Number(maintenanceCount),
          staleDevices: staleCount,
          complianceScore
        },
        byOsType: byOsType.map(r => ({ osType: r.osType, count: Number(r.count) })),
        agentVersions: agentVersions.map(r => ({ version: r.version, count: Number(r.count) })),
        issues
      }
    });
  }
);

// GET /reports/data/metrics - Performance metrics summary
dataRoutes.get(
  '/data/metrics',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dataQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (orgIds !== null && orgIds.length === 0) {
      return c.json({ data: { averages: {}, topCpu: [], topRam: [], topDisk: [] } });
    }

    // Build conditions for devices
    const deviceConditions: ReturnType<typeof eq>[] = [];

    if (query.orgId) {
      const hasAccess = await ensureOrgAccess(query.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      deviceConditions.push(eq(devices.orgId, query.orgId));
    } else if (orgIds) {
      deviceConditions.push(inArray(devices.orgId, orgIds));
    }

    if (query.siteId) {
      deviceConditions.push(eq(devices.siteId, query.siteId));
    }

    const deviceWhereCondition = deviceConditions.length > 0 ? and(...deviceConditions) : undefined;

    // Get device IDs for the org
    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(deviceWhereCondition);

    const deviceIds = orgDevices.map(d => d.id);

    if (deviceIds.length === 0) {
      return c.json({
        data: {
          averages: { cpu: 0, ram: 0, disk: 0 },
          topCpu: [],
          topRam: [],
          topDisk: []
        }
      });
    }

    // Build time range conditions
    const metricsConditions: ReturnType<typeof eq>[] = [
      inArray(deviceMetrics.deviceId, deviceIds)
    ];

    if (query.startDate) {
      metricsConditions.push(gte(deviceMetrics.timestamp, new Date(query.startDate)));
    }

    if (query.endDate) {
      metricsConditions.push(lte(deviceMetrics.timestamp, new Date(query.endDate)));
    }

    const metricsWhereCondition = and(...metricsConditions);

    // Get average metrics
    const averages = await db
      .select({
        avgCpu: sql<number>`avg(${deviceMetrics.cpuPercent})`,
        avgRam: sql<number>`avg(${deviceMetrics.ramPercent})`,
        avgDisk: sql<number>`avg(${deviceMetrics.diskPercent})`
      })
      .from(deviceMetrics)
      .where(metricsWhereCondition);

    // Get latest metrics per device for top consumers
    const latestMetrics = await db
      .select({
        deviceId: deviceMetrics.deviceId,
        hostname: devices.hostname,
        cpuPercent: deviceMetrics.cpuPercent,
        ramPercent: deviceMetrics.ramPercent,
        diskPercent: deviceMetrics.diskPercent,
        timestamp: deviceMetrics.timestamp
      })
      .from(deviceMetrics)
      .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
      .where(inArray(deviceMetrics.deviceId, deviceIds))
      .orderBy(desc(deviceMetrics.timestamp))
      .limit(100);

    // Get unique latest metrics per device
    const latestPerDevice = new Map<string, typeof latestMetrics[0]>();
    for (const metric of latestMetrics) {
      if (!latestPerDevice.has(metric.deviceId)) {
        latestPerDevice.set(metric.deviceId, metric);
      }
    }

    const latestArray = Array.from(latestPerDevice.values());

    // Sort by each metric to get top consumers
    const topCpu = [...latestArray]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 10)
      .map(m => ({ deviceId: m.deviceId, hostname: m.hostname, value: m.cpuPercent }));

    const topRam = [...latestArray]
      .sort((a, b) => b.ramPercent - a.ramPercent)
      .slice(0, 10)
      .map(m => ({ deviceId: m.deviceId, hostname: m.hostname, value: m.ramPercent }));

    const topDisk = [...latestArray]
      .sort((a, b) => b.diskPercent - a.diskPercent)
      .slice(0, 10)
      .map(m => ({ deviceId: m.deviceId, hostname: m.hostname, value: m.diskPercent }));

    return c.json({
      data: {
        averages: {
          cpu: Math.round((averages[0]?.avgCpu ?? 0) * 10) / 10,
          ram: Math.round((averages[0]?.avgRam ?? 0) * 10) / 10,
          disk: Math.round((averages[0]?.avgDisk ?? 0) * 10) / 10
        },
        topCpu,
        topRam,
        topDisk
      }
    });
  }
);
