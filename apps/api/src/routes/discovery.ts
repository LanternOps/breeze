import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { db } from '../db';
import {
  discoveryProfiles,
  discoveryJobs,
  discoveredAssets,
  networkTopology,
  topologyLayout,
  topologyManualNodes,
  sites,
  networkMonitors,
  snmpDevices,
  snmpAlertThresholds,
  snmpMetrics,
  devices
} from '../db/schema';
import { enqueueDiscoveryScan, getDiscoveryQueue } from '../jobs/discoveryWorker';
import { isRedisAvailable } from '../services/redis';
import { writeRouteAudit } from '../services/auditEvents';
import { isCronDue } from '../services/automationRuntime';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { createDiscoveryJobIfIdle } from '../services/discoveryJobCreation';
import {
  encryptSnmpCommunities,
  encryptSnmpCredentials,
  maskSnmpCommunities,
  maskSnmpCredentials,
  mergeEncryptSnmpCommunities,
  mergeEncryptSnmpCredentials,
} from '../services/snmpSecrets';

export const discoveryRoutes = new Hono();
const requireDiscoveryRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);
const requireDiscoveryWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);
const requireDiscoveryExecute = requirePermission(
  PERMISSIONS.DEVICES_EXECUTE.resource,
  PERMISSIONS.DEVICES_EXECUTE.action,
);
const requireTopologyRead = requirePermission(
  PERMISSIONS.TOPOLOGY_READ.resource,
  PERMISSIONS.TOPOLOGY_READ.action,
);
const requireTopologyWrite = requirePermission(
  PERMISSIONS.TOPOLOGY_WRITE.resource,
  PERMISSIONS.TOPOLOGY_WRITE.action,
);

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
      return { orgId: accessibleOrgIds[0]! } as const;
    }
    return { error: 'orgId is required when partner has multiple organizations', status: 400 } as const;
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
    orgResult.error === 'orgId is required when partner has multiple organizations'
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

async function validateRequestedDiscoveryAgent(
  agentId: string | undefined,
  profile: { orgId: string; siteId: string }
) {
  if (!agentId) return { ok: true } as const;

  const [agentDevice] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      agentId: devices.agentId,
      status: devices.status
    })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!agentDevice) {
    return { ok: false, error: 'Requested agent not found', status: 404 } as const;
  }

  if (agentDevice.orgId !== profile.orgId) {
    return { ok: false, error: 'Requested agent does not belong to the same organization as this profile', status: 403 } as const;
  }

  if (agentDevice.siteId !== profile.siteId) {
    return { ok: false, error: 'Requested agent does not belong to the same site as this profile', status: 403 } as const;
  }

  if (agentDevice.status !== 'online') {
    return { ok: false, error: 'Requested agent is not online', status: 409 } as const;
  }

  return { ok: true } as const;
}

function serializeDiscoveryProfile(profile: typeof discoveryProfiles.$inferSelect) {
  return {
    ...profile,
    snmpCommunities: maskSnmpCommunities(profile.snmpCommunities),
    snmpCredentials: maskSnmpCredentials(profile.snmpCredentials),
  };
}

/**
 * Site scope is enforced in the application layer; tenant RLS only scopes by
 * organization. A restricted caller must therefore have an explicit,
 * allowlisted site on every record. Missing/null site attribution fails closed.
 */
function canAccessRecordSite(
  permissions: UserPermissions | undefined,
  siteId: string | null | undefined,
): boolean {
  if (!permissions?.allowedSiteIds) return true;
  return typeof siteId === 'string' && canAccessSite(permissions, siteId);
}

function withVerifiedAssetLink<
  T extends { linkedDeviceId: string | null; linkSource: string | null },
>(asset: T, verifiedLinkedDeviceId: string | null | undefined): T {
  if (verifiedLinkedDeviceId) {
    return { ...asset, linkedDeviceId: verifiedLinkedDeviceId };
  }
  return { ...asset, linkedDeviceId: null, linkSource: null };
}

async function authorizeRequestedSite(
  orgId: string,
  siteId: string,
  permissions: UserPermissions | undefined,
) {
  if (!canAccessRecordSite(permissions, siteId)) {
    return { ok: false, error: 'Access to this site denied', status: 403 } as const;
  }

  const [site] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
    .limit(1);
  if (!site) return { ok: false, error: 'Site not found', status: 404 } as const;
  return { ok: true } as const;
}

async function authorizeAssetSet(
  orgId: string | null,
  assetIds: string[],
  permissions: UserPermissions | undefined,
) {
  const uniqueAssetIds = Array.from(new Set(assetIds));
  const conditions: SQL[] = [inArray(discoveredAssets.id, uniqueAssetIds)];
  if (orgId) conditions.push(eq(discoveredAssets.orgId, orgId));

  const assets = await db
    .select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      siteId: discoveredAssets.siteId,
    })
    .from(discoveredAssets)
    .where(and(...conditions));

  if (assets.length !== uniqueAssetIds.length) {
    return { ok: false, error: 'One or more assets not found', status: 404 } as const;
  }
  if (assets.some((asset) => !canAccessRecordSite(permissions, asset.siteId))) {
    return { ok: false, error: 'Access to this site denied', status: 403 } as const;
  }
  return { ok: true, assets } as const;
}

async function loadAuthorizedAsset(
  assetId: string,
  orgId: string | null,
  permissions: UserPermissions | undefined,
) {
  const conditions: SQL[] = [eq(discoveredAssets.id, assetId)];
  if (orgId) conditions.push(eq(discoveredAssets.orgId, orgId));

  const [asset] = await db
    .select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      siteId: discoveredAssets.siteId,
    })
    .from(discoveredAssets)
    .where(and(...conditions))
    .limit(1);

  if (!asset) return { ok: false, error: 'Asset not found', status: 404 } as const;
  if (!canAccessRecordSite(permissions, asset.siteId)) {
    return { ok: false, error: 'Access to this site denied', status: 403 } as const;
  }
  return { ok: true, asset } as const;
}

// --- Zod Schemas ---

const listProfilesSchema = z.object({
  orgId: z.string().guid().optional()
});

const scheduleSchema = z.object({
  type: z.enum(['manual', 'cron', 'interval']),
  cron: z.string().min(1).optional(),
  intervalMinutes: z.number().int().positive().optional(),
  timezone: z.string().min(1).optional()
}).refine((data) => {
  if (data.type === 'cron') return Boolean(data.cron);
  if (data.type === 'interval') return Boolean(data.intervalMinutes);
  return true;
}, { message: 'Schedule details required for selected type' }).superRefine((data, ctx) => {
  if (data.type !== 'cron' || !data.timezone) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: data.timezone });
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid schedule timezone',
      path: ['timezone']
    });
  }
});

const alertSettingsSchema = z.object({
  enabled: z.boolean(),
  alertOnNew: z.boolean(),
  alertOnDisappeared: z.boolean(),
  alertOnChanged: z.boolean(),
  changeRetentionDays: z.number().int().min(1).max(365)
}).optional();

const createProfileSchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid(),
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
  concurrency: z.number().int().positive().optional(),
  alertSettings: alertSettingsSchema
});

const scanSchema = z.object({
  profileId: z.string().guid(),
  agentId: z.string().optional(),
  orgId: z.string().guid().optional()
});

