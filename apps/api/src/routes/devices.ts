import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, gte, lte, like, sql, desc, asc, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceMetrics,
  deviceSoftware,
  deviceGroups,
  deviceGroupMemberships,
  deviceCommands,
  sites,
  organizations
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const deviceRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getDeviceWithOrgCheck(deviceId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

// Validation schemas
const listDevicesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
  osType: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

const updateDeviceSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  siteId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional()
});

const metricsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  interval: z.enum(['1m', '5m', '1h', '1d']).optional()
});

const softwareQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional()
});

const createCommandSchema = z.object({
  type: z.enum(['script', 'reboot', 'shutdown', 'update']),
  payload: z.any().optional()
});

// Apply auth middleware to all routes
deviceRoutes.use('*', authMiddleware);

// GET /devices - List devices (paginated, filtered, sorted)
deviceRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(devices.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      // Get all orgs under this partner
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(devices.orgId, query.orgId));
      } else {
        // Get devices from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(devices.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
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
deviceRoutes.get(
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
    const recentMetrics = await db
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

    return c.json({
      ...device,
      hardware: hardware || null,
      networkInterfaces,
      recentMetrics,
      groups: memberships
    });
  }
);

// PATCH /devices/:id - Update device
deviceRoutes.patch(
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
deviceRoutes.delete(
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

// GET /devices/:id/metrics - Get device metrics history
deviceRoutes.get(
  '/:id/metrics',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', metricsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Default to last 24 hours
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const startDate = query.startDate
      ? new Date(query.startDate)
      : new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
    const interval = query.interval || '5m';

    // Map interval to seconds for aggregation
    const intervalSeconds: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '1h': 3600,
      '1d': 86400
    };

    const bucketSeconds = intervalSeconds[interval] ?? 300; // default to 5 minutes

    // Query with time bucket aggregation
    const metricsData = await db
      .select({
        bucket: sql<Date>`date_trunc('minute', ${deviceMetrics.timestamp})`,
        avgCpuPercent: sql<number>`avg(${deviceMetrics.cpuPercent})`,
        avgRamPercent: sql<number>`avg(${deviceMetrics.ramPercent})`,
        avgRamUsedMb: sql<number>`avg(${deviceMetrics.ramUsedMb})`,
        avgDiskPercent: sql<number>`avg(${deviceMetrics.diskPercent})`,
        avgDiskUsedGb: sql<number>`avg(${deviceMetrics.diskUsedGb})`,
        totalNetworkIn: sql<bigint>`sum(${deviceMetrics.networkInBytes})`,
        totalNetworkOut: sql<bigint>`sum(${deviceMetrics.networkOutBytes})`,
        avgProcessCount: sql<number>`avg(${deviceMetrics.processCount})`
      })
      .from(deviceMetrics)
      .where(
        and(
          eq(deviceMetrics.deviceId, deviceId),
          gte(deviceMetrics.timestamp, startDate),
          lte(deviceMetrics.timestamp, endDate)
        )
      )
      .groupBy(sql`date_trunc('minute', ${deviceMetrics.timestamp})`)
      .orderBy(asc(sql`date_trunc('minute', ${deviceMetrics.timestamp})`));

    // Further aggregate based on requested interval
    const aggregatedData = aggregateMetricsByInterval(metricsData, interval, bucketSeconds);

    return c.json({
      data: aggregatedData,
      interval,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString()
    });
  }
);

