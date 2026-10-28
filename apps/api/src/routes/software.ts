import { Hono, type Context, type Next } from 'hono';
import { zValidator, optionalJsonValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, sql, desc, like, or, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  softwareCatalog,
  softwareVersions,
  softwareInventory,
  devices,
} from '../db/schema';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  requireSiteAccess,
  type AuthContext,
} from '../middleware/auth';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { writeRouteAudit, type RouteAuditInput } from '../services/auditEvents';
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
  deleteObjects,
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
import { softwareUploadRoutes } from './softwareUploads';
import { softwareInstallMethodRoutes } from './softwareInstallMethods';
import { packageSearchRoutes } from './packageSearch';
import { createSoftwareDeployment } from '../services/softwareDeployment';
import {
  detectionRulesSchema,
  successExitCodesSchema,
  softwareDownloadPolicySchema,
  defaultSilentArgsForFileType,
} from '@breeze/shared';
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  getFileExtension,
  authorizeCatalogItemRead,
  hasInstallScript,
  installSpecError,
  normalizeSupportedOs,
  resolveScopedOrgId,
  setLatestSoftwareVersion,
  insertLatestSoftwareVersion,
  lockSoftwareCatalogForVersionInsert,
} from '../services/softwareVersionShared';
import {
  BUILTIN_PACKAGE_IMMUTABLE,
  activeCatalog,
  authorizeCatalogItemWrite,
  createCatalogSchema,
  createVersionSchema,
  deleteCatalogAndUploadedObjects,
  isImmutableBuiltin,
  platformSchema,
  prepareSoftwareVersionCreate,
  prepareSoftwareVersionUpdate,
  resolveCatalogListScope,
  updateCatalogSchema,
  updateVersionSchema,
} from '../services/softwareCatalogOps';
import {
  DEPLOYMENT_RESULT_STATUSES,
  cancelDeploymentSchema,
  cancelSoftwareDeployment,
  commitThenDeliverWithAuth,
  createDeploymentSchema,
  createSoftwareDeploymentFromRequest,
  getSoftwareDeployment,
  getSoftwareDeploymentSummary,
  listSoftwareDeploymentResults,
  listSoftwareDeployments,
  retryDeploymentSchema,
  retrySoftwareDeployment,
  type PendingInstallDeliveries,
} from '../services/softwareDeploymentOps';

// Moved to services (W12); re-exported so existing importers keep working.
export {
  computeSoftwareDeploymentAggregateStatus,
  softwareDeploymentSiteScopePredicate,
  type SoftwareDeploymentStatusCounts,
} from '../services/softwareDeploymentQueries';
export {
  pickInstallMethodForPlatform,
  splitTargetsByPlatform,
} from '../services/softwareDeploymentOps';

export const softwareRoutes = new Hono();
const requireSoftwareRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireSoftwareWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const requireSoftwareExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

/**
 * #6958: a pre/post-install script runs as SYSTEM/root on every target, so a
 * version write that carries one needs devices.execute on top of the route's
 * devices.write + MFA. Runs the same permission gate as the deploy routes,
 * only when a script is present. Returns the denial response, or null.
 */
async function denyUnlessDevicesExecute(c: Context): Promise<Response | null> {
  let allowed = false;
  const res = await requireSoftwareExecute(c, async () => { allowed = true; });
  if (allowed) return null;
  return res ?? c.json({ error: 'Install scripts require the devices.execute permission' }, 403);
}

/**
 * Organization download policy is an org-wide security control. Organization
 * users with a site ceiling must not read or replace it; their supported
 * boundary is the site overlay endpoint below. Partner/system access remains
 * governed by the existing organization resolver.
 *
 * Treat any defined value as restricted, including a defensive runtime null.
 */
const requireOrgWideSoftwarePolicyAccess = async (c: Context, next: Next) => {
  const auth = c.get('auth') as AuthContext;
  if (auth.scope === 'organization' && auth.allowedSiteIds !== undefined) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const categorySchema = z.enum([
  'browser', 'utility', 'compression', 'productivity',
  'communication', 'developer', 'media', 'security'
]);

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

const versionParamSchema = z.object({ id: z.string().guid() });
const versionIdParamSchema = z.object({ id: z.string().guid(), versionId: z.string().guid() });

/**
 * Host of a managed-software URL, for logging. Never the full URL: these carry
 * presigned capability query strings, and a stored URL may still hold
 * unresolved `{{org.name}}` deploy-time tokens that make `new URL()` throw.
 */
function safeUrlHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host || 'unparseable';
  } catch {
    return 'unparseable';
  }
}

const listDeploymentsSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'completed_with_errors', 'failed', 'cancelled']).optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

const deploymentIdParamSchema = z.object({ id: z.string().guid() });

const listDeploymentResultsSchema = z.object({
  status: z.enum(DEPLOYMENT_RESULT_STATUSES).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
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

    const conditions: SQL[] = [activeCatalog];
    // Include partner-scoped built-in (integration) packages alongside the caller's
    // own org packages. RLS scopes built-ins to the caller's partner, so widening
    // the WHERE here cannot leak another partner's rows. Partner-scope callers
    // additionally see their own partner-wide custom packages (#2135) — gated on
    // scope === 'partner' because org tokens never pass breeze_has_partner_access
    // and must not get an app-layer condition RLS won't back.
    if (scopeResult.orgCondition) {
      const branches: SQL[] = [scopeResult.orgCondition, isNotNull(softwareCatalog.integrationProvider)];
      if (auth.scope === 'partner' && auth.partnerId) {
        branches.push(and(isNull(softwareCatalog.orgId), eq(softwareCatalog.partnerId, auth.partnerId))!);
      }
      conditions.push(or(...branches)!);
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
        builtinPackageKey: softwareCatalog.builtinPackageKey,
        name: softwareCatalog.name,
        vendor: softwareCatalog.vendor,
        description: softwareCatalog.description,
        category: softwareCatalog.category,
        iconUrl: softwareCatalog.iconUrl,
        websiteUrl: softwareCatalog.websiteUrl,
        isManaged: softwareCatalog.isManaged,
        createdAt: softwareCatalog.createdAt,
        // #6958: whether the latest version's stored scripts are dispatched
        // (null when the item has no latest version). Table-qualified outer
        // id, for the reason in the NOTE below.
        installScriptsEnabled: sql<boolean | null>`(SELECT software_versions.install_scripts_enabled FROM software_versions WHERE software_versions.catalog_id = ${softwareCatalog}.id AND software_versions.is_latest LIMIT 1)`,
        // NOTE: the outer catalog id MUST be written as `${softwareCatalog}.id`
        // (table-qualified), never `${softwareCatalog.id}`. Drizzle renders a
        // bare column reference UNqualified ("id"), which inside these
        // correlated sub-selects resolves against the SUBQUERY's own table —
        // `software_versions.catalog_id = software_versions.id` — so every
        // count came back 0 and every kinds array came back empty for every
        // row. Proven against real Postgres in
        // __tests__/integration/softwareInstallMethods.integration.test.ts.
        versionCount: sql<number>`(SELECT count(*) FROM software_versions WHERE software_versions.catalog_id = ${softwareCatalog}.id)`,
        // Package-manager items (winget/Homebrew) ship zero uploaded versions but
        // are still deployable, so the list feed carries the enabled-method count
        // and the distinct kinds the catalog cards badge with.
        methodCount: sql<number>`(SELECT count(*) FROM software_install_methods WHERE software_install_methods.catalog_id = ${softwareCatalog}.id AND software_install_methods.enabled)`,
        methodKinds: sql<string[]>`(SELECT coalesce(array_agg(DISTINCT software_install_methods.kind), ARRAY[]::varchar[]) FROM software_install_methods WHERE software_install_methods.catalog_id = ${softwareCatalog}.id AND software_install_methods.enabled)`,
      }).from(softwareCatalog)
        .where(whereClause)
        .orderBy(softwareCatalog.name, softwareCatalog.id)
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

    // Ownership axis (#2135): partner-wide packages are shared by every org
    // under the partner, so creation is gated on the partner-wide capability —
    // same gate as software policies. The partner is ALWAYS the caller's own.
    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (auth.scope !== 'system' && !auth.partnerId) {
        return c.json({ error: 'Partner-wide packages require partner scope' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: 'Partner-wide packages require full partner org access (orgAccess must be "all")' }, 403);
      }
      if (!auth.partnerId) {
        // System scope has no partner of its own to stamp.
        return c.json({ error: 'Partner-wide packages require partner scope' }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgResult = resolveScopedOrgId(auth, payload.orgId ?? c.req.query('orgId'));
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
      owner = { orgId: orgResult.orgId, partnerId: null };
    }

    const [item] = await db.insert(softwareCatalog).values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      name: payload.name,
      vendor: payload.vendor ?? null,
      description: payload.description ?? null,
      category: payload.category ?? null,
      iconUrl: payload.iconUrl ?? null,
      websiteUrl: payload.websiteUrl ?? null,
      isManaged: payload.isManaged ?? false,
    }).returning();

    writeRouteAudit(c, {
      orgId: owner.orgId,
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
    // Same dual-axis widening as GET /catalog: built-ins for everyone, the
    // caller's own partner-wide custom packages for partner scope (#2135) —
    // search must not return a narrower set than the list it searches.
    const scopeBranches: SQL[] = [eq(softwareCatalog.orgId, orgId), isNotNull(softwareCatalog.integrationProvider)];
    if (auth.scope === 'partner' && auth.partnerId) {
      scopeBranches.push(and(isNull(softwareCatalog.orgId), eq(softwareCatalog.partnerId, auth.partnerId))!);
    }
    const conditions = [
      activeCatalog,
      or(...scopeBranches)!,
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

    const { id } = c.req.valid('param');
    // Look up by id alone, then authorize in JS. RLS bounds what is visible:
    // the caller's org rows, plus NULL-org partner rows — built-ins for any
    // caller, but partner-wide custom packages only for partner-scope tokens
    // (org tokens never pass breeze_has_partner_access, so those rows are
    // simply invisible here and 404). Partner rows have org_id NULL, so an
    // `eq(orgId)` filter would exclude them — matching the /deploy route (#1957).
    // authorizeCatalogItemRead narrows org-owned rows to the request's resolved
    // org (a partner caller acting as org A must not read sibling org B's
    // package), falling back to canAccessOrg only in the org-less
    // All-organizations view.
    const [item] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), activeCatalog));
    if (!item) return c.json({ error: 'Catalog item not found' }, 404);
    const readError = authorizeCatalogItemRead(auth, item.orgId, c.req.query('orgId'));
    if (readError) return c.json({ error: readError.error }, readError.status);

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

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [existing] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), activeCatalog));
    if (!existing) return c.json({ error: 'Catalog item not found' }, 404);
    // Built-ins are provisioned in system context and stay immutable here.
    if (existing.integrationProvider !== null && auth.scope !== 'system') {
      return c.json({ error: 'Built-in integration packages cannot be modified' }, 403);
    }
    if (isImmutableBuiltin(existing, auth)) {
      return c.json({ error: BUILTIN_PACKAGE_IMMUTABLE }, 403);
    }
    const denied = authorizeCatalogItemWrite(auth, existing, c.req.query('orgId'));
    if (denied) return c.json({ error: denied.error }, denied.status);

    const [updated] = await db.update(softwareCatalog)
      .set(payload)
      .where(eq(softwareCatalog.id, id))
      .returning();

    writeRouteAudit(c, {
      orgId: existing.orgId,
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

    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), activeCatalog));
    if (!existing) return c.json({ error: 'Catalog item not found' }, 404);
    // Built-ins are provisioned in system context and stay immutable here.
    if (existing.integrationProvider !== null && auth.scope !== 'system') {
      return c.json({ error: 'Built-in integration packages cannot be deleted' }, 403);
    }
    if (isImmutableBuiltin(existing, auth)) {
      return c.json({ error: BUILTIN_PACKAGE_IMMUTABLE }, 403);
    }
    const denied = authorizeCatalogItemWrite(auth, existing, c.req.query('orgId'));
    if (denied) return c.json({ error: denied.error }, denied.status);

    const deletion = await deleteCatalogAndUploadedObjects({
      id: existing.id,
      orgId: existing.orgId,
      partnerId: existing.partnerId,
      integrationProvider: existing.integrationProvider,
    });
    if (deletion.kind === 'not_found') {
      return c.json({ error: 'Catalog item not found' }, 404);
    }
    const archived = deletion.kind === 'archived';

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'software.catalog.delete',
      resourceType: 'software_catalog_item',
      resourceId: existing.id,
      resourceName: existing.name,
      ...(archived
        ? {
            details: {
              archived: true,
              deploymentCount: deletion.deploymentCount,
              inventoryCount: deletion.inventoryCount,
            },
          }
        : {}),
    });

    return c.json(archived ? { success: true, id, archived: true } : { success: true, id });
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

    const { id } = c.req.valid('param');
    // Partner-scoped rows (built-in EDR packages and partner-wide custom
    // packages, #2135) have org_id NULL, so an `eq(orgId)` filter excludes the
    // catalog row entirely and the endpoint 404s — which the deploy wizard
    // renders as "No versions" with a grayed-out deploy. Look up by id and
    // authorize in JS, mirroring the /deploy route: RLS binds a visible
    // NULL-org row to the caller's own partner (system scope sees all).
    // authorizeCatalogItemRead narrows org-owned rows to the request's
    // resolved org; only the org-less All-organizations view falls back to
    // canAccessOrg.
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), activeCatalog));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);
    const readError = authorizeCatalogItemRead(auth, catalogItem.orgId, c.req.query('orgId'));
    if (readError) return c.json({ error: readError.error }, readError.status);

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

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    // Dual-axis fetch + write authorization (#2135): partner-wide packages have
    // org_id NULL and take versions from full-partner admins only.
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), activeCatalog));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);
    const prepared = await prepareSoftwareVersionCreate({
      auth,
      catalogItem,
      requestedOrgId: c.req.query('orgId'),
      payload,
      denyUnlessDevicesExecute: () => denyUnlessDevicesExecute(c),
    });
    if (!prepared.ok) {
      if ('denied' in prepared) return prepared.denied;
      return c.json(prepared.body, prepared.status);
    }
    const { fileType } = prepared;

    const version = await insertLatestSoftwareVersion(id, prepared.values);

    if (!version) {
      return c.json({ error: 'Failed to create software version' }, 500);
    }

    writeRouteAudit(c, {
      orgId: catalogItem.orgId,
      action: 'software.catalog.version.create',
      resourceType: 'software_version',
      resourceId: version.id,
      resourceName: catalogItem.name,
      details: { version: payload.version, fileType },
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
      .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId), activeCatalog));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);
    if (isImmutableBuiltin(catalogItem, auth)) {
      return c.json({ error: BUILTIN_PACKAGE_IMMUTABLE }, 403);
    }

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

      // #7038: same stance as detectionRules — a malformed declaration is a 400,
      // never silently dropped (dropping it reports every such install failed).
      let successExitCodes: number[] = [];
      if (typeof fields.successExitCodes === 'string' && fields.successExitCodes.trim() !== '') {
        let rawCodes: unknown;
        try {
          rawCodes = JSON.parse(fields.successExitCodes);
        } catch {
          return c.json({ error: 'successExitCodes must be valid JSON' }, 400);
        }
        const parsedCodes = successExitCodesSchema.safeParse(rawCodes);
        if (!parsedCodes.success) {
          return c.json({ error: 'successExitCodes is invalid', details: parsedCodes.error.issues }, 400);
        }
        successExitCodes = parsedCodes.data;
      }

      let rawSupportedOs: unknown = null;
      if (typeof fields.supportedOs === 'string') {
        try {
          rawSupportedOs = JSON.parse(fields.supportedOs);
        } catch {
          // Malformed supportedOs silently dropped the OS-targeting field on the
          // created version. Don't fail the upload (matches prior behavior), but
          // make the discard visible rather than fully silent.
          captureMessage('software upload: discarded malformed supportedOs', {
            eventCode: 'software_upload_malformed_supported_os',
          });
        }
      }

      // #6958: de-duplicate supportedOs BEFORE the single-OS rule runs.
      const normalizedOs = normalizeSupportedOs(rawSupportedOs);
      if (!normalizedOs.ok) return c.json({ error: normalizedOs.error }, 400);
      const supportedOs = normalizedOs.value ?? null;

      // Auto-detect MSI silent args
      const silentDefaults = defaultSilentArgsForFileType(fileType);
      if (silentDefaults && !silentInstallArgs) {
        silentInstallArgs = silentDefaults.install;
      }
      if (silentDefaults && !silentUninstallArgs) {
        silentUninstallArgs = silentDefaults.uninstall;
      }

      // #6958: a script runs as SYSTEM/root (devices.execute), and the install
      // spec is checked before any bytes reach object storage.
      const scriptsEnabled = hasInstallScript({ preInstallScript, postInstallScript });
      if (scriptsEnabled) {
        const executeDenied = await denyUnlessDevicesExecute(c);
        if (executeDenied) return executeDenied;
      }
      const specError = installSpecError({
        fileType,
        supportedOs,
        silentInstallArgs,
        preInstallScript,
        postInstallScript,
      });
      if (specError) return c.json(specError, 400);

      const checksum = file.checksum;
      const fileSize = file.fileSize;

      // Do not write object bytes unless the catalog parent is still live,
      // and keep deletion serialized until the version FK is committed.
      if (!await lockSoftwareCatalogForVersionInsert(catalogId)) {
        return c.json({ error: 'Catalog item not found' }, 404);
      }

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

      let versionRecord: Awaited<ReturnType<typeof insertLatestSoftwareVersion>> | null = null;
      try {
        versionRecord = await insertLatestSoftwareVersion(catalogId, {
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
          installScriptsEnabled: scriptsEnabled,
          detectionRules,
          successExitCodes,
        });
      } catch (err) {
        captureException(err, c);
      }

      if (!versionRecord) {
        await deleteObjects([s3Key]).catch((cleanupErr) => captureException(cleanupErr, c));
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

// PATCH /catalog/:id/versions/:versionId - Update version metadata
softwareRoutes.patch(
  '/catalog/:id/versions/:versionId',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', versionIdParamSchema),
  zValidator('json', updateVersionSchema),
  async (c) => {
    const auth = c.get('auth');

    const { id, versionId } = c.req.valid('param');
    const payload = c.req.valid('json');

    // Dual-axis fetch + write authorization (#2135) — see version create above.
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), activeCatalog));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);
    const prepared = await prepareSoftwareVersionUpdate({
      auth,
      catalogItem,
      requestedOrgId: c.req.query('orgId'),
      versionId,
      payload,
      denyUnlessDevicesExecute: () => denyUnlessDevicesExecute(c),
    });
    if (!prepared.ok) {
      if ('denied' in prepared) return prepared.denied;
      return c.json(prepared.body, prepared.status);
    }
    const { updates } = prepared;

    const [updated] = await db.update(softwareVersions)
      .set(updates)
      .where(eq(softwareVersions.id, versionId))
      .returning();
    if (!updated) return c.json({ error: 'Failed to update software version' }, 500);

    writeRouteAudit(c, {
      orgId: catalogItem.orgId,
      action: 'software.catalog.version.update',
      resourceType: 'software_version',
      resourceId: versionId,
      resourceName: catalogItem.name,
      details: { version: updated.version, updatedFields: Object.keys(updates) },
    });

    return c.json({ data: updated });
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

    const { id, versionId } = c.req.valid('param');
    // Dual-axis fetch + write authorization (#2135) — see version create above.
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, id), activeCatalog));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);
    const denied = authorizeCatalogItemWrite(auth, catalogItem, c.req.query('orgId'));
    if (denied) return c.json({ error: denied.error }, denied.status);
    // #6958: a built-in package's versions are Breeze-pinned (URL, checksum,
    // scripts); neither editing nor re-promoting one is the caller's call.
    if (isImmutableBuiltin(catalogItem, auth)) {
      return c.json({ error: BUILTIN_PACKAGE_IMMUTABLE }, 403);
    }

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
      orgId: catalogItem.orgId,
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

    const catalogId = c.req.param('id')!;
    const versionId = c.req.param('versionId')!;

    // Dual-axis read authorization: org rows are narrowed to the request's
    // resolved org (canAccessOrg fallback only in the org-less All-orgs view);
    // partner rows (org_id NULL) are already bound to the caller's partner by RLS.
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, catalogId), activeCatalog));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);
    const readError = authorizeCatalogItemRead(auth, catalogItem.orgId, c.req.query('orgId'));
    if (readError) return c.json({ error: readError.error }, readError.status);

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
    const { page, limit } = getPagination(query);

    // ?status= is accepted but ignored — see listSoftwareDeployments.
    return c.json(await listSoftwareDeployments({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId,
      status: query.status,
      page,
      limit,
    }));
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

    const summary = await getSoftwareDeploymentSummary({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId,
    });
    return c.json({ data: summary });
  }
);