const listJobsSchema = z.object({
  orgId: z.string().guid().optional()
});

// --- Next-run helpers ---

function getNextCronOccurrence(cronExpr: string, timezone: string, from: Date): Date | null {
  // Walk minute-by-minute up to 7 days ahead
  const limit = 7 * 24 * 60;
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // start from next minute
  for (let i = 0; i < limit; i++) {
    if (isCronDue(cronExpr, timezone, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

function getNextIntervalRun(lastRunAt: Date | null, intervalMinutes: number, now: Date): Date {
  if (!lastRunAt) return now; // due immediately
  const next = new Date(lastRunAt.getTime() + intervalMinutes * 60 * 1000);
  return next > now ? next : now; // if overdue, due now
}

const listAssetsSchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  approvalStatus: z.enum(['pending', 'approved', 'dismissed']).optional(),
  assetType: z.enum([
    'workstation', 'server', 'printer', 'router', 'switch',
    'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
  ]).optional()
});

const linkAssetSchema = z.object({
  deviceId: z.string().guid()
});

const topologyQuerySchema = z.object({
  orgId: z.string().guid().optional()
});

// LOCKED body contract for the drag-to-save layout upsert (#1728). `siteId`
// scopes the upsert key (rows are unique per site_id/node_type/node_id) and is
// validated against the caller's site access; `orgId` is server-derived via
// resolveOrgId. Each accepted position becomes an upsert with pinned=true.
const layoutPatchSchema = z.object({
  siteId: z.string().guid(),
  orgId: z.string().guid().optional(),
  positions: z.array(z.object({
    nodeType: z.enum(['discovered_asset', 'manual_node']),
    nodeId: z.string().guid(),
    x: z.number().finite(),
    y: z.number().finite(),
  })).min(1).max(2000),
});

// Manual topology placeholder node (#1728 phase 4). `orgId` is server-derived via
// resolveOrgId; `siteId` is validated against the resolved org + caller site access.
const manualNodeRoleSchema = z.enum(['switch', 'router', 'ap', 'firewall', 'patch_panel', 'other']);
const createManualNodeSchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid(),
  label: z.string().trim().min(1).max(255),
  role: manualNodeRoleSchema,
  notes: z.string().trim().max(2000).optional(),
});

// Manual topology edge (#1728 phase 4). Each endpoint is an asset/manual-node in
// the resolved (org, site); `orgId` is server-derived via resolveOrgId.
const manualEdgeEndpointSchema = z.object({
  type: z.enum(['discovered_asset', 'manual_node']),
  id: z.string().guid(),
});
const createManualEdgeSchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid(),
  source: manualEdgeEndpointSchema,
  target: manualEdgeEndpointSchema,
});

const bulkApproveSchema = z.object({
  assetIds: z.array(z.string().guid()).min(1).max(200)
});

const bulkDismissSchema = z.object({
  assetIds: z.array(z.string().guid()).min(1).max(200)
});

const updateAssetSchema = z.object({
  // null clears the display name — the edit form sends `label: null` for an
  // empty Display Name field, so this must be nullable, not just optional.
  label: z.string().max(255).nullish(),
  notes: z.string().nullish(),
  tags: z.string().array().optional(),
  // NOTE: keep this list literal — do NOT derive it from `discoveredAssetTypeEnum.enumValues`.
  // Several sibling tests fully mock '../db/schema' (vi.mock without importOriginal), so a
  // runtime reference to the enum here makes this module throw at import in those suites
  // (green locally, red in the full CI run — see #1424 / partner_multi_org_orgid.test.ts).
  assetType: z.enum([
    'workstation', 'server', 'printer', 'router', 'switch', 'firewall',
    'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
  ]).optional(),
  resetTypeToAuto: z.boolean().optional()
}).refine(
  (v) => !(v.assetType !== undefined && v.resetTypeToAuto === true),
  { message: 'assetType and resetTypeToAuto are mutually exclusive' }
);

// --- Routes ---

discoveryRoutes.use('*', authMiddleware);

// ==================== PROFILE ROUTES ====================

discoveryRoutes.get(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryRead,
  zValidator('query', listProfilesSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: SQL[] = [];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));
    if (permissions?.allowedSiteIds) {
      if (permissions.allowedSiteIds.length === 0) return c.json({ data: [] });
      conditions.push(inArray(discoveryProfiles.siteId, permissions.allowedSiteIds));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const results = await db.select({
      profile: discoveryProfiles,
      lastRunAt: sql<string | null>`(
        select max(${discoveryJobs.completedAt})
        from ${discoveryJobs}
        where ${discoveryJobs.profileId} = ${discoveryProfiles.id}
          and ${discoveryJobs.status} = 'completed'
      )`.as('last_run_at')
    }).from(discoveryProfiles)
      .where(where)
      .orderBy(desc(discoveryProfiles.createdAt));

    return c.json({
      data: results.filter((row) => canAccessRecordSite(permissions, row.profile.siteId)).map((row) => {
        const p = row.profile;
        return {
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
          alertSettings: p.alertSettings ?? null,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
          lastRunAt: row.lastRunAt ? new Date(row.lastRunAt).toISOString() : null
        };
      })
    });
  }
);

