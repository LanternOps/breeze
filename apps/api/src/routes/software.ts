import { Hono } from 'hono';
import { zValidator, optionalJsonValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, sql, desc, like, or, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  softwareCatalog,
  softwareVersions,
  softwareDeployments,
  deploymentResults,
  softwareInventory,
  devices,
  deviceCommands,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, requireSiteAccess } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveDeploymentTargets } from '../services/deploymentTargetResolver';
import {
  getOrganizationSoftwareDownloadPolicy,
  setOrganizationSoftwareDownloadPolicy,
  setSiteSoftwareDownloadPolicy,
} from '../services/softwareDownloadPolicy';
import {
  uploadBinary,
  getPresignedUrl,
  isS3Configured,
  S3ConfigError,
  S3OperationError,
} from '../services/s3Storage';
import {
  parseStreamingMultipart,
  MultipartError,
  type StreamedMultipart,
} from '../services/streamingUpload';
import { captureException, captureMessage } from '../services/sentry';
import { unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import {
  buildAndDispatchSoftwareInstalls,
  createSoftwareDeployment,
} from '../services/softwareDeployment';
import { detectionRulesSchema, softwareDownloadPolicySchema } from '@breeze/shared';

export const softwareRoutes = new Hono();
const requireSoftwareRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireSoftwareWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const requireSoftwareExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ResolveScopedOrgIdResult =
  | { orgId: string }
  | { error: string; status: 400 | 403 };

type AuthScopeContext = {
  scope: 'system' | 'partner' | 'organization';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
};

function resolveScopedOrgId(
  auth: AuthScopeContext,
  requestedOrgId?: string,
): ResolveScopedOrgIdResult {
  if (requestedOrgId) {
    if (auth.scope === 'system') {
      return { orgId: requestedOrgId };
    }
    if (auth.scope === 'organization') {
      if (!auth.orgId || requestedOrgId !== auth.orgId) {
        return { error: 'Access to this organization denied', status: 403 };
      }
      return { orgId: requestedOrgId };
    }
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!accessibleOrgIds.includes(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) return { orgId: auth.orgId };
  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    const single = auth.accessibleOrgIds[0];
    if (single) return { orgId: single };
  }
  return { error: 'orgId is required for this scope', status: 400 };
}

type ResolveCatalogListScopeResult =
  | { orgCondition?: SQL }
  | { empty: true }
  | { error: string; status: 400 | 403 };

function resolveCatalogListScope(
  auth: AuthScopeContext,
  requestedOrgId?: string,
): ResolveCatalogListScopeResult {
  const scopedOrg = resolveScopedOrgId(auth, requestedOrgId);
  if ('orgId' in scopedOrg) {
    return { orgCondition: eq(softwareCatalog.orgId, scopedOrg.orgId) };
  }

  if (requestedOrgId || scopedOrg.status !== 400) return scopedOrg;

  if (auth.scope === 'partner') {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (accessibleOrgIds.length === 0) return { empty: true };
    return { orgCondition: inArray(softwareCatalog.orgId, accessibleOrgIds) };
  }

  if (auth.scope === 'system') {
    return {};
  }

  return scopedOrg;
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

// limit/offset pagination (the per-device results endpoint) — defaults to 100
// rows, hard-capped at 500 so a huge deployment can't be pulled in one request.
function getLimitOffset(query: { limit?: string; offset?: string }) {
  const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? '100', 10) || 100));
  const offset = Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0);
  return { limit, offset };
}

const ALLOWED_EXTENSIONS = new Set(['.msi', '.exe', '.dmg', '.deb', '.pkg']);
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB
type SoftwareDeploymentAggregateStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

type SoftwareVersionInsert = Omit<typeof softwareVersions.$inferInsert, 'catalogId' | 'isLatest'>;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

async function setLatestSoftwareVersion(
  tx: DbTransaction,
  catalogId: string,
  versionId: string,
) {
  await tx.update(softwareVersions)
    .set({ isLatest: false })
    .where(eq(softwareVersions.catalogId, catalogId));

  const [version] = await tx.update(softwareVersions)
    .set({ isLatest: true })
    .where(and(
      eq(softwareVersions.catalogId, catalogId),
      eq(softwareVersions.id, versionId),
    ))
    .returning();

  return version ?? null;
}

export function computeSoftwareDeploymentAggregateStatus(
  results: Array<{ status: string; count: number }>,
): SoftwareDeploymentAggregateStatus {
  const counts = new Map(results.map((result) => [result.status, Number(result.count)]));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

  if (total === 0) return 'pending';

  const pendingCount = counts.get('pending') ?? 0;
  const completedCount = counts.get('completed') ?? 0;
  const failedCount = counts.get('failed') ?? 0;
  const cancelledCount = counts.get('cancelled') ?? 0;
  const inProgressCount = (
    (counts.get('running') ?? 0) +
    (counts.get('paused') ?? 0) +
    (counts.get('downloading') ?? 0) +
    (counts.get('installing') ?? 0) +
    (counts.get('rollback') ?? 0)
  );

  if (inProgressCount > 0) return 'in_progress';
  if (failedCount > 0) {
    return completedCount > 0 ? 'completed_with_errors' : 'failed';
  }
  if (cancelledCount === total) return 'cancelled';
  if (completedCount === total) return 'completed';
  if (pendingCount === total) return 'pending';
  if (pendingCount > 0 && completedCount > 0) return 'in_progress';

  return 'in_progress';
}

/**
 * Per-status result counts for one deployment, folded into the five buckets
 * the UI progress bars care about (raw agent-side statuses like 'downloading'
 * and 'installing' land in `inProgress`). `total` is the device count.
 */
export interface SoftwareDeploymentStatusCounts {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

function emptyStatusCounts(): SoftwareDeploymentStatusCounts {
  return { pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
}

function summarizeStatusCounts(
  groups: Array<{ status: string; count: number }>,
): SoftwareDeploymentStatusCounts {
  const counts = emptyStatusCounts();
  for (const { status, count } of groups) {
    const n = Number(count);
    counts.total += n;
    switch (status) {
      case 'pending':
      case 'draft':
        counts.pending += n;
        break;
      case 'completed':
        counts.completed += n;
        break;
      case 'failed':
        counts.failed += n;
        break;
      case 'cancelled':
        counts.cancelled += n;
        break;
      default:
        // running / paused / downloading / installing / rollback
        counts.inProgress += n;
    }
  }
  return counts;
}

interface DeploymentStatusEntry {
  status: SoftwareDeploymentAggregateStatus;
  counts: SoftwareDeploymentStatusCounts;
}

async function getDeploymentStatusMap(deploymentIds: string[]) {
  if (deploymentIds.length === 0) {
    return new Map<string, DeploymentStatusEntry>();
  }

  const rows = await db
    .select({
      deploymentId: deploymentResults.deploymentId,
      status: deploymentResults.status,
      count: sql<number>`count(*)::int`,
    })
    .from(deploymentResults)
    .where(inArray(deploymentResults.deploymentId, deploymentIds))
    .groupBy(deploymentResults.deploymentId, deploymentResults.status);

  const grouped = new Map<string, Array<{ status: string; count: number }>>();
  for (const row of rows) {
    const bucket = grouped.get(row.deploymentId) ?? [];
    bucket.push({ status: row.status, count: Number(row.count) });
    grouped.set(row.deploymentId, bucket);
  }

  const statusMap = new Map<string, DeploymentStatusEntry>();
  for (const deploymentId of deploymentIds) {
    const groups = grouped.get(deploymentId) ?? [];
    statusMap.set(deploymentId, {
      status: computeSoftwareDeploymentAggregateStatus(groups),
      counts: summarizeStatusCounts(groups),
    });
  }

  return statusMap;
}

async function resolveSoftwareTargetDeviceIds(
  orgId: string,
  permissions: UserPermissions | undefined,
  payload: {
    targetType: 'devices' | 'groups' | 'sites' | 'all' | 'filter';
    targetIds?: string[];
    targetFilter?: unknown;
  },
) {
  if (payload.targetType === 'sites') {
    return {
      error: 'Site targeting is not implemented for software deployments',
      deviceIds: [] as string[],
    };
  }

  const targetConfig =
    payload.targetType === 'devices'
      ? { type: 'devices' as const, deviceIds: payload.targetIds ?? [] }
      : payload.targetType === 'groups'
        ? { type: 'groups' as const, groupIds: payload.targetIds ?? [] }
        : payload.targetType === 'filter'
          ? { type: 'filter' as const, filter: payload.targetFilter as never }
          : { type: 'all' as const };

  const deviceIds = await resolveDeploymentTargets({ orgId, targetConfig });
  if (deviceIds.length === 0) {
    return {
      error: 'No devices resolved for the selected target scope',
      status: 400 as const,
      deviceIds,
    };
  }

  if (permissions?.allowedSiteIds) {
    const rows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));

    const allowedIds = rows
      .filter((device) => typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId))
      .map((device) => device.id);

