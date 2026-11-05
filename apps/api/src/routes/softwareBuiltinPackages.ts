/**
 * Breeze-pinned built-in software packages (#6958 D2): the DNS filtering
 * clients (Control D, NextDNS) defined in services/builtinDeploymentPackages.ts.
 *
 *   GET  /software/builtin-packages        list visible keys + provisioned state
 *   POST /software/builtin-packages/:key   provision (or un-archive) the partner's row
 *
 * Provisioning writes a PARTNER-AXIS software_catalog row whose version carries
 * install scripts that agents run as SYSTEM/root on every device the partner's
 * policies reach. So the POST requires, on top of partner/system scope:
 * devices.write, devices.execute, MFA, and canManagePartnerWidePolicies
 * (full partner org access). Partner scope always provisions for its own
 * partner (auth.partnerId); only system scope may name a partner, and only
 * system scope may provision a hidden key (lab gate L2).
 *
 * Org scope never reaches these routes (requireScope). It also does not list
 * keyed rows in GET /catalog: their versions are RLS-invisible to org scope
 * (deferred follow-up), so the card would be undeployable.
 *
 * No AI/MCP surface by design (mcpCoverage: human_only_provisioning).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { partners, softwareCatalog } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import {
  BUILTIN_TENANT_VAR_PACKAGES,
  ensurePinnedBuiltinPackage,
  isBuiltinPackageKey,
  type PinnedBuiltinPackageDef,
} from '../services/builtinDeploymentPackages';

export const softwareBuiltinPackagesRoutes = new Hono();
softwareBuiltinPackagesRoutes.use('*', authMiddleware);

const requireRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const requireExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

const partnerIdQuery = z.string().uuid();

type TargetPartner = { partnerId: string } | { response: Response };

/**
 * Partner scope: always the caller's own partner (a query/body partnerId is
 * ignored). System scope: `?partnerId=` is required.
 */
function resolveTargetPartner(c: Context, auth: Pick<AuthContext, 'scope' | 'partnerId'>): TargetPartner {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { response: c.json({ error: 'Partner context required' }, 403) };
    return { partnerId: auth.partnerId };
  }
  const parsed = partnerIdQuery.safeParse(c.req.query('partnerId'));
  if (!parsed.success) return { response: c.json({ error: 'partnerId query parameter (uuid) is required in system scope' }, 400) };
  return { partnerId: parsed.data };
}

function visibleDefs(scope: string): PinnedBuiltinPackageDef[] {
  return Object.values(BUILTIN_TENANT_VAR_PACKAGES).filter((def) => scope === 'system' || !def.hidden);
}

softwareBuiltinPackagesRoutes.get('/', requireScope('partner', 'system'), requireRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const target = resolveTargetPartner(c, auth);
  if ('response' in target) return target.response;

  // Partner scope reads through the request's RLS context (partner branch);
  // a system-scope request already runs in system context.
  const rows = await db
    .select({ id: softwareCatalog.id, builtinPackageKey: softwareCatalog.builtinPackageKey, deletedAt: softwareCatalog.deletedAt })
    .from(softwareCatalog)
    .where(and(eq(softwareCatalog.partnerId, target.partnerId), isNotNull(softwareCatalog.builtinPackageKey)));
  const byKey = new Map(rows.map((row) => [row.builtinPackageKey, row]));

  return c.json({
    data: visibleDefs(auth.scope).map((def) => {
      const row = byKey.get(def.key);
      return {
        key: def.key,
        name: def.name,
        vendor: def.vendor,
        os: def.os,
        version: def.version,
        fileType: def.fileType,
        requiredVars: [...def.requiredVars],
        uninstallCommand: def.uninstallCommand,
        catalogId: row?.id ?? null,
        archived: Boolean(row?.deletedAt),
      };
    }),
  });
});

softwareBuiltinPackagesRoutes.post(
  '/:key',
  requireScope('partner', 'system'),
  requireWrite,
  requireExecute,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const key = c.req.param('key') ?? '';
    // Hidden keys are not offered to partner scope: same 404 as an unknown key.
    if (!isBuiltinPackageKey(key) || (auth.scope !== 'system' && BUILTIN_TENANT_VAR_PACKAGES[key].hidden)) {
      return c.json({ error: 'Built-in package not found' }, 404);
    }

    const target = resolveTargetPartner(c, auth);
    if ('response' in target) return target.response;

    if (auth.scope === 'system') {
      const [partner] = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, target.partnerId)).limit(1);
      if (!partner) return c.json({ error: 'Partner not found' }, 404);
    }

    const def = BUILTIN_TENANT_VAR_PACKAGES[key];
    const { catalogId, versionId } = await ensurePinnedBuiltinPackage({ key, partnerId: target.partnerId });

    writeRouteAudit(c, {
      orgId: null,
      partnerId: target.partnerId,
      action: 'software.builtin_package.provision',
      resourceType: 'software_catalog',
      resourceId: catalogId,
      resourceName: def.name,
      details: { builtinPackageKey: key, version: def.version, versionId },
    });

    return c.json({ catalogId, versionId }, 201);
  },
);
