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
  };
  account: {
    primaryContact: ReadinessPrimaryContact | null;
    billingRoleContact: boolean;
    billingAddress: boolean;
    pendingInvitations?: number;
    overdueInvoices?: number;
  };
  /** W03: per-system mapping state. Typed loosely until the Integrations column lands. */
  integrations?: unknown[];
  tickets?: ReadinessTickets;
}

export interface AccountReadinessResponse {
  partnerId: string;
  capabilities: ReadinessCapabilities;
  serviceManagementMode: ServiceManagementMode;
  orgs: ReadinessOrg[];
}

/** Per-row fetch state kept by `useAccountReadiness`; declared here so this
 *  pure module can type `BoardRow` without importing the hook. */
export type ReadinessRowState = 'pending' | 'ready' | 'failed';

/* --------------------------------- Chips --------------------------------- */

export const STALE_CHECK_IN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SetupChipKey = 'noSite' | 'noDevices' | 'noCheckIn' | 'staleCheckIn' | 'noPolicy';
export type AccountChipKey =
  | 'primaryContact'
  | 'contactEmail'
  | 'contactPhone'
  | 'billingContact'
  | 'billingAddress'
  | 'overdueInvoices'
  | 'invitation';
export type ChipKey = SetupChipKey | AccountChipKey;
export type RepairTarget = 'sites' | 'devices' | 'policies' | 'contacts' | 'settings' | 'billing';

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
  overdueInvoices: 'billing',
  invitation: 'contacts',
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
  // filter and carry no readiness chips.
  if (isArchiveLifecycleOrg(org)) return { setup: [], account: [], accountApplicable: false };

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
