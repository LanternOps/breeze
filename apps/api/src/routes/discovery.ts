import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc, sql } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import {
  discoveryProfiles,
  discoveryJobs,
  discoveredAssets,
  networkTopology,
  networkMonitors,
  snmpDevices,
  snmpAlertThresholds,
  snmpMetrics,
  devices
} from '../db/schema';
import { enqueueDiscoveryScan, getDiscoveryQueue } from '../jobs/discoveryWorker';
import { isRedisAvailable } from '../services/redis';
import { writeRouteAudit } from '../services/auditEvents';

export const discoveryRoutes = new Hono();

// --- Helpers ---

function resolveOrgId(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 } as const;
    if (requestedOrgId && requestedOrgId !== auth.orgId) return { error: 'Access to this organization denied', status: 403 } as const;
    return { orgId: auth.orgId } as const;
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 } as const;
    }
    return { orgId: requestedOrgId } as const;
  }

  if (auth.scope === 'partner') {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && accessibleOrgIds.length === 1) {
      return { orgId: accessibleOrgIds[0] } as const;
    }
    return { error: 'orgId is required for partner scope', status: 400 } as const;
  }

  if (auth.scope === 'system' && !requestedOrgId) {
    return { error: 'orgId is required for system scope', status: 400 } as const;
  }

  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}

async function resolveOrgIdForAsset(
  auth: { scope: string; orgId: string | null; canAccessOrg: (orgId: string) => boolean; accessibleOrgIds: string[] | null },
  assetId: string,
  requestedOrgId?: string
) {
  const orgResult = resolveOrgId(auth, requestedOrgId);
  if (!('error' in orgResult)) return orgResult;

  const needsAssetResolution = (
    orgResult.error === 'orgId is required for partner scope'
    || orgResult.error === 'orgId is required for system scope'
    || orgResult.error === 'orgId is required'
  );
  if (!needsAssetResolution) return orgResult;

  const [asset] = await db
    .select({ orgId: discoveredAssets.orgId })
    .from(discoveredAssets)
    .where(eq(discoveredAssets.id, assetId))
    .limit(1);
  if (!asset) return { error: 'Asset not found', status: 404 } as const;
  if (!auth.canAccessOrg(asset.orgId)) return { error: 'Access to this organization denied', status: 403 } as const;

  return { orgId: asset.orgId } as const;
}

// --- Zod Schemas ---

const listProfilesSchema = z.object({
  orgId: z.string().uuid().optional()
});

const scheduleSchema = z.object({
  type: z.enum(['manual', 'cron', 'interval']),
  cron: z.string().min(1).optional(),
  intervalMinutes: z.number().int().positive().optional()
}).refine((data) => {
  if (data.type === 'cron') return Boolean(data.cron);
  if (data.type === 'interval') return Boolean(data.intervalMinutes);
  return true;
}, { message: 'Schedule details required for selected type' });

const createProfileSchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  subnets: z.array(z.string().min(1)).min(1),
  excludeIps: z.array(z.string()).optional(),
  methods: z.array(z.string().min(1)).min(1),
  portRanges: z.any().optional(),
  snmpCommunities: z.array(z.string()).optional(),
  snmpCredentials: z.any().optional(),
  schedule: scheduleSchema,
  deepScan: z.boolean().optional(),
  identifyOS: z.boolean().optional(),
  resolveHostnames: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional()
});

const updateProfileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  subnets: z.array(z.string().min(1)).min(1).optional(),
  excludeIps: z.array(z.string()).optional(),
  methods: z.array(z.string().min(1)).min(1).optional(),
  portRanges: z.any().optional(),
  snmpCommunities: z.array(z.string()).optional(),
  snmpCredentials: z.any().optional(),
  schedule: scheduleSchema.optional(),
  enabled: z.boolean().optional(),
  deepScan: z.boolean().optional(),
  identifyOS: z.boolean().optional(),
  resolveHostnames: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional()
});

const scanSchema = z.object({
  profileId: z.string().uuid(),
  agentId: z.string().optional()
});

const listJobsSchema = z.object({
  orgId: z.string().uuid().optional()
});

const listAssetsSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['new', 'identified', 'managed', 'ignored', 'offline']).optional(),
  assetType: z.enum([
    'workstation', 'server', 'printer', 'router', 'switch',
    'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
  ]).optional()
});

const linkAssetSchema = z.object({
  deviceId: z.string().uuid()
});

const ignoreAssetSchema = z.object({
  reason: z.string().max(1000).optional()
});

const topologyQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

// --- Routes ---

discoveryRoutes.use('*', authMiddleware);

// ==================== PROFILE ROUTES ====================

discoveryRoutes.get(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listProfilesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const where = orgResult.orgId ? eq(discoveryProfiles.orgId, orgResult.orgId) : undefined;
    const results = await db.select().from(discoveryProfiles)
      .where(where)
      .orderBy(desc(discoveryProfiles.createdAt));

    return c.json({
      data: results.map((p) => ({
        id: p.id,
        orgId: p.orgId,
        siteId: p.siteId,
        name: p.name,
        description: p.description,
        enabled: p.enabled,
        subnets: p.subnets,
        methods: p.methods,
        schedule: p.schedule,
        deepScan: p.deepScan,
        resolveHostnames: p.resolveHostnames,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString()
      }))
    });
  }
);

discoveryRoutes.post(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [profile] = await db.insert(discoveryProfiles).values({
      orgId: orgResult.orgId!,
      siteId: body.siteId,
      name: body.name,
      description: body.description ?? null,
      subnets: body.subnets,
      excludeIps: body.excludeIps ?? [],
      methods: body.methods as any,
      portRanges: body.portRanges ?? null,
      snmpCommunities: body.snmpCommunities ?? [],
      snmpCredentials: body.snmpCredentials ?? null,
      schedule: body.schedule,
      deepScan: body.deepScan ?? false,
      identifyOS: body.identifyOS ?? false,
      resolveHostnames: body.resolveHostnames ?? false,
      timeout: body.timeout ?? null,
      concurrency: body.concurrency ?? null,
      createdBy: auth.user?.id ?? null
    }).returning();

    writeRouteAudit(c, {
      orgId: profile?.orgId ?? orgResult.orgId,
      action: 'discovery.profile.create',
      resourceType: 'discovery_profile',
      resourceId: profile?.id,
      resourceName: profile?.name
    });

    return c.json(profile, 201);
  }
);

discoveryRoutes.get(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const profileId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [profile] = await db.select().from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!profile) return c.json({ error: 'Profile not found' }, 404);

    return c.json(profile);
  }
);

discoveryRoutes.patch(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const profileId = c.req.param('id');
    const updates = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [existing] = await db.select({ id: discoveryProfiles.id }).from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Profile not found' }, 404);

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.subnets !== undefined) setValues.subnets = updates.subnets;
    if (updates.excludeIps !== undefined) setValues.excludeIps = updates.excludeIps;
    if (updates.methods !== undefined) setValues.methods = updates.methods;
    if (updates.portRanges !== undefined) setValues.portRanges = updates.portRanges;
    if (updates.snmpCommunities !== undefined) setValues.snmpCommunities = updates.snmpCommunities;
    if (updates.snmpCredentials !== undefined) setValues.snmpCredentials = updates.snmpCredentials;
    if (updates.schedule !== undefined) setValues.schedule = updates.schedule;
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;
    if (updates.deepScan !== undefined) setValues.deepScan = updates.deepScan;
    if (updates.identifyOS !== undefined) setValues.identifyOS = updates.identifyOS;
    if (updates.resolveHostnames !== undefined) setValues.resolveHostnames = updates.resolveHostnames;
    if (updates.timeout !== undefined) setValues.timeout = updates.timeout;
    if (updates.concurrency !== undefined) setValues.concurrency = updates.concurrency;

    const [updated] = await db.update(discoveryProfiles)
      .set(setValues)
      .where(eq(discoveryProfiles.id, profileId))
      .returning();

    writeRouteAudit(c, {
      orgId: updated?.orgId ?? orgResult.orgId,
      action: 'discovery.profile.update',
      resourceType: 'discovery_profile',
      resourceId: updated?.id ?? profileId,
      resourceName: updated?.name,
      details: { changedFields: Object.keys(updates) }
    });

    return c.json(updated);
  }
);

