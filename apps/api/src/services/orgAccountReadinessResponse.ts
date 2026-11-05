/**
 * The Organizations account board's bulk readiness response (feature #5721;
 * shared operation since full-control W18, #6789). `GET /orgs/account-readiness`
 * and the `get_account_readiness` AI tool both call
 * `buildAccountReadinessResponse`, so the per-section grants live here only.
 *
 * Each optional section is present ONLY when the caller holds the matching
 * `<resource>:read` grant — and, for tickets and invoices, only when the
 * partner runs the native service desk (mirrors OrgOverviewTab's rule).
 * `capabilities` tells the web which sections were computed so it hides those
 * columns rather than rendering zeros. `policies` and `contacts` ride on the
 * `organizations:read` grant the whole route is gated on, so they are always
 * present. Every query lives in services/orgAccountReadiness.ts.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { PERMISSIONS } from './permissions';
import { notHiddenOrgType } from './unassignedPool/visibility';
import { getServiceManagementMode, type ServiceManagementMode } from './serviceManagement';
import { isBillingEnabledForPartner } from './billingEnabled';
import {
  loadAccountReadiness,
  resolveAcceptedOrgs,
  type AcceptedOrg,
  type OrgReadinessSignals,
  type OrgType,
  type PrimaryContact,
  type ReadinessSections,
  type TicketCounts,
} from './orgAccountReadiness';
import {
  computeAccountReadinessExtras,
  extrasForOrg,
  type AccountReadinessExtras,
} from './orgAccountReadinessExtras';
import type { Connector, OrgIntegration } from './orgAccountReadinessIntegrations';
import type { GrantCheck } from './orgSummary';

export interface AccountReadinessCapabilities {
  /** sites:read */
  sites: boolean;
  /** devices:read */
  devices: boolean;
  /** organizations:read — always true */
  policies: boolean;
  /** organizations:read — always true */
  contacts: boolean;
  /** users:read */
  portalUsers: boolean;
  /** invoices:read AND partners.billing_enabled (independent of service_management_mode) */
  invoices: boolean;
  /** tickets:read AND service_management_mode = 'native' */
  tickets: boolean;
  /** W03: connected_apps:read. */
  integrations: boolean;
  /** W03: contracts:read AND partners.billing_enabled (independent of service_management_mode). */
  contracts: boolean;
  /** W03: backup:read. */
  backup: boolean;
}

export interface AccountReadinessOrg {
  orgId: string;
  type: OrgType;
  status: string;
  setup: {
    /** capabilities.sites */
    sites?: number;
    /** capabilities.devices, non-decommissioned */
    devices?: number;
    /** capabilities.devices, max over the same population; null = never */
    lastSeenAt?: string | null;
    /** org- or partner-level assignment of an active policy */
    policyAssigned: boolean;
    /** W03, capabilities.backup: at least one active backup_configs row for this org. */
    backupConfigured?: boolean;
    /** W03, capabilities.backup: the partner has any active backup_configs row (plan §1); same value on every org. */
    backupApplicable?: boolean;
  };
  account: {
    primaryContact: PrimaryContact | null;
    /** any contact with roles ⊇ {'billing'} */
    billingRoleContact: boolean;
    billingAddress: boolean;
    /** capabilities.portalUsers; invited ≥ 7 days ago, never signed in */
    pendingInvitations?: number;
    /** capabilities.invoices */
    overdueInvoices?: number;
    /** W03, capabilities.contracts: contracts with status 'active' and no end date or an end date ≥ today. */
    activeContracts?: number;
  };
  /** W03. Present only with capabilities.integrations. */
  integrations?: OrgIntegration[];
  /** capabilities.tickets */
  tickets?: TicketCounts;
}

export interface AccountReadinessResponse {
  partnerId: string;
  /** Which sections were computed for this caller. Absent sections were withheld by permission or mode. */
  capabilities: AccountReadinessCapabilities;
  serviceManagementMode: ServiceManagementMode;
  /** W03. Present only with capabilities.integrations. */
  connectors?: Connector[];
  orgs: AccountReadinessOrg[];
}

const EMPTY_TICKETS: TicketCounts = { open: 0, awaitingCustomer: 0, slaBreached: 0 };

