import type { TopologyRequestContext, TopologyCapability } from '../../services/topology/access';
import { requireTopologySiteAccess, TopologyError } from '../../services/topology/access';
import type { AuthContext } from '../../middleware/auth';
import { getUserPermissions, type UserPermissions } from '../../services/permissions';
import type { MiddlewareHandler } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    topologyContext: TopologyRequestContext;
  }
}

/**
 * Route adapter for the common topology authorization boundary. Leaf routers
 * use the resulting `topologyContext`; they never construct authority from an
 * orgId supplied in a query string or request body.
 */
export function requireTopologySiteCapability(
  capability: TopologyCapability,
  siteIdParam = 'siteId',
): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    let permissions = c.get('permissions') as UserPermissions | undefined;
    if (!permissions) {
      permissions = await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId ?? undefined,
        orgId: auth.orgId ?? undefined,
        scope: auth.scope,
      }) ?? undefined;
    }

    if (!permissions) {
      return c.json(
        {
          error: 'Topology permission denied',
          code: 'topology_permission_denied',
        },
        403,
      );
    }

    try {
      const topologyContext = await requireTopologySiteAccess(
        auth,
        permissions,
        c.req.param(siteIdParam) ?? '',
        capability,
      );
      c.set('permissions', permissions);
      c.set('topologyContext', topologyContext);
      await next();
    } catch (error) {
      if (error instanceof TopologyError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  };
}
