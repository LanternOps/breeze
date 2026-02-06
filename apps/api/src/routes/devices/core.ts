import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, like, sql, desc } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceMetrics,
  deviceGroupMemberships,
  deviceGroups,
  sites
} from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getPagination, getDeviceWithOrgCheck } from './helpers';
import { listDevicesSchema, updateDeviceSchema } from './schemas';

export const coreRoutes = new Hono();

coreRoutes.use('*', authMiddleware);

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

    // Transform to include hardware as nested object
    const data = deviceList.map(d => ({
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
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      hardware: {
        cpuModel: d.cpuModel,
        cpuCores: d.cpuCores,
        ramTotalMb: d.ramTotalMb,
        diskTotalGb: d.diskTotalGb
      }
    }));

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
      networkInBytes: m.networkInBytes ? Number(m.networkInBytes) : null,
      networkOutBytes: m.networkOutBytes ? Number(m.networkOutBytes) : null
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

    const [updated] = await db
      .update(devices)
      .set(updates)
      .where(eq(devices.id, deviceId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /devices/:id - Decommission device (soft delete)
coreRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
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

    return c.json({ success: true, device: updated });
  }
);