// Helper function to aggregate metrics by interval
function aggregateMetricsByInterval(
  data: Array<{
    bucket: Date;
    avgCpuPercent: number;
    avgRamPercent: number;
    avgRamUsedMb: number;
    avgDiskPercent: number;
    avgDiskUsedGb: number;
    totalNetworkIn: bigint;
    totalNetworkOut: bigint;
    avgProcessCount: number;
  }>,
  interval: string,
  bucketSeconds: number
): Array<{
  timestamp: string;
  cpu: number;
  ram: number;
  ramUsedMb: number;
  disk: number;
  diskUsedGb: number;
  networkIn: number;
  networkOut: number;
  processCount: number;
}> {
  if (data.length === 0) return [];

  // For 1m interval, return data as-is
  if (interval === '1m') {
    return data.map(d => ({
      timestamp: d.bucket.toISOString(),
      cpu: Number(d.avgCpuPercent?.toFixed(2) ?? 0),
      ram: Number(d.avgRamPercent?.toFixed(2) ?? 0),
      ramUsedMb: Math.round(d.avgRamUsedMb ?? 0),
      disk: Number(d.avgDiskPercent?.toFixed(2) ?? 0),
      diskUsedGb: Number(d.avgDiskUsedGb?.toFixed(2) ?? 0),
      networkIn: Number(d.totalNetworkIn ?? 0),
      networkOut: Number(d.totalNetworkOut ?? 0),
      processCount: Math.round(d.avgProcessCount ?? 0)
    }));
  }

  // Group data into buckets
  const buckets = new Map<number, typeof data>();

  for (const point of data) {
    const timestamp = new Date(point.bucket).getTime();
    const bucketKey = Math.floor(timestamp / (bucketSeconds * 1000)) * (bucketSeconds * 1000);

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }
    buckets.get(bucketKey)!.push(point);
  }

  // Aggregate each bucket
  const result: Array<{
    timestamp: string;
    cpu: number;
    ram: number;
    ramUsedMb: number;
    disk: number;
    diskUsedGb: number;
    networkIn: number;
    networkOut: number;
    processCount: number;
  }> = [];

  for (const [bucketKey, points] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    const count = points.length;
    const avgCpu = points.reduce((sum, p) => sum + (p.avgCpuPercent ?? 0), 0) / count;
    const avgRam = points.reduce((sum, p) => sum + (p.avgRamPercent ?? 0), 0) / count;
    const avgRamUsed = points.reduce((sum, p) => sum + (p.avgRamUsedMb ?? 0), 0) / count;
    const avgDisk = points.reduce((sum, p) => sum + (p.avgDiskPercent ?? 0), 0) / count;
    const avgDiskUsed = points.reduce((sum, p) => sum + (p.avgDiskUsedGb ?? 0), 0) / count;
    const totalIn = points.reduce((sum, p) => sum + Number(p.totalNetworkIn ?? 0), 0);
    const totalOut = points.reduce((sum, p) => sum + Number(p.totalNetworkOut ?? 0), 0);
    const avgProcess = points.reduce((sum, p) => sum + (p.avgProcessCount ?? 0), 0) / count;

    result.push({
      timestamp: new Date(bucketKey).toISOString(),
      cpu: Number(avgCpu.toFixed(2)),
      ram: Number(avgRam.toFixed(2)),
      ramUsedMb: Math.round(avgRamUsed),
      disk: Number(avgDisk.toFixed(2)),
      diskUsedGb: Number(avgDiskUsed.toFixed(2)),
      networkIn: totalIn,
      networkOut: totalOut,
      processCount: Math.round(avgProcess)
    });
  }

  return result;
}

// GET /devices/:id/software - Get installed software list
deviceRoutes.get(
  '/:id/software',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', softwareQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(deviceSoftware.deviceId, deviceId)];

    if (query.search) {
      conditions.push(like(deviceSoftware.name, `%${query.search}%`));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceSoftware)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get software list
    const software = await db
      .select()
      .from(deviceSoftware)
      .where(whereCondition)
      .orderBy(asc(deviceSoftware.name))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: software,
      pagination: { page, limit, total }
    });
  }
);

// POST /devices/:id/commands - Queue a command for device
deviceRoutes.post(
  '/:id/commands',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createCommandSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Don't allow commands to decommissioned devices
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    // Validate payload based on command type
    if (data.type === 'script' && (!data.payload || !data.payload.scriptId)) {
      return c.json({ error: 'Script commands require a scriptId in payload' }, 400);
    }

    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type: data.type,
        payload: data.payload || {},
        status: 'pending',
        createdBy: auth.user.id
      })
      .returning();

    if (!command) {
      return c.json({ error: 'Failed to queue command' }, 500);
    }

    return c.json({
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: command.status,
      createdAt: command.createdAt
    }, 201);
  }
);

// Additional helper routes that were in the original file

// GET /devices/:id/hardware - Get device hardware (kept for backward compatibility)
deviceRoutes.get(
  '/:id/hardware',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [hardware] = await db
      .select()
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, deviceId))
      .limit(1);

    if (!hardware) {
      return c.json({ error: 'Hardware info not found' }, 404);
    }

    return c.json(hardware);
  }
);

// GET /devices/:id/commands - Get command history
deviceRoutes.get(
  '/:id/commands',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const { page = '1', limit = '50' } = c.req.query();
    const pagination = getPagination({ page, limit });

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, deviceId));
    const total = Number(countResult[0]?.count ?? 0);

    const commands = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, deviceId))
      .orderBy(desc(deviceCommands.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset);

    return c.json({
      data: commands,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total
      }
    });
  }
);

