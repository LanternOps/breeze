import {
  canonicalGrantKey,
  M365_WRITE_ACTION_REQUIRED_ROLES,
  type CanonicalAppRoleAssignment,
  type M365ExecutorActionId,
  type M365PermissionProfileManifest,
} from '@breeze/shared/m365';

/**
 * The fields of a connection row the per-role readiness reads. Kept as a
 * structural type (not a Pick of the snapshot) so the write ladder can pass a
 * raw `m365_connections` row and this module stays free of the connection
 * lifecycle's imports.
 */
export interface GrantObservation {
  permissionManifestVersion: number;
  grantsVerifiedAt: Date | null;
  observedGrants: readonly CanonicalAppRoleAssignment[];
}

/**
 * Per-app-role readiness from `observed_grants` (spec §4.1, §7.2): the input
 * the recipe library uses to degrade an effect to a human-work step instead of
 * failing a whole task. Keyed by role VALUE so callers name roles the way the
 * manifest and Microsoft's consent screen do, but MATCHED on the canonical
 * (resourceApplicationId, appRoleId) key from the manifest — a value is only a
 * label, and another resource can expose a role with the same name.
 *
 * `grantsVerifiedAt === null` means no authoritative observation exists, and
 * every role reports false. Callers must NOT turn that into a refusal on its
 * own — see missingRolesForAction.
 */
export function m365RoleReadiness(
  connection: GrantObservation,
  profile: M365PermissionProfileManifest,
): Record<string, boolean> {
  const authoritative = connection.grantsVerifiedAt !== null;
  const observed = new Set(connection.observedGrants.map(canonicalGrantKey));
  const readiness: Record<string, boolean> = {};
  for (const grant of profile.applicationPermissionAssignments ?? []) {
    readiness[grant.value] = authoritative && observed.has(canonicalGrantKey(grant));
  }
  return readiness;
}

/**
 * The roles `actionId` needs that the connection's authoritative observation
 * does not show, or `null` when there is no authoritative observation (plan
 * Decision 5: a never-reconciled connection falls through and lets Graph
 * answer — refusing there would stop every shipped connection's disable).
 *
 * A role the manifest does not declare at all can never be ready, so it is
 * reported missing (fail closed) rather than skipped.
 */
export function missingRolesForAction(
  connection: GrantObservation,
  profile: M365PermissionProfileManifest,
  actionId: M365ExecutorActionId,
): string[] | null {
  if (connection.grantsVerifiedAt === null) return null;
  const readiness = m365RoleReadiness(connection, profile);
  return (M365_WRITE_ACTION_REQUIRED_ROLES[actionId] ?? []).filter((role) => readiness[role] !== true);
}
