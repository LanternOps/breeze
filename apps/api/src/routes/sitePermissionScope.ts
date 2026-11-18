/**
 * Caller permission / site-scope resolution shared by the circuit and topology
 * routes. Lives in the route layer because it reads the Hono Context; services
 * receive the resolved {@link CircuitSiteScope} instead.
 */

import type { Context } from 'hono';
import type { AuthContext } from '../middleware/auth';
import { getUserPermissions, type UserPermissions } from '../services/permissions';
import { TopologyError } from '../services/topology/access';
import type { CircuitSiteScope } from '../services/circuits';

/** The caller's live permissions, resolved the same way the topology routes do. */
export async function resolveCallerPermissions(c: Context): Promise<UserPermissions> {
  const auth = c.get('auth') as AuthContext;
  let permissions = c.get('permissions') as UserPermissions | undefined;
  if (!permissions) {
    permissions = (await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId ?? undefined,
      orgId: auth.orgId ?? undefined,
      scope: auth.scope,
    })) ?? undefined;
  }
  if (!permissions) throw new TopologyError('topology_permission_denied', 403, 'Topology permission denied');
  return permissions;
}

/**
 * The sites the caller may reach: the token ceiling (`auth.allowedSiteIds`)
 * intersected with the live permission allowlist (`permissions.allowedSiteIds`).
 * `null` is unrestricted; a malformed allowlist fails closed to no sites.
 */
export async function resolveCallerSiteScope(c: Context): Promise<CircuitSiteScope> {
  const auth = c.get('auth') as AuthContext;
  const permissions = await resolveCallerPermissions(c);
  const lists = [auth.allowedSiteIds, permissions.allowedSiteIds].filter((l) => l !== undefined);
  if (lists.length === 0) return { allowedSiteIds: null };
  let allowed: string[] | null = null;
  for (const list of lists) {
    const ids: string[] = Array.isArray(list) ? list : [];
    allowed = allowed === null ? [...ids] : allowed.filter((id) => ids.includes(id));
  }
  return { allowedSiteIds: allowed };
}
