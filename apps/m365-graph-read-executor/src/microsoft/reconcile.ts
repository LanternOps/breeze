import {
  canonicalGrantKey,
  getM365PermissionProfile,
  type CanonicalAppRoleAssignment,
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

export function reconcileCustomerGraphRead(
  observation: GraphTenantObservation,
  dependencies: ReconciliationDependencies = {},
) {
  const profile = getM365PermissionProfile('customer-graph-read');
  const currentDate = dependencies.currentDate ?? new Date();
  const timestamp = currentDate.toISOString();
  const proof = {
    tenantId: observation.tenantId,
    applicationId: observation.applicationId,
    organizationDisplayName: observation.organizationDisplayName,
    manifestVersion: profile.version,
    verifiedAt: timestamp,
  } as const;

  if (observation.observedGrants === null) {
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
  const observed = canonicalize(observation.observedGrants);
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
    observedGrants: observed,
    missingGrants: missing,
    unexpectedGrants: unexpected,
    grantsVerifiedAt: timestamp,
  };
}