    if (payload.targetType === 'devices' && allowedIds.length !== deviceIds.length) {
      return {
        error: 'Access to one or more device sites denied',
        status: 403 as const,
        deviceIds: [] as string[],
      };
    }

    if (allowedIds.length === 0) {
      return {
        error: 'No devices resolved for the selected target scope',
        status: 400 as const,
        deviceIds: allowedIds,
      };
    }

    return { deviceIds: allowedIds };
  }

  return { deviceIds };
}

async function insertLatestSoftwareVersion(
  catalogId: string,
  values: SoftwareVersionInsert,
) {
  return db.transaction(async (tx) => {
    const [inserted] = await tx.insert(softwareVersions)
      .values({ ...values, catalogId, isLatest: false })
      .returning();

    if (!inserted) return null;

    return setLatestSoftwareVersion(tx, catalogId, inserted.id);
  });
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const categorySchema = z.enum([
  'browser', 'utility', 'compression', 'productivity',
  'communication', 'developer', 'media', 'security'
]);
const platformSchema = z.enum(['windows', 'macos', 'linux']);

const listCatalogSchema = z.object({
  search: z.string().optional(),
  q: z.string().optional(),
  category: categorySchema.optional(),
  platform: platformSchema.optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

const catalogSearchSchema = z.object({
  q: z.string().min(1),
  category: categorySchema.optional()
});

const catalogIdParamSchema = z.object({ id: z.string().guid() });

const createCatalogSchema = z.object({
  name: z.string().min(1).max(200),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  iconUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  isManaged: z.boolean().optional(),
  orgId: z.string().guid().optional()
});

const updateCatalogSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  iconUrl: z.string().url().optional(),
  websiteUrl: z.string().url().optional(),
  isManaged: z.boolean().optional()
});

const versionParamSchema = z.object({ id: z.string().guid() });
const versionIdParamSchema = z.object({ id: z.string().guid(), versionId: z.string().guid() });

const createVersionSchema = z.object({
  version: z.string().min(1).max(100),
  releaseDate: z.string().datetime().optional(),
  releaseNotes: z.string().max(5000).optional(),
  downloadUrl: z.string().url().optional(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  fileSize: z.number().min(0).optional(),
  supportedOs: z.array(platformSchema).optional(),
  architecture: z.string().max(20).optional(),
  silentInstallArgs: z.string().max(2000).optional(),
  silentUninstallArgs: z.string().max(2000).optional(),
  preInstallScript: z.string().optional(),
  postInstallScript: z.string().optional(),
  detectionRules: detectionRulesSchema.optional()
});

const listDeploymentsSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'completed_with_errors', 'failed', 'cancelled']).optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

const deploymentIdParamSchema = z.object({ id: z.string().guid() });

// Known deployment_results statuses (deploymentStatusEnum minus 'draft', which
// results never take — they default to 'pending' at insert).
const DEPLOYMENT_RESULT_STATUSES = [
  'pending',
  'running',
  'paused',
  'downloading',
  'installing',
  'completed',
  'failed',
  'cancelled',
  'rollback',
] as const;

const listDeploymentResultsSchema = z.object({
  status: z.enum(DEPLOYMENT_RESULT_STATUSES).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const createDeploymentSchema = z.object({
  name: z.string().min(1).max(255),
  softwareVersionId: z.string().guid(),
  deploymentType: z.enum(['install', 'uninstall', 'update']),
  targetType: z.enum(['devices', 'groups', 'sites', 'all', 'filter']),
  targetIds: z.array(z.string().guid()).optional(),
  targetFilter: z.unknown().optional(),
  scheduleType: z.enum(['immediate', 'scheduled', 'maintenance']),
  scheduledAt: z.string().datetime().optional(),
  maintenanceWindowId: z.string().guid().optional(),
  options: z.record(z.string(), z.unknown()).optional()
}).superRefine((data, ctx) => {
  // Reject what never runs (#1.4): nothing dispatches uninstall/update
  // deployments today — accepting them inserted rows that sat pending forever.
  if (data.deploymentType === 'uninstall' || data.deploymentType === 'update') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deploymentType'],
      message: 'Uninstall/update deployments are not yet supported',
    });
  }
  // A maintenance-window deployment without a window can never be evaluated by
  // the scheduler — it would sit undispatched forever.
  if (data.scheduleType === 'maintenance' && !data.maintenanceWindowId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maintenanceWindowId'],
      message: 'maintenanceWindowId is required for maintenance-window deployments',
    });
  }
  if (data.scheduleType === 'scheduled') {
    if (!data.scheduledAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledAt'],
        message: 'scheduledAt is required for scheduled deployments',
      });
    } else if (new Date(data.scheduledAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledAt'],
        message: 'scheduledAt must be in the future',
      });
    }
  }
});

const retryDeploymentSchema = z.object({
  deviceIds: z.array(z.string().guid()).max(1000).optional(),
});

const cancelDeploymentSchema = z.object({
  reason: z.string().max(500).optional()
});

const listInventorySchema = z.object({
  deviceId: z.string().guid().optional(),
  search: z.string().optional()
});

const inventoryParamSchema = z.object({ deviceId: z.string().guid() });

const downloadPolicySiteParamSchema = z.object({ siteId: z.string().guid() });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
softwareRoutes.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// CATALOG ROUTES
// ---------------------------------------------------------------------------