discoveryRoutes.post(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  zValidator('json', createProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const siteAuthorization = await authorizeRequestedSite(
      orgResult.orgId!,
      body.siteId,
      permissions,
    );
    if (!siteAuthorization.ok) {
      return c.json({ error: siteAuthorization.error }, siteAuthorization.status);
    }

    const [profile] = await db.insert(discoveryProfiles).values({
      orgId: orgResult.orgId!,
      siteId: body.siteId,
      name: body.name,
      description: body.description ?? null,
      subnets: body.subnets,
      excludeIps: body.excludeIps ?? [],
      methods: body.methods as any,
      portRanges: body.portRanges ?? null,
      snmpCommunities: encryptSnmpCommunities(body.snmpCommunities) ?? [],
      snmpCredentials: body.snmpCredentials === undefined ? null : encryptSnmpCredentials(body.snmpCredentials),
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

    return c.json(profile ? serializeDiscoveryProfile(profile) : profile, 201);
  }
);

discoveryRoutes.get(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryRead,
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const profileId = c.req.param('id')!;
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [profile] = await db.select().from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!profile) return c.json({ error: 'Profile not found' }, 404);
    if (!canAccessRecordSite(permissions, profile.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    return c.json(serializeDiscoveryProfile(profile));
  }
);

discoveryRoutes.patch(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  zValidator('json', updateProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const profileId = c.req.param('id')!;
    const updates = c.req.valid('json');
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveryProfiles.id,
      siteId: discoveryProfiles.siteId,
      snmpCommunities: discoveryProfiles.snmpCommunities,
      snmpCredentials: discoveryProfiles.snmpCredentials,
    }).from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Profile not found' }, 404);
    if (!canAccessRecordSite(permissions, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.subnets !== undefined) setValues.subnets = updates.subnets;
    if (updates.excludeIps !== undefined) setValues.excludeIps = updates.excludeIps;
    if (updates.methods !== undefined) setValues.methods = updates.methods;
    if (updates.portRanges !== undefined) setValues.portRanges = updates.portRanges;
    if (updates.snmpCommunities !== undefined) setValues.snmpCommunities = mergeEncryptSnmpCommunities(updates.snmpCommunities, existing.snmpCommunities);
    if (updates.snmpCredentials !== undefined) setValues.snmpCredentials = mergeEncryptSnmpCredentials(updates.snmpCredentials, existing.snmpCredentials);
    if (updates.schedule !== undefined) setValues.schedule = updates.schedule;
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;
    if (updates.deepScan !== undefined) setValues.deepScan = updates.deepScan;
    if (updates.identifyOS !== undefined) setValues.identifyOS = updates.identifyOS;
    if (updates.resolveHostnames !== undefined) setValues.resolveHostnames = updates.resolveHostnames;
    if (updates.timeout !== undefined) setValues.timeout = updates.timeout;
    if (updates.concurrency !== undefined) setValues.concurrency = updates.concurrency;
    if (updates.alertSettings !== undefined) setValues.alertSettings = updates.alertSettings;

    const [updated] = await db.update(discoveryProfiles)
      .set(setValues)
      .where(eq(discoveryProfiles.id, profileId))
      .returning();

    // 0-row write despite the prior access-checked SELECT => RLS rejection or a
    // race. Surface it rather than returning 200 + null (a silent failure).
    if (!updated) {
      return c.json({ error: 'Failed to update discovery profile' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'discovery.profile.update',
      resourceType: 'discovery_profile',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { changedFields: Object.keys(updates) }
    });

    return c.json(serializeDiscoveryProfile(updated));
  }
);

discoveryRoutes.delete(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const profileId = c.req.param('id')!;
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveryProfiles.id,
      orgId: discoveryProfiles.orgId,
      siteId: discoveryProfiles.siteId,
      name: discoveryProfiles.name
    }).from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Profile not found' }, 404);
    if (!canAccessRecordSite(permissions, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

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
  requireDiscoveryExecute,
  requireMfa(),
  zValidator('json', scanSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId ?? c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryProfiles.id, body.profileId)];
    if (orgResult.orgId) conditions.push(eq(discoveryProfiles.orgId, orgResult.orgId));

    const [profile] = await db.select().from(discoveryProfiles)
      .where(and(...conditions)).limit(1);
    if (!profile) return c.json({ error: 'Profile not found' }, 404);
    if (!canAccessRecordSite(permissions, profile.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const requestedAgentValidation = await validateRequestedDiscoveryAgent(body.agentId, {
      orgId: profile.orgId,
      siteId: profile.siteId
    });
    if (!requestedAgentValidation.ok) {
      return c.json({ error: requestedAgentValidation.error }, requestedAgentValidation.status);
    }

    const created = await createDiscoveryJobIfIdle({
      profileId: profile.id,
      orgId: profile.orgId,
      siteId: profile.siteId,
      agentId: body.agentId ?? null,
    });
    const job = created?.job;
    if (!job) return c.json({ error: 'Failed to create job' }, 500);
    if (!created.created) {
      return c.json({ error: 'A discovery job is already scheduled or running for this profile', jobId: job.id }, 409);
    }

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
  requireDiscoveryRead,
  zValidator('query', listJobsSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const jobConditions: SQL[] = [];
    if (orgResult.orgId) jobConditions.push(eq(discoveryJobs.orgId, orgResult.orgId));
    if (permissions?.allowedSiteIds) {
      if (permissions.allowedSiteIds.length === 0) return c.json({ data: [] });
      jobConditions.push(inArray(discoveryJobs.siteId, permissions.allowedSiteIds));
    }
    const where = jobConditions.length > 0 ? and(...jobConditions) : undefined;

    const results = await db
      .select({
        id: discoveryJobs.id,
        orgId: discoveryJobs.orgId,
        siteId: discoveryJobs.siteId,
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

    type JobRow = {
      id: string;
      orgId: string;
      siteId: string;
      profileId: string | null;
      profileName: string | null;
      agentId: string | null;
      status: string;
      scheduledAt: string | null;
      startedAt: string | null;
      completedAt: string | null;
      hostsScanned: number | null;
      hostsDiscovered: number | null;
      newAssets: number | null;
      errors: unknown;
      createdAt: string;
    };

    const jobRows: JobRow[] = results.filter((job) => canAccessRecordSite(permissions, job.siteId)).map((j) => ({
      ...j,
      status: j.status as string,
      createdAt: j.createdAt.toISOString(),
      scheduledAt: j.scheduledAt?.toISOString() ?? null,
      startedAt: j.startedAt?.toISOString() ?? null,
      completedAt: j.completedAt?.toISOString() ?? null
    }));

    // Build synthetic "pending" rows for the next scheduled run of each active profile
    const profileWhere: SQL[] = [eq(discoveryProfiles.enabled, true)];
    if (orgResult.orgId) profileWhere.push(eq(discoveryProfiles.orgId, orgResult.orgId));
    if (permissions?.allowedSiteIds) {
      profileWhere.push(inArray(discoveryProfiles.siteId, permissions.allowedSiteIds));
    }

    const activeProfiles = await db
      .select({
        id: discoveryProfiles.id,
        orgId: discoveryProfiles.orgId,
        siteId: discoveryProfiles.siteId,
        name: discoveryProfiles.name,
        schedule: discoveryProfiles.schedule
      })
      .from(discoveryProfiles)
      .where(and(...profileWhere));

    // Profiles that already have a scheduled/running job don't need a pending row
    const activeProfileIds = new Set(
      jobRows
        .filter((j) => j.status === 'scheduled' || j.status === 'running')
        .map((j) => j.profileId)
    );

    const now = new Date();
    const pendingRows: typeof jobRows = [];

    for (const profile of activeProfiles.filter((entry) => canAccessRecordSite(permissions, entry.siteId))) {
      if (activeProfileIds.has(profile.id)) continue;

      const sched = profile.schedule as { type?: string; cron?: string; intervalMinutes?: number; timezone?: string } | null;
      if (!sched || sched.type === 'manual') continue;

      let nextRunAt: Date | null = null;

      if (sched.type === 'interval' && sched.intervalMinutes) {
        // Find the most recent job for this profile to compute next interval
        const lastJob = jobRows.find((j) => j.profileId === profile.id);
        const lastRunAt = lastJob?.scheduledAt ? new Date(lastJob.scheduledAt) : null;
        nextRunAt = getNextIntervalRun(lastRunAt, sched.intervalMinutes, now);
      } else if (sched.type === 'cron' && sched.cron) {
        const tz = sched.timezone || 'UTC';
        nextRunAt = getNextCronOccurrence(sched.cron, tz, now);
      }

      if (nextRunAt) {
        pendingRows.push({
          id: `next-${profile.id}`,
          orgId: profile.orgId,
          siteId: profile.siteId,
          profileId: profile.id,
          profileName: profile.name,
          agentId: null,
          status: 'pending',
          scheduledAt: nextRunAt.toISOString(),
          startedAt: null,
          completedAt: null,
          hostsScanned: null,
          hostsDiscovered: null,
          newAssets: null,
          errors: null,
          createdAt: nextRunAt.toISOString()
        });
      }
    }

    // Pending rows go first, then real jobs by createdAt desc
    return c.json({ data: [...pendingRows, ...jobRows] });
  }
);

discoveryRoutes.get(
  '/jobs/:id',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryRead,
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const jobId = c.req.param('id')!;
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryJobs.id, jobId)];
    if (orgResult.orgId) conditions.push(eq(discoveryJobs.orgId, orgResult.orgId));

    const [job] = await db.select().from(discoveryJobs)
      .where(and(...conditions)).limit(1);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    if (!canAccessRecordSite(permissions, job.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const assetRows = await db
      .select({ asset: discoveredAssets, linkedDeviceId: devices.id })
      .from(discoveredAssets)
      .leftJoin(devices, and(
        eq(discoveredAssets.linkedDeviceId, devices.id),
        eq(discoveredAssets.orgId, devices.orgId),
        eq(discoveredAssets.siteId, devices.siteId),
      ))
      .where(and(
        eq(discoveredAssets.lastJobId, jobId),
        eq(discoveredAssets.orgId, job.orgId),
        eq(discoveredAssets.siteId, job.siteId),
      ));
    const assets = assetRows
      .filter((row) => row.asset.orgId === job.orgId
        && row.asset.siteId === job.siteId
        && canAccessRecordSite(permissions, row.asset.siteId))
      .map((row) => withVerifiedAssetLink(row.asset, row.linkedDeviceId));

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
  requireDiscoveryExecute,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const jobId = c.req.param('id')!;
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveryJobs.id, jobId)];
    if (orgResult.orgId) conditions.push(eq(discoveryJobs.orgId, orgResult.orgId));

    const [job] = await db.select().from(discoveryJobs)
      .where(and(...conditions)).limit(1);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    if (!canAccessRecordSite(permissions, job.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

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
  requireDiscoveryRead,
  zValidator('query', listAssetsSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: SQL[] = [];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));
    if (query.siteId) {
      if (perms?.allowedSiteIds && !canAccessSite(perms, query.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      conditions.push(eq(discoveredAssets.siteId, query.siteId));
    } else if (perms?.allowedSiteIds) {
      if (perms.allowedSiteIds.length === 0) {
        return c.json({ data: [] });
      }
      conditions.push(inArray(discoveredAssets.siteId, perms.allowedSiteIds));
    }
    if (query.approvalStatus) conditions.push(eq(discoveredAssets.approvalStatus, query.approvalStatus));
    if (query.assetType) conditions.push(eq(discoveredAssets.assetType, query.assetType));

    const where = conditions.length ? and(...conditions) : undefined;
    const results = await db
      .select({
        asset: discoveredAssets,
        snmpMonitoringEnabled: sql<boolean>`exists (
          select 1
          from ${snmpDevices}
          where ${snmpDevices.assetId} = ${discoveredAssets.id}
            and ${snmpDevices.orgId} = ${discoveredAssets.orgId}
            and ${snmpDevices.isActive} = true
        )`,
        networkMonitoringEnabled: sql<boolean>`exists (
          select 1
          from ${networkMonitors}
          where ${networkMonitors.assetId} = ${discoveredAssets.id}
            and ${networkMonitors.orgId} = ${discoveredAssets.orgId}
            and ${networkMonitors.isActive} = true
        )`,
        linkedDeviceId: devices.id,
        linkedDeviceHostname: devices.hostname,
        linkedDeviceDisplayName: devices.displayName,
        profileId: discoveryProfiles.id,
        profileName: discoveryProfiles.name,
        profileSubnets: discoveryProfiles.subnets
      })
      .from(discoveredAssets)
      .leftJoin(devices, and(
        eq(discoveredAssets.linkedDeviceId, devices.id),
        eq(discoveredAssets.orgId, devices.orgId),
        eq(discoveredAssets.siteId, devices.siteId),
      ))
      .leftJoin(discoveryJobs, eq(discoveredAssets.lastJobId, discoveryJobs.id))
      .leftJoin(discoveryProfiles, eq(discoveryJobs.profileId, discoveryProfiles.id))
      .where(where)
      .orderBy(desc(discoveredAssets.lastSeenAt));

    return c.json({
      data: results.map((row) => {
        const a = row.asset;
        return {
          id: a.id,
          orgId: a.orgId,
          assetType: a.assetType,
          approvalStatus: a.approvalStatus,
          isOnline: a.isOnline,
          hostname: a.hostname,
          label: a.label,
          ipAddress: a.ipAddress,
          macAddress: a.macAddress,
          manufacturer: a.manufacturer,
          model: a.model,
          openPorts: a.openPorts,
          snmpData: a.snmpData,
          responseTimeMs: a.responseTimeMs,
          linkedDeviceId: row.linkedDeviceId ?? null,
          linkedDeviceName: row.linkedDeviceDisplayName ?? row.linkedDeviceHostname ?? null,
          linkSource: row.linkedDeviceId ? a.linkSource : null,
          typeSource: a.typeSource,
          detectedAssetType: a.detectedAssetType,
          snmpMonitoringEnabled: Boolean(row.snmpMonitoringEnabled),
          networkMonitoringEnabled: Boolean(row.networkMonitoringEnabled),
          monitoringEnabled: Boolean(row.snmpMonitoringEnabled) || Boolean(row.networkMonitoringEnabled),
          discoveryMethods: a.discoveryMethods,
          profileId: row.profileId ?? null,
          profileName: row.profileName ?? null,
          profileSubnets: row.profileSubnets ?? null,
          notes: a.notes,
          tags: a.tags,
          firstSeenAt: a.firstSeenAt.toISOString(),
          lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString()
        };
      })
    });
  }
);

// GET /assets/:id — single discovered asset detail (topology node click + the
// `?asset=` deep link both fetch by id). Mirrors the list serialization for one
// row, scoped by resolveOrgIdForAsset so partner/system callers resolve the org
// from the asset when no orgId is supplied. The sibling bulk routes are POST, so
// this GET never shadows them. (#1728)
discoveryRoutes.get(
  '/assets/:id',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryRead,
  zValidator('query', z.object({ orgId: z.string().guid().optional() })),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;
    const { orgId: requestedOrgId } = c.req.valid('query');

    const orgResult = await resolveOrgIdForAsset(auth, assetId, requestedOrgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: SQL[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [row] = await db
      .select({
        asset: discoveredAssets,
        snmpMonitoringEnabled: sql<boolean>`exists (
          select 1
          from ${snmpDevices}
          where ${snmpDevices.assetId} = ${discoveredAssets.id}
            and ${snmpDevices.orgId} = ${discoveredAssets.orgId}
            and ${snmpDevices.isActive} = true
        )`,
        networkMonitoringEnabled: sql<boolean>`exists (
          select 1
          from ${networkMonitors}
          where ${networkMonitors.assetId} = ${discoveredAssets.id}
            and ${networkMonitors.orgId} = ${discoveredAssets.orgId}
            and ${networkMonitors.isActive} = true
        )`,
        linkedDeviceId: devices.id,
        linkedDeviceHostname: devices.hostname,
        linkedDeviceDisplayName: devices.displayName,
        profileId: discoveryProfiles.id,
        profileName: discoveryProfiles.name,
        profileSubnets: discoveryProfiles.subnets
      })
      .from(discoveredAssets)
      .leftJoin(devices, and(
        eq(discoveredAssets.linkedDeviceId, devices.id),
        eq(discoveredAssets.orgId, devices.orgId),
        eq(discoveredAssets.siteId, devices.siteId),
      ))
      .leftJoin(discoveryJobs, eq(discoveredAssets.lastJobId, discoveryJobs.id))
      .leftJoin(discoveryProfiles, eq(discoveryJobs.profileId, discoveryProfiles.id))
      .where(and(...conditions))
      .limit(1);

    if (!row) return c.json({ error: 'Asset not found' }, 404);

    // Site-scope is an app-layer-only authz axis; RLS does not defend it.
    if (!canAccessRecordSite(perms, row.asset.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const a = row.asset;
    return c.json({
      data: {
        id: a.id,
        orgId: a.orgId,
        siteId: a.siteId,
        assetType: a.assetType,
        approvalStatus: a.approvalStatus,
        isOnline: a.isOnline,
        hostname: a.hostname,
        label: a.label,
        ipAddress: a.ipAddress,
        macAddress: a.macAddress,
        manufacturer: a.manufacturer,
        model: a.model,
        openPorts: a.openPorts,
        osFingerprint: a.osFingerprint,
        snmpData: a.snmpData,
        responseTimeMs: a.responseTimeMs,
        linkedDeviceId: row.linkedDeviceId ?? null,
        linkedDeviceName: row.linkedDeviceDisplayName ?? row.linkedDeviceHostname ?? null,
        linkSource: row.linkedDeviceId ? a.linkSource : null,
        typeSource: a.typeSource,
        detectedAssetType: a.detectedAssetType,
        snmpMonitoringEnabled: Boolean(row.snmpMonitoringEnabled),
        networkMonitoringEnabled: Boolean(row.networkMonitoringEnabled),
        monitoringEnabled: Boolean(row.snmpMonitoringEnabled) || Boolean(row.networkMonitoringEnabled),
        discoveryMethods: a.discoveryMethods,
        profileId: row.profileId ?? null,
        profileName: row.profileName ?? null,
        profileSubnets: row.profileSubnets ?? null,
        notes: a.notes,
        tags: a.tags,
        firstSeenAt: a.firstSeenAt.toISOString(),
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString()
      }
    });
  }
);

// POST /assets/bulk-approve — MUST be before /assets/:id routes
discoveryRoutes.post(
  '/assets/bulk-approve',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  zValidator('json', bulkApproveSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const { assetIds } = c.req.valid('json');
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const authorization = await authorizeAssetSet(orgResult.orgId, assetIds, permissions);
    if (!authorization.ok) return c.json({ error: authorization.error }, authorization.status);

    const conditions: SQL[] = [inArray(discoveredAssets.id, assetIds)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const updated = await db
      .update(discoveredAssets)
      .set({
        approvalStatus: 'approved',
        approvedBy: auth.user?.id ?? null,
        approvedAt: new Date()
      })
      .where(and(...conditions))
      .returning({ id: discoveredAssets.id });

    return c.json({ approvedCount: updated.length });
  }
);

// POST /assets/bulk-dismiss — MUST be before /assets/:id routes
discoveryRoutes.post(
  '/assets/bulk-dismiss',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  zValidator('json', bulkDismissSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const { assetIds } = c.req.valid('json');
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const authorization = await authorizeAssetSet(orgResult.orgId, assetIds, permissions);
    if (!authorization.ok) return c.json({ error: authorization.error }, authorization.status);

    const conditions: SQL[] = [inArray(discoveredAssets.id, assetIds)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const updated = await db
      .update(discoveredAssets)
      .set({
        approvalStatus: 'dismissed',
        dismissedBy: auth.user?.id ?? null,
        dismissedAt: new Date()
      })
      .where(and(...conditions))
      .returning({ id: discoveredAssets.id });

    return c.json({ dismissedCount: updated.length });
  }
);

// PATCH /assets/:id — Update label, notes, tags
discoveryRoutes.patch(
  '/assets/:id',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  zValidator('json', updateAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;
    const updates = c.req.valid('json');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    if (permissions?.allowedSiteIds) {
      const authorization = await loadAuthorizedAsset(assetId, orgResult.orgId, permissions);
      if (!authorization.ok) return c.json({ error: authorization.error }, authorization.status);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const conditions: SQL[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.label !== undefined) setValues.label = updates.label;
    if (updates.notes !== undefined) setValues.notes = updates.notes;
    if (updates.tags !== undefined) setValues.tags = updates.tags;
    if (updates.assetType !== undefined) {
      setValues.assetType = updates.assetType;
      setValues.typeSource = 'manual';
    }
    if (updates.resetTypeToAuto) {
      // Restore the scan's last classification; fall back to current type if
      // the asset was never auto-classified (detectedAssetType still null).
      setValues.assetType = sql`coalesce(${discoveredAssets.detectedAssetType}, ${discoveredAssets.assetType})`;
      setValues.typeSource = 'auto';
    }

    if (Object.keys(setValues).length === 1) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const [updated] = await db.update(discoveredAssets)
      .set(setValues)
      .where(and(...conditions))
      .returning();

    if (!updated) return c.json({ error: 'Asset not found' }, 404);

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'discovery.asset.update',
      resourceType: 'discovered_asset',
      resourceId: updated.id,
      resourceName: updated.label ?? updated.hostname ?? updated.ipAddress ?? undefined,
      details: { changedFields: Object.keys(updates) }
    });

    let verifiedLinkedDeviceId: string | null = null;
    if (updated.linkedDeviceId && updated.siteId) {
      const [linkedDevice] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(
          eq(devices.id, updated.linkedDeviceId),
          eq(devices.orgId, updated.orgId),
          eq(devices.siteId, updated.siteId),
        ))
        .limit(1);
      verifiedLinkedDeviceId = linkedDevice?.id ?? null;
    }

    return c.json(withVerifiedAssetLink(updated, verifiedLinkedDeviceId));
  }
);

discoveryRoutes.post(
  '/assets/:id/link',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  zValidator('json', linkAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id')!;
    const body = c.req.valid('json');
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      siteId: discoveredAssets.siteId
    }).from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Asset not found' }, 404);

    const [targetDevice] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId
      })
      .from(devices)
      .where(eq(devices.id, body.deviceId))
      .limit(1);

    if (!targetDevice) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (!canAccessRecordSite(perms, existing.siteId) || !canAccessRecordSite(perms, targetDevice.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    if (targetDevice.orgId !== existing.orgId) {
      return c.json({ error: 'Device does not belong to the same organization as this asset' }, 403);
    }

    if (targetDevice.siteId !== existing.siteId) {
      return c.json({ error: 'Device does not belong to the same site as this asset' }, 403);
    }

    const [updated] = await db.update(discoveredAssets)
      .set({
        approvalStatus: 'approved',
        linkedDeviceId: body.deviceId,
        linkSource: 'manual',
        updatedAt: new Date()
      })
      .where(eq(discoveredAssets.id, assetId))
      .returning();

    // 0-row write despite the prior access-checked SELECT => RLS rejection or a
    // race. Surface it rather than returning 200 + null (a silent failure).
    if (!updated) {
      return c.json({ error: 'Failed to link discovered asset' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'discovery.asset.link',
      resourceType: 'discovered_asset',
      resourceId: updated.id,
      resourceName: updated.hostname ?? updated.ipAddress ?? undefined,
      details: { linkedDeviceId: body.deviceId }
    });

    return c.json(updated);
  }
);

discoveryRoutes.delete(
  '/assets/:id/link',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id')!;
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: SQL[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      siteId: discoveredAssets.siteId,
      hostname: discoveredAssets.hostname,
      ipAddress: discoveredAssets.ipAddress,
      linkedDeviceId: discoveredAssets.linkedDeviceId,
      linkSource: discoveredAssets.linkSource
    }).from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Asset not found' }, 404);

    // Site-scope is an app-layer-only authz axis; RLS does not defend it.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (!canAccessRecordSite(perms, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Already unlinked: idempotent no-op.
    if (!existing.linkedDeviceId) {
      return c.json(existing);
    }

    // Only manually-created links may be removed here.
    if (existing.linkSource !== 'manual') {
      return c.json({ error: 'Only manually linked assets can be unlinked' }, 403);
    }

    const previousDeviceId = existing.linkedDeviceId;
    // Scope the write to the same conditions as the read (id + org) so read- and
    // write-scope match. A 0-row result here means the row vanished or was
    // re-scoped between the select and update — treat it as not-found and
    // audit nothing, rather than recording a misleading "unlink" success.
    const [updated] = await db.update(discoveredAssets)
      .set({
        linkedDeviceId: null,
        linkSource: null,
        updatedAt: new Date()
      })
      .where(and(...conditions))
      .returning();

    if (!updated) return c.json({ error: 'Asset not found' }, 404);

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'discovery.asset.unlink',
      resourceType: 'discovered_asset',
      resourceId: updated.id,
      resourceName: updated.hostname ?? updated.ipAddress ?? undefined,
      details: { previousLinkedDeviceId: previousDeviceId }
    });

    return c.json(updated);
  }
);

// PATCH /assets/:id/approve
discoveryRoutes.patch(
  '/assets/:id/approve',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id')!;
    const orgResult = await resolveOrgIdForAsset(auth, id);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    if (permissions?.allowedSiteIds) {
      const authorization = await loadAuthorizedAsset(id, orgResult.orgId, permissions);
      if (!authorization.ok) return c.json({ error: authorization.error }, authorization.status);
    }

    const conditions: SQL[] = [eq(discoveredAssets.id, id)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const updated = await db
      .update(discoveredAssets)
      .set({
        approvalStatus: 'approved',
        approvedBy: auth.user?.id ?? null,
        approvedAt: new Date()
      })
      .where(and(...conditions))
      .returning({ id: discoveredAssets.id });

    if (updated.length === 0) return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
  }
);

// PATCH /assets/:id/dismiss
discoveryRoutes.patch(
  '/assets/:id/dismiss',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id')!;
    const orgResult = await resolveOrgIdForAsset(auth, id);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    if (permissions?.allowedSiteIds) {
      const authorization = await loadAuthorizedAsset(id, orgResult.orgId, permissions);
      if (!authorization.ok) return c.json({ error: authorization.error }, authorization.status);
    }

    const conditions: SQL[] = [eq(discoveredAssets.id, id)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const updated = await db
      .update(discoveredAssets)
      .set({
        approvalStatus: 'dismissed',
        dismissedBy: auth.user?.id ?? null,
        dismissedAt: new Date()
      })
      .where(and(...conditions))
      .returning({ id: discoveredAssets.id });

    if (updated.length === 0) return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
  }
);

discoveryRoutes.delete(
  '/assets/:id',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id')!;
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: ReturnType<typeof eq>[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      siteId: discoveredAssets.siteId,
      hostname: discoveredAssets.hostname,
      ipAddress: discoveredAssets.ipAddress
    }).from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Asset not found' }, 404);

    // Site-scope is an app-layer-only authz axis; RLS does not defend it.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (!canAccessRecordSite(perms, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

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
      // Remove any saved topology layout positions for this asset (#1728).
      await tx.delete(topologyLayout).where(
        and(
          eq(topologyLayout.orgId, existing.orgId),
          eq(topologyLayout.nodeType, 'discovered_asset'),
          eq(topologyLayout.nodeId, assetId),
        ),
      );
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

// Monitoring is managed via the dedicated /monitoring routes.

// ==================== TOPOLOGY ROUTE ====================

discoveryRoutes.get(
  '/topology',
  requireScope('organization', 'partner', 'system'),
  requireTopologyRead,
  zValidator('query', topologyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const assetConditions: SQL[] = [];
    if (orgResult.orgId) assetConditions.push(eq(discoveredAssets.orgId, orgResult.orgId));
    if (permissions?.allowedSiteIds) {
      if (permissions.allowedSiteIds.length === 0) {
        return c.json({ nodes: [], subnets: [], layout: [], edges: [] });
      }
      assetConditions.push(inArray(discoveredAssets.siteId, permissions.allowedSiteIds));
    }
    const orgFilter = assetConditions.length > 0 ? and(...assetConditions) : undefined;

    const assets = (await db.select().from(discoveredAssets).where(orgFilter))
      .filter((asset) => canAccessRecordSite(permissions, asset.siteId));

    const edgeConditions: SQL[] = [];
    if (orgResult.orgId) edgeConditions.push(eq(networkTopology.orgId, orgResult.orgId));
    if (permissions?.allowedSiteIds) {
      edgeConditions.push(inArray(networkTopology.siteId, permissions.allowedSiteIds));
    }
    const edges = (edgeConditions.length > 0
      ? await db.select().from(networkTopology).where(and(...edgeConditions))
      : await db.select().from(networkTopology))
      .filter((edge) => canAccessRecordSite(permissions, edge.siteId));

    // The honest topology view groups assets by the subnet they actually belong
    // to. We surface the discovery-profile CIDRs so the client can group by the
    // correct mask (e.g. a /23 or /16) instead of guessing a /24 from the IP.
    const profileRows = await db
      .select({ subnets: discoveryProfiles.subnets, siteId: discoveryProfiles.siteId })
      .from(discoveryProfiles)
      .where(and(
        ...(orgResult.orgId ? [eq(discoveryProfiles.orgId, orgResult.orgId)] : []),
        ...(permissions?.allowedSiteIds
          ? [inArray(discoveryProfiles.siteId, permissions.allowedSiteIds)]
          : []),
      ));
    const subnets = Array.from(
      new Set(
        profileRows.filter((profile) => canAccessRecordSite(permissions, profile.siteId)).flatMap((p) =>
          (p.subnets ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
        )
      )
    );

    // Saved Cytoscape node positions (#1728). Org-scoped, mirroring the edges query.
    const layoutConditions: SQL[] = [];
    if (orgResult.orgId) layoutConditions.push(eq(topologyLayout.orgId, orgResult.orgId));
    if (permissions?.allowedSiteIds) {
      layoutConditions.push(inArray(topologyLayout.siteId, permissions.allowedSiteIds));
    }
    const layoutRows = (layoutConditions.length > 0
      ? await db.select().from(topologyLayout).where(and(...layoutConditions))
      : await db.select().from(topologyLayout))
      .filter((entry) => canAccessRecordSite(permissions, entry.siteId));

    // Hand-mapped placeholder nodes (#1728 phase 4). Org-scoped like the rest;
    // never touched by scan reconciliation. Surfaced alongside discovered nodes.
    const manualNodeConditions: SQL[] = [];
    if (orgResult.orgId) manualNodeConditions.push(eq(topologyManualNodes.orgId, orgResult.orgId));
    if (permissions?.allowedSiteIds) {
      manualNodeConditions.push(inArray(topologyManualNodes.siteId, permissions.allowedSiteIds));
    }
    const manualNodes = (manualNodeConditions.length > 0
      ? await db.select().from(topologyManualNodes).where(and(...manualNodeConditions))
      : await db.select().from(topologyManualNodes))
      .filter((node) => canAccessRecordSite(permissions, node.siteId));

    const nodes = [
      ...assets.map((a) => ({
        id: a.id,
        type: a.assetType,
        label: a.label ?? a.hostname ?? a.ipAddress ?? a.id,
        status: a.isOnline ? 'online' : 'offline',
        approvalStatus: a.approvalStatus,
        ipAddress: a.ipAddress,
        macAddress: a.macAddress,
        // Each node carries its own siteId so the client can scope the
        // layout PATCH per (site_id, node_type, node_id) (#1728).
        siteId: a.siteId,
        kind: 'discovered' as const,
      })),
      ...manualNodes.map((m) => ({
        id: m.id,
        type: m.role,
        label: m.label,
        siteId: m.siteId,
        kind: 'manual' as const,
      })),
    ];

    return c.json({
      nodes,
      subnets,
      layout: layoutRows.map((l) => ({
        nodeType: l.nodeType as 'discovered_asset' | 'manual_node',
        nodeId: l.nodeId,
        x: l.x,
        y: l.y,
        pinned: l.pinned,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        type: e.connectionType,
        sourceType: e.sourceType,
        targetType: e.targetType,
        bandwidth: e.bandwidth,
        latency: e.latency,
        observedAt: e.lastVerifiedAt?.toISOString() ?? null,
        method: e.method ?? null,
        confidence: e.confidence ?? null,
        interfaceName: e.interfaceName ?? null,
        vlan: e.vlan ?? null,
        createdBy: e.createdBy ?? null,
        inferred:
          e.sourceType === 'discovered_asset' &&
          e.targetType === 'discovered_asset' &&
          (e.connectionType === 'ethernet' || e.connectionType === 'routed')
      }))
    });
  }
);

// PATCH /discovery/topology/layout — batch upsert saved node positions
// (drag-to-save, #1728). Runs on the request `db` so writes are RLS-scoped to the
// caller (org/site server-derived); never a bare/system pool (silent 0-row class).
discoveryRoutes.patch(
  '/topology/layout',
  requireScope('organization', 'partner', 'system'),
  requireTopologyWrite,
  zValidator('json', layoutPatchSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const perms = c.get('permissions') as UserPermissions | undefined;
    // fetchWithAuth auto-injects orgId as a query param; accept it as a fallback so
    // partner users spanning multiple orgs don't hit "orgId is required" on
    // drag-to-save (the body carries no orgId).
    const orgResult = resolveOrgId(auth, body.orgId ?? c.req.query('orgId'), true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    // The site axis is app-layer only (RLS scopes by org, not site), so without
    // this check a partner caller could persist layout rows against another org's
    // site — a silent cross-tenant 0-row "success" under the wrong key. Confirm
    // the site belongs to the resolved org before touching topology_layout.
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, body.siteId), eq(sites.orgId, orgResult.orgId!)))
      .limit(1);
    if (!site) return c.json({ error: 'Site not found' }, 404);

    if (perms?.allowedSiteIds && !canAccessSite(perms, body.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    let upserted = 0;
    await db.transaction(async (tx) => {
      for (const p of body.positions) {
        // Upsert keyed on (site_id, node_type, node_id) — onConflictDoUpdate
        // resolves the unique-key collision in-statement so a re-save is a clean
        // update, never a duplicate-key 500.
        await tx
          .insert(topologyLayout)
          .values({
            orgId: orgResult.orgId!,
            siteId: body.siteId,
            nodeType: p.nodeType,
            nodeId: p.nodeId,
            x: p.x,
            y: p.y,
            pinned: true,
            updatedBy: auth.user?.id ?? null,
          })
          .onConflictDoUpdate({
            target: [topologyLayout.siteId, topologyLayout.nodeType, topologyLayout.nodeId],
            set: { x: p.x, y: p.y, pinned: true, updatedBy: auth.user?.id ?? null, updatedAt: new Date() },
          });
        upserted += 1;
      }
    });

    writeRouteAudit(c, {
      orgId: orgResult.orgId ?? undefined,
      action: 'discovery.topology.layout.upsert',
      resourceType: 'topology_layout',
      resourceId: body.siteId,
      details: { siteId: body.siteId, count: upserted },
    });

    return c.json({ upserted });
  }
);

// POST /discovery/topology/manual-node — create a hand-mapped placeholder node
// (#1728 phase 4). Runs on the request `db` so the INSERT is RLS-scoped to the
// caller (org/site server-derived); never a bare/system pool (silent 0-row class).
discoveryRoutes.post(
  '/topology/manual-node',
  requireScope('organization', 'partner', 'system'),
  requireTopologyWrite,
  zValidator('json', createManualNodeSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId ?? c.req.query('orgId'), true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    // Site must belong to the resolved org (RLS doesn't defend the site axis).
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, body.siteId), eq(sites.orgId, orgResult.orgId!)))
      .limit(1);
    if (!site) return c.json({ error: 'Site not found' }, 404);

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, body.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const [node] = await db
      .insert(topologyManualNodes)
      .values({
        orgId: orgResult.orgId!,
        siteId: body.siteId,
        label: body.label,
        role: body.role,
        notes: body.notes ?? null,
        createdBy: auth.user?.id ?? null,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: orgResult.orgId ?? undefined,
      action: 'discovery.topology.manual_node.create',
      resourceType: 'topology_manual_node',
      resourceId: node?.id,
      resourceName: node?.label,
    });

    return c.json(node, 201);
  }
);

// Resolve a manual-edge endpoint to confirm it is an asset/manual-node in (org, site).
// The site axis is app-layer only (RLS does not defend it), so each endpoint is
// pinned to both the resolved org and the request site.
async function manualEdgeEndpointExists(
  endpoint: { type: 'discovered_asset' | 'manual_node'; id: string },
  orgId: string,
  siteId: string,
): Promise<boolean> {
  if (endpoint.type === 'discovered_asset') {
    const [r] = await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.id, endpoint.id),
          eq(discoveredAssets.orgId, orgId),
          eq(discoveredAssets.siteId, siteId),
        ),
      )
      .limit(1);
    return !!r;
  }
  const [r] = await db
    .select({ id: topologyManualNodes.id })
    .from(topologyManualNodes)
    .where(
      and(
        eq(topologyManualNodes.id, endpoint.id),
        eq(topologyManualNodes.orgId, orgId),
        eq(topologyManualNodes.siteId, siteId),
      ),
    )
    .limit(1);
  return !!r;
}

