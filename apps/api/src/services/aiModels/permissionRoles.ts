/**
 * Role names that grant a permission, for the picker's "Requires <role>"
 * (AI model registry W05, #7603, spec §11). Explicit grants plus every
 * wildcard form the RBAC matcher honours (`permissionGrantMatches`: the
 * resource and the action may each be `*`). Lists every role that holds the
 * grant at runtime: its own rows plus those inherited through `parent_role_id`
 * (resolved by roleInheritance since #9600/#11702). Names are a hint, capped
 * at three.
 *
 * Tenancy: roles are partner / org rows and the picker runs under org tokens,
 * so this reads in a fresh system context with EXPLICIT filters — the
 * caller's own partner's roles, the caller's own org's roles, and the global
 * system templates (no partner, no org). Never another tenant's role names.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { roles } from '../../db/schema';
import { permissionGrantMatches } from '../permissionMatching';
import { getRolesPermissionGrants } from '../roleInheritance';

const MAX_ROLE_NAMES = 3;

export async function rolesGrantingPermission(input: {
  partnerId: string;
  orgId: string | null;
  permission: string;
}): Promise<string[]> {
  const [resource, action, ...rest] = input.permission.split(':');
  if (!resource || !action || rest.length > 0) return [];
  const tenantFilter = or(
    eq(roles.partnerId, input.partnerId),
    input.orgId ? eq(roles.orgId, input.orgId) : undefined,
    and(isNull(roles.partnerId), isNull(roles.orgId)),
  );
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const candidates = await db.select({ id: roles.id, name: roles.name }).from(roles).where(tenantFilter);
    if (candidates.length === 0) return [];
    const grants = await getRolesPermissionGrants(candidates.map((r) => r.id));
    const names = new Set<string>();
    for (const r of candidates) {
      if ((grants.get(r.id) ?? []).some((g) => permissionGrantMatches(g, resource, action))) names.add(r.name);
    }
    // localeCompare, not code-unit order: closer to the old SQL ORDER BY name collation.
    return [...names].sort((a, b) => a.localeCompare(b)).slice(0, MAX_ROLE_NAMES);
  }));
}