// GET /catalog - List catalog items
softwareRoutes.get(
  '/catalog',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('query', listCatalogSchema),
  async (c) => {
    const auth = c.get('auth');
    const scopeResult = resolveCatalogListScope(auth, c.req.query('orgId'));
    if ('error' in scopeResult) return c.json({ error: scopeResult.error }, scopeResult.status);

    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const searchTerm = query.search ?? query.q;

    if ('empty' in scopeResult) {
      return c.json({ data: [], pagination: { page, limit, total: 0 } });
    }

    const conditions: SQL[] = [];
    // Include partner-scoped built-in (integration) packages alongside the caller's
    // own org packages. RLS scopes built-ins to the caller's partner, so widening
    // the WHERE here cannot leak another partner's rows.
    if (scopeResult.orgCondition) {
      conditions.push(or(scopeResult.orgCondition, isNotNull(softwareCatalog.integrationProvider))!);
    }
    if (searchTerm) {
      const term = `%${searchTerm}%`;
      conditions.push(
        or(
          like(softwareCatalog.name, term),
          like(softwareCatalog.vendor, term),
          like(softwareCatalog.description, term)
        )!
      );
    }
    if (query.category) {
      conditions.push(eq(softwareCatalog.category, query.category));
    }
    const whereClause = conditions.length > 0 ? and(...conditions)! : sql`true`;

    const [items, countResult] = await Promise.all([
      db.select({
        id: softwareCatalog.id,
        orgId: softwareCatalog.orgId,
        partnerId: softwareCatalog.partnerId,
        integrationProvider: softwareCatalog.integrationProvider,
        name: softwareCatalog.name,
        vendor: softwareCatalog.vendor,
        description: softwareCatalog.description,
        category: softwareCatalog.category,
        iconUrl: softwareCatalog.iconUrl,
        websiteUrl: softwareCatalog.websiteUrl,
        isManaged: softwareCatalog.isManaged,
        createdAt: softwareCatalog.createdAt,
        versionCount: sql<number>`(SELECT count(*) FROM software_versions WHERE software_versions.catalog_id = ${softwareCatalog.id})`,
      }).from(softwareCatalog)
        .where(whereClause)
        .orderBy(softwareCatalog.name)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(softwareCatalog)
        .where(whereClause)
    ]);

    return c.json({
      data: items,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// POST /catalog - Create catalog item
softwareRoutes.post(
  '/catalog',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('json', createCatalogSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgResult = resolveScopedOrgId(auth, payload.orgId ?? c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const [item] = await db.insert(softwareCatalog).values({
      orgId,
      name: payload.name,
      vendor: payload.vendor ?? null,
      description: payload.description ?? null,
      category: payload.category ?? null,
      iconUrl: payload.iconUrl ?? null,
      websiteUrl: payload.websiteUrl ?? null,
      isManaged: payload.isManaged ?? false,
    }).returning();

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.create',
      resourceType: 'software_catalog_item',
      resourceId: item!.id,
      resourceName: item!.name,
      details: { vendor: item!.vendor },
    });

    return c.json({ data: item }, 201);
  }
);

// GET /catalog/search - Search catalog
softwareRoutes.get(
  '/catalog/search',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('query', catalogSearchSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const query = c.req.valid('query');
    const term = `%${query.q}%`;
    const conditions = [
      eq(softwareCatalog.orgId, orgId),
      or(
        like(softwareCatalog.name, term),
        like(softwareCatalog.vendor, term),
        like(softwareCatalog.description, term)
      )!
    ];
    if (query.category) {
      conditions.push(eq(softwareCatalog.category, query.category));
    }

    const items = await db.select().from(softwareCatalog).where(and(...conditions));
    return c.json({ data: items, total: items.length });
  }
);

// GET /catalog/:id - Get catalog item
softwareRoutes.get(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('param', catalogIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    // Look up by id alone, then authorize in JS. RLS restricts visibility to the
    // caller's org rows + their partner's built-ins; the org guard below rejects a
    // (visible) org-scoped row belonging to a different org. Built-in integration
    // packages (Huntress/SentinelOne) are partner-scoped with org_id NULL, so an
    // `eq(orgId)` filter would exclude them — matching the /deploy route (#1957).
    const [item] = await db.select().from(softwareCatalog)
      .where(eq(softwareCatalog.id, id));
    if (!item || (item.orgId !== null && item.orgId !== orgId)) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const [versionCount] = await db.select({ count: sql<number>`count(*)` })
      .from(softwareVersions).where(eq(softwareVersions.catalogId, id));

    return c.json({ data: { ...item, versionCount: Number(versionCount?.count ?? 0) } });
  }
);

// PATCH /catalog/:id - Update catalog item
softwareRoutes.patch(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', catalogIdParamSchema),
  zValidator('json', updateCatalogSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [existing] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!existing) return c.json({ error: 'Catalog item not found' }, 404);

    const [updated] = await db.update(softwareCatalog)
      .set(payload)
      .where(eq(softwareCatalog.id, id))
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.update',
      resourceType: 'software_catalog_item',
      resourceId: id,
      resourceName: updated!.name,
      details: { updatedFields: Object.keys(payload) },
    });

    return c.json({ data: updated });
  }
);

// DELETE /catalog/:id - Delete catalog item
softwareRoutes.delete(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', catalogIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!existing) return c.json({ error: 'Catalog item not found' }, 404);

    // A version that is still referenced by a deployment cannot be deleted —
    // software_deployments.software_version_id is an ON DELETE RESTRICT FK, so
    // deleting the versions below would throw an unhandled 500 (#1407).
    // Pre-check and return a clean 409 so deployment history is preserved and
    // the caller gets an actionable message instead of a server error.
    const [deploymentRef] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(softwareDeployments)
      .innerJoin(softwareVersions, eq(softwareDeployments.softwareVersionId, softwareVersions.id))
      .where(eq(softwareVersions.catalogId, id));
    const blockingCount = deploymentRef?.count ?? 0;
    if (blockingCount > 0) {
      return c.json(
        {
          error: `Cannot delete: ${blockingCount} deployment${blockingCount === 1 ? '' : 's'} still reference a version of this software. Remove those deployments first.`,
        },
        409
      );
    }

    // Delete versions first (FK constraint)
    await db.delete(softwareVersions).where(eq(softwareVersions.catalogId, id));
    await db.delete(softwareCatalog).where(eq(softwareCatalog.id, id));

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.delete',
      resourceType: 'software_catalog_item',
      resourceId: existing.id,
      resourceName: existing.name,
    });

    return c.json({ success: true, id });
  }
);

// ---------------------------------------------------------------------------
// VERSION ROUTES
// ---------------------------------------------------------------------------

// GET /catalog/:id/versions - List versions for a catalog item
softwareRoutes.get(
  '/catalog/:id/versions',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('param', versionParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    // Built-in integration packages (Huntress/SentinelOne) are partner-scoped with
    // org_id NULL, so an `eq(orgId)` filter excludes the catalog row entirely and
    // the endpoint 404s — which the deploy wizard renders as "No versions" with a
    // grayed-out deploy. Look up by id and authorize in JS, mirroring the /deploy
    // route: for an org/partner-scoped caller RLS binds a visible built-in to their
    // own partner, so a NULL-org row here is the caller's own (system scope sees all).
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(eq(softwareCatalog.id, id));
    if (!catalogItem || (catalogItem.orgId !== null && catalogItem.orgId !== orgId)) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const versions = await db.select().from(softwareVersions)
      .where(eq(softwareVersions.catalogId, id))
      .orderBy(desc(softwareVersions.isLatest), desc(softwareVersions.releaseDate));

    return c.json({ data: versions });
  }
);

