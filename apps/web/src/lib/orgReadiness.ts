import type { Organization } from '@/components/settings/organizationTypes';
import type { ServiceManagementMode } from '@/stores/orgStore';
import { isArchiveLifecycleOrg } from '@/lib/archiveLifecycle';

/* ----------------------------------------------------------------------------
 * Wire contract of GET /orgs/account-readiness (W01). Mirrors the spec's
 * AccountReadinessResponse. A section withheld by permission or mode is absent
 * from `capabilities` AND from every org; the web treats absence as "not
 * evaluated" — never as zero and never as evidence of completeness.
 * ------------------------------------------------------------------------- */
export interface ReadinessCapabilities {
  sites: boolean;
  devices: boolean;
  policies: boolean;
  contacts: boolean;
  portalUsers: boolean;
  invoices: boolean;
  tickets: boolean;
  /** W03: connected_apps:read. Nothing in W02 reads it. */
  integrations: boolean;
  /** W03: contracts:read AND native mode. */
  contracts: boolean;
  /** W03: backup:read. */
  backup: boolean;
}

export interface ReadinessPrimaryContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface ReadinessTickets {
  open: number;
  awaitingCustomer: number;
  slaBreached: number;
}

/* ---- W03 wire shapes (mirror apps/api/src/services/orgAccountReadinessIntegrations.ts) ---- */
export type ConnectorSystem = 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'huntress' | 'sentinelone';
export type ConnectorState = 'connected' | 'reauth_required' | 'disconnected' | 'error' | 'disabled';
export interface ReadinessConnector {
  system: ConnectorSystem;
  state: ConnectorState;
  /** PSA provider id — PSA only. */
  provider?: string;
}
export type IntegrationSystem = ConnectorSystem | 'm365' | 'dns_filter' | 'external';
export type IntegrationState = 'linked' | 'pending' | 'error' | 'identity';
export type IntegrationReason =
  | 'suggested_match' | 'sync_error' | 'consent_pending' | 'expired' | 'degraded' | 'suspended'
  | 'error' | 'never_synced' | 'sync_failed' | 'disabled' | 'connector_error';
export interface ReadinessIntegration {
  system: IntegrationSystem;
  state: IntegrationState;
  /** A code; translated under orgBoard.integrations.reason.* */
  reason?: IntegrationReason;
  /** 'external' rows: the raw organization_external_links.system value. */
  label?: string;
}

export interface ReadinessOrg {
  orgId: string;
  type: 'customer' | 'internal' | 'quick_support';
  status: string;
  setup: {
    sites?: number;
    devices?: number;
    /** max(last_seen_at) over non-decommissioned devices; null = never; absent = not evaluated. */
    lastSeenAt?: string | null;
    policyAssigned: boolean;
    backupConfigured?: boolean;
    backupApplicable?: boolean;
  };
  account: {
    primaryContact: ReadinessPrimaryContact | null;
    billingRoleContact: boolean;
    billingAddress: boolean;
    pendingInvitations?: number;
    overdueInvoices?: number;
    activeContracts?: number;
  };
  /** W03: per-system mapping state. */
  integrations?: ReadinessIntegration[];
  tickets?: ReadinessTickets;
}

export interface AccountReadinessResponse {
  partnerId: string;
  capabilities: ReadinessCapabilities;
  serviceManagementMode: ServiceManagementMode;
  orgs: ReadinessOrg[];
  connectors?: ReadinessConnector[];
}

/** Per-row fetch state kept by `useAccountReadiness`; declared here so this
 *  pure module can type `BoardRow` without importing the hook. */
export type ReadinessRowState = 'pending' | 'ready' | 'failed';

/* --------------------------------- Chips --------------------------------- */

export const STALE_CHECK_IN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SetupChipKey = 'noSite' | 'noDevices' | 'noCheckIn' | 'staleCheckIn' | 'noPolicy' | 'noBackup';
export type AccountChipKey =
  | 'primaryContact'
  | 'contactEmail'
  | 'contactPhone'
  | 'billingContact'
  | 'billingAddress'
  | 'noActiveContract'
  | 'overdueInvoices'
  | 'invitation';
export type ChipKey = SetupChipKey | AccountChipKey;
export type RepairTarget = 'sites' | 'devices' | 'policies' | 'contacts' | 'settings' | 'billing' | 'backup';

