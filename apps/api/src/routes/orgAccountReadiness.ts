/**
 * GET /orgs/account-readiness — the Organizations account board's bulk read
 * (spec docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md,
 * "API: GET /orgs/account-readiness"). Feature #5721, W01.
 *
 * Sibling router mounted under `/orgs` next to orgSummaryRoutes. The path is
 * deliberately NOT `/organizations/account-readiness`: orgRoutes is mounted
 * first and its `/organizations/:id` would capture that literal and answer
 * 404 from its UUID guard.
 *
 * The route validates, pins the partner, gates and shapes. Every query lives
 * in services/orgAccountReadiness.ts. Each optional section is present ONLY
 * when the caller holds the matching `<resource>:read` grant — and, for
 * tickets and invoices, only when the partner runs the native service desk
 * (mirrors OrgOverviewTab's rule). `capabilities` tells the web which sections
 * were computed so it hides those columns rather than rendering zeros.
 * `policies` and `contacts` ride on the `organizations:read` grant the whole
 * route is gated on, so they are always present.
 */
import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { getServiceManagementMode, type ServiceManagementMode } from '../services/serviceManagement';
import {
  loadAccountReadiness,
  resolveAcceptedOrgs,
  type AcceptedOrg,
  type OrgReadinessSignals,
  type OrgType,
  type PrimaryContact,
  type ReadinessSections,
  type TicketCounts,
} from '../services/orgAccountReadiness';
import { PG_UUID_REGEX } from '../utils/uuid';
import {
  computeAccountReadinessExtras,
  extrasForOrg,
  type AccountReadinessExtras,
} from '../services/orgAccountReadinessExtras';
import type {
  Connector,
  OrgIntegration,
} from '../services/orgAccountReadinessIntegrations';

/** The web batches by this many ids (spec "States": per 200-id batch). */
export const MAX_ACCOUNT_READINESS_ORG_IDS = 200;

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
  /** invoices:read AND service_management_mode = 'native' */
  invoices: boolean;
  /** tickets:read AND service_management_mode = 'native' */
  tickets: boolean;
  /** W03: connected_apps:read. */
  integrations: boolean;
  /** W03: contracts:read AND service_management_mode = 'native'. */
  contracts: boolean;
  /** W03: backup:read. */
  backup: boolean;
}

export type {
  ConnectorSystem,
  ConnectorState,
  IntegrationSystem,
  IntegrationState,
  IntegrationReason,
  Connector as AccountReadinessConnector,
  OrgIntegration as AccountReadinessIntegration,
} from '../services/orgAccountReadinessIntegrations';
// (imported above, under the service's own names, to avoid a self-import —
// a self-referential `import type { X } from './orgAccountReadiness'` inside
// this same file sent tsc's type resolution into unbounded recursion / OOM.)
type AccountReadinessConnector = Connector;
type AccountReadinessIntegration = OrgIntegration;

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
  integrations?: AccountReadinessIntegration[];
  /** capabilities.tickets */
  tickets?: TicketCounts;
}

export interface AccountReadinessResponse {
  partnerId: string;
  /** Which sections were computed for this caller. Absent sections were withheld by permission or mode. */
  capabilities: AccountReadinessCapabilities;
  serviceManagementMode: ServiceManagementMode;
  /** W03. Present only with capabilities.integrations. */
  connectors?: AccountReadinessConnector[];
  orgs: AccountReadinessOrg[];
}

export type OrgIdsParse = { ok: true; orgIds: string[] } | { ok: false; error: string };

/**
 * `orgIds` = comma-separated UUIDs, 1–200. The cap counts entries as sent;
 * duplicates are then collapsed (first occurrence wins) and ids lower-cased so
 * they compare equal to the uuid column's text form.
 */
export function parseOrgIdsParam(raw: string | undefined): OrgIdsParse {
  const parts = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: false, error: 'orgIds is required' };
  if (parts.length > MAX_ACCOUNT_READINESS_ORG_IDS) {
    return { ok: false, error: `orgIds accepts at most ${MAX_ACCOUNT_READINESS_ORG_IDS} ids` };
  }
  if (parts.some((part) => !PG_UUID_REGEX.test(part))) {
    return { ok: false, error: 'orgIds must be comma-separated UUIDs' };
  }
  return { ok: true, orgIds: Array.from(new Set(parts.map((part) => part.toLowerCase()))) };
}

export const orgAccountReadinessRoutes = new Hono();

orgAccountReadinessRoutes.use('*', authMiddleware);

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

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

orgAccountReadinessRoutes.get(
  '/account-readiness',
  requireScope('partner', 'system'),
  requireOrgRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    // Shape-check BEFORE any DB access (same rule as GET /organizations/:id):
    // a non-UUID reaching a uuid column raises Postgres 22P02, an uncaught 500.
    const parsed = parseOrgIdsParam(c.req.query('orgIds'));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    // Whose orgs. Same contract as GET /orgs: a partner token is pinned to its
    // own partner (a `partnerId` query is ignored); system scope must name one.
    let partnerId: string;
    if (auth.scope === 'system') {
      const queryPartnerId = c.req.query('partnerId');
      if (!queryPartnerId) return c.json({ error: 'partnerId is required for system scope' }, 400);
      if (!PG_UUID_REGEX.test(queryPartnerId)) return c.json({ error: 'partnerId must be a UUID' }, 400);
      partnerId = queryPartnerId;
    } else {
      if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
      partnerId = auth.partnerId;
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const can = (grant: { resource: string; action: string }) =>
      Boolean(permissions && hasPermission(permissions, grant.resource, grant.action));

    // Fails open to 'native' (services/serviceManagement.ts); its partners read
    // runs under this request's context and passes the table's own-partner
    // SELECT policy.
    const serviceManagementMode = await getServiceManagementMode(partnerId);
    const native = serviceManagementMode === 'native';
    const capabilities: AccountReadinessCapabilities = {
      sites: can(PERMISSIONS.SITES_READ),
      devices: can(PERMISSIONS.DEVICES_READ),
      policies: true,
      contacts: true,
      portalUsers: can(PERMISSIONS.USERS_READ),
      invoices: can(PERMISSIONS.INVOICES_READ) && native,
      tickets: can(PERMISSIONS.TICKETS_READ) && native,
      integrations: can(PERMISSIONS.CONNECTED_APPS_READ),
      contracts: can(PERMISSIONS.CONTRACTS_READ) && native,
      backup: can(PERMISSIONS.BACKUP_READ),
    };

    const accepted = await resolveAcceptedOrgs({
      orgIds: parsed.orgIds,
      partnerId,
      // A partner token whose list never resolved gets nothing, not everything.
      accessibleOrgIds: auth.scope === 'system' ? null : (auth.accessibleOrgIds ?? []),
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

    const response: AccountReadinessResponse = {
      partnerId,
      capabilities,
      serviceManagementMode,
      ...(extras.connectors ? { connectors: extras.connectors } : {}),
      orgs: accepted.map((org) => shapeOrg(org, signals.get(org.id), capabilities, extras)),
    };
    return c.json(response);
  },
);
