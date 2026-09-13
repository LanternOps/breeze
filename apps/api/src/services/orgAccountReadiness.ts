/**
 * Organizations account board — readiness signals (spec
 * docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md,
 * "API: GET /orgs/account-readiness"). Feature #5721, W01.
 *
 * Owns every query behind the endpoint. The route
 * (routes/orgAccountReadiness.ts) validates, gates and shapes; nothing here
 * knows about permissions or HTTP.
 *
 * Tenancy: every read runs inside the request's `withDbAccessContext`
 * transaction (opened by authMiddleware) under forced RLS as breeze_app. `db`
 * is the request-bound proxy, so the `Promise.all` in loadAccountReadiness is
 * orchestration only — the statements execute one after another on the
 * transaction's single connection. Never wrap any of these in
 * `withSystemDbAccessContext` / `runOutsideDbContext` to "parallelise" them:
 * that double-holds a pooled connection under the request transaction and
 * bypasses RLS (#2417, #1105).
 */
import { and, eq, inArray, isNull, max, ne, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  contacts,
  devices,
  invoices,
  organizations,
  portalUsers,
  sites,
  tickets,
} from '../db/schema';
import { INVOICE_OPEN_STATUSES, TICKET_OPEN_STATUSES, sqlStatusList } from './openWorkStatuses';

export type OrgType = 'customer' | 'internal' | 'quick_support';

export interface AcceptedOrg {
  id: string;
  type: OrgType;
  status: string;
  /** billing_address_line1, _city and _country are all present. */
  billingAddress: boolean;
}

export interface ResolveAcceptedOrgsInput {
  /** Deduplicated, UUID-shaped ids from the query string, in request order. */
  orgIds: string[];
  partnerId: string;
  /** `null` = unrestricted (system scope). A partner token passes its own list. */
  accessibleOrgIds: string[] | null;
}

/**
 * The organizations the caller may see among the ids it asked for — resolved
 * against organization rows BEFORE any aggregate runs, so every later query is
 * keyed on ids that are live, this partner's, not the hidden quick_support org,
 * and (partner scope) inside the token's accessible list. Ids that do not
 * survive are simply absent: the endpoint never answers 403 for one of them,
 * matching `auth.canAccessOrg` semantics on GET /organizations/:id.
 */
export async function resolveAcceptedOrgs(input: ResolveAcceptedOrgsInput): Promise<AcceptedOrg[]> {
  if (input.orgIds.length === 0) return [];
  // A partner token with nothing accessible gets nothing — and no query. An
  // empty `inArray` would compile to `false` anyway; this keeps it explicit.
  if (input.accessibleOrgIds !== null && input.accessibleOrgIds.length === 0) return [];

  const rows = await db
    .select({
      id: organizations.id,
      type: organizations.type,
      status: organizations.status,
      billingAddressLine1: organizations.billingAddressLine1,
      billingAddressCity: organizations.billingAddressCity,
      billingAddressCountry: organizations.billingAddressCountry,
    })
    .from(organizations)
    .where(
      and(
        inArray(organizations.id, input.orgIds),
        eq(organizations.partnerId, input.partnerId),
        isNull(organizations.deletedAt),
        // Inside accessibleOrgIds by design (RLS lets a tech reach their own
        // support session) but never enumerated — same rule as GET /orgs.
        ne(organizations.type, 'quick_support'),
        input.accessibleOrgIds === null ? undefined : inArray(organizations.id, input.accessibleOrgIds),
      ),
    );

  const byId = new Map(rows.map((row) => [row.id, row]));
  const accepted: AcceptedOrg[] = [];
  for (const id of input.orgIds) {
    const row = byId.get(id);
    if (!row) continue;
    accepted.push({
      id: row.id,
      type: row.type,
      status: row.status,
      billingAddress: Boolean(row.billingAddressLine1 && row.billingAddressCity && row.billingAddressCountry),
    });
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// Signals (filled in by Task 3)
// ---------------------------------------------------------------------------

export interface ReadinessSections {
  sites: boolean;
  devices: boolean;
  portalUsers: boolean;
  invoices: boolean;
  tickets: boolean;
}

export interface PrimaryContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface TicketCounts {
  open: number;
  awaitingCustomer: number;
  slaBreached: number;
}

/** One org's computed signals. Optional fields are present iff their section was requested. */
export interface OrgReadinessSignals {
  sites?: number;
  devices?: number;
  /** ISO timestamp of the freshest check-in over the non-decommissioned population; null = never. */
  lastSeenAt?: string | null;
  policyAssigned: boolean;
  primaryContact: PrimaryContact | null;
  billingRoleContact: boolean;
  pendingInvitations?: number;
  overdueInvoices?: number;
  tickets?: TicketCounts;
}

export interface LoadAccountReadinessInput {
  /** Accepted ids only (from resolveAcceptedOrgs). */
  orgIds: string[];
  partnerId: string;
  sections: ReadinessSections;
}

export async function loadAccountReadiness(_input: LoadAccountReadinessInput): Promise<Map<string, OrgReadinessSignals>> {
  // Task 3 replaces this body. Referencing the imports keeps tsc/eslint quiet
  // until then; none of them is used by resolveAcceptedOrgs.
  void [configPolicyAssignments, configurationPolicies, contacts, devices, invoices, portalUsers, sites, tickets];
  void [max, or, sql, INVOICE_OPEN_STATUSES, TICKET_OPEN_STATUSES, sqlStatusList];
  return new Map();
}
