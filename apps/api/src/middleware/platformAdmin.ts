import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware } from './auth';
import { createAuditLogAsync } from '../services/auditService';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';

/**
 * Gates cross-tenant /admin/* endpoints to platform admins only. Runs the
 * standard authMiddleware first, then enforces `isPlatformAdmin === true`.
 * Every request that reaches a protected handler is audit-logged with
 * action `platform_admin.<route>` so we can spot misuse after the fact.
 */
export async function platformAdminMiddleware(c: Context, next: Next) {
  let authorized = false;

  await authMiddleware(c, async () => {
    const auth = c.get('auth');
    if (auth?.user?.isPlatformAdmin !== true) {
      throw new HTTPException(403, { message: 'platform admin access required' });
    }

    authorized = true;
    const route = buildRouteAction(c.req.path);
    createAuditLogAsync({
      orgId: null,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: `platform_admin.${route}`,
      resourceType: 'platform_admin',
      details: {
        method: c.req.method,
        path: c.req.path,
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success',
    });

    await next();
  });

  // If authMiddleware threw HTTPException, we never reach here. If it ran
  // without auth being set (e.g. mocked-out in tests), enforce 403 here too.
  if (!authorized) {
    throw new HTTPException(403, { message: 'platform admin access required' });
  }
}

function buildRouteAction(path: string): string {
  const cleaned = path.replace(/^\/api\/v1\/admin\//, '').replace(/^\/admin\//, '');
  const segments = cleaned
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ? ':id' : seg
    )
    .slice(0, 4);
  const action = segments.join('.') || 'unknown';
  return action.length > 80 ? action.slice(0, 80) : action;
}
