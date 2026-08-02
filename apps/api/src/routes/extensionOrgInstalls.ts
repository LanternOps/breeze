/**
 * Partner management surface for tenant-scoped extension installs (L1).
 * Mounted at /api/v1/extensions. Reachable safely alongside the extension
 * gateway's `/api/v1/:routeNamespace/*` catch-all for two reasons — NOT
 * mount/registration order on the Hono app (see the fuller note at the
 * `/extensions` mounts in index.ts): (a) 'extensions' is in
 * RESERVED_ROUTE_NAMESPACES (packages/extension-sdk/src/manifest.ts), so no
 * extension manifest's routeNamespace can ever be 'extensions' — the gateway
 * can never resolve an active extension for this namespace; (b) the
 * gateway's dispatchAlias middleware calls `next()` (a pass-through) rather
 * than responding whenever no active extension resolves, so unmatched
 * `/api/v1/extensions/*` traffic always continues on to this router.
 *
 * Access model: partner/system-scope callers; per-org authorization is the
 * explicit canAccessOrg check (404 on failure — the non-disclosure stance of
 * the dispatch gate: a caller must not learn whether an extension or an org
 * exists outside its reach). Persistence runs in the AMBIENT REQUEST CONTEXT,
 * so the org-axis RLS on extension_org_installs bounds it a second time —
 * deliberately unlike the gateway's system-scope read (orgInstallStore.ts).
 *
 * The provisioning existence check is host-owned and system-scoped
 * (ExtensionStateStore.get): whether a bundle is provisioned is not a tenant
 * fact. Activating an unprovisioned extension is 404, not 400.
 *
 * Deactivate flips enabled=false and KEEPS the row (installed_by/installed_at
 * are the audit trail); re-activation is the same upsert.
 */
import { Hono, type Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { db } from '../db';
import { extensionOrgInstalls } from '../db/schema/extensions';
import { createExtensionStateStore, type ExtensionStateStore } from '../extensions/stateStore';
import { createAuditLogAsync } from '../services/auditService';

const uuidSchema = z.string().uuid();

export interface ExtensionOrgInstallListEntry {
  orgId: string;
  enabled: boolean;
  installedBy: string | null;
  installedAt: Date;
  updatedAt: Date;
}

/** Request-scoped persistence port (injectable for unit tests). */
export interface ExtensionOrgInstallManagementPort {
  upsert(extension: string, orgId: string, installedBy: string | null): Promise<void>;
  /** enabled=false; returns false when no row exists. */
  disable(extension: string, orgId: string): Promise<boolean>;
  list(extension: string): Promise<ExtensionOrgInstallListEntry[]>;
}

export interface ExtensionOrgInstallRoutesDeps {
  stateStore: Pick<ExtensionStateStore, 'get'>;
  installs: ExtensionOrgInstallManagementPort;
}

const notFound = (c: Context) => c.json({ error: 'not found' }, 404);

export function createExtensionOrgInstallRoutes(deps: ExtensionOrgInstallRoutesDeps): Hono {
  const routes = new Hono();
  routes.use('*', authMiddleware);
  routes.use('*', requireScope('partner', 'system'));

  /**
   * Shared gate: extension provisioned + orgId well-formed + org accessible.
   * Every failure is the same 404 — non-disclosure, like the dispatch gate.
   */
  async function gate(
    c: Context,
    opts: { requireOrg: boolean },
  ): Promise<{ name: string; orgId: string | null } | Response> {
    const name = c.req.param('name');
    if (!name || !(await deps.stateStore.get(name))) return notFound(c);
    if (!opts.requireOrg) return { name, orgId: null };
    const rawOrgId = c.req.param('orgId');
    const parsed = uuidSchema.safeParse(rawOrgId);
    if (!parsed.success) return notFound(c);
    const auth = c.get('auth') as AuthContext;
    if (!auth.canAccessOrg(parsed.data)) return notFound(c);
    return { name, orgId: parsed.data };
  }

  routes.put('/:name/orgs/:orgId', async (c) => {
    const gated = await gate(c, { requireOrg: true });
    if (gated instanceof Response) return gated;
    const auth = c.get('auth') as AuthContext;
    await deps.installs.upsert(gated.name, gated.orgId!, auth.user.id);
    createAuditLogAsync({
      orgId: gated.orgId!,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'extension_org_install.activated',
      resourceType: 'extension',
      resourceId: gated.name,
      resourceName: gated.name,
      result: 'success',
    });
    return c.json({ extension: gated.name, orgId: gated.orgId, enabled: true });
  });

  routes.delete('/:name/orgs/:orgId', async (c) => {
    const gated = await gate(c, { requireOrg: true });
    if (gated instanceof Response) return gated;
    const auth = c.get('auth') as AuthContext;
    const existed = await deps.installs.disable(gated.name, gated.orgId!);
    if (!existed) return notFound(c);
    createAuditLogAsync({
      orgId: gated.orgId!,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'extension_org_install.deactivated',
      resourceType: 'extension',
      resourceId: gated.name,
      resourceName: gated.name,
      result: 'success',
    });
    return c.json({ extension: gated.name, orgId: gated.orgId, enabled: false });
  });

  routes.get('/:name/orgs', async (c) => {
    const gated = await gate(c, { requireOrg: false });
    if (gated instanceof Response) return gated;
    // Ambient request scope: RLS filters rows to the caller's accessible orgs.
    const installs = await deps.installs.list(gated.name);
    return c.json({
      installs: installs.map((row) => ({
        orgId: row.orgId,
        enabled: row.enabled,
        installedBy: row.installedBy,
        installedAt: row.installedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  return routes;
}

/** Production port: plain Drizzle in the ambient request context (RLS-bounded). */
export const drizzleInstallManagementPort: ExtensionOrgInstallManagementPort = {
  async upsert(extension, orgId, installedBy) {
    await db
      .insert(extensionOrgInstalls)
      .values({ extensionName: extension, orgId, enabled: true, installedBy })
      .onConflictDoUpdate({
        target: [extensionOrgInstalls.extensionName, extensionOrgInstalls.orgId],
        set: { enabled: true, installedBy, updatedAt: sql`now()` },
      });
  },
  async disable(extension, orgId) {
    const updated = await db
      .update(extensionOrgInstalls)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(and(
        eq(extensionOrgInstalls.extensionName, extension),
        eq(extensionOrgInstalls.orgId, orgId),
      ))
      .returning({ orgId: extensionOrgInstalls.orgId });
    return updated.length > 0;
  },
  async list(extension) {
    return db
      .select({
        orgId: extensionOrgInstalls.orgId,
        enabled: extensionOrgInstalls.enabled,
        installedBy: extensionOrgInstalls.installedBy,
        installedAt: extensionOrgInstalls.installedAt,
        updatedAt: extensionOrgInstalls.updatedAt,
      })
      .from(extensionOrgInstalls)
      .where(eq(extensionOrgInstalls.extensionName, extension));
  },
};

export const extensionOrgInstallRoutes = createExtensionOrgInstallRoutes({
  stateStore: createExtensionStateStore(),
  installs: drizzleInstallManagementPort,
});