// POST /catalog/:id/versions - Create version (JSON metadata only)
softwareRoutes.post(
  '/catalog/:id/versions',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', versionParamSchema),
  zValidator('json', createVersionSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const version = await insertLatestSoftwareVersion(id, {
      version: payload.version,
      releaseDate: payload.releaseDate ? new Date(payload.releaseDate) : new Date(),
      releaseNotes: payload.releaseNotes ?? null,
      downloadUrl: payload.downloadUrl ?? null,
      checksum: payload.checksum ?? null,
      fileSize: payload.fileSize ?? null,
      supportedOs: payload.supportedOs ?? null,
      architecture: payload.architecture ?? null,
      silentInstallArgs: payload.silentInstallArgs ?? null,
      silentUninstallArgs: payload.silentUninstallArgs ?? null,
      preInstallScript: payload.preInstallScript ?? null,
      postInstallScript: payload.postInstallScript ?? null,
      detectionRules: payload.detectionRules ?? null,
    });

    if (!version) {
      return c.json({ error: 'Failed to create software version' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.version.create',
      resourceType: 'software_version',
      resourceId: version.id,
      resourceName: catalogItem.name,
      details: { version: payload.version },
    });

    return c.json({ data: version }, 201);
  }
);

// POST /catalog/:id/versions/upload - Upload package file
softwareRoutes.post(
  '/catalog/:id/versions/upload',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    if (!isS3Configured()) {
      return c.json({ error: 'S3 storage is not configured' }, 503);
    }

    const catalogId = c.req.param('id')!;
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    // Stream the multipart body straight to a temp file via busboy, hashing as
    // it arrives, instead of buffering the whole parsed File into the Node heap
    // (which `c.req.parseBody()` does before the handler runs). Peak heap is now
    // constant regardless of file size — the OOM vector from #1408. The file's
    // extension is validated in `onFile` before any bytes are written to disk.
    const tempDir = join(tmpdir(), 'breeze-uploads');
    await mkdir(tempDir, { recursive: true });
    const tempPath = join(tempDir, `${randomUUID()}.upload`);

    let parsed: StreamedMultipart;
    try {
      parsed = await parseStreamingMultipart({
        contentType: c.req.header('content-type'),
        body: c.req.raw.body,
        tempPath,
        maxFileSize: MAX_UPLOAD_SIZE,
        onFile: ({ filename }) => {
          // Preserve the route's prior contract: disallowed extension -> 400.
          const candidate = getFileExtension(filename || 'package');
          if (!ALLOWED_EXTENSIONS.has(candidate)) {
            throw new MultipartError(
              `Unsupported file type: ${candidate}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
              400,
            );
          }
        },
      });
    } catch (err) {
      if (err instanceof MultipartError) {
        return c.json({ error: err.message }, err.status);
      }
      // A non-MultipartError is an infrastructure failure (disk full, aborted
      // body, malformed multipart) with no client status. Don't let it vanish
      // into a blank 500 — capture it with request context, then surface a
      // specific message so an out-of-disk condition is diagnosable.
      captureException(err, c);
      return c.json({ error: 'Failed to store uploaded package' }, 500);
    }

    const { fields, file } = parsed;
    if (!file) {
      return c.json({ error: 'file is required' }, 400);
    }

    try {
      const version = typeof fields.version === 'string' ? fields.version.trim() : '';
      if (!version) return c.json({ error: 'version is required' }, 400);

      const originalFileName = file.filename || 'package';
      const ext = getFileExtension(originalFileName);
      // Defensive: onFile already rejected disallowed extensions before writing.
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return c.json({ error: `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` }, 400);
      }

      const fileType = ext.slice(1); // remove leading dot
      const architecture = typeof fields.architecture === 'string' ? fields.architecture : null;
      const releaseNotes = typeof fields.releaseNotes === 'string' ? fields.releaseNotes : null;
      let silentInstallArgs = typeof fields.silentInstallArgs === 'string' ? fields.silentInstallArgs : null;
      let silentUninstallArgs = typeof fields.silentUninstallArgs === 'string' ? fields.silentUninstallArgs : null;
      const preInstallScript = typeof fields.preInstallScript === 'string' ? fields.preInstallScript : null;
      const postInstallScript = typeof fields.postInstallScript === 'string' ? fields.postInstallScript : null;
      // Detection rules arrive as a JSON-encoded field. Unlike supportedOs we do
      // NOT silently drop a malformed value: detection rules are a deliberate
      // install-safety config, so a parse/validation failure must surface as a
      // 400 rather than quietly shipping a version that can't verify itself.
      let detectionRules: unknown = null;
      if (typeof fields.detectionRules === 'string' && fields.detectionRules.trim() !== '') {
        let rawDetection: unknown;
        try {
          rawDetection = JSON.parse(fields.detectionRules);
        } catch {
          return c.json({ error: 'detectionRules must be valid JSON' }, 400);
        }
        const parsedDetection = detectionRulesSchema.safeParse(rawDetection);
        if (!parsedDetection.success) {
          return c.json({ error: 'detectionRules is invalid', details: parsedDetection.error.issues }, 400);
        }
        detectionRules = parsedDetection.data;
      }

      let supportedOs: string[] | null = null;
      if (typeof fields.supportedOs === 'string') {
        try {
          supportedOs = JSON.parse(fields.supportedOs);
        } catch {
          // Malformed supportedOs silently dropped the OS-targeting field on the
          // created version. Don't fail the upload (matches prior behavior), but
          // make the discard visible rather than fully silent.
          captureMessage('software upload: discarded malformed supportedOs', 'warning', {
            orgId,
            catalogId,
          });
        }
      }

      // Auto-detect MSI silent args
      if (fileType === 'msi' && !silentInstallArgs) {
        silentInstallArgs = 'msiexec /i "{file}" /qn /norestart';
      }
      if (fileType === 'msi' && !silentUninstallArgs) {
        silentUninstallArgs = 'msiexec /x "{file}" /qn /norestart';
      }

      const checksum = file.checksum;
      const fileSize = file.fileSize;

      // Generate version ID for S3 key path
      const versionId = randomUUID();
      const s3Key = `software/${orgId}/${catalogId}/${versionId}/${originalFileName}`;

      // Upload to S3. Previously a bare call, so any storage fault (bad
      // credentials, missing bucket, unreachable endpoint, MinIO TLS mismatch,
      // region mismatch) reached the global handler as an opaque
      // `500 Internal Server Error` and a self-hoster had no path from the
      // symptom to a cause (#2794). Map it to a status that says whose problem
      // it is, carrying the operator-actionable hint.
      try {
        await uploadBinary(tempPath, s3Key, checksum);
      } catch (err) {
        captureException(err, c);
        // Misconfigured env => 503, matching the isS3Configured() gate above.
        // `clientMessage`, not `message`: the latter can quote the raw
        // S3_ENDPOINT value, which may carry inline credentials.
        if (err instanceof S3ConfigError) {
          return c.json({ error: err.clientMessage }, 503);
        }
        // Storage reachable-ish but failing => 502. The message is curated in
        // classifyS3Failure and never echoes raw provider output.
        if (err instanceof S3OperationError) {
          return c.json({ error: err.message, storageFailure: err.failureCode }, 502);
        }
        return c.json(
          {
            error:
              'Upload to object storage failed before the request was sent. Check the API server logs for details.',
          },
          502
        );
      }

      const versionRecord = await insertLatestSoftwareVersion(catalogId, {
        id: versionId,
        version,
        releaseDate: new Date(),
        releaseNotes,
        s3Key,
        fileType,
        originalFileName,
        checksum,
        fileSize,
        supportedOs,
        architecture,
        silentInstallArgs,
        silentUninstallArgs,
        preInstallScript,
        postInstallScript,
        detectionRules,
      });

      if (!versionRecord) {
        return c.json({ error: 'Failed to create uploaded software version' }, 500);
      }

      writeRouteAudit(c, {
        orgId,
        action: 'software.catalog.version.upload',
        resourceType: 'software_version',
        resourceId: versionRecord.id,
        resourceName: catalogItem.name,
        details: { version, fileType, fileSize, checksum },
      });

      return c.json({ data: versionRecord }, 201);
    } finally {
      // Clean up temp file
      await unlink(tempPath).catch(() => {});
    }
  }
);

// POST /catalog/:id/versions/:versionId/promote - Mark an existing version as latest
softwareRoutes.post(
  '/catalog/:id/versions/:versionId/promote',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', versionIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id, versionId } = c.req.valid('param');
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const [existingVersion] = await db.select().from(softwareVersions)
      .where(and(
        eq(softwareVersions.id, versionId),
        eq(softwareVersions.catalogId, id),
      ));
    if (!existingVersion) return c.json({ error: 'Version not found' }, 404);

    const promotedVersion = await db.transaction(async (tx) => {
      return setLatestSoftwareVersion(tx, id, versionId);
    });

    if (!promotedVersion) {
      return c.json({ error: 'Failed to promote software version' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.version.promote',
      resourceType: 'software_version',
      resourceId: promotedVersion.id,
      resourceName: catalogItem.name,
      details: { version: promotedVersion.version },
    });

    return c.json({ data: promotedVersion });
  }
);

// GET /catalog/:id/versions/:versionId/download-url - Get presigned download URL
softwareRoutes.get(
  '/catalog/:id/versions/:versionId/download-url',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const catalogId = c.req.param('id')!;
    const versionId = c.req.param('versionId')!;

    // Verify catalog belongs to org
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const [versionRecord] = await db.select().from(softwareVersions)
      .where(and(eq(softwareVersions.id, versionId), eq(softwareVersions.catalogId, catalogId)));
    if (!versionRecord) return c.json({ error: 'Version not found' }, 404);

    if (versionRecord.s3Key) {
      const url = await getPresignedUrl(versionRecord.s3Key, 3600);
      return c.json({ data: { url, expiresIn: 3600 } });
    }

    if (versionRecord.downloadUrl) {
      return c.json({ data: { url: versionRecord.downloadUrl, expiresIn: null } });
    }

    return c.json({ error: 'No download available for this version' }, 404);
  }
);

// ---------------------------------------------------------------------------
// DEPLOYMENT ROUTES
// ---------------------------------------------------------------------------

// GET /deployments - List deployments
softwareRoutes.get(
  '/deployments',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('query', listDeploymentsSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // NOTE on ?status=: the deployment status is a *computed aggregate* over
    // grouped deployment_results (computeSoftwareDeploymentAggregateStatus),
    // so filtering on it in SQL would mean re-expressing that derivation as a
    // correlated subquery. Server-side aggregate filtering is intentionally
    // not implemented; the param stays accepted for backwards compatibility
    // but is ignored — clients filter the returned page on the computed
    // `status` field instead. (Previously the route fetched every org row,
    // filtered in JS and sliced — SQL pagination replaces that.)
    const orgCondition = eq(softwareDeployments.orgId, orgId);
    const [items, countRows] = await Promise.all([
      db.select().from(softwareDeployments)
        .where(orgCondition)
        .orderBy(desc(softwareDeployments.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` })
        .from(softwareDeployments)
        .where(orgCondition),
    ]);

    const statusMap = await getDeploymentStatusMap(items.map((item) => item.id));
    const enrichedItems = items.map((item) => {
      const entry = statusMap.get(item.id);
      return {
        ...item,
        status: entry?.status ?? 'pending',
        counts: entry?.counts ?? emptyStatusCounts(),
      };
    });

    return c.json({
      data: enrichedItems,
      pagination: { page, limit, total: Number(countRows[0]?.count ?? 0) }
    });
  }
);

// GET /deployments/summary - Aggregate counts for the overview cards.
// MUST be registered before GET /deployments/:id: Hono matches routes in
// registration order, so registering it later would let the :id route capture
// 'summary' as a path param (and 400 on the uuid validation).
softwareRoutes.get(
  '/deployments/summary',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    // One grouped query: deployments LEFT JOIN results, grouped by
    // (deployment, result status). A deployment with no result rows still
    // appears (status NULL, count 0). The aggregate status per deployment is
    // then derived in JS with the same computeSoftwareDeploymentAggregateStatus
    // used everywhere else — no N+1, no per-deployment queries.
    const rows = await db
      .select({
        deploymentId: softwareDeployments.id,
        dispatchedAt: softwareDeployments.dispatchedAt,
        createdAt: softwareDeployments.createdAt,
        status: deploymentResults.status,
        count: sql<number>`count(${deploymentResults.id})::int`,
        lastCompletedAt: sql<string | Date | null>`max(${deploymentResults.completedAt})`,
      })
      .from(softwareDeployments)
      .leftJoin(deploymentResults, eq(deploymentResults.deploymentId, softwareDeployments.id))
      .where(eq(softwareDeployments.orgId, orgId))
      .groupBy(
        softwareDeployments.id,
        softwareDeployments.dispatchedAt,
        softwareDeployments.createdAt,
        deploymentResults.status,
      );

    type SummaryAccumulator = {
      dispatchedAt: unknown;
      createdAt: unknown;
      groups: Array<{ status: string; count: number }>;
      /** epoch ms of max(deployment_results.completed_at); 0 = none */
      lastCompletedAt: number;
    };
    const byDeployment = new Map<string, SummaryAccumulator>();
    for (const row of rows) {
      let entry = byDeployment.get(row.deploymentId);
      if (!entry) {
        entry = { dispatchedAt: row.dispatchedAt, createdAt: row.createdAt, groups: [], lastCompletedAt: 0 };
        byDeployment.set(row.deploymentId, entry);
      }
      if (row.status != null) {
        entry.groups.push({ status: row.status, count: Number(row.count) });
      }
      if (row.lastCompletedAt) {
        const t = new Date(row.lastCompletedAt as string | Date).getTime();
        if (Number.isFinite(t) && t > entry.lastCompletedAt) entry.lastCompletedAt = t;
      }
    }

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let active = 0;
    let scheduled = 0;
    let completedLast7d = 0;
    let failedLast7d = 0;
    for (const entry of byDeployment.values()) {
      const aggregate = computeSoftwareDeploymentAggregateStatus(entry.groups);
      const terminal =
        aggregate === 'completed' ||
        aggregate === 'completed_with_errors' ||
        aggregate === 'failed' ||
        aggregate === 'cancelled';

      if (!entry.dispatchedAt) {
        // Awaiting the scheduler. A deployment cancelled before it ever
        // dispatched is terminal and must not count as "scheduled" forever.
        if (!terminal) scheduled++;
        continue;
      }
      if (!terminal) {
        // Dispatched with at least one pending/in-progress result.
        active++;
        continue;
      }
      // Terminal reference time: max(deployment_results.completed_at) is the
      // moment the last device finished — the cheapest correct "when did this
      // deployment end" already produced by the grouped query. Fallback to
      // createdAt for degenerate rows that never got a completed_at.
      const refTime = entry.lastCompletedAt
        || new Date(entry.createdAt as string | Date).getTime();
      if (refTime >= sevenDaysAgo) {
        if (aggregate === 'completed') completedLast7d++;
        else if (aggregate === 'failed' || aggregate === 'completed_with_errors') failedLast7d++;
        // 'cancelled' deliberately counts in neither 7d bucket.
      }
    }

    return c.json({ data: { active, scheduled, completedLast7d, failedLast7d } });
  }
);

// POST /deployments - Create deployment
softwareRoutes.post(
  '/deployments',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareExecute,
  requireMfa(),
  zValidator('json', createDeploymentSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const payload = c.req.valid('json');

    // Verify version exists and get catalog info
    const [versionRecord] = await db.select().from(softwareVersions)
      .where(eq(softwareVersions.id, payload.softwareVersionId));
    if (!versionRecord) return c.json({ error: 'Software version not found' }, 404);

    const [catalogItem] = await db.select({
      id: softwareCatalog.id,
      orgId: softwareCatalog.orgId,
      name: softwareCatalog.name,
      integrationProvider: softwareCatalog.integrationProvider,
    }).from(softwareCatalog)
      .where(eq(softwareCatalog.id, versionRecord.catalogId));
    // RLS already restricts visibility to the caller's org rows + their partner's
    // built-ins. Extra guard: an org-scoped (non-built-in) row must match the
    // authenticated org; built-in packages have org_id NULL and are allowed.
    if (!catalogItem || (catalogItem.orgId !== null && catalogItem.orgId !== orgId)) {
      return c.json({ error: 'Catalog item not found or access denied' }, 404);
    }

    const resolvedTargets = await resolveSoftwareTargetDeviceIds(orgId, c.get('permissions') as UserPermissions | undefined, payload);
    if (resolvedTargets.error) {
      const status = resolvedTargets.status ?? 400;
      return c.json({ error: resolvedTargets.error }, status);
    }
    const targetDeviceIds = resolvedTargets.deviceIds;

    const result = await createSoftwareDeployment({
      orgId,
      softwareVersionId: payload.softwareVersionId,
      deploymentType: payload.deploymentType,
      deviceIds: targetDeviceIds,
      scheduleType: payload.scheduleType,
      createdBy: auth.user?.id ?? null,
      name: payload.name,
      scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
      maintenanceWindowId: payload.maintenanceWindowId ?? null,
      targetType: payload.targetType,
      targetIds: payload.targetIds ?? null,
      options:
        payload.targetType === 'filter'
          ? { ...(payload.options ?? {}), targetFilter: payload.targetFilter ?? null }
          : payload.options ?? undefined,
    });

    if (result.status === 'failed') {
      return c.json({ data: { id: result.deploymentId, status: result.status, message: result.message } }, 200);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.deployment.create',
      resourceType: 'software_deployment',
      resourceId: result.deploymentId,
      resourceName: payload.name,
      details: {
        deploymentType: payload.deploymentType,
        targetType: payload.targetType,
        deviceCount: targetDeviceIds.length,
      },
    });

    return c.json({ data: result.deployment }, 201);
  }
);

