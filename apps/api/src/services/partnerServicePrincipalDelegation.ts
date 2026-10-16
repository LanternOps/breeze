import { PERMISSION_GRANTS } from '@breeze/shared';
import { API_KEY_SCOPE_POLICIES } from './apiKeyScopes';
import { hasPermission, type Permission, type UserPermissions } from './permissions';
import type { PartnerServicePrincipalScope } from './partnerServicePrincipalScopes';

/**
 * Issuing or rotating a key, re-enabling a principal, adding a scope or
 * loosening its expiry / source CIDRs hands out more of the principal's
 * authority, which is bounded by its owner (`created_by`). Only the owner may
 * do those; every partner-wide admin may still revoke, disable or narrow.
 */
export const PARTNER_SERVICE_PRINCIPAL_OWNER_REQUIRED_MESSAGE =
  "Only this service principal's owner can issue or rotate its keys, re-enable it, or widen its access";

/**
 * The permissions a person must hold to grant each partner service principal
 * scope. Granting a scope (creating a principal, adding a scope, or issuing,
 * rotating or re-enabling a key that carries it) delegates that authority to
 * a machine that reaches every org of the partner, so the granter must hold
 * the same permission the staff UI requires for the same data.
 *
 * Typed as a complete record: adding a scope to the catalog without deciding
 * its permission here is a compile error.
 *
 * MCP (ai:*) scopes reuse the org API-key baselines (services/apiKeyScopes.ts)
 * so both credential kinds stay in step.
 */
export const PARTNER_SERVICE_PRINCIPAL_SCOPE_PERMISSIONS = {
  'organizations:read': [PERMISSION_GRANTS.ORGS_READ],
  'sites:read': [PERMISSION_GRANTS.SITES_READ],
  'devices:read': [PERMISSION_GRANTS.DEVICES_READ],
  // Software and hardware inventory are device data in the staff UI.
  'inventory:read': [PERMISSION_GRANTS.DEVICES_READ],
  // Configuration policies, assignments and automations.
  'configuration:read': [PERMISSION_GRANTS.DEVICES_READ, PERMISSION_GRANTS.AUTOMATIONS_READ],
  'scripts:read': [PERMISSION_GRANTS.SCRIPTS_READ],
  'backup-configuration:read': [PERMISSION_GRANTS.BACKUP_READ],
  // Custom field definitions and values are managed under device permissions.
  'custom-fields:read': [PERMISSION_GRANTS.DEVICES_READ],
  'alerts:read': [PERMISSION_GRANTS.ALERTS_READ],
  'tickets:read': [PERMISSION_GRANTS.TICKETS_READ],
  'device-status:read': [PERMISSION_GRANTS.DEVICES_READ],
  'organizations:write': [PERMISSION_GRANTS.ORGS_WRITE],
  'sites:write': [PERMISSION_GRANTS.SITES_WRITE],
  // Staff enrollment-key management is gated on organizations:write.
  'enrollment-keys:write': [PERMISSION_GRANTS.ORGS_WRITE],
  'contracts:write': [PERMISSION_GRANTS.CONTRACTS_WRITE],
  'tickets:write': [PERMISSION_GRANTS.TICKETS_WRITE],
  'ai:read': API_KEY_SCOPE_POLICIES['ai:read'],
  'ai:write': API_KEY_SCOPE_POLICIES['ai:write'],
  'ai:execute': API_KEY_SCOPE_POLICIES['ai:execute'],
  'ai:execute_admin': API_KEY_SCOPE_POLICIES['ai:execute_admin'],
} as const satisfies Record<PartnerServicePrincipalScope, readonly Permission[]>;

export type PartnerServicePrincipalScopeDelegationResult =
  | { ok: true }
  | { ok: false; status: 403; error: string; details?: Record<string, unknown> };

/**
 * True when `granterPermissions` holds every permission each of `scopes`
 * requires. Scope names are validated elsewhere
 * (validatePartnerServicePrincipalScopes); an unknown name here fails closed.
 */
export function validatePartnerServicePrincipalScopeDelegation(
  scopes: readonly string[],
  granterPermissions: UserPermissions | undefined,
): PartnerServicePrincipalScopeDelegationResult {
  if (!granterPermissions) {
    return { ok: false, status: 403, error: 'Unable to verify service principal scope delegation permissions' };
  }
  for (const scope of scopes) {
    const required = (PARTNER_SERVICE_PRINCIPAL_SCOPE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[scope];
    if (!required) {
      return { ok: false, status: 403, error: `Cannot delegate service principal scope "${scope}"`, details: { scope } };
    }
    for (const permission of required) {
      if (!hasPermission(granterPermissions, permission.resource, permission.action)) {
        return {
          ok: false,
          status: 403,
          error: `Cannot delegate service principal scope "${scope}" without ${permission.resource}.${permission.action}`,
          details: { scope, requiredPermission: { resource: permission.resource, action: permission.action } },
        };
      }
    }
  }
  return { ok: true };
}
