import { createAuditLogAsync } from './auditService';
import { getTrustedClientIpOrUndefined } from './clientIp';

const ANONYMOUS_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function writeAuditEvent(c: RequestLike, event: AuditEventInput): void {
  if (!event.orgId) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[audit] Dropped event (no orgId):', event.action, event.resourceType);
    }
    return;
  }

  const details = (event.details && typeof event.details === 'object')
    ? { ...event.details }
    : {};

  const rawActorId = event.actorId ?? null;
  const actorId = isUuid(rawActorId) ? rawActorId : ANONYMOUS_ACTOR_ID;
  if (rawActorId && !isUuid(rawActorId)) {
    details.rawActorId = rawActorId;
  }

  const rawResourceId = event.resourceId ?? null;
  const resourceId = isUuid(rawResourceId) ? rawResourceId : undefined;
  if (rawResourceId && !isUuid(rawResourceId)) {
    details.rawResourceId = rawResourceId;
  }

  createAuditLogAsync({
    orgId: event.orgId,
    actorType: event.actorType ?? (event.actorId ? 'user' : 'system'),
    actorId,
    actorEmail: event.actorEmail ?? undefined,
    action: event.action,
    resourceType: event.resourceType,
    resourceId,
    resourceName: event.resourceName ?? undefined,
    details: Object.keys(details).length > 0 ? details : undefined,
    ipAddress: getTrustedClientIpOrUndefined(c),
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
