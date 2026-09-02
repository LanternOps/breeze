/**
 * Package-manager install-method CRUD (winget/Homebrew), scoped under
 * /software/catalog/:id/install-methods. Mounted from routes/software.ts.
 *
 * `softwareInstallMethods` has no org_id column (parent-FK join tenancy —
 * see db/schema/software.ts) so ownership is enforced by loading the parent
 * software_catalog row and checking org_id, mirroring the deploy handlers'
 * inline guard in software.ts (loadOwnedCatalogItem below).
 */
import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { softwareCatalog, softwareInstallMethods } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { resolveScopedOrgId, type AuthScopeContext } from '../services/softwareVersionShared';
import { pgErrorCode } from '../utils/pgErrors';

export const WINGET_PACKAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const BREW_PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._/@-]{0,255}$/;

export function validatePackageIdForKind(kind: string, packageId: string): string | null {
  if (packageId.length > 256) return 'packageId exceeds 256 characters';
  if (kind === 'winget') {
    return WINGET_PACKAGE_ID_RE.test(packageId) ? null : 'Invalid winget package ID';
  }
  if (
    !BREW_PACKAGE_NAME_RE.test(packageId) ||
    packageId.startsWith('-') || packageId.startsWith('/') || packageId.includes('..')
  ) {
    return 'Invalid Homebrew package name';
  }
  return null;
}

export const installMethodBodySchema = z.object({
  platform: z.enum(['windows', 'macos']),
  kind: z.enum(['winget', 'homebrew_cask', 'homebrew_formula']),
  packageId: z.string().min(1).max(256),
  enabled: z.boolean().optional(),
}).superRefine((data, ctx) => {
  const platformOk =
    (data.kind === 'winget' && data.platform === 'windows') ||
    (data.kind !== 'winget' && data.platform === 'macos');
  if (!platformOk) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'kind does not match platform' });
  }
  const err = validatePackageIdForKind(data.kind, data.packageId);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packageId'], message: err });
});

const installMethodPatchSchema = z.object({
  packageId: z.string().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
}).refine(
  (data) => data.packageId !== undefined || data.enabled !== undefined,
  { message: 'At least one of packageId or enabled must be provided' },
);

export const softwareInstallMethodRoutes = new Hono();
softwareInstallMethodRoutes.use('*', authMiddleware);

const requireInstallMethodRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireInstallMethodWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

async function loadOwnedCatalogItem(catalogId: string, orgId: string) {
  const [item] = await db.select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId)).limit(1);
  // RLS restricts visibility; extra guard mirrors software.ts deploy handlers.
  if (!item || (item.orgId !== null && item.orgId !== orgId)) return null;
  return item;
}

async function loadInstallMethod(catalogId: string, methodId: string) {
  const [method] = await db.select().from(softwareInstallMethods)
    .where(and(eq(softwareInstallMethods.id, methodId), eq(softwareInstallMethods.catalogId, catalogId)))
    .limit(1);
  return method ?? null;
}

softwareInstallMethodRoutes.get(
  '/catalog/:id/install-methods',
  requireScope('organization', 'partner', 'system'),
  requireInstallMethodRead,
  async (c) => {
    const auth = c.get('auth') as AuthScopeContext;
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id')!, orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);

    const methods = await db.select().from(softwareInstallMethods)
      .where(eq(softwareInstallMethods.catalogId, item.id));
    return c.json({ data: methods }, 200);
  },
);

softwareInstallMethodRoutes.post(
  '/catalog/:id/install-methods',
  requireScope('organization', 'partner', 'system'),
  requireInstallMethodWrite,
  requireMfa(),
  zValidator('json', installMethodBodySchema),
  async (c) => {
    const auth = c.get('auth') as AuthScopeContext;
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id'), orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    if (item.integrationProvider !== null) {
      return c.json({ error: 'Built-in packages cannot carry install methods' }, 400);
    }
    const payload = c.req.valid('json');
    try {
      const [method] = await db.insert(softwareInstallMethods).values({
        catalogId: item.id,
        platform: payload.platform,
        kind: payload.kind,
        packageId: payload.packageId,
        enabled: payload.enabled ?? true,
      }).returning();
      writeRouteAudit(c, {
        orgId: orgResult.orgId,
        action: 'software.install_method.create',
        resourceType: 'software_install_method',
        resourceId: method!.id,
        resourceName: `${item.name} (${payload.kind}:${payload.packageId})`,
      });
      return c.json({ data: method }, 201);
    } catch (err: unknown) {
      // Read the SQLSTATE through pgErrorCode: drizzle-orm/postgres-js rethrows
      // the PostgresError inside a DrizzleQueryError whose own `.code` is
      // undefined, so a top-level `err.code` check never fires (issue #3881).
      if (pgErrorCode(err) === '23505') {
        return c.json({ error: 'An install method for this platform and kind already exists' }, 409);
      }
      throw err;
    }
  },
);