export interface ReadinessChip {
  key: ChipKey;
  /** amber = something missing, red = something wrong (spec: Account data cell). */
  tone: 'warning' | 'destructive';
  target: RepairTarget;
  href: string;
  /** Interpolated into the label: stale days, overdue invoices, pending invitations. */
  count?: number;
}

export interface DerivedChips {
  setup: ReadinessChip[];
  account: ReadinessChip[];
  /** False for internal orgs: their Account cell renders a dash, never "Complete". */
  accountApplicable: boolean;
}

/** Where each chip repairs. Record tab hashes are `ORG_RECORD_TABS` ids (orgRecordTabs.ts). */
export const REPAIR_TARGETS: Record<ChipKey, RepairTarget> = {
  noSite: 'sites',
  noDevices: 'devices',
  noCheckIn: 'devices',
  staleCheckIn: 'devices',
  noPolicy: 'policies',
  primaryContact: 'contacts',
  contactEmail: 'contacts',
  contactPhone: 'contacts',
  billingContact: 'contacts',
  billingAddress: 'settings',
  noActiveContract: 'billing',
  overdueInvoices: 'billing',
  invitation: 'contacts',
  noBackup: 'backup',
};

export function repairHref(target: RepairTarget, orgId: string): string {
  switch (target) {
    case 'sites':
      return `/organizations/${orgId}#sites`;
    case 'devices':
      return `/organizations/${orgId}#devices`;
    case 'contacts':
      return `/organizations/${orgId}#contacts`;
    case 'billing':
      return `/organizations/${orgId}#billing`;
    case 'settings':
      return `/settings/organizations/${orgId}`;
    case 'policies':
      return '/configuration-policies';
    case 'backup':
      return '/backup';
  }
}

/** Whole days since `lastSeenAt` (floored); null when unparseable so no NaN ever reaches a label. */
export function staleCheckInDays(lastSeenAt: string, now: Date): number | null {
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return null;
  return Math.floor((now.getTime() - seen) / DAY_MS);
}

function chip(key: ChipKey, orgId: string, tone: ReadinessChip['tone'], count?: number): ReadinessChip {
  const target = REPAIR_TARGETS[key];
  const base: ReadinessChip = { key, tone, target, href: repairHref(target, orgId) };
  return count === undefined ? base : { ...base, count };
}

export type ReadinessOrgRow = Pick<Organization, 'id' | 'status' | 'type' | 'archived'>;

/**
 * Every Setup and Account chip plus every applicability rule from the spec, in
 * one place and nowhere else. Returns null when the org has no readiness
 * payload yet or the capabilities are unknown: the cell then renders a skeleton
 * or a dash, never "Complete".
 */
