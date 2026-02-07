import { createAuditLogAsync } from './auditService';

const ANONYMOUS_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

type AuditActorType = 'user' | 'api_key' | 'agent' | 'system';
type AuditResult = 'success' | 'failure' | 'denied';

export type RequestLike = {
  req: {
    header: (name: string) => string | undefined;
  };
};

export interface AuditEventInput {
  orgId: string | null | undefined;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  details?: Record<string, unknown>;
  result?: AuditResult;
  errorMessage?: string;
  actorType?: AuditActorType;
  actorId?: string | null;
  actorEmail?: string | null;
}

function getClientIp(c: RequestLike): string | undefined {
  const forwarded = c.req.header('x-forwarded-for') ?? c.req.header('X-Forwarded-For');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim();
  }

  return c.req.header('x-real-ip') ?? c.req.header('X-Real-IP');
}

export function writeAuditEvent(c: RequestLike, event: AuditEventInput): void {
  if (!event.orgId) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[audit] Dropped event (no orgId):', event.action, event.resourceType);
    }
    return;
  }

  createAuditLogAsync({
    orgId: event.orgId,
    actorType: event.actorType ?? (event.actorId ? 'user' : 'system'),
    actorId: event.actorId ?? ANONYMOUS_ACTOR_ID,
    actorEmail: event.actorEmail ?? undefined,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? undefined,
    resourceName: event.resourceName ?? undefined,
    details: event.details,
    ipAddress: getClientIp(c),
    userAgent: c.req.header('user-agent'),
    result: event.result ?? 'success',
    errorMessage: event.errorMessage
  });
}

/**
 * Convenience wrapper for route handlers that extracts actorId/actorEmail
 * from the Hono auth context, reducing boilerplate at each call site.
 */
export interface RouteAuditInput {
  orgId: string | null | undefined;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  details?: Record<string, unknown>;
  result?: AuditResult;
}

export type AuthContext = RequestLike & {
  get(key: 'auth'): { user: { id: string; email?: string } };
};

export function writeRouteAudit(c: AuthContext, event: RouteAuditInput): void {
  const auth = c.get('auth');
  const user = auth?.user;
  writeAuditEvent(c, {
    ...event,
    actorId: user?.id ?? ANONYMOUS_ACTOR_ID,
    actorEmail: user?.email,
  });
}