// POST /discovery/topology/manual-edge — draw a hand-asserted edge between two
// endpoints (#1728 phase 4). Manual edges live in network_topology with
// method='manual'/confidence='asserted'; they are scan-immune (reconcile filters
// the measured method set) and the provenance unique index keeps a manual + a
// measured edge distinct on the same pair. Runs on the request `db` (RLS-scoped).
discoveryRoutes.post(
  '/topology/manual-edge',
  requireScope('organization', 'partner', 'system'),
  requireTopologyWrite,
  zValidator('json', createManualEdgeSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId ?? c.req.query('orgId'), true);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    if (body.source.type === body.target.type && body.source.id === body.target.id) {
      return c.json({ error: 'An edge cannot connect a node to itself' }, 400);
    }

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, body.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const [srcOk, tgtOk] = await Promise.all([
      manualEdgeEndpointExists(body.source, orgResult.orgId!, body.siteId),
      manualEdgeEndpointExists(body.target, orgResult.orgId!, body.siteId),
    ]);
    if (!srcOk || !tgtOk) {
      return c.json({ error: 'Edge endpoint not found in this site' }, 404);
    }

    // Pre-check the provenance unique key (org, site, src, tgt, method='manual').
    // A raw duplicate insert would trip the unique index 23505 — but the whole
    // request runs inside a single withDbAccessContext transaction, so an
    // in-statement error poisons that transaction and the COMMIT then 500s.
    // Checking first keeps the transaction clean and lets us return a 409.
    const [dupe] = await db
      .select({ id: networkTopology.id })
      .from(networkTopology)
      .where(
        and(
          eq(networkTopology.orgId, orgResult.orgId!),
          eq(networkTopology.siteId, body.siteId),
          eq(networkTopology.sourceType, body.source.type),
          eq(networkTopology.sourceId, body.source.id),
          eq(networkTopology.targetType, body.target.type),
          eq(networkTopology.targetId, body.target.id),
          eq(networkTopology.method, 'manual'),
        ),
      )
      .limit(1);
    if (dupe) {
      return c.json({ error: 'A manual edge already connects these two nodes' }, 409);
    }

    const [edge] = await db
      .insert(networkTopology)
      .values({
        orgId: orgResult.orgId!,
        siteId: body.siteId,
        sourceType: body.source.type,
        sourceId: body.source.id,
        targetType: body.target.type,
        targetId: body.target.id,
        connectionType: 'manual',
        method: 'manual',
        confidence: 'asserted',
        createdBy: auth.user?.id ?? null,
      })
      .returning();

    writeRouteAudit(c, {
      orgId: orgResult.orgId ?? undefined,
      action: 'discovery.topology.manual_edge.create',
      resourceType: 'topology_manual_edge',
      resourceId: edge?.id,
    });

    return c.json(edge, 201);
  }
);

