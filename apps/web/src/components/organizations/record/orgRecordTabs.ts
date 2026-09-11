import type { PermissionAction, PermissionResource } from '@breeze/shared';
import { hasPermission } from '@/lib/permissions';
import type { Permission } from '@/stores/auth';
import type { ServiceManagementMode } from '@/stores/orgStore';

/**
 * The organization record's tab registry (#5075 W01).
 *
 * Declaration order is render order — `visibleTabs` filters, it never reorders,
 * so the strip reads the same for every user regardless of which grants they
 * hold.
 */
export const ORG_RECORD_TABS = [
  'overview',
  'contacts',
  'sites',
  'devices',
  'tickets',
  'billing',
  'service',
  'activity',
] as const;

export type OrgRecordTab = (typeof ORG_RECORD_TABS)[number];

/**
 * Partner-level Service Management mode, stored on `partners` (#5075 W04).
 * Re-exported from the store — one definition, so the tab gate and the runtime
 * value can never disagree about what the modes are.
 */
export type { ServiceManagementMode } from '@/stores/orgStore';

type Grant = { resource: PermissionResource; action: PermissionAction };

/**
 * Grants that unlock each tab, ANY-of.
 *
 * An EMPTY array means "no extra grant" — not "ungated": reaching the record at
 * all requires `organizations:read`, and overview/contacts/sites are served by
 * that same read. Every tab has an entry so a tab added later cannot become
 * ungated by omission (pinned by a test).
 *
 * Deviation from the plan's `Record<tab, Grant | null>`: Contracts & Billing
 * stacks contracts, invoices and quotes, and a user holding only one of those
 * reads still has something to see there — a single-grant shape could only
 * express that by picking one and hiding the tab from half the users who can
 * use it.
 */
export const TAB_PERMISSION: Record<OrgRecordTab, ReadonlyArray<Grant>> = {
  overview: [],
  contacts: [],
  sites: [],
  devices: [{ resource: 'devices', action: 'read' }],
  tickets: [{ resource: 'tickets', action: 'read' }],
  billing: [
    { resource: 'contracts', action: 'read' },
    { resource: 'invoices', action: 'read' },
    { resource: 'quotes', action: 'read' },
  ],
  // Service deliverables (#5573 W01) live under the contracts read: they are
  // what a contract promises, so anyone who can read contracts can see them.
  service: [{ resource: 'contracts', action: 'read' }],
  activity: [{ resource: 'audit', action: 'read' }],
};

/**
 * The tabs the Service Management module owns. `off` hides both; `external`
 * keeps Tickets (it lists shadow rows that link into the PSA) and hides
 * Contracts & Billing, whose system of record is then the PSA (spec Part 2).
 */
export const SERVICE_MANAGEMENT_TABS: ReadonlySet<OrgRecordTab> = new Set<OrgRecordTab>(['tickets', 'billing']);

const MODE_HIDDEN_TABS: Record<ServiceManagementMode, ReadonlySet<OrgRecordTab>> = {
  native: new Set<OrgRecordTab>(),
  off: SERVICE_MANAGEMENT_TABS,
  // Derived, not a second hand-written list: "external hides everything the
  // module owns EXCEPT Tickets" stays true when a third service-management tab
  // is added, instead of that tab silently staying visible in external mode
  // because nobody remembered to edit a duplicate set.
  external: new Set<OrgRecordTab>([...SERVICE_MANAGEMENT_TABS].filter((tab) => tab !== 'tickets')),
};

const TAB_IDS = new Set<string>(ORG_RECORD_TABS);

/** `'#tickets'` / `'tickets'` → `'tickets'`; anything else → undefined. */
export function tabFromHash(hash: string): OrgRecordTab | undefined {
  const raw = hash.replace(/^#/, '');
  return TAB_IDS.has(raw) ? (raw as OrgRecordTab) : undefined;
}

/**
 * Which tabs this user sees, in declaration order.
 *
 * `permissions` is `undefined` while `/users/me` is in flight; `hasPermission`
 * answers false for that, so gated tabs stay hidden until the grants are known
 * rather than appearing and then vanishing.
 *
 * `mode` defaults to `'native'` — the shell is correct before W04 wires the
 * partner's stored mode, and a failed mode fetch fails open rather than hiding
 * a module the partner actually runs.
 */
export function visibleTabs(
  permissions: Permission[] | undefined,
  mode: ServiceManagementMode = 'native',
): OrgRecordTab[] {
  const hidden = MODE_HIDDEN_TABS[mode] ?? MODE_HIDDEN_TABS.native;
  return ORG_RECORD_TABS.filter((tab) => {
    if (hidden.has(tab)) return false;
    const grants = TAB_PERMISSION[tab];
    if (grants.length === 0) return true;
    return grants.some((g) => hasPermission(permissions, g.resource, g.action));
  });
}