discoveryRoutes.delete(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const profileId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveryProfiles.id,
      orgId: discoveryProfiles.orgId,
      name: discoveryProfiles.name
    }).from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Profile not found' }, 404);

    // Delete related jobs and profile atomically
    await db.transaction(async (tx) => {
      await tx.delete(discoveryJobs).where(eq(discoveryJobs.profileId, profileId));
      await tx.delete(discoveryProfiles).where(eq(discoveryProfiles.id, profileId));
    });

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'discovery.profile.delete',
      resourceType: 'discovery_profile',
      resourceId: existing.id,
      resourceName: existing.name
    });

    return c.json({ success: true });
  }
);

// ==================== SCAN / JOB ROUTES ====================

discoveryRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', scanSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, body.profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [profile] = await db.select().from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!profile) return c.json({ error: 'Profile not found' }, 404);

    const rows = await db.insert(discoveryJobs).values({
      profileId: profile.id,
      orgId: profile.orgId,
      siteId: profile.siteId,
      agentId: body.agentId ?? null,
      status: 'scheduled',
      scheduledAt: new Date()
    }).returning();
    const job = rows[0];
    if (!job) return c.json({ error: 'Failed to create job' }, 500);

    // Enqueue scan dispatch via BullMQ
    if (!isRedisAvailable()) {
      await db.update(discoveryJobs).set({
        status: 'failed',
        completedAt: new Date(),
        errors: { message: 'Background job service unavailable' },
        updatedAt: new Date()
      }).where(eq(discoveryJobs.id, job.id));
      return c.json({ error: 'Background job service unavailable. Redis is required for scan dispatch.' }, 503);
    }

    try {
      await enqueueDiscoveryScan(
        job.id,
        profile.id,
        profile.orgId,
        profile.siteId,
        body.agentId
      );
    } catch (err) {
      console.error('[Discovery] Failed to enqueue scan:', err);
      await db.update(discoveryJobs).set({
        status: 'failed',
        completedAt: new Date(),
        errors: { message: 'Failed to enqueue scan job' },
        updatedAt: new Date()
      }).where(eq(discoveryJobs.id, job.id));
      return c.json({ error: 'Failed to enqueue scan job' }, 503);
    }

    writeRouteAudit(c, {
      orgId: job.orgId,
      action: 'discovery.scan.queue',
      resourceType: 'discovery_job',
      resourceId: job.id,
      details: { profileId: profile.id, agentId: body.agentId ?? null }
    });

    return c.json(job, 201);
  }
);

discoveryRoutes.get(
  '/jobs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listJobsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const where = orgResult.orgId ? eq(discoveryJobs.orgId, orgResult.orgId) : undefined;

    const results = await db
      .select({
        id: discoveryJobs.id,
        orgId: discoveryJobs.orgId,
        profileId: discoveryJobs.profileId,
        profileName: discoveryProfiles.name,
        agentId: discoveryJobs.agentId,
        status: discoveryJobs.status,
        scheduledAt: discoveryJobs.scheduledAt,
        startedAt: discoveryJobs.startedAt,
        completedAt: discoveryJobs.completedAt,
        hostsScanned: discoveryJobs.hostsScanned,
        hostsDiscovered: discoveryJobs.hostsDiscovered,
        newAssets: discoveryJobs.newAssets,
        errors: discoveryJobs.errors,
        createdAt: discoveryJobs.createdAt
      })
      .from(discoveryJobs)
      .leftJoin(discoveryProfiles, eq(discoveryJobs.profileId, discoveryProfiles.id))
      .where(where)
      .orderBy(desc(discoveryJobs.createdAt));

    return c.json({
      data: results.map((j) => ({
        ...j,
        createdAt: j.createdAt.toISOString(),
        scheduledAt: j.scheduledAt?.toISOString() ?? null,
        startedAt: j.startedAt?.toISOString() ?? null,
        completedAt: j.completedAt?.toISOString() ?? null
      }))
    });
  }
);