function shapeOrg(
  org: AcceptedOrg,
  signals: OrgReadinessSignals | undefined,
  capabilities: AccountReadinessCapabilities,
  extras: AccountReadinessExtras,
): AccountReadinessOrg {
  const setup: AccountReadinessOrg['setup'] = { policyAssigned: signals?.policyAssigned ?? false };
  if (capabilities.sites) setup.sites = signals?.sites ?? 0;
  if (capabilities.devices) {
    setup.devices = signals?.devices ?? 0;
    setup.lastSeenAt = signals?.lastSeenAt ?? null;
  }

  const account: AccountReadinessOrg['account'] = {
    primaryContact: signals?.primaryContact ?? null,
    billingRoleContact: signals?.billingRoleContact ?? false,
    billingAddress: org.billingAddress,
  };
  if (capabilities.portalUsers) account.pendingInvitations = signals?.pendingInvitations ?? 0;
  if (capabilities.invoices) account.overdueInvoices = signals?.overdueInvoices ?? 0;

  const shaped: AccountReadinessOrg = { orgId: org.id, type: org.type, status: org.status, setup, account };
  if (capabilities.tickets) shaped.tickets = signals?.tickets ?? EMPTY_TICKETS;

  const fields = extrasForOrg(org.id, extras);
  if (fields.integrations) shaped.integrations = fields.integrations;
  if (fields.activeContracts !== undefined) shaped.account.activeContracts = fields.activeContracts;
  if (fields.backupApplicable !== undefined) {
    shaped.setup.backupApplicable = fields.backupApplicable;
    shaped.setup.backupConfigured = fields.backupConfigured;
  }
  return shaped;
}

export interface AccountReadinessInput {
  /** The partner whose orgs are read: the caller's own, or the one a system caller named. */
  partnerId: string;
  /** Requested org ids, already validated and de-duplicated. */
  orgIds: string[];
  /** The caller's accessible orgs; null ONLY for system scope (a partner list that never resolved is []). */
  accessibleOrgIds: string[] | null;
  can: GrantCheck;
}

/**
 * W18 Decision 7: the `get_account_readiness` tool's default set when the model
 * names no orgs — the caller's first `limit` live orgs of the partner by name,
 * plus whether more exist. Same filters as `resolveAcceptedOrgs` (partner,
 * not deleted, not a hidden org type, inside the allowlist), so the default
 * can never name an org the explicit path would drop.
 */
export async function listDefaultReadinessOrgIds(input: {
  partnerId: string;
  accessibleOrgIds: string[] | null;
  limit: number;
}): Promise<{ orgIds: string[]; truncated: boolean }> {
  if (input.accessibleOrgIds !== null && input.accessibleOrgIds.length === 0) return { orgIds: [], truncated: false };
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.partnerId, input.partnerId),
        isNull(organizations.deletedAt),
        notHiddenOrgType(),
        input.accessibleOrgIds === null ? undefined : inArray(organizations.id, input.accessibleOrgIds),
      ),
    )
    .orderBy(asc(organizations.name), asc(organizations.id))
    .limit(input.limit + 1);
  return { orgIds: rows.slice(0, input.limit).map((row) => row.id), truncated: rows.length > input.limit };
}

export async function buildAccountReadinessResponse(input: AccountReadinessInput): Promise<AccountReadinessResponse> {
  const { partnerId, can } = input;

  // Fails open to 'native' (services/serviceManagement.ts); its partners read
  // runs under this request's context and passes the table's own-partner
  // SELECT policy.
  const serviceManagementMode = await getServiceManagementMode(partnerId);
  const native = serviceManagementMode === 'native';
  // Billing surfaces (invoices/contracts) follow the partner billing master
  // switch, not service_management_mode; tickets keep following the mode.
  // Fails open to true (services/billingEnabled.ts).
  const billingEnabled = await isBillingEnabledForPartner(partnerId);
  const capabilities: AccountReadinessCapabilities = {
    sites: can(PERMISSIONS.SITES_READ),
    devices: can(PERMISSIONS.DEVICES_READ),
    policies: true,
    contacts: true,
    portalUsers: can(PERMISSIONS.USERS_READ),
    invoices: can(PERMISSIONS.INVOICES_READ) && billingEnabled,
    tickets: can(PERMISSIONS.TICKETS_READ) && native,
    integrations: can(PERMISSIONS.CONNECTED_APPS_READ),
    contracts: can(PERMISSIONS.CONTRACTS_READ) && billingEnabled,
    backup: can(PERMISSIONS.BACKUP_READ),
  };

  const accepted = await resolveAcceptedOrgs({
    orgIds: input.orgIds,
    partnerId,
    accessibleOrgIds: input.accessibleOrgIds,
  });

  const sections: ReadinessSections = {
    sites: capabilities.sites,
    devices: capabilities.devices,
    portalUsers: capabilities.portalUsers,
    invoices: capabilities.invoices,
    tickets: capabilities.tickets,
  };
  const signals =
    accepted.length > 0
      ? await loadAccountReadiness({ orgIds: accepted.map((org) => org.id), partnerId, sections })
      : new Map<string, OrgReadinessSignals>();

  const extras = await computeAccountReadinessExtras({
    partnerId,
    orgIds: accepted.map((org) => org.id),
    capabilities,
    grants: { accounting: can(PERMISSIONS.ACCOUNTING_READ), pax8: can(PERMISSIONS.BILLING_MANAGE) },
    now: new Date(),
  });

  return {
    partnerId,
    capabilities,
    serviceManagementMode,
    ...(extras.connectors ? { connectors: extras.connectors } : {}),
    orgs: accepted.map((org) => shapeOrg(org, signals.get(org.id), capabilities, extras)),
  };
}