export function deriveReadinessChips(
  org: ReadinessOrgRow,
  readiness: ReadinessOrg | undefined,
  capabilities: ReadinessCapabilities | null,
  mode: ServiceManagementMode,
  now: Date,
): DerivedChips | null {
  if (!readiness || !capabilities) return null;
  // Archived and archive-draining orgs are listed only under the Archived
  // filter and carry no readiness chips. `null` (not `{accountApplicable:
  // false}`) so this matches the encoding `archivedRows` already uses for
  // rows in the Archived list — ReadinessChips renders both as a dash.
  if (isArchiveLifecycleOrg(org)) return null;

  const type = readiness.type ?? org.type ?? 'customer';
  const status = readiness.status ?? org.status;
  const setup: ReadinessChip[] = [];
  const account: ReadinessChip[] = [];

  // ---- Setup: applies to every live org, internal included ----
  if (capabilities.sites && readiness.setup.sites === 0) setup.push(chip('noSite', org.id, 'warning'));
  if (capabilities.devices && typeof readiness.setup.devices === 'number') {
    const devices = readiness.setup.devices;
    if (devices === 0) {
      setup.push(chip('noDevices', org.id, 'warning'));
    } else if (readiness.setup.lastSeenAt === null) {
      setup.push(chip('noCheckIn', org.id, 'warning'));
    } else if (typeof readiness.setup.lastSeenAt === 'string') {
      const days = staleCheckInDays(readiness.setup.lastSeenAt, now);
      if (days !== null && days >= STALE_CHECK_IN_DAYS) setup.push(chip('staleCheckIn', org.id, 'warning', days));
    }
  }
  if (capabilities.policies && !readiness.setup.policyAssigned) setup.push(chip('noPolicy', org.id, 'warning'));
  // W03: applicable only when the partner uses backup at all (plan §1); a setup chip, so internal orgs count.
  if (capabilities.backup && readiness.setup.backupApplicable === true && readiness.setup.backupConfigured === false) {
    setup.push(chip('noBackup', org.id, 'warning'));
  }

  // ---- Account data: customer orgs only ----
  const accountApplicable = type === 'customer';
  if (accountApplicable) {
    if (capabilities.contacts) {
      const primary = readiness.account.primaryContact;
      if (!primary) {
        account.push(chip('primaryContact', org.id, 'warning'));
      } else {
        if (primary.email === null) account.push(chip('contactEmail', org.id, 'warning'));
        if (primary.phone === null && primary.mobile === null) account.push(chip('contactPhone', org.id, 'warning'));
      }
    }
    // Billing checks apply to ACTIVE customer orgs only: trial, suspended,
    // churned, offboarding and merging orgs are not billed as customers.
    const billingApplies = status === 'active';
    if (billingApplies && capabilities.contacts && !readiness.account.billingRoleContact) {
      account.push(chip('billingContact', org.id, 'warning'));
    }
    if (billingApplies && !readiness.account.billingAddress) account.push(chip('billingAddress', org.id, 'warning'));
    // W03: the contracts table is the source of truth; evergreen terms count as active (plan §8).
    if (billingApplies && capabilities.contracts && mode === 'native' && readiness.account.activeContracts === 0) {
      account.push(chip('noActiveContract', org.id, 'warning'));
    }
    if (billingApplies && capabilities.invoices && mode === 'native' && (readiness.account.overdueInvoices ?? 0) > 0) {
      account.push(chip('overdueInvoices', org.id, 'destructive', readiness.account.overdueInvoices));
    }
    if (capabilities.portalUsers && (readiness.account.pendingInvitations ?? 0) > 0) {
      account.push(chip('invitation', org.id, 'warning', readiness.account.pendingInvitations));
    }
  }

  return { setup, account, accountApplicable };
}

/* ------------------------- Organization cell helpers ---------------------- */
// Moved verbatim from the retired settings/OrganizationsPage.tsx (#3699, #4166).

/**
 * Whether the org cell should render its `{{count}} devices` label. The count
 * is absent for organization-scoped callers (minimal projection of
 * `GET /orgs/organizations`); interpolating `undefined` produced a bare
 * " devices". `0` is a real value and must render, so this is not a truthiness check.
 */
export function shouldShowDeviceCount(count: number | undefined): boolean {
  return typeof count === 'number' && Number.isFinite(count);
}

/**
 * Days remaining until an archived org's scheduled purge, rounded UP so a
 * countdown reading "1 day" never flips to "0 days" while any part of that day
 * remains. `null` covers both `purgeAt: null` ("kept indefinitely") and an
 * unparseable timestamp, so callers treat the two identically instead of
 * rendering `NaN`.
 */
export function purgeCountdownDays(purgeAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!purgeAt) return null;
  const target = new Date(purgeAt);
  if (Number.isNaN(target.getTime())) return null;
  return Math.ceil((target.getTime() - now.getTime()) / DAY_MS);
}

/* ---------------------- Lens, filters, sort, columns ---------------------- */

export const BOARD_LENSES = ['setup', 'account', 'both'] as const;
export type BoardLens = (typeof BOARD_LENSES)[number];
export const DEFAULT_LENS: BoardLens = 'both';

/** Chip order = band order. W03 inserts 'unlinked' between accountMissing and openTickets. */
export const BOARD_FILTERS = ['all', 'setupIncomplete', 'accountMissing', 'unlinked', 'openTickets', 'trial', 'archived'] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];
export const DEFAULT_FILTER: BoardFilter = 'all';

