import { createAuditLogAsync, type InitiatedByType } from './auditService';
import { getTrustedClientIpOrUndefined } from './clientIp';
import { sanitizeAuditPayload } from './auditPayloadSanitizer';
import * as dbModule from '../db';

export const ANONYMOUS_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Aliased to the shared ActorType so this file cannot drift from the DB enum
// and the shared validators — parity pinned by db/schema/audit.enums.test.ts.
type AuditActorType = import('@breeze/shared').ActorType;
type AuditResult = import('@breeze/shared').AuditResult;

export type RequestLike = {
  req: {
    header: (name: string) => string | undefined;
  };
};

/** Build a RequestLike shim from a pre-captured IP + user-agent snapshot. */
export function requestLikeFromSnapshot(snapshot: { ip?: string; userAgent?: string }): RequestLike {
  return {
    req: {
      header: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'x-forwarded-for') return snapshot.ip;
        if (lower === 'user-agent') return snapshot.userAgent;
        return undefined;
      },
    },
  };
}

export interface AuditEventInput {
  orgId: string | null | undefined;
  /**
   * Partner attribution for a partner-scoped (org_id NULL) event (#7696) — what
   * makes the row visible in that partner's Audit Trail. Ignored (persisted as
   * NULL) whenever `orgId` is set: org rows stay on the org axis. When omitted
   * (`undefined`) on a NULL-org event, it is derived from a partner-scope
   * request's auth (see `derivePartnerAttribution`); pass `null` explicitly for
   * a NULL-org event that is platform-wide even though a partner user caused it.
   */
  partnerId?: string | null;
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
  initiatedBy?: InitiatedByType;
  /**
   * Pre-resolved client IP / user-agent, for a service that audits on behalf of
   * a request it no longer holds. Takes precedence over deriving them from `c`.
   * Needed because `requestLikeFromSnapshot` carries no socket peer, so
   * `getTrustedClientIp` on that shim fails the proxy-trust check in production
   * (TRUSTED_PROXY_CIDRS set) and silently records no IP — plus a false
   * `[proxy-trust] MISCONFIGURATION` warning (#5611 review).
   */
  ipAddress?: string;
  userAgent?: string;
}

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

type PartnerScopeAuth = { scope?: unknown; partnerId?: unknown };

function readRequestAuth(c: RequestLike): PartnerScopeAuth | undefined {
  // RequestLike is structural: route callers pass the Hono context (which has
  // `get`), services pass a `requestLikeFromSnapshot` shim (which does not).
  const get = (c as { get?: (key: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  try {
    const auth = get.call(c, 'auth');
    return auth && typeof auth === 'object' ? (auth as PartnerScopeAuth) : undefined;
  } catch (err) {
    console.warn('[audit] could not read request auth for partner attribution:', err);
    return undefined;
  }
}

/**
 * The ambient RLS context's partner, for partner scope only. AI tools and
 * services audit through `requestLikeFromSnapshot` (no auth on it) but run
 * inside `withDbAccessContext(dbAccessContextFromAuth(auth))`, so this is the
 * same partner the caller's reads are scoped to.
 */
function ambientPartnerScopeId(): string | null {
  let ctx: ReturnType<typeof dbModule.getCurrentDbAccessContext>;
  try {
    ctx = dbModule.getCurrentDbAccessContext();
  } catch {
    // Unit tests that mock '../db' without this export.
    return null;
  }
  if (ctx?.scope !== 'partner') return null;
  const ids = ctx.accessiblePartnerIds;
  return Array.isArray(ids) && ids.length === 1 && isUuid(ids[0]) ? ids[0]! : null;
}

/**
 * The partner_id to persist for this event (#7696).
 *
 * - Org rows never carry one (the DB CHECK
 *   audit_logs_partner_only_without_org_chk enforces the same invariant).
 * - An explicit `event.partnerId` (including `null`) wins.
 * - Otherwise a NULL-org event written from a PARTNER-scope request is
 *   attributed to the caller's partner. Gated on scope, not on `partnerId`
 *   alone: organization-scope tokens carry their MSP's partnerId too, and a
 *   NULL-org row an org user causes must not land in the MSP's trail.
 * - With no request auth on `c` (a snapshot shim), the ambient partner-scope
 *   DB access context is used instead, under the same scope gate.
 */
export function derivePartnerAttribution(c: RequestLike, event: Pick<AuditEventInput, 'orgId' | 'partnerId'>): string | null {
  if (event.orgId) return null;
  if (event.partnerId !== undefined) {
    if (event.partnerId !== null && !isUuid(event.partnerId)) {
      console.warn('[audit] ignoring non-uuid partnerId for partner attribution', { partnerId: event.partnerId });
      return null;
    }
    return event.partnerId;
  }
  const auth = readRequestAuth(c);
  if (auth) {
    return auth.scope === 'partner' && typeof auth.partnerId === 'string' && isUuid(auth.partnerId)
      ? auth.partnerId
      : null;
  }
  return ambientPartnerScopeId();
}

export function writeAuditEventAsync(c: RequestLike, event: AuditEventInput): Promise<void> {

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

  const resolvedActorType = event.actorType ?? (event.actorId ? 'user' : 'system');

  // Auto-derive initiatedBy from actorType when not explicitly set
  let initiatedBy: InitiatedByType | undefined = event.initiatedBy;
  if (!initiatedBy) {
    switch (resolvedActorType) {
      case 'agent': initiatedBy = 'agent'; break;
      case 'api_key': initiatedBy = 'integration'; break;
      case 'system': initiatedBy = 'schedule'; break;
      case 'ai_agent': initiatedBy = 'ai'; break;
      default: initiatedBy = 'manual'; break;
    }
  }

  // Run details through the shared sanitizer before persisting. ~499
  // audit call sites previously had to filter secrets at the call point;
  // applying sanitizeAuditPayload here closes the systemic gap (e.g.
  // admin/abuse.ts persisting raw err.message strings into details).
  const sanitizedDetails = Object.keys(details).length > 0
    ? (sanitizeAuditPayload(details) as Record<string, unknown>)
    : undefined;

  return createAuditLogAsync({
    orgId: event.orgId ?? undefined,
    // Resolved now, not at persist time: a failed write is replayed from the
    // retry queue long after the request (and its auth) is gone.
    partnerId: derivePartnerAttribution(c, event),
    actorType: resolvedActorType,
    actorId,
    actorEmail: event.actorEmail ?? undefined,
    action: event.action,
    resourceType: event.resourceType,
    resourceId,
    resourceName: event.resourceName ?? undefined,
    details: sanitizedDetails,
    ipAddress: event.ipAddress ?? getTrustedClientIpOrUndefined(c),
    userAgent: event.userAgent ?? c.req.header('user-agent'),
    result: event.result ?? 'success',
    errorMessage: event.errorMessage,
    initiatedBy,
  });
}

/** Fire-and-forget compatibility wrapper for existing audit call sites. */
export function writeAuditEvent(c: RequestLike, event: AuditEventInput): void {
  void writeAuditEventAsync(c, event);
}

/**
 * Convenience wrapper for route handlers that extracts actorId/actorEmail
 * from the Hono auth context, reducing boilerplate at each call site.
 */
export interface RouteAuditInput {
  orgId: string | null | undefined;
  /** See AuditEventInput.partnerId. */
  partnerId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  details?: Record<string, unknown>;
  result?: AuditResult;
  initiatedBy?: InitiatedByType;
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