// DELETE /discovery/topology/manual-edge/:id — remove a hand-asserted edge
// (#1728 phase 4). Only deletes rows with method='manual'; measured edges are
// scan-owned and read-only. Runs on the request `db` (RLS-scoped); 404 when no
// manual edge with that id is visible.
discoveryRoutes.delete(
  '/topology/manual-edge/:id',
  requireScope('organization', 'partner', 'system'),
  requireTopologyWrite,
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conds = [eq(networkTopology.id, id), eq(networkTopology.method, 'manual')];
    if (orgResult.orgId) conds.push(eq(networkTopology.orgId, orgResult.orgId));

    const [existing] = await db
      .select({
        id: networkTopology.id,
        orgId: networkTopology.orgId,
        siteId: networkTopology.siteId,
      })
      .from(networkTopology)
      .where(and(...conds))
      .limit(1);
    if (!existing) return c.json({ error: 'Manual edge not found' }, 404);

    // Site axis is app-layer only (RLS scopes by org, not site). Without this a
    // site-restricted caller could delete a manual edge in a site they cannot
    // access — a cross-site IDOR. Mirror the create-route site gate. 404 (not
    // 403) so an out-of-scope id is indistinguishable from a non-existent one.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, existing.siteId)) {
      return c.json({ error: 'Manual edge not found' }, 404);
    }

    await db.delete(networkTopology).where(eq(networkTopology.id, existing.id));

    writeRouteAudit(c, {
      orgId: existing.orgId ?? undefined,
      action: 'discovery.topology.manual_edge.delete',
      resourceType: 'topology_manual_edge',
      resourceId: existing.id,
    });

    return c.json({ success: true });
  }
);

