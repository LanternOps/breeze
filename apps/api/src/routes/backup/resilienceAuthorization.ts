import type { Context } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  ResilienceAuthorizationError,
  authorizeResilienceResources,
  isSiteRestrictedPrincipalKind,
  type AuthorizedResilienceResources,
  type ResilienceOperation,
  type ResilienceResourceRef,
} from '../../services/resilienceSiteAuthorization';
import type { UserPermissions } from '../../services/permissions';

export type RouteResilienceAuthorization =
  | { ok: true; authorization: AuthorizedResilienceResources }
  | { ok: false; response: Response };

/**
 * Adapts an authenticated Hono request to the shared minimal-lineage resolver.
 * Route handlers must call this before loading protected metadata or causing a
 * provider, queue, command, token, or audit side effect.
 */
export async function authorizeRouteResilienceResources(
  c: Context,
  orgId: string,
  refs: readonly ResilienceResourceRef[],
  operation: ResilienceOperation,
): Promise<RouteResilienceAuthorization> {
  const auth = c.get('auth') as AuthContext;
  const permissions = (c.get('permissions') as UserPermissions | undefined) ?? {
    permissions: [],
    partnerId: auth.partnerId,
    orgId: auth.orgId,
    roleId: '',
    scope: auth.scope,
    allowedSiteIds: auth.allowedSiteIds,
  };

  try {
    const authorization = await authorizeResilienceResources({
      orgId,
      principal: { kind: auth.principal.kind, permissions },
      refs,
      operation,
    });
    return { ok: true, authorization };
  } catch (error) {
    if (error instanceof ResilienceAuthorizationError) {
      return {
        ok: false,
        response: c.json({ error: error.code }, error.status),
      };
    }
    throw error;
  }
}

/** Returns null for unrestricted principals, otherwise only device identities
 * whose complete site lineage is inside the caller's grant. */
export async function resolveRouteAuthorizedDeviceIds(
  c: Context,
  orgId: string,
): Promise<string[] | null> {
  const auth = c.get('auth') as AuthContext;
  const permissions = c.get('permissions') as UserPermissions | undefined;
  if (!isSiteRestrictedPrincipalKind(auth.principal.kind) || !permissions?.allowedSiteIds) return null;
  if (permissions.allowedSiteIds.length === 0) return [];

  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      inArray(devices.siteId, permissions.allowedSiteIds),
    ));
  return rows.map((row) => row.id);
}
