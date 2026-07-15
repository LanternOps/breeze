import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { servicePrincipals } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { validateApiKeyScopeDelegation } from '../services/apiKeyScopes';
import {
  createServicePrincipal,
  rotateServicePrincipalKey,
  disableServicePrincipal,
  migrateHumanKeyToServicePrincipal,
  ServicePrincipalNotFoundError,
  ApiKeyNotFoundError,
} from '../services/servicePrincipals';

// SR2-15: service-principal management. Mounted behind `authMiddleware` ONLY
// (never `apiKeyAuthMiddleware`) — these routes are JWT-user-only by design.
// A service-principal key itself has no interactive-login / MFA / recovery
// surface, so it must never be able to reach its own management surface;
// authMiddleware requires a `Bearer` JWT and rejects an X-API-Key-only
// request outright, which is what enforces that here.
export const servicePrincipalRoutes = new Hono();

// ============================================
// Helpers
// ============================================

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }
  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }
  // system scope has access to all
  return true;
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function mapServicePrincipalError(err: unknown): { status: 404 | 400; error: string } | null {
  if (err instanceof ServicePrincipalNotFoundError) {
    return { status: 404, error: 'Service principal not found' };
  }
  if (err instanceof ApiKeyNotFoundError) {
    return { status: 404, error: 'API key not found' };
  }
  if (err instanceof Error && err.message.includes('different organization')) {
    return { status: 400, error: err.message };
  }
  return null;
}

// ============================================
// Validation schemas
// ============================================

const listServicePrincipalsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().guid().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const createServicePrincipalSchema = z.object({
  orgId: z.string().guid(),
  name: z.string().min(1).max(255),
  scopes: z.array(z.string()).default([]),
});

const migrateKeySchema = z.object({
  keyId: z.string().guid(),
});

const principalIdParamSchema = z.object({ id: z.string().guid() });

// ============================================
// Routes
// ============================================

servicePrincipalRoutes.use('*', authMiddleware);

// GET /service-principals - list for org
servicePrincipalRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listServicePrincipalsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: ReturnType<typeof eq>[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(servicePrincipals.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(servicePrincipals.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(inArray(servicePrincipals.orgId, orgIds) as ReturnType<typeof eq>);
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(servicePrincipals.orgId, query.orgId));
    }

    if (query.status) {
      conditions.push(eq(servicePrincipals.status, query.status));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(servicePrincipals)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const list = await db
      .select()
      .from(servicePrincipals)
      .where(whereCondition)
      .orderBy(desc(servicePrincipals.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data: list, pagination: { page, limit, total } });
  }
);

// POST /service-principals - create
servicePrincipalRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', createServicePrincipalSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      if (data.orgId !== auth.orgId) {
        return c.json({ error: 'Can only create service principals for your organization' }, 403);
      }
    } else if (auth.scope === 'partner') {
      const hasAccess = await ensureOrgAccess(data.orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;

    // A service principal is organization-wide — service_principals has no site
    // axis — so a site-restricted creator must not mint one, or the principal
    // would reach every site in the org and escape the creator's restriction.
    if (permissions?.allowedSiteIds) {
      return c.json(
        { error: 'Site-restricted users cannot create service principals, which are organization-wide' },
        403,
      );
    }

    // SR2-15 delegation ceiling: a principal must never carry a scope its
    // creator does not currently hold. Mirrors the human API-key mint path
    // (routes/apiKeys.ts → validateRequestedScopes); without it, an org admin
    // with only orgs:write could mint a devices:execute principal and push an
    // arbitrary binary to the fleet via /dev/push.
    const delegation = validateApiKeyScopeDelegation(data.scopes, permissions);
    if (!delegation.ok) {
      return c.json(
        { error: delegation.error, ...(delegation.details ? { details: delegation.details } : {}) },
        delegation.status,
      );
    }

    const principal = await createServicePrincipal({
      orgId: data.orgId,
      name: data.name,
      scopes: data.scopes,
      createdBy: auth.user.id,
    });

    return c.json(principal, 201);
  }
);

// GET /service-principals/:id
servicePrincipalRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', principalIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const [principal] = await db
      .select()
      .from(servicePrincipals)
      .where(eq(servicePrincipals.id, id))
      .limit(1);

    if (!principal) {
      return c.json({ error: 'Service principal not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(principal.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json(principal);
  }
);

async function requirePrincipalOrgAccess(c: any, id: string) {
  const auth = c.get('auth') as AuthContext;
  const [principal] = await db
    .select()
    .from(servicePrincipals)
    .where(eq(servicePrincipals.id, id))
    .limit(1);

  if (!principal) {
    return { response: c.json({ error: 'Service principal not found' }, 404) };
  }

  const hasAccess = await ensureOrgAccess(principal.orgId, auth);
  if (!hasAccess) {
    return { response: c.json({ error: 'Access denied' }, 403) };
  }

  return { principal, auth };
}

// POST /service-principals/:id/rotate - mint a new key, revoke the prior one
servicePrincipalRoutes.post(
  '/:id/rotate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', principalIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = await requirePrincipalOrgAccess(c, id);
    if ('response' in gate) return gate.response;

    try {
      const rotated = await rotateServicePrincipalKey(id, gate.auth.user.id);
      return c.json({
        ...rotated,
        warning: 'Store this new API key securely. The old key has been revoked and this new key will not be shown again.',
      });
    } catch (err) {
      const mapped = mapServicePrincipalError(err);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      throw err;
    }
  }
);

// POST /service-principals/:id/disable - disable and cascade-revoke keys
servicePrincipalRoutes.post(
  '/:id/disable',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', principalIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = await requirePrincipalOrgAccess(c, id);
    if ('response' in gate) return gate.response;

    try {
      const disabled = await disableServicePrincipal(id, gate.auth.user.id);
      return c.json(disabled);
    } catch (err) {
      const mapped = mapServicePrincipalError(err);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      throw err;
    }
  }
);

// POST /service-principals/:id/migrate-key - re-point an existing human key
// onto this principal. The ONLY path that flips api_keys.principal_type.
servicePrincipalRoutes.post(
  '/:id/migrate-key',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', principalIdParamSchema),
  zValidator('json', migrateKeySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { keyId } = c.req.valid('json');
    const gate = await requirePrincipalOrgAccess(c, id);
    if ('response' in gate) return gate.response;

    try {
      const migrated = await migrateHumanKeyToServicePrincipal(keyId, id, gate.auth.user.id);
      return c.json(migrated);
    } catch (err) {
      const mapped = mapServicePrincipalError(err);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      throw err;
    }
  }
);