softwareInstallMethodRoutes.patch(
  '/catalog/:id/install-methods/:methodId',
  requireScope('organization', 'partner', 'system'),
  requireInstallMethodWrite,
  requireMfa(),
  zValidator('json', installMethodPatchSchema),
  async (c) => {
    const auth = c.get('auth') as AuthScopeContext;
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id'), orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    const existing = await loadInstallMethod(item.id, c.req.param('methodId'));
    if (!existing) return c.json({ error: 'Install method not found' }, 404);

    const payload = c.req.valid('json');
    if (payload.packageId !== undefined) {
      const err = validatePackageIdForKind(existing.kind, payload.packageId);
      if (err) return c.json({ error: err }, 400);
    }

    const updates: { packageId?: string; enabled?: boolean } = {};
    if (payload.packageId !== undefined) updates.packageId = payload.packageId;
    if (payload.enabled !== undefined) updates.enabled = payload.enabled;

    const [method] = await db.update(softwareInstallMethods)
      .set(updates)
      .where(and(eq(softwareInstallMethods.id, existing.id), eq(softwareInstallMethods.catalogId, item.id)))
      .returning();

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'software.install_method.update',
      resourceType: 'software_install_method',
      resourceId: existing.id,
      resourceName: `${item.name} (${existing.kind}:${payload.packageId ?? existing.packageId})`,
    });
    return c.json({ data: method ?? existing }, 200);
  },
);

const importPackageSchema = z.object({
  name: z.string().min(1).max(200),
  vendor: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  homepageUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  orgId: z.string().guid().optional(),
  methods: z.array(
    z.object({
      platform: z.enum(['windows', 'macos']),
      kind: z.enum(['winget', 'homebrew_cask', 'homebrew_formula']),
      packageId: z.string().min(1).max(256),
    })
  ).min(1).max(4),
}).superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.methods.forEach((m, i) => {
    const key = `${m.platform}:${m.kind}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i], message: 'Duplicate platform+kind' });
    }
    seen.add(key);
    const platformOk = (m.kind === 'winget') === (m.platform === 'windows');
    if (!platformOk) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i, 'kind'], message: 'kind does not match platform' });
    const err = validatePackageIdForKind(m.kind, m.packageId);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['methods', i, 'packageId'], message: err });
  });
});

// One-shot import: creates a catalog row and its install methods together, so
// the web import modal (Task 9) never leaves a catalog row with zero install
// methods (or vice versa) if the request is interrupted partway through.
softwareInstallMethodRoutes.post(
  '/catalog/import-package',
  requireScope('organization', 'partner', 'system'),
  requireInstallMethodWrite,
  requireMfa(),
  zValidator('json', importPackageSchema),
  async (c) => {
    const auth = c.get('auth') as AuthScopeContext;
    const payload = c.req.valid('json');
    // payload.orgId (if present) is the intended owner; otherwise fall back to
    // the ?orgId= query param / auth default, same resolution Task 2 uses.
    // Either way it's passed through resolveScopedOrgId so a caller can't
    // smuggle in an org they don't have access to via the body.
    const orgResult = resolveScopedOrgId(auth, payload.orgId ?? c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const orgId = orgResult.orgId;

    const { catalogItem, methods } = await db.transaction(async (tx) => {
      const [catalogItem] = await tx.insert(softwareCatalog).values({
        orgId,
        name: payload.name,
        vendor: payload.vendor,
        category: payload.category ?? 'application',
        description: payload.description,
        iconUrl: payload.iconUrl,
        websiteUrl: payload.homepageUrl,
      }).returning();

      const methods = await tx.insert(softwareInstallMethods).values(
        payload.methods.map((m) => ({
          catalogId: catalogItem!.id,
          platform: m.platform,
          kind: m.kind,
          packageId: m.packageId,
          enabled: true,
        }))
      ).returning();

      return { catalogItem: catalogItem!, methods };
    });

    writeRouteAudit(c, {
      orgId,
      action: 'software.catalog.import',
      resourceType: 'software_catalog',
      resourceId: catalogItem.id,
      resourceName: catalogItem.name,
      details: { methodCount: methods.length },
    });

    return c.json({ data: { catalogItem, methods } }, 201);
  },
);

softwareInstallMethodRoutes.delete(
  '/catalog/:id/install-methods/:methodId',
  requireScope('organization', 'partner', 'system'),
  requireInstallMethodWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AuthScopeContext;
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id')!, orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    const existing = await loadInstallMethod(item.id, c.req.param('methodId')!);
    if (!existing) return c.json({ error: 'Install method not found' }, 404);

    try {
      await db.delete(softwareInstallMethods)
        .where(and(eq(softwareInstallMethods.id, existing.id), eq(softwareInstallMethods.catalogId, item.id)));
    } catch (err: unknown) {
      // Same DrizzleQueryError unwrap as the create handler above (#3881).
      if (pgErrorCode(err) === '23503') {
        return c.json({
          error: 'This install method is referenced by past deployments — disable it instead of deleting it',
        }, 409);
      }
      throw err;
    }

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'software.install_method.delete',
      resourceType: 'software_install_method',
      resourceId: existing.id,
      resourceName: `${item.name} (${existing.kind}:${existing.packageId})`,
    });
    return c.json({ data: { success: true } }, 200);
  },
);
