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

// Static pages that share a record route's prefix (`/devices/compare`, …).
const RECORD_STATIC_SIBLINGS: Record<string, ReadonlySet<string>> = {
  devices: new Set(['compare', 'groups', 'network', 'posture', 'time', 'unassigned']),
  organizations: new Set(),
  tickets: new Set(['new']),
};

/**
 * Where an org-NAME click in the switcher lands (#9027): on a record page
 * (`/devices/:id`, `/organizations/:id`, `/tickets/:id`) the user stays on that
 * record, so switching scope does not bounce them to a list that may be empty
 * for the new org. `undefined` elsewhere = the default switch behaviour. The
 * hash is dropped on purpose: a same-path navigation that carries a hash is a
 * scroll-to-anchor for the router, not a swap, so the switch would not settle.
 */
export function recordStayDestination(pathname: string, search = ''): string | undefined {
  const match = pathname.match(/^\/(devices|organizations|tickets)\/([^/]+)\/?$/);
  if (!match) return undefined;
  const [, section, segment] = match;
  if (RECORD_STATIC_SIBLINGS[section!]!.has(segment!)) return undefined;
  return `${pathname}${search}`;
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
