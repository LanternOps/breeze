import { visibleTabs } from '@/components/organizations/record/orgRecordTabs';
import { hasPermission } from '@/lib/permissions';
import type { Permission } from '@/stores/auth';
import type { ServiceManagementMode } from '@/stores/orgStore';

/** The pages the org switcher's pane offers, in render order. */
export const ORG_SWITCHER_DESTINATIONS = [
  'overview',
  'devices',
  'tickets',
  'alerts',
  'sites',
  'billing',
] as const;

export type OrgSwitcherDestination = (typeof ORG_SWITCHER_DESTINATIONS)[number];

export function destinationTarget(dest: OrgSwitcherDestination, orgId: string): string {
  switch (dest) {
    case 'overview':
      return `/organizations/${orgId}`;
    case 'devices':
      return '/devices';
    case 'tickets':
      return '/tickets';
    case 'alerts':
      return '/alerts';
    case 'sites':
      return `/organizations/${orgId}#sites`;
    case 'billing':
      return `/organizations/${orgId}#billing`;
  }
}

/**
 * Which destinations this user can reach. Five of the six reuse the org record's
 * tab gating (permission + Service Management mode) verbatim; Alerts has no
 * record tab, so it is gated on `alerts:read` alone.
 */
export function visibleDestinations(
  permissions: Permission[] | undefined,
  mode: ServiceManagementMode,
): OrgSwitcherDestination[] {
  const tabs = new Set<string>(visibleTabs(permissions, mode));
  return ORG_SWITCHER_DESTINATIONS.filter((dest) =>
    dest === 'alerts' ? hasPermission(permissions, 'alerts', 'read') : tabs.has(dest),
  );
}
