import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyToken, TokenPayload } from '../services/jwt';
import { getUserPermissions, hasPermission, canAccessOrg, canAccessSite, UserPermissions } from '../services/permissions';
import { db } from '../db';
import { users, partnerUsers, organizationUsers, organizations } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface AuthContext {
  user: {
    id: string;
    email: string;
    name: string;
  };
  token: TokenPayload;
  partnerId: string | null;
  orgId: string | null;
  scope: 'system' | 'partner' | 'organization';
  /**
   * Pre-computed list of org IDs this user can access.
   * - string[] = user can access these specific orgs (org or partner scope)
   * - null = user can access ALL orgs (system scope)
   *
   * Usage in routes:
   *   if (auth.accessibleOrgIds) {
   *     conditions.push(inArray(table.orgId, auth.accessibleOrgIds));
   *   }
   */
  accessibleOrgIds: string[] | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// Optional auth - doesn't throw if not authenticated, just sets auth to null
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Not authenticated - continue without auth context
    await next();
    return;
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);

  if (!payload || payload.type !== 'access') {
    // Invalid token - continue without auth context
    await next();
    return;
  }

  // Fetch user
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status
    })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (user && user.status === 'active') {
    const accessibleOrgIds = await computeAccessibleOrgIds(
      payload.scope,
      payload.partnerId,
      payload.orgId
    );

    c.set('auth', {
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      },
      token: payload,
      partnerId: payload.partnerId,
      orgId: payload.orgId,
      scope: payload.scope,
      accessibleOrgIds
    });
  }

  await next();
}

/**
 * Compute which org IDs a user can access based on their scope.
 * Called once per request in authMiddleware.
 */
async function computeAccessibleOrgIds(
  scope: 'system' | 'partner' | 'organization',
  partnerId: string | null,
  orgId: string | null
): Promise<string[] | null> {
  if (scope === 'system') {
    // System users can access all orgs - return null to indicate no filter
    return null;
  }

  if (scope === 'organization') {
    // Org users can only access their org
    return orgId ? [orgId] : [];
  }

  if (scope === 'partner' && partnerId) {
    // Partner users can access all orgs under their partner
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId));

    return partnerOrgs.map(o => o.id);
  }

  return [];
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);

  if (!payload) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  if (payload.type !== 'access') {
    throw new HTTPException(401, { message: 'Invalid token type' });
  }

  // Fetch user to ensure they still exist and are active
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status
    })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user) {
    throw new HTTPException(401, { message: 'User not found' });
  }

  if (user.status !== 'active') {
    throw new HTTPException(403, { message: 'Account is not active' });
  }

  // Pre-compute accessible org IDs
  const accessibleOrgIds = await computeAccessibleOrgIds(
    payload.scope,
    payload.partnerId,
    payload.orgId
  );

  c.set('auth', {
    user: {
      id: user.id,
      email: user.email,
      name: user.name
    },
    token: payload,
    partnerId: payload.partnerId,
    orgId: payload.orgId,
    scope: payload.scope,
    accessibleOrgIds
  });

  await next();
}

export function requireScope(...scopes: Array<'system' | 'partner' | 'organization'>) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    if (!scopes.includes(auth.scope)) {
      throw new HTTPException(403, { message: 'Insufficient permissions' });
    }

    await next();
  };
}

export function requirePartner(c: Context, next: Next) {
  const auth = c.get('auth');

  if (!auth?.partnerId) {
    throw new HTTPException(403, { message: 'Partner context required' });
  }

  return next();
}

export function requireOrg(c: Context, next: Next) {
  const auth = c.get('auth');

  if (!auth?.orgId) {
    throw new HTTPException(403, { message: 'Organization context required' });
  }

  return next();
}

// Permission-based middleware
export function requirePermission(resource: string, action: string) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    const userPerms = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined
    });

    if (!userPerms) {
      throw new HTTPException(403, { message: 'No permissions found' });
    }

    if (!hasPermission(userPerms, resource, action)) {
      throw new HTTPException(403, { message: 'Permission denied' });
    }

    // Store permissions in context for further checks
    c.set('permissions', userPerms);

    await next();
  };
}

// Check if user can access a specific organization
export function requireOrgAccess(orgIdParam: string = 'orgId') {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');
    const orgId = c.req.param(orgIdParam) || c.req.query(orgIdParam);

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    if (!orgId) {
      throw new HTTPException(400, { message: 'Organization ID required' });
    }

    let userPerms = c.get('permissions') as UserPermissions | undefined;

    if (!userPerms) {
      const fetchedPerms = await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId || undefined,
        orgId: auth.orgId || undefined
      });
      userPerms = fetchedPerms || undefined;
    }

    if (!userPerms || !canAccessOrg(userPerms, orgId)) {
      throw new HTTPException(403, { message: 'Access to this organization denied' });
    }

    await next();
  };
}

// Check if user can access a specific site
export function requireSiteAccess(siteIdParam: string = 'siteId') {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');
    const siteId = c.req.param(siteIdParam) || c.req.query(siteIdParam);

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    if (!siteId) {
      throw new HTTPException(400, { message: 'Site ID required' });
    }

    let userPerms = c.get('permissions') as UserPermissions | undefined;

    if (!userPerms) {
      const fetchedPerms = await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId || undefined,
        orgId: auth.orgId || undefined
      });
      userPerms = fetchedPerms || undefined;
    }

    if (!userPerms || !canAccessSite(userPerms, siteId)) {
      throw new HTTPException(403, { message: 'Access to this site denied' });
    }

    await next();
  };
}

/**
 * Resolves which org(s) a user can access based on their auth context.
 * Use this instead of requiring orgId on every request.
 *
 * @param auth - The auth context from the request
 * @param requestedOrgId - Optional specific org ID requested (query param)
 * @returns Object with either:
 *   - type: 'single' with orgId - filter to one org
 *   - type: 'multiple' with orgIds - filter to these orgs (partner seeing all their orgs)
 *   - type: 'all' - no org filter (system scope)
 *   - type: 'error' - access denied
 */
export async function resolveOrgAccess(
  auth: AuthContext,
  requestedOrgId?: string
): Promise<
  | { type: 'single'; orgId: string }
  | { type: 'multiple'; orgIds: string[] }
  | { type: 'all' }
  | { type: 'error'; error: string; status: 400 | 403 }
> {
  // Organization-scoped users can only see their org
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { type: 'error', error: 'Organization context required', status: 403 };
    }
    // If they requested a different org, deny
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { type: 'error', error: 'Access to this organization denied', status: 403 };
    }
    return { type: 'single', orgId: auth.orgId };
  }

  // Partner-scoped users
  if (auth.scope === 'partner') {
    if (!auth.partnerId) {
      return { type: 'error', error: 'Partner context required', status: 403 };
    }

    // If specific org requested, verify it belongs to partner
    if (requestedOrgId) {
      const [org] = await db
        .select({ id: organizations.id, partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, requestedOrgId))
        .limit(1);

      if (!org || org.partnerId !== auth.partnerId) {
        return { type: 'error', error: 'Access to this organization denied', status: 403 };
      }

      return { type: 'single', orgId: requestedOrgId };
    }

    // No specific org - get all orgs under this partner
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId));

    return { type: 'multiple', orgIds: partnerOrgs.map(o => o.id) };
  }

  // System-scoped users
  if (requestedOrgId) {
    return { type: 'single', orgId: requestedOrgId };
  }

  return { type: 'all' };
}