// GET /devices/:id/alerts - Get device alerts
deviceRoutes.get(
  '/:id/alerts',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const { status = 'active' } = c.req.query();

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // TODO: Query alerts table when implemented
    return c.json({ data: [] });
  }
);

// Device Groups routes

const createGroupSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  siteId: z.string().uuid().optional(),
  type: z.enum(['static', 'dynamic']),
  rules: z.any().optional(),
  parentId: z.string().uuid().optional()
});

const updateGroupSchema = createGroupSchema.partial().omit({ orgId: true });

// GET /devices/groups - List device groups
deviceRoutes.get(
  '/groups',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, page = '1', limit = '50' } = c.req.query();
    const pagination = getPagination({ page, limit });

    if (!orgId) {
      return c.json({ error: 'orgId query parameter required' }, 400);
    }

    const hasAccess = await ensureOrgAccess(orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceGroups)
      .where(eq(deviceGroups.orgId, orgId));
    const total = Number(countResult[0]?.count ?? 0);

    const groups = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.orgId, orgId))
      .orderBy(asc(deviceGroups.name))
      .limit(pagination.limit)
      .offset(pagination.offset);

    return c.json({
      data: groups,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total
      }
    });
  }
);

// POST /devices/groups - Create device group
deviceRoutes.post(
  '/groups',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const hasAccess = await ensureOrgAccess(data.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    // Verify site belongs to org if provided
    if (data.siteId) {
      const [site] = await db
        .select()
        .from(sites)
        .where(
          and(
            eq(sites.id, data.siteId),
            eq(sites.orgId, data.orgId)
          )
        )
        .limit(1);

      if (!site) {
        return c.json({ error: 'Site not found or belongs to different organization' }, 400);
      }
    }

    // Verify parent group exists and belongs to same org
    if (data.parentId) {
      const [parent] = await db
        .select()
        .from(deviceGroups)
        .where(
          and(
            eq(deviceGroups.id, data.parentId),
            eq(deviceGroups.orgId, data.orgId)
          )
        )
        .limit(1);

      if (!parent) {
        return c.json({ error: 'Parent group not found or belongs to different organization' }, 400);
      }
    }

    const [group] = await db
      .insert(deviceGroups)
      .values({
        orgId: data.orgId,
        name: data.name,
        siteId: data.siteId,
        type: data.type,
        rules: data.rules,
        parentId: data.parentId
      })
      .returning();

    return c.json(group, 201);
  }
);

// PATCH /devices/groups/:id - Update device group
deviceRoutes.patch(
  '/groups/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateGroupSchema),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const [updated] = await db
      .update(deviceGroups)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(deviceGroups.id, groupId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /devices/groups/:id - Delete device group
deviceRoutes.delete(
  '/groups/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Delete memberships first
    await db
      .delete(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.groupId, groupId));

    // Delete the group
    await db
      .delete(deviceGroups)
      .where(eq(deviceGroups.id, groupId));

    return c.json({ success: true });
  }
);

// POST /devices/groups/:id/members - Add devices to group
deviceRoutes.post(
  '/groups/:id/members',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');
    const { deviceIds } = await c.req.json<{ deviceIds: string[] }>();

    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return c.json({ error: 'deviceIds array required' }, 400);
    }

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Verify all devices belong to the same org
    const validDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          inArray(devices.id, deviceIds),
          eq(devices.orgId, group.orgId)
        )
      );

    const validDeviceIds = validDevices.map(d => d.id);

    if (validDeviceIds.length === 0) {
      return c.json({ error: 'No valid devices found' }, 400);
    }

    // Insert memberships (ignore duplicates)
    await db
      .insert(deviceGroupMemberships)
      .values(
        validDeviceIds.map(deviceId => ({
          deviceId,
          groupId,
          addedBy: 'manual' as const
        }))
      )
      .onConflictDoNothing();

    return c.json({
      success: true,
      added: validDeviceIds.length
    });
  }
);

// DELETE /devices/groups/:id/members - Remove devices from group
deviceRoutes.delete(
  '/groups/:id/members',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const groupId = c.req.param('id');
    const { deviceIds } = await c.req.json<{ deviceIds: string[] }>();

    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return c.json({ error: 'deviceIds array required' }, 400);
    }

    const [group] = await db
      .select()
      .from(deviceGroups)
      .where(eq(deviceGroups.id, groupId))
      .limit(1);

    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(group.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    await db
      .delete(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, groupId),
          inArray(deviceGroupMemberships.deviceId, deviceIds)
        )
      );

    return c.json({ success: true });
  }
);