export const BOARD_SORTS = ['manual', 'name', 'tickets'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** Readiness columns in render order. 'integrations' is the W03 slot. */
export const BOARD_COLUMNS = ['setup', 'account', 'integrations', 'tickets'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export interface BoardRow {
  org: Organization;
  readiness: ReadinessOrg | undefined;
  state: ReadinessRowState;
  chips: DerivedChips | null;
  /** null = integrations withheld, or the row's batch not landed. */
  badges: IntegrationBadge[] | null;
}

export const isBoardLens = (value: string): value is BoardLens => (BOARD_LENSES as readonly string[]).includes(value);
export const isBoardFilter = (value: string): value is BoardFilter => (BOARD_FILTERS as readonly string[]).includes(value);
export const isBoardSort = (value: string): value is BoardSort => (BOARD_SORTS as readonly string[]).includes(value);

const LENS_HIDES: Record<BoardLens, BoardColumn | null> = { setup: 'account', account: 'setup', both: null };
/** Which column carries a filter's evidence; applying it under a lens that hides that column forces Both. */
const FILTER_EVIDENCE: Partial<Record<BoardFilter, BoardColumn>> = {
  setupIncomplete: 'setup',
  accountMissing: 'account',
  unlinked: 'integrations',
  openTickets: 'tickets',
};

export function visibleColumns(lens: BoardLens, capabilities: ReadinessCapabilities | null): BoardColumn[] {
  return BOARD_COLUMNS.filter((column) => {
    if (LENS_HIDES[lens] === column) return false;
    if (column === 'integrations') return capabilities?.integrations === true;
    if (column === 'tickets') return capabilities?.tickets === true;
    return true; // setup / account: policies + contacts are always-true capabilities
  });
}

/** A capability-trimmed section takes its filter with it; Archived is always discoverable. */
export function visibleFilters(capabilities: ReadinessCapabilities | null): BoardFilter[] {
  return BOARD_FILTERS.filter((filter) => {
    if (filter === 'openTickets') return capabilities?.tickets === true;
    if (filter === 'unlinked') return capabilities?.integrations === true;
    return true;
  });
}

export function lensForFilter(filter: BoardFilter, lens: BoardLens): BoardLens {
  const evidence = FILTER_EVIDENCE[filter];
  return evidence !== undefined && LENS_HIDES[lens] === evidence ? 'both' : lens;
}

export function matchesFilter(filter: BoardFilter, row: BoardRow): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'setupIncomplete':
      return (row.chips?.setup.length ?? 0) > 0;
    case 'accountMissing':
      return (row.chips?.account.length ?? 0) > 0;
    case 'unlinked':
      return hasUnlinked(row.badges);
    case 'openTickets':
      return (row.readiness?.tickets?.open ?? 0) > 0;
    case 'trial':
      return row.org.status === 'trial';
    case 'archived':
      return row.org.archived === true;
  }
}

export function compareRows(sort: BoardSort): ((a: BoardRow, b: BoardRow) => number) | null {
  if (sort === 'name') return (a, b) => a.org.name.localeCompare(b.org.name);
  if (sort === 'tickets') {
    return (a, b) =>
      (b.readiness?.tickets?.open ?? 0) - (a.readiness?.tickets?.open ?? 0) || a.org.name.localeCompare(b.org.name);
  }
  return null; // manual: the server's stored partner order, untouched
}

export function sortRows(rows: BoardRow[], sort: BoardSort): BoardRow[] {
  const compare = compareRows(sort);
  return compare ? [...rows].sort(compare) : rows;
}

/** Search over org name, primary contact name and email — client-side over the loaded list plus the readiness payload. */
export function searchMatches(query: string, org: Pick<Organization, 'name'>, readiness: ReadinessOrg | undefined): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (org.name.toLowerCase().includes(q)) return true;
  const primary = readiness?.account.primaryContact;
  if (!primary) return false;
  return (primary.name?.toLowerCase().includes(q) ?? false) || (primary.email?.toLowerCase().includes(q) ?? false);
}

/* ------------------------------ W03 integrations ------------------------------ */
// Spec "Integrations cell"; plan "Spec ambiguities resolved" §2, §7, §9, §10.

export interface IntegrationBadge {
  system: IntegrationSystem;
  state: IntegrationState | 'not_linked';
  reason?: IntegrationReason;
  label?: string;
  /** The system's partner connector is not connected: render quietly, never as a problem. */
  muted: boolean;
}

export interface ConnectorRepair {
  system: ConnectorSystem;
  state: Exclude<ConnectorState, 'connected'>;
  provider?: string;
  href: string;
}

/** Brand names are locale-invariant product names, so they live here rather than in eight catalogs. */
export const SYSTEM_DISPLAY_NAMES: Record<Exclude<IntegrationSystem, 'psa' | 'dns_filter' | 'external'>, string> = {
  quickbooks: 'QuickBooks',
  xero: 'Xero',
  pax8: 'Pax8',
  m365: 'Microsoft 365',
  huntress: 'Huntress',
  sentinelone: 'SentinelOne',
};