discoveryRoutes.get(
  '/jobs/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const jobId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryJobs.id, jobId)];
    if (orgResult.orgId) conditions.push(eq(discoveryJobs.orgId, orgResult.orgId));

    const [job] = await db.select().from(discoveryJobs)
      .where(and(...conditions)).limit(1);
    if (!job) return c.json({ error: 'Job not found' }, 404);

    const assets = await db.select().from(discoveredAssets)
      .where(eq(discoveredAssets.lastJobId, jobId));

    return c.json({
      ...job,
      createdAt: job.createdAt.toISOString(),
      scheduledAt: job.scheduledAt?.toISOString() ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      assets
    });
  }
);

// POST /jobs/:id/cancel - Cancel a scheduled or running discovery job
discoveryRoutes.post(
  '/jobs/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const jobId = c.req.param('id');
    const orgResult = resolveOrgId(auth);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryJobs.id, jobId)];
    if (orgResult.orgId) conditions.push(eq(discoveryJobs.orgId, orgResult.orgId));

    const [job] = await db.select().from(discoveryJobs)
      .where(and(...conditions)).limit(1);
    if (!job) return c.json({ error: 'Job not found' }, 404);

    const cancelableStatuses = ['scheduled', 'running'];
    if (!cancelableStatuses.includes(job.status)) {
      return c.json({ error: `Cannot cancel job with status: ${job.status}` }, 400);
    }

    const [updated] = await db.update(discoveryJobs)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(discoveryJobs.id, jobId))
      .returning();

    if (!updated) return c.json({ error: 'Failed to cancel job' }, 500);

    // Best-effort: remove from BullMQ queue if still queued
    try {
      const queue = getDiscoveryQueue();
      await queue.remove(jobId);
    } catch {
      // Job may already be processing or completed in the queue — ignore
    }

    writeRouteAudit(c, {
      orgId: updated.orgId ?? orgResult.orgId,
      action: 'discovery.job.cancel',
      resourceType: 'discovery_job',
      resourceId: updated.id,
      details: { previousStatus: job.status }
    });

    return c.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      scheduledAt: updated.scheduledAt?.toISOString() ?? null,
      startedAt: updated.startedAt?.toISOString() ?? null,
      completedAt: updated.completedAt?.toISOString() ?? null
    });
  }
);

// ==================== ASSET ROUTES ====================

discoveryRoutes.get(
  '/assets',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAssetsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));
    if (query.status) conditions.push(eq(discoveredAssets.status, query.status));
    if (query.assetType) conditions.push(eq(discoveredAssets.assetType, query.assetType));

    const where = conditions.length ? and(...conditions) : undefined;
    const results = await db
      .select({
        asset: discoveredAssets,
        snmpMonitoringEnabled: sql<boolean>`exists (
          select 1
          from ${snmpDevices}
          where ${snmpDevices.assetId} = ${discoveredAssets.id}
            and ${snmpDevices.isActive} = true
        )`,
        networkMonitoringEnabled: sql<boolean>`exists (
          select 1
          from ${networkMonitors}
          where ${networkMonitors.assetId} = ${discoveredAssets.id}
            and ${networkMonitors.isActive} = true
        )`,
        linkedDeviceHostname: devices.hostname,
        linkedDeviceDisplayName: devices.displayName
      })
      .from(discoveredAssets)
      .leftJoin(devices, eq(discoveredAssets.linkedDeviceId, devices.id))
      .where(where)
      .orderBy(desc(discoveredAssets.lastSeenAt));

    return c.json({
      data: results.map((row) => {
        const a = row.asset;
        return {
          id: a.id,
          orgId: a.orgId,
          assetType: a.assetType,
          status: a.status,
          hostname: a.hostname,
          ipAddress: a.ipAddress,
          macAddress: a.macAddress,
          manufacturer: a.manufacturer,
          model: a.model,
          openPorts: a.openPorts,
          responseTimeMs: a.responseTimeMs,
          linkedDeviceId: a.linkedDeviceId,
          linkedDeviceName: row.linkedDeviceDisplayName ?? row.linkedDeviceHostname ?? null,
          snmpMonitoringEnabled: Boolean(row.snmpMonitoringEnabled),
          networkMonitoringEnabled: Boolean(row.networkMonitoringEnabled),
          monitoringEnabled: Boolean(row.snmpMonitoringEnabled) || Boolean(row.networkMonitoringEnabled),
          discoveryMethods: a.discoveryMethods,
          firstSeenAt: a.firstSeenAt.toISOString(),
          lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString()
        };
      })
    });
  }
);