// ---------------------------------------------------------------------------
// Deployment creation (services/softwareDeploymentOps.ts)
// ---------------------------------------------------------------------------

/**
 * #7347 — the deployment create routes (`POST /deployments`, `POST /deploy`)
 * and `POST /deployments/:id/retry` run with NO ambient request transaction;
 * see commitThenDeliverWithAuth for the commit-before-push contract.
 */
function commitThenDeliver(
  c: Context,
  admit: (deliveries: PendingInstallDeliveries) => Promise<Response>,
): Promise<Response> {
  return commitThenDeliverWithAuth(c.get('auth'), admit);
}

/** writeRouteAudit bound to this request, for the service-layer audit callback. */
function routeAudit(c: Context) {
  return (event: RouteAuditInput) => writeRouteAudit(c, event);
}

// POST /deployments - Create deployment
softwareRoutes.post(
  '/deployments',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareExecute,
  requireMfa(),
  zValidator('json', createDeploymentSchema),
  // #7347 — self-managed: every row commits before any push (commitThenDeliver).
  async (c) => commitThenDeliver(c, async (deliveries) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const payload = c.req.valid('json');

    const result = await createSoftwareDeploymentFromRequest({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId,
      payload,
      createdBy: auth.user?.id ?? null,
      deliveries,
      audit: routeAudit(c),
    });
    return c.json(result.body, result.status);
  })
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
  // #7347 — self-managed: every row commits before any push (commitThenDeliver).
  async (c) => commitThenDeliver(c, async (deliveries) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const body = c.req.valid('json');
    const softwareId = body.softwareId;
    const version = body.version;
    const deviceIds = body.targets?.deviceIds ?? [];

    // Look up the catalog item + version. RLS restricts visibility to the caller's
    // org rows + partner-scoped NULL-org rows (built-in EDR packages, and — for
    // partner-scope tokens — partner-wide custom packages, #2135); the org guard
    // below rejects a (visible) org-owned row that belongs to a different org.
    const [catalogItem] = await db.select({
      id: softwareCatalog.id,
      orgId: softwareCatalog.orgId,
      name: softwareCatalog.name,
      integrationProvider: softwareCatalog.integrationProvider,
    }).from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, softwareId), activeCatalog));
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
      deferDelivery: true,
    });
    if (result.deliver) deliveries.push(result.deliver);

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
  })
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
    const deployment = await getSoftwareDeployment({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId,
      deploymentId: id,
    });
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);

    return c.json({ data: deployment });
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
    const result = await cancelSoftwareDeployment({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId,
      deploymentId: id,
      payload: c.req.valid('json'),
      audit: routeAudit(c),
    });
    return c.json(result.body, result.status);
  }
);
// POST /deployments/:id/retry - Retry failed per-device results
softwareRoutes.post(
  '/deployments/:id/retry',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareExecute,
  requireMfa(),
  zValidator('param', deploymentIdParamSchema),
  optionalJsonValidator(retryDeploymentSchema),
  // #7347 — self-managed: every row commits before any push (commitThenDeliver).
  async (c) => commitThenDeliver(c, async (deliveries) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const { id } = c.req.valid('param');
    const result = await retrySoftwareDeployment({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId,
      deploymentId: id,
      payload: c.req.valid('json'),
      createdBy: auth.user?.id ?? null,
      deliveries,
      audit: routeAudit(c),
    });
    return c.json(result.body, result.status);
  })
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

    const page = await listSoftwareDeploymentResults({
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      orgId,
      deploymentId: id,
      status: query.status,
      limit,
      offset,
    });
    if (!page) return c.json({ error: 'Deployment not found' }, 404);

    return c.json(page);
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
  requireOrgWideSoftwarePolicyAccess,
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
  requireOrgWideSoftwarePolicyAccess,
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

// ---------------------------------------------------------------------------
// Chunked upload sessions (issue #2951). Mounted after `use('*',
// authMiddleware)` above, so the sub-router's handlers run behind auth.
// ---------------------------------------------------------------------------
softwareRoutes.route('/', softwareUploadRoutes);

// ---------------------------------------------------------------------------
// Package-manager (winget/Homebrew) install-method CRUD. Same mounting
// pattern as softwareUploadRoutes above.
// ---------------------------------------------------------------------------
softwareRoutes.route('/', softwareInstallMethodRoutes);

// ---------------------------------------------------------------------------
// GET /software/package-search — winget/Homebrew typeahead. Same mounting
// pattern as the sub-routers above.
// ---------------------------------------------------------------------------
softwareRoutes.route('/', packageSearchRoutes);