// POST /deploy - Legacy deployment endpoint (used by DeploymentWizard)
softwareRoutes.post(
  '/deploy',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareExecute,
  requireMfa(),
  zValidator(
    'json',
    z.object({
      softwareId: z.string().guid(),
      version: z.string().min(1).max(64),
      targets: z
        .object({
          deviceIds: z.array(z.string().guid()).max(1000).optional(),
          siteIds: z.array(z.string().guid()).max(100).optional(),
          deviceGroupIds: z.array(z.string().guid()).max(100).optional(),
        })
        .optional(),
      configuration: z
        .object({
          scheduleType: z.enum(['immediate', 'scheduled', 'maintenance_window']).optional(),
        })
        .partial()
        .optional(),
    }).superRefine((data, ctx) => {
      // Reject what never runs (#1.4): this legacy route carries no scheduledAt
      // or maintenanceWindowId field, so a non-immediate deployment created here
      // can never be picked up by the scheduler — it would sit pending forever.
      const scheduleType = data.configuration?.scheduleType ?? 'immediate';
      if (scheduleType !== 'immediate') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['configuration', 'scheduleType'],
          message:
            'Scheduled and maintenance-window deployments are not supported on this endpoint — use POST /software/deployments',
        });
      }
    })
  ),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const body = c.req.valid('json');
    const softwareId = body.softwareId;
    const version = body.version;
    const deviceIds = body.targets?.deviceIds ?? [];

    // Look up the catalog item + version. RLS restricts visibility to the caller's
    // org rows + their partner's built-ins; the org guard below rejects a (visible)
    // org-scoped row that belongs to a different org. Built-ins have org_id NULL.
    const [catalogItem] = await db.select({
      id: softwareCatalog.id,
      orgId: softwareCatalog.orgId,
      name: softwareCatalog.name,
      integrationProvider: softwareCatalog.integrationProvider,
    }).from(softwareCatalog)
      .where(eq(softwareCatalog.id, softwareId));
    if (!catalogItem || (catalogItem.orgId !== null && catalogItem.orgId !== orgId)) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const [versionRecord] = await db.select().from(softwareVersions)
      .where(and(eq(softwareVersions.catalogId, softwareId), eq(softwareVersions.version, version)));

    if (!versionRecord) return c.json({ error: 'Version not found' }, 404);

    let resolvedDeviceIds = await resolveDeploymentTargets({
      orgId,
      targetConfig: {
        type: 'devices',
        deviceIds: Array.isArray(deviceIds) ? deviceIds : [],
      },
    });
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds && resolvedDeviceIds.length > 0) {
      const rows = await db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(and(eq(devices.orgId, orgId), inArray(devices.id, resolvedDeviceIds)));
      resolvedDeviceIds = rows
        .filter((device) => typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId))
        .map((device) => device.id);
      if (resolvedDeviceIds.length !== deviceIds.length) {
        return c.json({ error: 'Access to one or more device sites denied' }, 403);
      }
    }
    if (resolvedDeviceIds.length === 0) {
      return c.json({ error: 'No devices resolved for the selected targets' }, 400);
    }

    // Delegate to the canonical create path (services/softwareDeployment.ts):
    // deployment + per-device result inserts, presign, EDR resolution,
    // installer-variable substitution, detection rules, failure pre-writes and
    // honest WS-vs-queue dispatch — this route previously re-implemented all
    // of that inline and had drifted. The legacy route exposes no
    // force-reinstall toggle (no options => forceReinstall false, matching the
    // old hardcode) and only ever creates immediate installs — the superRefine
    // above rejects every other scheduleType, so `scheduleType` is 'immediate'
    // by the time we get here.
    const result = await createSoftwareDeployment({
      orgId,
      softwareVersionId: versionRecord.id,
      deploymentType: 'install',
      deviceIds: resolvedDeviceIds,
      scheduleType: 'immediate',
      createdBy: auth.user?.id ?? null,
      name: `Deploy ${catalogItem.name} v${version}`,
      targetType: 'devices',
      targetIds: resolvedDeviceIds,
    });

    // Preserve the legacy failure contract: HTTP 200 with a failed status body
    // (EDR resolution error / no installer available), no audit write.
    //
    // This route used to re-implement dispatch inline (S3 presign, EDR
    // resolution, the Wave 6 Task 5 managed-software destination-policy gate,
    // per-device WS send) and had drifted from the canonical path above it.
    // It now fully delegates to createSoftwareDeployment — including the
    // Wave 6 Task 5 policy gate, which lives once in the shared
    // buildAndDispatchSoftwareInstalls fan-out (services/softwareDeployment.ts)
    // so create/scheduler/retry all apply it identically instead of each
    // route carrying its own copy.
    if (result.status === 'failed') {
      return c.json({ data: { id: result.deploymentId, status: 'failed', message: result.message } }, 200);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.deployment.create',
      resourceType: 'software_deployment',
      resourceId: result.deploymentId,
      resourceName: catalogItem.name,
      details: { version, deviceCount: resolvedDeviceIds.length, deprecated: true },
    });

    // Legacy response shape: full row under `data` plus a top-level `id`.
    return c.json({ data: result.deployment, id: result.deploymentId }, 201);
  }
);

