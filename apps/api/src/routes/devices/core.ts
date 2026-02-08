import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, like, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { randomBytes } from 'crypto';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceMetrics,
  deviceGroupMemberships,
  deviceGroups,
  sites,
  enrollmentKeys
} from '../../db/schema';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getPagination, getDeviceWithOrgCheck } from './helpers';
import { listDevicesSchema, updateDeviceSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';

export const coreRoutes = new Hono();

coreRoutes.use('*', authMiddleware);

// POST /devices/onboarding-token - Generate a short-lived enrollment key
coreRoutes.post(
  '/onboarding-token',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const requestedOrgId = c.req.query('orgId');

    let orgId = auth.orgId ?? null;

    if (requestedOrgId) {
      if (!auth.canAccessOrg(requestedOrgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      orgId = requestedOrgId;
    }

    if (!orgId && auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
      orgId = auth.accessibleOrgIds[0];
    }

    if (!orgId) {
      return c.json({ error: 'Organization ID required. Provide orgId query parameter.' }, 400);
    }

    // Pick the first site in the org for the enrollment key
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.orgId, orgId))
      .limit(1);

    if (!site) {
      return c.json({ error: 'No site found for this organization. Create a site first.' }, 400);
    }

    const key = `enroll_${randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db.insert(enrollmentKeys).values({
      orgId,
      siteId: site.id,
      name: `Onboarding token (${new Date().toISOString().slice(0, 10)})`,
      key,
      maxUsage: 10,
      expiresAt,
      createdBy: auth.user.id,
    });

    return c.json({ token: key });
  }
);

// GET /devices - List devices (paginated, filtered, sorted)
coreRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access (uses pre-computed accessibleOrgIds from auth middleware)
    const orgFilter = auth.orgCondition(devices.orgId);
    if (orgFilter) {
      conditions.push(orgFilter);
    }

    // Optional: filter to specific org if requested (must be accessible)
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    }

    // Additional filters
    if (query.siteId) {
      conditions.push(eq(devices.siteId, query.siteId));
    }

    if (query.status) {
      conditions.push(eq(devices.status, query.status));
    }

    if (query.osType) {
      conditions.push(eq(devices.osType, query.osType));
    }

    if (query.search) {
      conditions.push(like(devices.hostname, `%${query.search}%`));
    }

    // Exclude decommissioned by default unless explicitly requested
    if (!query.status) {
      conditions.push(sql`${devices.status} != 'decommissioned'`);
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get devices with hardware summary
    const deviceList = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        agentId: devices.agentId,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        osVersion: devices.osVersion,
        osBuild: devices.osBuild,
        architecture: devices.architecture,
        agentVersion: devices.agentVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        enrolledAt: devices.enrolledAt,
        tags: devices.tags,
        customFields: devices.customFields,
        createdAt: devices.createdAt,
        updatedAt: devices.updatedAt,
        // Hardware summary
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb
      })
      .from(devices)
      .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
      .where(whereCondition)
      .orderBy(desc(devices.lastSeenAt))
      .limit(limit)
      .offset(offset);

    const deviceIds = deviceList.map(d => d.id);

    const latestMetricsByDevice = new Map<string, {
      cpuPercent: number;
      ramPercent: number;
      timestamp: Date;
    }>();

    if (deviceIds.length > 0) {
      const latestMetricTimestamps = db
        .select({
          deviceId: deviceMetrics.deviceId,
          latestTimestamp: sql<Date>`max(${deviceMetrics.timestamp})`.as('latest_timestamp')
        })
        .from(deviceMetrics)
        .where(inArray(deviceMetrics.deviceId, deviceIds))
        .groupBy(deviceMetrics.deviceId)
        .as('latest_metric_timestamps');

      const latestMetrics = await db
        .select({
          deviceId: deviceMetrics.deviceId,
          cpuPercent: deviceMetrics.cpuPercent,
          ramPercent: deviceMetrics.ramPercent,
          timestamp: deviceMetrics.timestamp
        })
        .from(deviceMetrics)
        .innerJoin(
          latestMetricTimestamps,
          and(
            eq(deviceMetrics.deviceId, latestMetricTimestamps.deviceId),
            eq(deviceMetrics.timestamp, latestMetricTimestamps.latestTimestamp)
          )
        );

      for (const metric of latestMetrics) {
        if (!latestMetricsByDevice.has(metric.deviceId)) {
          latestMetricsByDevice.set(metric.deviceId, {
            cpuPercent: metric.cpuPercent,
            ramPercent: metric.ramPercent,
            timestamp: metric.timestamp
          });
        }
      }
    }

    // Transform to include hardware and latest metrics as nested objects
    const data = deviceList.map(d => {
      const latestMetrics = latestMetricsByDevice.get(d.id);

      return {
        id: d.id,
        orgId: d.orgId,
        siteId: d.siteId,
        agentId: d.agentId,
        hostname: d.hostname,
        displayName: d.displayName,
        osType: d.osType,
        osVersion: d.osVersion,
        osBuild: d.osBuild,
        architecture: d.architecture,
        agentVersion: d.agentVersion,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        enrolledAt: d.enrolledAt,
        tags: d.tags,
        customFields: d.customFields,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        cpuPercent: latestMetrics?.cpuPercent ?? 0,
        ramPercent: latestMetrics?.ramPercent ?? 0,
        hardware: {
          cpuModel: d.cpuModel,
          cpuCores: d.cpuCores,
          ramTotalMb: d.ramTotalMb,
          diskTotalGb: d.diskTotalGb
        },
        metrics: latestMetrics
          ? {
            cpuPercent: latestMetrics.cpuPercent,
            ramPercent: latestMetrics.ramPercent,
            timestamp: latestMetrics.timestamp
          }
          : null
      };
    });

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// GET /devices/:id - Get device details
coreRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Get hardware info
    const [hardware] = await db
      .select()
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, deviceId))
      .limit(1);

    // Get network interfaces
    const networkInterfaces = await db
      .select()
      .from(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, deviceId));

    // Get recent metrics (last 24 hours, sampled)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentMetricsRaw = await db
      .select()
      .from(deviceMetrics)
      .where(
        and(
          eq(deviceMetrics.deviceId, deviceId),
          gte(deviceMetrics.timestamp, oneDayAgo)
        )
      )
      .orderBy(desc(deviceMetrics.timestamp))
      .limit(288); // ~5 min intervals for 24 hours

    // Convert BigInt fields to numbers for JSON serialization
    const recentMetrics = recentMetricsRaw.map(m => ({
      ...m,
      networkInBytes: m.networkInBytes != null ? Number(m.networkInBytes) : null,
      networkOutBytes: m.networkOutBytes != null ? Number(m.networkOutBytes) : null,
      bandwidthInBps: m.bandwidthInBps != null ? Number(m.bandwidthInBps) : null,
      bandwidthOutBps: m.bandwidthOutBps != null ? Number(m.bandwidthOutBps) : null
    }));

    // Get group memberships
    const memberships = await db
      .select({
        groupId: deviceGroupMemberships.groupId,
        addedAt: deviceGroupMemberships.addedAt,
        addedBy: deviceGroupMemberships.addedBy,
        groupName: deviceGroups.name,
        groupType: deviceGroups.type
      })
      .from(deviceGroupMemberships)
      .innerJoin(deviceGroups, eq(deviceGroupMemberships.groupId, deviceGroups.id))
      .where(eq(deviceGroupMemberships.deviceId, deviceId));

    // Get site info
    const [site] = await db
      .select({ timezone: sites.timezone, name: sites.name })
      .from(sites)
      .where(eq(sites.id, device.siteId))
      .limit(1);

    return c.json({
      ...device,
      hardware: hardware || null,
      networkInterfaces,
      recentMetrics,
      groups: memberships,
      siteName: site?.name || 'Unknown Site',
      siteTimezone: site?.timezone || 'UTC'
    });
  }
);

// PATCH /devices/:id - Update device
coreRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // If moving to a different site, verify it's in the same org
    if (data.siteId && data.siteId !== device.siteId) {
      const [targetSite] = await db
        .select()
        .from(sites)
        .where(
          and(
            eq(sites.id, data.siteId),
            eq(sites.orgId, device.orgId)
          )
        )
        .limit(1);

      if (!targetSite) {
        return c.json({ error: 'Target site not found or belongs to a different organization' }, 400);
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.displayName !== undefined) updates.displayName = data.displayName;
    if (data.siteId !== undefined) updates.siteId = data.siteId;
    if (data.tags !== undefined) updates.tags = data.tags;
    if (data.customFields !== undefined) {
      // Merge with existing custom fields rather than replacing
      const raw = device.customFields;
      const existing: Record<string, unknown> =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      updates.customFields = { ...existing, ...data.customFields };
    }

    const [updated] = await db
      .update(devices)
      .set(updates)
      .where(eq(devices.id, deviceId))
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.update',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(updated);
  }
);

// DELETE /devices/:id - Decommission device (soft delete)
coreRoutes.delete(
  '/:id',
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status === 'decommissioned') {
      return c.json({ error: 'Device is already decommissioned' }, 400);
    }

    const [updated] = await db
      .update(devices)
      .set({
        status: 'decommissioned',
        updatedAt: new Date()
      })
      .where(eq(devices.id, deviceId))
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.decommission',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname
    });

    return c.json({ success: true, device: updated });
  }
);
