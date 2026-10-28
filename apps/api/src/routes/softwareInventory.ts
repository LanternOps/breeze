import { Hono, type Context } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { writeRouteAudit, type RouteAuditInput } from '../services/auditEvents';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';
import {
  approveInventorySoftware,
  clearInventorySoftware,
  denyInventorySoftware,
  listInventory,
  listInventoryDevices,
  resolveOrgId,
  searchInventoryNames,
} from '../services/softwareInventoryPolicy';

import { isHoldingOrg } from '../services/unassignedPool/protectedOrg';
import { PROTECTED_ORG_ERROR } from '../services/unassignedPool/orgType';
export const softwareInventoryRoutes = new Hono();
const requireSoftwareInventoryRead = requirePermission(
  PERMISSIONS.DEVICES_READ.resource,
  PERMISSIONS.DEVICES_READ.action,
);
const requireSoftwareInventoryWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

softwareInventoryRoutes.use('*', authMiddleware);
softwareInventoryRoutes.use('*', requireScope('organization', 'partner', 'system'));

// ============================================
// Query Schemas
// ============================================

const listQuerySchema = z.object({
  search: z.string().optional(),
  vendor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sortBy: z.enum(['name', 'vendor', 'deviceCount', 'lastSeen']).default('deviceCount'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const approveSchema = z.object({
  softwareName: z.string().min(1).max(500),
  vendor: z.string().max(200).optional(),
});

const denySchema = z.object({
  softwareName: z.string().min(1).max(500),
  vendor: z.string().max(200).optional(),
});

const deviceDrilldownQuerySchema = z.object({
  vendor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const nameSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

/** writeRouteAudit bound to this request, for the service-layer audit callback. */
function routeAudit(c: Context) {
  return (event: RouteAuditInput) => writeRouteAudit(c, event);
}

/**
 * The shared front half of the quick policy writes: the site-ceiling gate,
 * single-org resolution and the holding-org refusal. Returns the org id, or
 * the response to send.
 */
async function resolveInventoryWriteOrg(c: Context, auth: AuthContext): Promise<{ orgId: string } | Response> {
  const orgResult = resolveOrgId(auth, c.req.query('orgId'));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }
  const { orgId } = orgResult;
  // canAccessOrg is true for system scope: the holding org is never a target.
  if (await isHoldingOrg(orgId)) return c.json(PROTECTED_ORG_ERROR, 409);
  return { orgId };
}

// ============================================
// GET / — Aggregate inventory
// ============================================

softwareInventoryRoutes.get('/', requireSoftwareInventoryRead, zValidator('query', listQuerySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;
  const result = await listInventory({ auth, perms, orgId: c.req.query('orgId'), ...c.req.valid('query') });
  if ('error' in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json(result);
});

// ============================================
// GET /names — Distinct software-name search (filter picker)
// ============================================

softwareInventoryRoutes.get('/names', requireSoftwareInventoryRead, zValidator('query', nameSearchQuerySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;
  const { q, limit } = c.req.valid('query');
  const result = await searchInventoryNames({ auth, perms, orgId: c.req.query('orgId'), q, limit });
  if ('error' in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

// ============================================
// POST /approve — Quick approve
// ============================================

softwareInventoryRoutes.post('/approve', requireSoftwareInventoryWrite, requireMfa(), zValidator('json', approveSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  if (!canMutateOrgWideGovernance(auth)) {
    return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
  }
  const { softwareName, vendor } = c.req.valid('json');

  const org = await resolveInventoryWriteOrg(c, auth);
  if (org instanceof Response) return org;

  const result = await approveInventorySoftware({
    auth,
    orgId: org.orgId,
    softwareName,
    vendor,
    actorUserId: auth.user?.id ?? null,
    audit: routeAudit(c),
  });
  return c.json(result.body, result.status);
});

// ============================================
// POST /deny — Quick deny
// ============================================

softwareInventoryRoutes.post('/deny', requireSoftwareInventoryWrite, requireMfa(), zValidator('json', denySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  if (!canMutateOrgWideGovernance(auth)) {
    return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
  }
  const { softwareName, vendor } = c.req.valid('json');

  const org = await resolveInventoryWriteOrg(c, auth);
  if (org instanceof Response) return org;

  const result = await denyInventorySoftware({
    auth,
    orgId: org.orgId,
    softwareName,
    vendor,
    actorUserId: auth.user?.id ?? null,
    audit: routeAudit(c),
  });
  return c.json(result.body, result.status);
});

// ============================================
// POST /clear — Remove from allowlist/blocklist
// ============================================

softwareInventoryRoutes.post('/clear', requireSoftwareInventoryWrite, requireMfa(), zValidator('json', approveSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  if (!canMutateOrgWideGovernance(auth)) {
    return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
  }
  const { softwareName, vendor } = c.req.valid('json');

  const org = await resolveInventoryWriteOrg(c, auth);
  if (org instanceof Response) return org;

  const result = await clearInventorySoftware({
    auth,
    orgId: org.orgId,
    softwareName,
    vendor,
    actorUserId: auth.user?.id ?? null,
    audit: routeAudit(c),
  });
  return c.json(result.body, result.status);
});

// ============================================
// GET /:name/devices — Device drill-down
// ============================================

softwareInventoryRoutes.get('/:name/devices', requireSoftwareInventoryRead, zValidator('query', deviceDrilldownQuerySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;
  const softwareName = decodeURIComponent(c.req.param('name'));
  const { vendor, limit, offset } = c.req.valid('query');

  const result = await listInventoryDevices({
    auth,
    perms,
    orgId: c.req.query('orgId'),
    softwareName,
    vendor,
    limit,
    offset,
  });
  if ('error' in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json(result);
});