/** PSA provider ids from PSA_PROVIDERS (@breeze/shared validators/psa.ts) → product names. */
export const PSA_PROVIDER_NAMES: Record<string, string> = {
  connectwise: 'ConnectWise',
  autotask: 'Autotask',
  jira: 'Jira',
  servicenow: 'ServiceNow',
  freshservice: 'Freshservice',
  zendesk: 'Zendesk',
};

/** Where a connector is repaired — the /integrations hub tab hashes (IntegrationsPage.tsx) and the PSA page. */
export const CONNECTOR_SETTINGS_HREF: Record<ConnectorSystem, string> = {
  quickbooks: '/integrations#quickbooks',
  xero: '/integrations#accounting',
  psa: '/integrations/psa',
  pax8: '/integrations#pax8',
  huntress: '/integrations#huntress',
  sentinelone: '/integrations#sentinelone',
};

/** Connectors that imply a per-org mapping (a dashed "not linked" is meaningful). M365 / DNS / external have no partner connector. */
export const NOT_LINKED_CONNECTOR_SYSTEMS: readonly ConnectorSystem[] = ['quickbooks', 'xero', 'psa', 'pax8', 'huntress', 'sentinelone'];

export function deriveIntegrationBadges(
  readiness: ReadinessOrg | undefined,
  connectors: ReadinessConnector[] | null | undefined,
  capabilities: ReadinessCapabilities | null,
): IntegrationBadge[] | null {
  if (!capabilities?.integrations || !readiness?.integrations) return null;
  const connected = new Set<ConnectorSystem>();
  const notConnected = new Set<ConnectorSystem>();
  for (const connector of connectors ?? []) {
    if (connector.state === 'connected') connected.add(connector.system);
    else notConnected.add(connector.system);
  }
  const badges: IntegrationBadge[] = readiness.integrations.map((row) => ({
    ...row,
    muted: notConnected.has(row.system as ConnectorSystem) && !connected.has(row.system as ConnectorSystem),
  }));
  if (readiness.type !== 'customer') return badges;
  const present = new Set(readiness.integrations.map((row) => row.system));
  for (const system of NOT_LINKED_CONNECTOR_SYSTEMS) {
    if (connected.has(system) && !present.has(system)) badges.push({ system, state: 'not_linked', muted: false });
  }
  return badges;
}

export function hasUnlinked(badges: IntegrationBadge[] | null): boolean {
  return badges !== null && badges.some((badge) => badge.state === 'not_linked');
}

/** One repair line per connector that is not connected — never N per-org problems. */
export function connectorRepairs(connectors: ReadinessConnector[] | null | undefined): ConnectorRepair[] {
  const repairs: ConnectorRepair[] = [];
  for (const connector of connectors ?? []) {
    if (connector.state === 'connected') continue;
    repairs.push({
      system: connector.system,
      state: connector.state,
      ...(connector.provider ? { provider: connector.provider } : {}),
      href: CONNECTOR_SETTINGS_HREF[connector.system],
    });
  }
  return repairs;
}

/* ---------------------------------- Hash ---------------------------------- */

export interface BoardHashState {
  lens?: BoardLens;
  filter?: BoardFilter;
  /** A bare `#<uuid>`: scroll to and briefly highlight that row. */
  highlightOrgId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `lens=setup&filter=all` → state; a bare uuid → row highlight; anything else → undefined (useHashState's default). */
export function parseBoardHash(hash: string): BoardHashState | undefined {
  const raw = hash.replace(/^#/, '');
  if (!raw) return undefined;
  if (UUID_RE.test(raw)) return { highlightOrgId: raw.toLowerCase() };
  const params = new URLSearchParams(raw);
  const lens = params.get('lens');
  const filter = params.get('filter');
  const state: BoardHashState = {};
  if (lens && isBoardLens(lens)) state.lens = lens;
  if (filter && isBoardFilter(filter)) state.filter = filter;
  return Object.keys(state).length > 0 ? state : undefined;
}

/** Always both keys: the hash must win over the localStorage default for BOTH values once the user has chosen. */
export function serializeBoardHash(state: { lens: BoardLens; filter: BoardFilter }): string {
  return `lens=${state.lens}&filter=${state.filter}`;
}
