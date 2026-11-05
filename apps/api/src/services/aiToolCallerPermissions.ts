/**
 * The AI caller's live permission set, for tools whose output is assembled
 * section by section from separate grants (report types in aiToolsFleet.ts;
 * the W18 org summary and readiness tools, #6789). Moved here from
 * aiToolsFleet.ts so every such tool resolves grants the same way.
 */
import type { AuthContext } from '../middleware/auth';
import { getUserPermissions, hasPermission, type UserPermissions } from './permissions';

/** The AI caller's LIVE permission set — what `requirePermission` would
 *  resolve for the same token on an HTTP route. */
export function aiCallerPermissions(auth: AuthContext): Promise<UserPermissions | null> {
  return getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
    scope: auth.scope,
  });
}

/** A `can(grant)` over the caller's live permissions; no permission set means no grant. */
export async function aiCallerGrantCheck(auth: AuthContext): Promise<(grant: { resource: string; action: string }) => boolean> {
  const permissions = await aiCallerPermissions(auth);
  return (grant) => Boolean(permissions && hasPermission(permissions, grant.resource, grant.action));
}
