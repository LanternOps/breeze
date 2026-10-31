/**
 * Shared helpers for the W11 security-policy tools (full-control W11, #6781).
 *
 * Every tool is a thin adapter over the same exported helpers and services the
 * REST routes call. The rules that must not drift between adapters live here:
 *  - `mfaDenied`: the substitute for a route's `requireMfa()` on a write
 *    (W11-D10; an MCP key carries no MFA claim);
 *  - `orgWideWriteDenied`: an org-wide record (a security policy, an org-wide
 *    recommendation status, an audit baseline, PAM config) is not editable by a
 *    site- or exact-device-restricted caller (W11-D6, `canMutateOrgWideGovernance`);
 *  - `deviceBoundDenied`: an org-wide aggregate is not readable by a session
 *    bound to exact devices (a device-bound chat or agent run);
 *  - `notFound`: a miss, a foreign-org id and a hidden-site row are ONE answer;
 *  - `thrown` / `bounded`: a thrown error never reaches the model raw, and no
 *    single result may flood its context.
 */
import type { AuthContext } from '../middleware/auth';
import { canMutateOrgWideGovernance } from './siteCeilingAccess';
import { aiOriginAuditActor } from './aiOriginColumns';
import { createAuditLogAsync } from './auditService';
import { NETWORK_TOOL_MAX_BYTES, clip, defined, json, jsonError, requireFields, thrown } from './aiToolsNetworkMonitoringShared';

export { clip, defined, json, jsonError, requireFields, thrown };

/** No single result may flood the model's context; the refusal says how to narrow a security-policy read. */
export function bounded(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > NETWORK_TOOL_MAX_BYTES
    ? jsonError('Result too large; narrow the request (pass orgId, a filter, or a smaller limit).', 'result_too_large')
    : text;
}

/**
 * The route-style audit row for a W11 write, attributed by AI origin: a person's
 * chat or MCP key → that user; an agent run → the agent; a flow → system
 * automation (never its synthetic id). Fire-and-forget like `writeRouteAudit`.
 */
export function auditToolWrite(
  auth: AuthContext,
  event: { orgId: string | null; partnerId?: string | null; action: string; resourceType: string; resourceId?: string; resourceName?: string; details?: Record<string, unknown>; result?: 'success' | 'failure' },
): void {
  const actor = auth.aiOrigin
    ? aiOriginAuditActor(auth.aiOrigin, { agentActorId: auth.user.id, humanActorId: auth.user.id })
    : { actorType: 'user' as const, actorId: auth.user.id, initiatedBy: 'ai' as const, originDetails: {} };
  void createAuditLogAsync({
    orgId: event.orgId,
    partnerId: event.orgId ? null : (event.partnerId ?? null),
    actorType: actor.actorType,
    actorId: actor.actorId,
    ...(actor.actorType === 'user' && auth.user.email ? { actorEmail: auth.user.email } : {}),
    initiatedBy: actor.initiatedBy,
    action: event.action,
    resourceType: event.resourceType,
    ...(event.resourceId ? { resourceId: event.resourceId } : {}),
    ...(event.resourceName ? { resourceName: event.resourceName } : {}),
    details: { ...(event.details ?? {}), ...actor.originDetails },
    result: event.result ?? 'success',
  });
}

/** The single "not found" answer, identical for every reason the row is unreachable. */
export function notFound(what: string): string {
  return jsonError(`${what} not found or access denied`, 'NOT_FOUND');
}

export function orgWideWriteDenied(auth: AuthContext, what: string): string | null {
  return canMutateOrgWideGovernance(auth)
    ? null
    : jsonError(`${what} applies to the whole organization; a site- or device-restricted session cannot change it`, 'ACCESS_DENIED');
}

export function deviceBoundDenied(auth: AuthContext, what: string): string | null {
  return auth.allowedDeviceIds !== undefined
    ? jsonError(`${what} covers the whole organization; a session bound to specific devices cannot read it`, 'ACCESS_DENIED')
    : null;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