// DELETE /discovery/topology/manual-node/:id — remove a hand-mapped placeholder
// node and everything it owns (#1728 phase 4). In ONE transaction: delete its
// method='manual' edges in network_topology where it is the source OR the target,
// delete its topology_layout row, then delete the node. Measured edges never
// reference a manual_node, so they are untouched. Runs on the request `db`
// (RLS-scoped); 404 when the node is not visible to the caller.
discoveryRoutes.delete(
  '/topology/manual-node/:id',
  requireScope('organization', 'partner', 'system'),
  requireTopologyWrite,
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const orgResult = resolveOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conds = [eq(topologyManualNodes.id, id)];
    if (orgResult.orgId) conds.push(eq(topologyManualNodes.orgId, orgResult.orgId));

    const [node] = await db
      .select({
        id: topologyManualNodes.id,
        orgId: topologyManualNodes.orgId,
        siteId: topologyManualNodes.siteId,
        label: topologyManualNodes.label,
      })
      .from(topologyManualNodes)
      .where(and(...conds))
      .limit(1);
    if (!node) return c.json({ error: 'Manual node not found' }, 404);

    // Site axis is app-layer only (RLS scopes by org, not site). Without this a
    // site-restricted caller could delete a manual node (and cascade its edges)
    // in a site they cannot access — a cross-site IDOR. Mirror the create-route
    // site gate. 404 (not 403) so an out-of-scope id reads as non-existent.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, node.siteId)) {
      return c.json({ error: 'Manual node not found' }, 404);
    }

    await db.transaction(async (tx) => {
      // Manual edges that reference this placeholder as source. Only method='manual'
      // rows are removed — measured edges never carry a manual_node endpoint.
      await tx.delete(networkTopology).where(
        and(
          eq(networkTopology.method, 'manual'),
          eq(networkTopology.sourceType, 'manual_node'),
          eq(networkTopology.sourceId, node.id),
        ),
      );
      // ...and as target.
      await tx.delete(networkTopology).where(
        and(
          eq(networkTopology.method, 'manual'),
          eq(networkTopology.targetType, 'manual_node'),
          eq(networkTopology.targetId, node.id),
        ),
      );
      // Its saved Cytoscape position.
      await tx.delete(topologyLayout).where(
        and(
          eq(topologyLayout.nodeType, 'manual_node'),
          eq(topologyLayout.nodeId, node.id),
        ),
      );
      await tx.delete(topologyManualNodes).where(eq(topologyManualNodes.id, node.id));
    });

    writeRouteAudit(c, {
      orgId: node.orgId ?? undefined,
      action: 'discovery.topology.manual_node.delete',
      resourceType: 'topology_manual_node',
      resourceId: node.id,
      resourceName: node.label,
    });

    return c.json({ success: true });
  }
);