discoveryRoutes.post(
  '/assets/:id/link',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', linkAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const body = c.req.valid('json');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [existing] = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Asset not found' }, 404);

    const [updated] = await db.update(discoveredAssets)
      .set({
        status: 'managed',
        linkedDeviceId: body.deviceId,
        updatedAt: new Date()
      })
      .where(eq(discoveredAssets.id, assetId))
      .returning();

    writeRouteAudit(c, {
      orgId: updated?.orgId ?? orgResult.orgId,
      action: 'discovery.asset.link',
      resourceType: 'discovered_asset',
      resourceId: updated?.id ?? assetId,
      resourceName: updated?.hostname ?? updated?.ipAddress ?? undefined,
      details: { linkedDeviceId: body.deviceId }
    });

    return c.json(updated);
  }
);

discoveryRoutes.post(
  '/assets/:id/ignore',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', ignoreAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const body = c.req.valid('json');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [existing] = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Asset not found' }, 404);

    const [updated] = await db.update(discoveredAssets)
      .set({
        status: 'ignored',
        linkedDeviceId: null,
        notes: body.reason ?? null,
        ignoredBy: auth.user?.id ?? null,
        ignoredAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(discoveredAssets.id, assetId))
      .returning();

    writeRouteAudit(c, {
      orgId: updated?.orgId ?? orgResult.orgId,
      action: 'discovery.asset.ignore',
      resourceType: 'discovered_asset',
      resourceId: updated?.id ?? assetId,
      resourceName: updated?.hostname ?? updated?.ipAddress ?? undefined,
      details: { reason: body.reason ?? null }
    });

    return c.json(updated);
  }
);

discoveryRoutes.delete(
  '/assets/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      hostname: discoveredAssets.hostname,
      ipAddress: discoveredAssets.ipAddress
    }).from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Asset not found' }, 404);

    await db.transaction(async (tx) => {
      const monitoringDevices = await tx.select({ id: snmpDevices.id })
        .from(snmpDevices)
        .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, existing.orgId)));

      for (const monitoringDevice of monitoringDevices) {
        await tx.delete(snmpMetrics).where(eq(snmpMetrics.deviceId, monitoringDevice.id));
        await tx.delete(snmpAlertThresholds).where(eq(snmpAlertThresholds.deviceId, monitoringDevice.id));
      }

      await tx.delete(snmpDevices)
        .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, existing.orgId)));
      await tx.delete(networkMonitors)
        .where(and(eq(networkMonitors.assetId, assetId), eq(networkMonitors.orgId, existing.orgId)));
      await tx.delete(discoveredAssets).where(eq(discoveredAssets.id, assetId));
    });

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'discovery.asset.delete',
      resourceType: 'discovered_asset',
      resourceId: existing.id,
      resourceName: existing.hostname ?? existing.ipAddress ?? undefined
    });

    return c.json({ success: true });
  }
);

// ==================== MONITORING BRIDGE ROUTES ====================

const enableMonitoringSchema = z.object({
  snmpVersion: z.enum(['v1', 'v2c', 'v3']),
  community: z.string().optional(),
  username: z.string().optional(),
  authProtocol: z.enum(['md5', 'sha', 'sha256']).optional(),
  authPassword: z.string().optional(),
  privProtocol: z.enum(['des', 'aes', 'aes256']).optional(),
  privPassword: z.string().optional(),
  templateId: z.string().uuid().optional(),
  pollingInterval: z.number().int().positive().optional()
}).refine((data) => {
  if (data.snmpVersion === 'v1' || data.snmpVersion === 'v2c') {
    return Boolean(data.community);
  }
  if (data.snmpVersion === 'v3') {
    return Boolean(data.username);
  }
  return true;
}, { message: 'Community string required for v1/v2c; username required for v3' });

