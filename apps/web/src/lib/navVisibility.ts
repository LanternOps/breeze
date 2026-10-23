// The viewer-facing half of nav visibility. The predicate itself is
// `isNavGateVisible` (lib/navGates.ts), which the Sidebar and the /settings
// catalogue already share; this module adds the pieces a non-sidebar surface
// (the dashboard click-through, spec §3.5) needs to ask "may this viewer open
// that destination?" without re-deriving the Sidebar's gates:
//
//   - `NavDestinationGate` / `pickNavGate`: the gate-only slice of a nav item.
//   - `canOpenDestination`: the predicate over a viewer context.
//   - `useNavViewer`: builds that context from the same stores the Sidebar
//     reads. Feature-flag gates (autopay, tool sources, flows, pre-assignment,
//     AI for Office) are not read here: no dashboard destination uses them, so
//     they stay in their conservative "off" state.
//
// UX only; every destination re-checks server-side.
import { useMemo } from 'react';
import { useAuthStore } from '../stores/auth';
import { useOrgStore } from '../stores/orgStore';
import { getJwtClaims } from './authScope';
import { isNavGateVisible, type NavGate, type NavGateContext } from './navGates';

export type NavDestinationGate = Pick<
  NavGate,
  | 'requiredPermission'
  | 'alsoRequiredPermissions'
  | 'requiresModule'
  | 'platformAdminOnly'
  | 'partnerScopeOnly'
  | 'requiresPartnerWideAdmin'
>;

export type NavViewer = NavGateContext;

const GATE_KEYS = [
  'requiredPermission',
  'alsoRequiredPermissions',
  'requiresModule',
  'platformAdminOnly',
  'partnerScopeOnly',
  'requiresPartnerWideAdmin',
] as const satisfies readonly (keyof NavDestinationGate)[];

/** The gate-only slice of a nav item (drops name, href, icon, testId, …). */
export function pickNavGate(item: NavDestinationGate): NavDestinationGate {
  const out: Record<string, unknown> = {};
  for (const key of GATE_KEYS) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  return out as NavDestinationGate;
}

export function canOpenDestination(gate: NavDestinationGate, viewer: NavViewer): boolean {
  return isNavGateVisible(gate, viewer);
}

/** The current viewer, from the same stores the Sidebar reads. */
export function useNavViewer(): NavViewer {
  const isPlatformAdmin = useAuthStore((s) => s.user?.isPlatformAdmin === true);
  const permissions = useAuthStore((s) => s.user?.permissions);
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide);
  // Reactive trigger only: the access token is the cache key for the scope decode.
  const accessToken = useAuthStore((s) => s.tokens?.accessToken ?? null);
  const serviceManagementMode = useOrgStore((s) => s.serviceManagementMode);
  return useMemo<NavViewer>(
    () => ({
      isPlatformAdmin,
      permissions,
      getScope: () => getJwtClaims().scope,
      toolSourcesEnabled: false,
      aiForOfficeEnabled: false,
      serviceManagementMode,
      canManagePartnerWide,
    }),
    // accessToken is a cache key only: getScope() re-reads the decoded claims.
    [isPlatformAdmin, permissions, canManagePartnerWide, accessToken, serviceManagementMode],
  );
}
