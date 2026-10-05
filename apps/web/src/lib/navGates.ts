import type { PermissionGrant } from '@breeze/shared';
import { hasPermission } from './permissions';
import type { Permission } from '../stores/auth';

/**
 * Visibility gates shared by every nav-like surface (the sidebar and the
 * /settings catalogue, #6220). One predicate — `isNavGateVisible` — so the two
 * can never disagree about who sees an entry. UX only; the routes re-check
 * everything server-side.
 */
export interface NavGate {
  requiresAutopay?: boolean;
  /** Hidden unless the current user is a platform admin. */
  platformAdminOnly?: boolean;
  /**
   * Hidden when the JWT decodes to a non-partner scope. Undecodable tokens fall
   * through to visible and the server re-checks.
   */
  partnerScopeOnly?: boolean;
  /** Shown only when the partner has AI for Office enabled. */
  requiresAiForOffice?: boolean;
  /** #5216 W01: gated on the SERVER's TOOL_SOURCES_ENABLED via /config. */
  requiresToolSources?: boolean;
  /** Gated on the SERVER's PRE_ASSIGNMENT_ENROLLMENT_ENABLED via /config. */
  requiresPreAssignment?: boolean;
  /** Hidden unless the user holds this permission (hidden while loading). */
  requiredPermission?: PermissionGrant;
  /** Additional permissions the user must ALL hold (hidden while loading). */
  alsoRequiredPermissions?: readonly PermissionGrant[];
  /** Hidden unless the partner runs the named product module. */
  requiresModule?: 'service_management';
  /**
   * Hidden unless the user may administer partner-wide state
   * (`canManagePartnerWide` from /users/me — org_access 'all' or system).
   * Unknown counts as not capable: these are full-partner-admin surfaces.
   */
  requiresPartnerWideAdmin?: boolean;
}

export interface NavGateContext {
  autopayEnabled?: boolean;
  isPlatformAdmin: boolean;
  permissions: Permission[] | undefined;
  /** Read lazily: only consulted for `partnerScopeOnly` entries. */
  getScope: () => string | null;
  toolSourcesEnabled: boolean;
  /** Only consulted for `requiresPreAssignment` entries; unknown ⇒ hidden. */
  preAssignmentEnabled?: boolean;
  aiForOfficeEnabled: boolean;
  serviceManagementMode: string | null | undefined;
  /** From the auth store; only consulted for `requiresPartnerWideAdmin` entries. */
  canManagePartnerWide?: boolean;
}

export function isNavGateVisible(gate: NavGate, ctx: NavGateContext): boolean {
  if (gate.requiresAutopay && ctx.autopayEnabled !== true) return false;
  if (gate.requiresModule === 'service_management' && ctx.serviceManagementMode !== 'native') return false;
  if (gate.requiresAiForOffice && !ctx.aiForOfficeEnabled) return false;
  if (gate.requiresToolSources && !ctx.toolSourcesEnabled) return false;
  if (gate.requiresPreAssignment && ctx.preAssignmentEnabled !== true) return false;
  if (gate.platformAdminOnly && !ctx.isPlatformAdmin) return false;
  if (gate.requiresPartnerWideAdmin && ctx.canManagePartnerWide !== true) return false;
  if (gate.partnerScopeOnly) {
    const scope = ctx.getScope();
    if (scope !== null && scope !== 'partner') return false;
  }
  if (gate.alsoRequiredPermissions?.some((p) => !hasPermission(ctx.permissions, p.resource, p.action))) {
    return false;
  }
  if (gate.requiredPermission) {
    if (!hasPermission(ctx.permissions, gate.requiredPermission.resource, gate.requiredPermission.action)) {
      return false;
    }
  }
  return true;
}