discoveryRoutes.post(
  '/assets/:id/enable-monitoring',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', enableMonitoringSchema),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const body = c.req.valid('json');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [asset] = await db.select().from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    // Check if monitoring is already enabled
    const [existing] = await db.select({ id: snmpDevices.id })
      .from(snmpDevices)
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId), eq(snmpDevices.isActive, true)))
      .limit(1);
    if (existing) return c.json({ error: 'Monitoring already enabled for this asset' }, 409);

    const [snmpDevice] = await db.insert(snmpDevices).values({
      orgId: asset.orgId,
      assetId: asset.id,
      name: asset.hostname ?? asset.ipAddress ?? 'Unknown',
      ipAddress: asset.ipAddress ?? '',
      snmpVersion: body.snmpVersion,
      community: body.community ?? null,
      username: body.username ?? null,
      authProtocol: body.authProtocol ?? null,
      authPassword: body.authPassword ?? null,
      privProtocol: body.privProtocol ?? null,
      privPassword: body.privPassword ?? null,
      templateId: body.templateId ?? null,
      pollingInterval: body.pollingInterval ?? 300,
      isActive: true
    }).returning();

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: 'discovery.asset.enable_monitoring',
      resourceType: 'discovered_asset',
      resourceId: assetId,
      resourceName: asset.hostname ?? asset.ipAddress ?? undefined,
      details: { snmpDeviceId: snmpDevice?.id, snmpVersion: body.snmpVersion }
    });

    return c.json({
      success: true,
      snmpDevice: snmpDevice ? {
        id: snmpDevice.id,
        snmpVersion: snmpDevice.snmpVersion,
        pollingInterval: snmpDevice.pollingInterval,
        isActive: snmpDevice.isActive,
        templateId: snmpDevice.templateId
      } : null
    }, 201);
  }
);

discoveryRoutes.delete(
  '/assets/:id/disable-monitoring',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [asset] = await db.select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId })
      .from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const disabledSnmp = await db.update(snmpDevices)
      .set({ isActive: false })
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId), eq(snmpDevices.isActive, true)))
      .returning();

    const disabledNetworkMonitors = await db.update(networkMonitors)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(networkMonitors.assetId, assetId), eq(networkMonitors.orgId, asset.orgId), eq(networkMonitors.isActive, true)))
      .returning({ id: networkMonitors.id });

    if (disabledSnmp.length === 0 && disabledNetworkMonitors.length === 0) {
      return c.json({ error: 'No active monitoring found for this asset' }, 404);
    }

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: 'discovery.asset.disable_monitoring',
      resourceType: 'discovered_asset',
      resourceId: assetId,
      details: {
        disabledSnmpDeviceIds: disabledSnmp.map((row) => row.id),
        disabledNetworkMonitorCount: disabledNetworkMonitors.length
      }
    });

    return c.json({ success: true });
  }
);

discoveryRoutes.get(
  '/assets/:id/monitoring',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [asset] = await db.select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId })
      .from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const [snmpDevice] = await db.select()
      .from(snmpDevices)
      .where(eq(snmpDevices.assetId, assetId))
      .limit(1);

    const [networkMonitorTotal] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkMonitors)
      .where(and(eq(networkMonitors.assetId, assetId), eq(networkMonitors.orgId, asset.orgId)));

    const [networkMonitorActive] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkMonitors)
      .where(and(
        eq(networkMonitors.assetId, assetId),
        eq(networkMonitors.orgId, asset.orgId),
        eq(networkMonitors.isActive, true)
      ));

    if (!snmpDevice) {
      return c.json({
        enabled: Number(networkMonitorActive?.count ?? 0) > 0,
        snmpDevice: null,
        networkMonitors: {
          totalCount: Number(networkMonitorTotal?.count ?? 0),
          activeCount: Number(networkMonitorActive?.count ?? 0)
        },
        recentMetrics: []
      });
    }

    const recentMetrics = await db.select()
      .from(snmpMetrics)
      .where(eq(snmpMetrics.deviceId, snmpDevice.id))
      .orderBy(desc(snmpMetrics.timestamp))
      .limit(20);

    return c.json({
      enabled: snmpDevice.isActive || Number(networkMonitorActive?.count ?? 0) > 0,
      snmpDevice: {
        id: snmpDevice.id,
        snmpVersion: snmpDevice.snmpVersion,
        templateId: snmpDevice.templateId,
        pollingInterval: snmpDevice.pollingInterval,
        isActive: snmpDevice.isActive,
        lastPolled: snmpDevice.lastPolled?.toISOString() ?? null,
        lastStatus: snmpDevice.lastStatus
      },
      networkMonitors: {
        totalCount: Number(networkMonitorTotal?.count ?? 0),
        activeCount: Number(networkMonitorActive?.count ?? 0)
      },
      recentMetrics: recentMetrics.map(m => ({
        id: m.id,
        oid: m.oid,
        name: m.name,
        value: m.value,
        valueType: m.valueType,
        timestamp: m.timestamp.toISOString()
      }))
    });
  }
);