// GET /deployments/:id - Get deployment
softwareRoutes.get(
  '/deployments/:id',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('param', deploymentIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const [deployment] = await db.select().from(softwareDeployments)
      .where(and(eq(softwareDeployments.id, id), eq(softwareDeployments.orgId, orgId)));
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    const statusMap = await getDeploymentStatusMap([deployment.id]);
    const entry = statusMap.get(deployment.id);

    return c.json({
      data: {
        ...deployment,
        status: entry?.status ?? 'pending',
        counts: entry?.counts ?? emptyStatusCounts(),
      },
    });
  }
);

// POST /deployments/:id/cancel - Cancel deployment
softwareRoutes.post(
  '/deployments/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareExecute,
  requireMfa(),
  zValidator('param', deploymentIdParamSchema),
  zValidator('json', cancelDeploymentSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const [deployment] = await db.select().from(softwareDeployments)
      .where(and(eq(softwareDeployments.id, id), eq(softwareDeployments.orgId, orgId)));
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    // Update pending results to cancelled. `.returning()` surfaces which rows
    // carried a queued device_commands link (offline-queue fallback) so the
    // not-yet-delivered commands can be purged below.
    const flipped = await db.update(deploymentResults)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(and(
        eq(deploymentResults.deploymentId, id),
        eq(deploymentResults.status, 'pending')
      ))
      .returning({ deviceCommandId: deploymentResults.deviceCommandId });

    // Honest cancel: a queued-offline install must not execute when the agent
    // eventually reconnects. Cancel the linked device_commands rows that are
    // STILL 'pending' (not yet claimed by the agent) — mirrors the stale
    // reaper's tier-2 guarded cancel, same result payload shape. Delivered
    // ('sent') commands are left alone: in-flight installs run to completion
    // by design, and their late results no-op against the already-cancelled
    // result rows via the pending-status guard.
    const queuedCommandIds = [
      ...new Set(
        flipped
          .map((row) => row.deviceCommandId)
          .filter((commandId): commandId is string => typeof commandId === 'string'),
      ),
    ];
    let cancelledQueuedCommands = 0;
    if (queuedCommandIds.length > 0) {
      const cancelledCommands = await db.update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          result: {
            status: 'cancelled',
            error: 'Deployment cancelled before delivery',
            cancelledBy: auth.user?.id ?? 'software-deployment-cancel',
          },
        })
        .where(and(
          inArray(deviceCommands.id, queuedCommandIds),
          eq(deviceCommands.status, 'pending'),
        ))
        .returning({ id: deviceCommands.id });
      cancelledQueuedCommands = cancelledCommands.length;
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.deployment.cancel',
      resourceType: 'software_deployment',
      resourceId: id,
      resourceName: deployment.name,
      details: {
        cancelledResultCount: flipped.length,
        cancelledQueuedCommands,
      },
    });

    const statusMap = await getDeploymentStatusMap([id]);
    const entry = statusMap.get(id);

    return c.json({
      data: {
        ...deployment,
        status: entry?.status ?? 'cancelled',
        counts: entry?.counts ?? emptyStatusCounts(),
      },
      cancelledQueuedCommands,
    });
  }
);

