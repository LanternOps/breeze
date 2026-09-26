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
  /** Hidden unless the user holds this permission (hidden while loading). */
  requiredPermission?: PermissionGrant;
  /** Hidden unless the partner runs the named product module. */
  requiresModule?: 'service_management';
}

export interface NavGateContext {
  isPlatformAdmin: boolean;
  permissions: Permission[] | undefined;
  /** Read lazily: only consulted for `partnerScopeOnly` entries. */
  getScope: () => string | null;
  toolSourcesEnabled: boolean;
  aiForOfficeEnabled: boolean;
  serviceManagementMode: string | null | undefined;
}

export function isNavGateVisible(gate: NavGate, ctx: NavGateContext): boolean {
  if (gate.requiresModule === 'service_management' && ctx.serviceManagementMode !== 'native') return false;
  if (gate.requiresAiForOffice && !ctx.aiForOfficeEnabled) return false;
  if (gate.requiresToolSources && !ctx.toolSourcesEnabled) return false;
  if (gate.platformAdminOnly && !ctx.isPlatformAdmin) return false;
  if (gate.partnerScopeOnly) {
    const scope = ctx.getScope();
    if (scope !== null && scope !== 'partner') return false;
  }
  if (gate.requiredPermission) {
    if (!hasPermission(ctx.permissions, gate.requiredPermission.resource, gate.requiredPermission.action)) {
      return false;
    }
  }
  return true;
}