const updateMonitoringSchema = z.object({
  snmpVersion: z.enum(['v1', 'v2c', 'v3']).optional(),
  community: z.string().optional(),
  username: z.string().optional(),
  authProtocol: z.enum(['md5', 'sha', 'sha256']).optional(),
  authPassword: z.string().optional(),
  privProtocol: z.enum(['des', 'aes', 'aes256']).optional(),
  privPassword: z.string().optional(),
  templateId: z.string().uuid().nullable().optional(),
  pollingInterval: z.number().int().min(30).max(86400).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  isActive: z.boolean().optional()
});

discoveryRoutes.patch(
  '/assets/:id/monitoring',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateMonitoringSchema),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const body = c.req.valid('json');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [asset] = await db.select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId })
      .from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const [existing] = await db.select()
      .from(snmpDevices)
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId)))
      .limit(1);
    if (!existing) return c.json({ error: 'No monitoring configuration found for this asset' }, 404);

    const setValues: Record<string, unknown> = {};
    if (body.snmpVersion !== undefined) setValues.snmpVersion = body.snmpVersion;
    if (body.community !== undefined) setValues.community = body.community;
    if (body.username !== undefined) setValues.username = body.username;
    if (body.authProtocol !== undefined) setValues.authProtocol = body.authProtocol;
    if (body.authPassword !== undefined) setValues.authPassword = body.authPassword;
    if (body.privProtocol !== undefined) setValues.privProtocol = body.privProtocol;
    if (body.privPassword !== undefined) setValues.privPassword = body.privPassword;
    if (body.templateId !== undefined) setValues.templateId = body.templateId;
    if (body.pollingInterval !== undefined) setValues.pollingInterval = body.pollingInterval;
    if (body.port !== undefined) setValues.port = body.port;
    if (body.isActive !== undefined) setValues.isActive = body.isActive;

    if (Object.keys(setValues).length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    const [updated] = await db.update(snmpDevices)
      .set(setValues)
      .where(eq(snmpDevices.id, existing.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update monitoring configuration' }, 500);
    }

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: 'discovery.asset.update_monitoring',
      resourceType: 'discovered_asset',
      resourceId: assetId,
      details: { snmpDeviceId: updated.id, changes: Object.keys(setValues) }
    });

    return c.json({
      success: true,
      snmpDevice: {
        id: updated.id,
        snmpVersion: updated.snmpVersion,
        port: updated.port,
        community: updated.community ? '***' : null,
        username: updated.username ?? null,
        templateId: updated.templateId,
        pollingInterval: updated.pollingInterval,
        isActive: updated.isActive,
        lastPolled: updated.lastPolled?.toISOString() ?? null,
        lastStatus: updated.lastStatus
      }
    });
  }
);

// ==================== TOPOLOGY ROUTE ====================

discoveryRoutes.get(
  '/topology',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', topologyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const orgFilter = orgResult.orgId ? eq(discoveredAssets.orgId, orgResult.orgId) : undefined;

    const assets = await db.select().from(discoveredAssets).where(orgFilter);

    const edges = orgResult.orgId
      ? await db.select().from(networkTopology).where(eq(networkTopology.orgId, orgResult.orgId))
      : await db.select().from(networkTopology);

    const nodes = assets.map((a) => ({
      id: a.id,
      type: a.assetType,
      label: a.hostname ?? a.ipAddress ?? a.id,
      status: a.status,
      ipAddress: a.ipAddress,
      macAddress: a.macAddress
    }));

    return c.json({
      nodes,
      edges: edges.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        sourceType: e.sourceType,
        targetType: e.targetType,
        connectionType: e.connectionType,
        bandwidth: e.bandwidth,
        latency: e.latency
      }))
    });
  }
);