// ---------------------------------------------------------------------------
// Retry dispatch helper
// ---------------------------------------------------------------------------

// Re-dispatch a retried device subset through the shared fan-out
// (services/softwareDeployment.ts). `scopeToDeviceIds` restricts the shared
// builder's failure pre-writes (EDR resolution error, missing installer,
// unresolvable `{{...}}` variables) to the retried rows only — previously
// COMPLETED rows are never clobbered to failed. The version/catalog lookups
// live here because the builder takes them as inputs; if either row has been
// deleted since the original dispatch, fail just the retried rows.
async function redispatchSoftwareInstall(opts: {
  deployment: typeof softwareDeployments.$inferSelect;
  orgId: string;
  deviceIds: string[];
  createdBy: string | null;
  /** Post-bump retryCount per device, keyed by deviceId — see the caller. */
  deviceRetryCounts: Record<string, number>;
}): Promise<{ dispatchedDeviceIds: string[]; error?: string }> {
  const { deployment, orgId, deviceIds, createdBy, deviceRetryCounts } = opts;

  const failTargets = async (errorMessage: string) => {
    await db.update(deploymentResults)
      .set({ status: 'failed', errorMessage, completedAt: new Date() })
      .where(and(
        eq(deploymentResults.deploymentId, deployment.id),
        inArray(deploymentResults.deviceId, deviceIds),
      ));
  };

  const [versionRecord] = await db.select().from(softwareVersions)
    .where(eq(softwareVersions.id, deployment.softwareVersionId));
  if (!versionRecord) {
    const error = 'Software version no longer exists for this deployment';
    await failTargets(error);
    return { dispatchedDeviceIds: [], error };
  }

  const [catalogItem] = await db.select({
    id: softwareCatalog.id,
    orgId: softwareCatalog.orgId,
    name: softwareCatalog.name,
    integrationProvider: softwareCatalog.integrationProvider,
  }).from(softwareCatalog)
    .where(eq(softwareCatalog.id, versionRecord.catalogId));
  if (!catalogItem) {
    const error = 'Catalog item no longer exists for this deployment';
    await failTargets(error);
    return { dispatchedDeviceIds: [], error };
  }

  // markDispatched: false — the deployment already carries its dispatched_at
  // claim from the original run; a retry must not re-stamp it.
  const fanout = await buildAndDispatchSoftwareInstalls({
    deploymentId: deployment.id,
    orgId,
    versionRecord,
    catalogItem,
    deviceIds,
    scopeToDeviceIds: deviceIds,
    options: (deployment.options ?? null) as Record<string, unknown> | null,
    createdBy,
    markDispatched: false,
    deviceRetryCounts,
  });

  return {
    dispatchedDeviceIds: fanout.dispatchedDeviceIds,
    ...(fanout.status === 'failed' && fanout.message ? { error: fanout.message } : {}),
  };
}

// POST /deployments/:id/retry - Retry failed per-device results
softwareRoutes.post(
  '/deployments/:id/retry',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareExecute,
  requireMfa(),
  zValidator('param', deploymentIdParamSchema),
  optionalJsonValidator(retryDeploymentSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const { deviceIds } = c.req.valid('json');

    const [deployment] = await db.select().from(softwareDeployments)
      .where(and(eq(softwareDeployments.id, id), eq(softwareDeployments.orgId, orgId)));
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    // Retrying an undispatched scheduled/maintenance deployment makes no sense —
    // its rows are pending because the scheduler hasn't run it yet, not failed.
    if (!deployment.dispatchedAt) {
      return c.json(
        { error: 'Deployment has not been dispatched yet — only deployments that already ran can be retried' },
        409,
      );
    }

    // Site is an app-layer concept only — RLS doesn't defend it — so a
    // site-restricted caller must not be able to re-trigger installs on
    // devices in sites outside their allowlist (see PR #864/#868).
    const permissions = c.get('permissions') as UserPermissions | undefined;
    let siteAllowedDeviceIds: string[] | null = null;
    if (permissions?.allowedSiteIds) {
      const orgDevices = await db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.orgId, orgId));
      siteAllowedDeviceIds = orgDevices
        .filter((device) => typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId))
        .map((device) => device.id);
      if (siteAllowedDeviceIds.length === 0) {
        return c.json({ retriedDeviceIds: [], skippedDeviceIds: deviceIds ?? [] });
      }
    }

    // Flip targeted failed rows back to pending, bumping retryCount and
    // clearing prior-attempt fields. .returning() tells us which rows actually
    // flipped — requested devices that were not in failed status (or not part
    // of this deployment), or outside the caller's site scope, are reported as
    // skipped.
    const conditions = [
      eq(deploymentResults.deploymentId, id),
      eq(deploymentResults.status, 'failed'),
    ];
    if (deviceIds && deviceIds.length > 0) {
      conditions.push(inArray(deploymentResults.deviceId, deviceIds));
    }
    if (siteAllowedDeviceIds) {
      conditions.push(inArray(deploymentResults.deviceId, siteAllowedDeviceIds));
    }

    // .returning() also carries the post-increment retryCount per device
    // (not just deviceId) — the re-dispatch below MUST bake this NEW attempt
    // number into the WS command id it builds so a late result from the
    // attempt being retried can never be misattributed to this one (see
    // dispatchSoftwareInstallToDevice / applySoftwareInstallResult). This
    // UPDATE...RETURNING is the ordering guarantee: retryCount is bumped in
    // the DB before redispatchSoftwareInstall (and therefore the new command
    // id) is ever constructed.
    const flipped = await db.update(deploymentResults)
      .set({
        status: 'pending',
        retryCount: sql`${deploymentResults.retryCount} + 1`,
        startedAt: null,
        completedAt: null,
        exitCode: null,
        output: null,
        errorMessage: null,
        deviceCommandId: null,
      })
      .where(and(...conditions))
      .returning({ deviceId: deploymentResults.deviceId, retryCount: deploymentResults.retryCount });

    const retriedDeviceIds = flipped.map((row) => row.deviceId);
    const retriedSet = new Set(retriedDeviceIds);
    const skippedDeviceIds = (deviceIds ?? []).filter((deviceId) => !retriedSet.has(deviceId));
    const deviceRetryCounts = Object.fromEntries(
      flipped.map((row) => [row.deviceId, row.retryCount]),
    );

    let dispatchError: string | undefined;
    if (retriedDeviceIds.length > 0) {
      const dispatchResult = await redispatchSoftwareInstall({
        deployment,
        orgId,
        deviceIds: retriedDeviceIds,
        createdBy: auth.user?.id ?? null,
        deviceRetryCounts,
      });
      dispatchError = dispatchResult.error;
    }

    writeRouteAudit(c, {
      orgId,
      action: 'software.deployment.retry',
      resourceType: 'software_deployment',
      resourceId: id,
      resourceName: deployment.name,
      details: {
        retriedCount: retriedDeviceIds.length,
        skippedCount: skippedDeviceIds.length,
        ...(deviceIds && deviceIds.length > 0 ? { requestedDeviceIds: deviceIds } : {}),
      },
    });

    return c.json({
      retriedDeviceIds,
      skippedDeviceIds,
      ...(dispatchError ? { message: dispatchError } : {}),
    });
  }
);

