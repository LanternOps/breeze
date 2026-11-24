import {
  getM365PermissionProfile,
  MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
  type CanonicalAppRoleAssignment,
} from '@breeze/shared/m365';

/**
 * Resolves the Admin actions grant inventory when Graph answered the
 * appRoleAssignments read but refused the resource lookup
 * (`/servicePrincipals/{resourceId}?$select=appId,appRoles`), which needs
 * Application.Read.All — a permission the Admin actions set deliberately does
 * not carry (#12085).
 *
 * Inputs: the complete assignment inventory (every page read) and the Graph
 * role values from the app-only token this executor acquired itself
 * (`graphApplicationRolesFromToken`, already checked for audience, tenant,
 * client, expiry and app-only).
 *
 * The appRoleAssignments payload names the resource only by its
 * tenant-specific service principal object id and a display name. It does not
 * carry the resource's appId, and a display name is not proof of anything. So
 * the resource is established by this argument instead:
 *
 * 1. The inventory is whole: every page of the assignment read succeeded.
 * 2. It names exactly ONE resource.
 * 3. Every appRoleId on it is one of the manifest's Microsoft Graph app-role
 *    ids (`applicationPermissionAssignments` in packages/shared profiles.ts,
 *    which cites Microsoft's permissions reference; Graph app-role ids are the
 *    same in every tenant).
 * 4. The set of names those ids map to EQUALS the token's roles claim, and is
 *    non-empty.
 *
 * A token whose audience is Microsoft Graph lists exactly the app roles this
 * application holds on the Microsoft Graph service principal, and every such
 * grant is an appRoleAssignment, so it is in the whole inventory. The token
 * holds at least one role, so the Graph service principal is among the
 * inventory's resources; there is only one resource; so that resource is
 * Microsoft Graph, and its grants are exactly the roles the token names.
 *
 * Every other case is NOT verified and returns a closed reason: two or more
 * resources (an assignment the exact check would flag but cannot name here),
 * an id outside the table (including a real Graph role the manifest does not
 * hold — it cannot be named without the refused read), or any disagreement
 * between the ids and the token (in either direction, including an absent or
 * empty roles claim). "Could not check" is never "matches".
 */

export type ResourceCrossCheckFailureCode =
  | 'grant_resource_unresolved'
  | 'grant_role_unknown'
  | 'graph_token_roles_mismatch';

export interface ResourceRoleAssignment {
  readonly resourceId: string;
  readonly appRoleId: string;
}

const MANIFEST_GRAPH_ROLE_VALUES: ReadonlyMap<string, string> = new Map(
  (getM365PermissionProfile('customer-graph-actions').applicationPermissionAssignments ?? [])
    .filter((grant) => grant.resourceApplicationId === MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID)
    .map((grant) => [grant.appRoleId, grant.value] as const),
);

export function crossCheckManifestRolesAgainstToken(
  assignments: readonly ResourceRoleAssignment[],
  graphTokenRoles: readonly string[],
):
  | { grants: CanonicalAppRoleAssignment[] }
  | { failure: ResourceCrossCheckFailureCode } {
  const resourceIds = new Set(assignments.map((assignment) => assignment.resourceId));
  if (resourceIds.size !== 1) return { failure: 'grant_resource_unresolved' };

  const byRoleId = new Map<string, CanonicalAppRoleAssignment>();
  for (const { appRoleId } of assignments) {
    const value = MANIFEST_GRAPH_ROLE_VALUES.get(appRoleId);
    if (value === undefined) return { failure: 'grant_role_unknown' };
    byRoleId.set(appRoleId, {
      resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
      appRoleId,
      value,
    });
  }

  // Two-way set equality, non-empty. A subset check would let an absent roles
  // claim (decoded as []) or an extra Graph role pass.
  const derived = new Set([...byRoleId.values()].map((grant) => grant.value!));
  const fromToken = new Set(graphTokenRoles);
  if (derived.size === 0
    || derived.size !== fromToken.size
    || [...derived].some((value) => !fromToken.has(value))) {
    return { failure: 'graph_token_roles_mismatch' };
  }

  return {
    grants: [...byRoleId.values()].sort((left, right) =>
      `${left.resourceApplicationId}/${left.appRoleId}`.localeCompare(`${right.resourceApplicationId}/${right.appRoleId}`)),
  };
}
