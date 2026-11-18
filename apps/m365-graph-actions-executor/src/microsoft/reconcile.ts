import {
  canonicalGrantKey,
  getM365PermissionProfile,
  MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
  type CanonicalAppRoleAssignment,
  type GrantReconciliationMode,
} from '@breeze/shared/m365';
import type { GraphTenantObservation } from './graphClient';

export type GrantReconciliationOutcome =
  | 'active'
  | 'missing'
  | 'unexpected'
  | 'missing_and_unexpected'
  | 'grant_reconciliation_unavailable';

interface ReconciliationDependencies {
  currentDate?: Date;
}

function canonicalize(
  grants: readonly CanonicalAppRoleAssignment[],
): CanonicalAppRoleAssignment[] {
  const byKey = new Map<string, CanonicalAppRoleAssignment>();
  for (const grant of grants) {
    const key = canonicalGrantKey(grant);
    if (!byKey.has(key)) byKey.set(key, { ...grant });
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, grant]) => grant);
}

/**
 * Maps the Graph role values from the app-only token onto canonical grants.
 * A token names roles by value, not id. Required roles take the manifest's
 * verified Graph appRoleId (Graph app role ids are the same in every tenant),
 * so they key exactly like an inventory observation. Any other value is kept
 * with `appRoleId: null`: resolving it would mean reading the Graph service
 * principal, which needs the same Application.Read.All whose absence put us
 * on this path. The value still makes it unexpected drift.
 */
function graphTokenGrants(
  roles: readonly string[],
  required: readonly CanonicalAppRoleAssignment[],
): CanonicalAppRoleAssignment[] {
  const requiredGraphByValue = new Map<string, CanonicalAppRoleAssignment>();
  for (const grant of required) {
    if (grant.resourceApplicationId === MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID && grant.value !== null) {
      requiredGraphByValue.set(grant.value, grant);
    }
  }
  return roles.map((value) => requiredGraphByValue.get(value) ?? {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: null,
    value,
  });
}

export function reconcileCustomerGraphActions(
  observation: GraphTenantObservation,
  dependencies: ReconciliationDependencies = {},
) {
  const profile = getM365PermissionProfile('customer-graph-actions');
  const currentDate = dependencies.currentDate ?? new Date();
  const timestamp = currentDate.toISOString();
  const proof = {
    tenantId: observation.tenantId,
    applicationId: observation.applicationId,
    organizationDisplayName: observation.organizationDisplayName,
    manifestVersion: profile.version,
    verifiedAt: timestamp,
  } as const;

  // Exact inventory when Graph let us read it; otherwise the Graph token roles
  // fallback (#12085); otherwise unavailable.
  let mode: GrantReconciliationMode;
  let observedSource: readonly CanonicalAppRoleAssignment[];
  if (observation.observedGrants !== null) {
    mode = 'exact';
    observedSource = observation.observedGrants;
  } else if (observation.graphTokenRoles !== undefined) {
    mode = 'graph_token_only';
    observedSource = graphTokenGrants(observation.graphTokenRoles, profile.applicationPermissionAssignments ?? []);
  } else {
    return {
      ...proof,
      outcome: 'grant_reconciliation_unavailable' as const,
      grantReconciliation: 'unavailable' as const,
      errorCode: 'grant_reconciliation_unavailable' as const,
      observedGrants: null,
      missingGrants: null,
      unexpectedGrants: null,
      grantsVerifiedAt: null,
    };
  }

  const required = canonicalize(profile.applicationPermissionAssignments ?? []);
  const observed = canonicalize(observedSource);
  const requiredKeys = new Set(required.map(canonicalGrantKey));
  const observedKeys = new Set(observed.map(canonicalGrantKey));
  const missing = required.filter((grant) => !observedKeys.has(canonicalGrantKey(grant)));
  const unexpected = observed.filter((grant) => !requiredKeys.has(canonicalGrantKey(grant)));
  const outcome: GrantReconciliationOutcome = missing.length > 0
    ? unexpected.length > 0 ? 'missing_and_unexpected' : 'missing'
    : unexpected.length > 0 ? 'unexpected' : 'active';

  return {
    ...proof,
    outcome,
    grantReconciliation: 'complete' as const,
    grantReconciliationMode: mode,
    observedGrants: observed,
    missingGrants: missing,
    unexpectedGrants: unexpected,
    grantsVerifiedAt: timestamp,
  };
}