// GET /deployments/:id/results - Get per-device results (enriched)
softwareRoutes.get(
  '/deployments/:id/results',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('param', deploymentIdParamSchema),
  zValidator('query', listDeploymentResultsSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    const { limit, offset } = getLimitOffset(query);

    const [deployment] = await db.select().from(softwareDeployments)
      .where(and(eq(softwareDeployments.id, id), eq(softwareDeployments.orgId, orgId)));
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    const conditions: SQL[] = [eq(deploymentResults.deploymentId, id)];
    if (query.status) {
      conditions.push(eq(deploymentResults.status, query.status));
    }
    // Site is an app-layer concept only — RLS doesn't defend it — so a
    // site-restricted caller must not see per-device results (hostname, exit
    // code, output) for devices in sites outside their allowlist (#864/#868).
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds) {
      const orgDevices = await db
        .select({ id: devices.id, siteId: devices.siteId })
        .from(devices)
        .where(eq(devices.orgId, orgId));
      const siteAllowedDeviceIds = orgDevices
        .filter((device) => typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId))
        .map((device) => device.id);
      if (siteAllowedDeviceIds.length === 0) {
        return c.json({ data: [], total: 0 });
      }
      conditions.push(inArray(deploymentResults.deviceId, siteAllowedDeviceIds));
    }
    const whereClause = and(...conditions);

    // Single joined page query: devices for hostname (the UI must not render
    // UUIDs or N+1-fetch device names), device_commands for the derived
    // queuedOffline flag — a result still 'pending' whose offline-queued
    // command has not been claimed by the agent yet ("queued — device
    // offline", not a misleading in-progress spinner). COALESCE folds the
    // NULLs from the left joins (WS-dispatched rows have no linked command)
    // to false.
    const [results, countRows] = await Promise.all([
      db.select({
        id: deploymentResults.id,
        deploymentId: deploymentResults.deploymentId,
        deviceId: deploymentResults.deviceId,
        status: deploymentResults.status,
        startedAt: deploymentResults.startedAt,
        completedAt: deploymentResults.completedAt,
        exitCode: deploymentResults.exitCode,
        output: deploymentResults.output,
        errorMessage: deploymentResults.errorMessage,
        retryCount: deploymentResults.retryCount,
        deviceCommandId: deploymentResults.deviceCommandId,
        hostname: devices.hostname,
        queuedOffline: sql<boolean>`coalesce(${deploymentResults.status} = 'pending' and ${deploymentResults.deviceCommandId} is not null and ${deviceCommands.status} = 'pending', false)`,
      })
        .from(deploymentResults)
        .leftJoin(devices, eq(deploymentResults.deviceId, devices.id))
        .leftJoin(deviceCommands, eq(deploymentResults.deviceCommandId, deviceCommands.id))
        .where(whereClause)
        .orderBy(devices.hostname, deploymentResults.deviceId)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` })
        .from(deploymentResults)
        .where(whereClause),
    ]);

    return c.json({ data: results, total: Number(countRows[0]?.count ?? 0) });
  }
);

// ---------------------------------------------------------------------------
// INVENTORY ROUTES
// ---------------------------------------------------------------------------

// GET /inventory - List software inventory
softwareRoutes.get(
  '/inventory',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('query', listInventorySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const query = c.req.valid('query');

    // Get devices for org, narrowed by the caller's site allowlist when set.
    // Site is an app-layer concept only — RLS doesn't defend it — so a
    // partner-scope user restricted to one site must not see inventory for
    // devices in other sites within the same org. See PR #864/#868.
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const orgDevices = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.orgId, orgId));
    const allowedDeviceIds = orgDevices
      .filter((device) => !permissions?.allowedSiteIds
        || (typeof device.siteId === 'string' && canAccessSite(permissions, device.siteId)))
      .map((device) => device.id);

    if (allowedDeviceIds.length === 0) {
      return c.json({ data: [], total: 0 });
    }

    // If caller filtered to a specific deviceId, verify it's in the allowed set
    // — otherwise return 403 (do NOT silently return empty, which would be
    // ambiguous with "device exists but has no inventory rows").
    if (query.deviceId && !allowedDeviceIds.includes(query.deviceId)) {
      return c.json({ error: 'Device not found or access denied' }, 403);
    }

    const conditions = [inArray(softwareInventory.deviceId, allowedDeviceIds)];
    if (query.deviceId) {
      conditions.push(eq(softwareInventory.deviceId, query.deviceId));
    }
    if (query.search) {
      conditions.push(like(softwareInventory.name, `%${query.search}%`));
    }

    const items = await db.select().from(softwareInventory)
      .where(and(...conditions))
      .orderBy(softwareInventory.name);

    return c.json({ data: items, total: items.length });
  }
);

// GET /inventory/:deviceId - Get device software inventory
softwareRoutes.get(
  '/inventory/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareRead,
  zValidator('param', inventoryParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { deviceId } = c.req.valid('param');

    // Verify device belongs to org AND caller's site allowlist (when set).
    const [device] = await db.select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds) {
      if (typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
    }

    const items = await db.select().from(softwareInventory)
      .where(eq(softwareInventory.deviceId, deviceId))
      .orderBy(softwareInventory.name);

    return c.json({ data: items });
  }
);

// ---------------------------------------------------------------------------
// PRIVATE SOFTWARE DOWNLOAD ORIGIN POLICY (Wave 6 Task 4, security remediation)
// ---------------------------------------------------------------------------
// Server-side counterpart to agent/internal/netpolicy (Tasks 1-3): the org-
// and site-scoped allowlist of approved private origins the agent may dial
// for managed-software downloads. Task 5 (not this file) sends the effective
// allowlist with every managed-software command. Every endpoint here is
// MFA-protected and requires devices:write, matching the brief — this is a
// security-relevant policy surface, not a read-only informational one.

// GET /download-policy - Effective (org-only, since no site is targeted)
// approved-origins policy for the caller's org.
softwareRoutes.get(
  '/download-policy',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const policy = await getOrganizationSoftwareDownloadPolicy(orgId);
    return c.json({ data: policy });
  }
);

// PUT /download-policy - Replace the organization's approved-origins policy.
softwareRoutes.put(
  '/download-policy',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('json', softwareDownloadPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const payload = c.req.valid('json');
    const result = await setOrganizationSoftwareDownloadPolicy(orgId, payload);
    // A missing/RLS-invisible org (or a 0-row UPDATE despite the service's own
    // prior SELECT finding a row) must not read as success — see the service's
    // doc comment. Surfacing 404 here matches routes/orgs.ts's precedent for
    // the same zero-row-write class of bug rather than returning 200 for a
    // write that never persisted.
    if (!result.ok) return c.json({ error: 'Organization not found' }, 404);

    // Audit metadata is a count + version only — never the raw request URL or
    // its query string (finding: policy-change audit rows must not carry URL
    // query data). Written only on confirmed success, never for a rejected
    // write.
    writeRouteAudit(c, {
      orgId,
      action: 'software.downloadPolicy.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: {
        version: result.policy.version,
        approvedOriginCount: result.policy.approvedPrivateOrigins.length,
      },
    });

    return c.json({ data: result.policy });
  }
);

// PUT /download-policy/sites/:siteId - Replace a single site's approved-
// origins policy. requireSiteAccess enforces the caller's site allowlist
// (denied-site partner users get 403); the service additionally scopes the
// site lookup to the resolved org, so a siteId belonging to a different org
// 404s rather than silently writing (or reading) another tenant's row.
softwareRoutes.put(
  '/download-policy/sites/:siteId',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  requireSiteAccess('siteId'),
  zValidator('param', downloadPolicySiteParamSchema),
  zValidator('json', softwareDownloadPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { siteId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const result = await setSiteSoftwareDownloadPolicy(orgId, siteId, payload);
    if (!result.ok) return c.json({ error: 'Site not found' }, 404);

    writeRouteAudit(c, {
      orgId,
      action: 'software.downloadPolicy.site.update',
      resourceType: 'site',
      resourceId: siteId,
      details: {
        version: result.policy.version,
        approvedOriginCount: result.policy.approvedPrivateOrigins.length,
      },
    });

    // Return the EFFECTIVE (org ∪ site) policy — what Task 5's dispatch path
    // will actually send to devices at this site — not just the site's own
    // delta, so the operator sees the real outcome of the write.
    return c.json({ data: result.effective });
  }
);
