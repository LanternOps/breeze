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
});

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
    const item = await loadOwnedCatalogItem(c.req.param('id'), orgResult.orgId);
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
      if ((err as { code?: string }).code === '23505') {
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

softwareInstallMethodRoutes.delete(
  '/catalog/:id/install-methods/:methodId',
  requireScope('organization', 'partner', 'system'),
  requireInstallMethodWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AuthScopeContext;
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id'), orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    const existing = await loadInstallMethod(item.id, c.req.param('methodId'));
    if (!existing) return c.json({ error: 'Install method not found' }, 404);

    await db.delete(softwareInstallMethods)
      .where(and(eq(softwareInstallMethods.id, existing.id), eq(softwareInstallMethods.catalogId, item.id)));

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
