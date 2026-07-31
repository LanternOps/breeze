import { getM365PermissionProfile } from '@breeze/shared/m365';

const OIDC_SCOPES = new Set(['openid', 'profile', 'offline_access']);
const GRAPH_PREFIX = 'https://graph.microsoft.com/';

/**
 * String-set reconciliation of granted vs profile scopes (§4.2) — NOT
 * appRoleAssignment enumeration; delegated grants have no app roles. Scopes
 * arrive from AuthenticationResult.scopes and may come back either bare
 * (`Mail.Send`) or resource-qualified; normalize both sides, compare
 * case-insensitively. offline_access is load-bearing but is an OIDC scope the
 * token response does not echo as a resource scope — its absence surfaces as
 * the first acquireTokenSilent failing with delegated_reauth_required, which
 * the runbook documents (Plan 3).
 */
export function reconcileCommunicationsDelegated(grantedScopes: readonly string[]): {
  complete: boolean;
  missingScopes: string[];
} {
  const granted = new Set(grantedScopes.map((scope) =>
    (scope.startsWith(GRAPH_PREFIX) ? scope.slice(GRAPH_PREFIX.length) : scope).toLowerCase()));
  const required = getM365PermissionProfile('communications-delegated')
    .delegatedPermissions.filter((scope) => !OIDC_SCOPES.has(scope));
  const missingScopes = required.filter((scope) => !granted.has(scope.toLowerCase()));
  return { complete: missingScopes.length === 0, missingScopes };
}
