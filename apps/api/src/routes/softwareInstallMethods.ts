/**
 * Package-manager install-method CRUD (winget/Homebrew), scoped under
 * /software/catalog/:id/install-methods. Mounted from routes/software.ts.
 *
 * `softwareInstallMethods` has no org_id column (parent-FK join tenancy —
 * see db/schema/software.ts) so ownership is enforced by loading the parent
 * software_catalog row and checking org_id, mirroring the deploy handlers'
 * inline guard in software.ts (loadOwnedCatalogItem below). Every write also
 * applies the package routes' ownership check (`authorizeCatalogItemWrite`):
 * a partner-owned package's methods are changed only by a full-partner caller
 * of its own partner (canManagePartnerWidePolicies, #2135).
 */
import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { softwareCatalog, softwareInstallMethods } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { resolveScopedOrgId, type AuthScopeContext } from '../services/softwareVersionShared';
import { pgErrorCode, isPgForeignKeyViolationCode } from '../utils/pgErrors';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import {
  authorizeCatalogItemWrite,
  importCatalogPackage,
  type CatalogPackageOwner,
} from '../services/softwareCatalogOps';
import {
  importPackageSchema,
  installMethodBodySchema,
  installMethodPatchSchema,
  validatePackageIdForKind,
} from '../services/softwareInstallMethodSchemas';

export {
  BREW_PACKAGE_NAME_RE,
  importPackageSchema,
  installMethodBodySchema,
  installMethodPatchSchema,
  validatePackageIdForKind,
  WINGET_PACKAGE_ID_RE,
} from '../services/softwareInstallMethodSchemas';

export const softwareInstallMethodRoutes = new Hono();
softwareInstallMethodRoutes.use('*', authMiddleware);

const requireInstallMethodRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireInstallMethodWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

export async function loadOwnedCatalogItem(catalogId: string, orgId: string) {
  const [item] = await db.select().from(softwareCatalog)
    .where(and(eq(softwareCatalog.id, catalogId), isNull(softwareCatalog.deletedAt))).limit(1);
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
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id'), orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    // Same ownership check as PATCH/DELETE /catalog/:id.
    const denied = authorizeCatalogItemWrite(auth, item, c.req.query('orgId'));
    if (denied) return c.json({ error: denied.error }, denied.status);
    // Integration rows and Breeze built-in packages (#6958) alike: the package
    // definition is not the caller's to extend.
    if (item.integrationProvider !== null || item.builtinPackageKey != null) {
      return c.json({ error: 'Built-in packages cannot carry install methods' }, 400);
    }
    const payload = c.req.valid('json');
    try {
      // Savepoint around the insert only (#11203): the caught unique violation
      // must not poison the request transaction. Audit stays outside it.
      const [method] = await withDbTransaction(async () =>
        db.insert(softwareInstallMethods).values({
          catalogId: item.id,
          platform: payload.platform,
          kind: payload.kind,
          packageId: payload.packageId,
          enabled: payload.enabled ?? true,
        }).returning()
      );
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
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id'), orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    // Same ownership check as PATCH/DELETE /catalog/:id. A method never moves
    // to another package: `packageId` is the winget/Homebrew identifier, and
    // the update below is pinned to this catalog row.
    const denied = authorizeCatalogItemWrite(auth, item, c.req.query('orgId'));
    if (denied) return c.json({ error: denied.error }, denied.status);
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
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    // Ownership axis (#2135, #12675): the same gate as POST /catalog. The
    // partner is ALWAYS the caller's own, and an explicit 'partner' wins over
    // the ?orgId= the web client adds for the organization selected in the
    // header.
    let owner: CatalogPackageOwner;
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
      // payload.orgId (if present) is the intended owner; otherwise fall back to
      // the ?orgId= query param / auth default, same resolution Task 2 uses.
      // Either way it's passed through resolveScopedOrgId so a caller can't
      // smuggle in an org they don't have access to via the body.
      const orgResult = resolveScopedOrgId(auth, payload.orgId ?? c.req.query('orgId'));
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
      owner = { orgId: orgResult.orgId, partnerId: null };
    }

    const { catalogItem, methods } = await importCatalogPackage({ owner, payload });

    writeRouteAudit(c, {
      orgId: owner.orgId,
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
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const item = await loadOwnedCatalogItem(c.req.param('id')!, orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    // Same ownership check as PATCH/DELETE /catalog/:id.
    const denied = authorizeCatalogItemWrite(auth, item, c.req.query('orgId'));
    if (denied) return c.json({ error: denied.error }, denied.status);
    const existing = await loadInstallMethod(item.id, c.req.param('methodId')!);
    if (!existing) return c.json({ error: 'Install method not found' }, 404);

    try {
      // Savepoint so the caught FK violation cannot poison the request
      // transaction and turn the 409 into a 500 at commit (#11203).
      await withDbTransaction(async () =>
        db.delete(softwareInstallMethods)
          .where(and(eq(softwareInstallMethods.id, existing.id), eq(softwareInstallMethods.catalogId, item.id)))
      );
    } catch (err: unknown) {
      // Same DrizzleQueryError unwrap as the create handler above (#3881).
      if (isPgForeignKeyViolationCode(pgErrorCode(err))) {
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
