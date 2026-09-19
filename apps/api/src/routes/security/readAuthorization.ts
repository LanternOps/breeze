import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { requirePermission } from '../../middleware/auth';

const requireDeviceRead = requirePermission('devices', 'read');

/**
 * Security fleet reads are available to live platform administrators in system
 * scope without a tenant membership. Tenant-scoped callers must instead prove
 * the ordinary devices:read grant from their current org/partner membership.
 *
 * authMiddleware revalidates that a system token still belongs to a platform
 * admin. Keep the identity check here too: it makes this boundary fail closed
 * when mounted in isolation and prevents a forged system-shaped context from
 * bypassing the membership-backed permission path.
 */
export const requireSecurityReadAccess: MiddlewareHandler = async (c, next) => {
  const auth = c.get('auth');
  if (auth?.scope === 'system') {
    if (auth.user?.isPlatformAdmin === true) return next();
    throw new HTTPException(403, { message: 'platform admin access required' });
  }
  return requireDeviceRead(c, next);
};
