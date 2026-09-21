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
 * matching `auth.canAccessOrg` semantics on GET /organizations/:id. Archived
 * and offboarding orgs sit outside a partner token's accessibleOrgIds
 * (middleware/auth.ts computeAccessibleOrgIds admits active|trial only) and
 * are therefore absent too — by design: the board renders no readiness chips
 * for them (spec "Applicability") and lists them from the org list's
 * `includeArchived` fetch, never from this endpoint.
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
// Signals
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

/**
 * Every W02 signal for the accepted ids, one grouped statement per domain.
 * Sections the caller may not see are never queried (`sections`), so an
 * ungated request costs no more than the sections it is allowed to read.
 */
export async function loadAccountReadiness(input: LoadAccountReadinessInput): Promise<Map<string, OrgReadinessSignals>> {
  const ids = input.orgIds;
  const result = new Map<string, OrgReadinessSignals>();
  if (ids.length === 0) return result;

  const { sections } = input;
  const [siteRows, deviceRows, policyRows, contactRows, portalRows, ticketRows, invoiceRows] = await Promise.all([
    sections.sites ? querySiteCounts(ids) : null,
    sections.devices ? queryDeviceSignals(ids) : null,
    queryPolicyAssignments(ids, input.partnerId),
    queryContactSignals(ids),
    sections.portalUsers ? queryPendingInvitations(ids) : null,
    sections.tickets ? queryTicketCounts(ids) : null,
    sections.invoices ? queryOverdueInvoices(ids) : null,
  ]);

  const siteCount = new Map<string, number>(siteRows?.map((row) => [row.orgId, toCount(row.count)]) ?? []);
  const deviceSignal = new Map<string, { count: number; lastSeenAt: string | null }>(
    deviceRows?.map((row) => [row.orgId, { count: toCount(row.count), lastSeenAt: toIsoOrNull(row.lastSeenAt) }]) ?? [],
  );
  // A partner-level assignment of an active policy covers every org of the
  // partner; an org-level one covers its target only (spec: "No policy assigned").
  const partnerAssigned = policyRows.some((row) => row.level === 'partner');
  const orgAssigned = new Set(policyRows.filter((row) => row.level === 'organization').map((row) => row.targetId));
  const contactSignal = new Map(contactRows.map((row) => [row.orgId, row]));
  const pendingInvitations = new Map<string, number>(portalRows?.map((row) => [row.orgId, toCount(row.count)]) ?? []);
  const ticketCounts = new Map<string, TicketCounts>(
    ticketRows?.map((row) => [
      row.orgId,
      { open: toCount(row.open), awaitingCustomer: toCount(row.awaitingCustomer), slaBreached: toCount(row.slaBreached) },
    ]) ?? [],
  );
  const overdueInvoices = new Map<string, number>(invoiceRows?.map((row) => [row.orgId, toCount(row.count)]) ?? []);

  for (const id of ids) {
    const contact = contactSignal.get(id);
    const signals: OrgReadinessSignals = {
      policyAssigned: partnerAssigned || orgAssigned.has(id),
      primaryContact:
        contact && toBool(contact.hasPrimary)
          ? {
              name: contact.primaryName ?? null,
              email: contact.primaryEmail ?? null,
              phone: contact.primaryPhone ?? null,
              mobile: contact.primaryMobile ?? null,
            }
          : null,
      billingRoleContact: contact ? toBool(contact.billingRole) : false,
    };
    if (sections.sites) signals.sites = siteCount.get(id) ?? 0;
    if (sections.devices) {
      const device = deviceSignal.get(id);
      signals.devices = device?.count ?? 0;
      signals.lastSeenAt = device?.lastSeenAt ?? null;
    }
    if (sections.portalUsers) signals.pendingInvitations = pendingInvitations.get(id) ?? 0;
    if (sections.invoices) signals.overdueInvoices = overdueInvoices.get(id) ?? 0;
    if (sections.tickets) signals.tickets = ticketCounts.get(id) ?? { open: 0, awaitingCustomer: 0, slaBreached: 0 };
    result.set(id, signals);
  }
  return result;
}

// ---------------------------------------------------------------------------
// One grouped statement per domain. Each is index-backed on org_id where an
// index exists (devices_org_id_status_idx / devices_org_id_last_seen_at_idx,
// contacts_org_idx, tickets_org_status_idx, invoices_org_status_idx,
// config_assignments_level_target_idx); the measured plans live in the W01
// PR ("Query plan evidence").
// ---------------------------------------------------------------------------

function querySiteCounts(ids: string[]) {
  return db
    .select({ orgId: sites.orgId, count: sql<string>`count(*)` })
    .from(sites)
    .where(inArray(sites.orgId, ids))
    .groupBy(sites.orgId);
}

// Removed (decommissioned) devices are excluded from BOTH the count and the
// freshness max (#5315 — every device surface hides them). `max()` maps the
// timestamp through the column decoder, so the driver's naive UTC text comes
// back as a Date; toIsoOrNull still normalises a raw string defensively.
function queryDeviceSignals(ids: string[]) {
  return db
    .select({
      orgId: devices.orgId,
      count: sql<string>`count(*)`,
      lastSeenAt: max(devices.lastSeenAt),
    })
    .from(devices)
    .where(and(inArray(devices.orgId, ids), ne(devices.status, 'decommissioned')))
    .groupBy(devices.orgId);
}

// "Assigned", deliberately not "covered": site, device-group and device-level
// assignments are not counted, and an assignment does not prove the policy's
// feature links apply to this org's devices (spec "No policy assigned").
function queryPolicyAssignments(ids: string[], partnerId: string) {
  return db
    .select({ level: configPolicyAssignments.level, targetId: configPolicyAssignments.targetId })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyAssignments.configPolicyId))
    .where(
      and(
        eq(configurationPolicies.status, 'active'),
        or(
          and(eq(configPolicyAssignments.level, 'organization'), inArray(configPolicyAssignments.targetId, ids)),
          and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, partnerId)),
        ),
      ),
    )
    .groupBy(configPolicyAssignments.level, configPolicyAssignments.targetId);
}

// One grouped pass over the org's contacts. The org-level primary is unique
// per org (partial unique index contacts_org_primary_uniq, db/schema/contacts.ts),
// so `max(col) FILTER (WHERE is_primary AND site_id IS NULL)` reads exactly
// that row's field. Contact data comes from the canonical `contacts` table,
// never from organizations.billing_contact (spec "Account data cell").
function queryContactSignals(ids: string[]) {
  const primary = sql`FILTER (WHERE ${contacts.isPrimary} AND ${contacts.siteId} IS NULL)`;
  return db
    .select({
      orgId: contacts.orgId,
      hasPrimary: sql<boolean>`bool_or(${contacts.isPrimary} AND ${contacts.siteId} IS NULL)`,
      primaryName: sql<string | null>`max(${contacts.name}) ${primary}`,
      primaryEmail: sql<string | null>`max(${contacts.email}) ${primary}`,
      primaryPhone: sql<string | null>`max(${contacts.phone}) ${primary}`,
      primaryMobile: sql<string | null>`max(${contacts.mobile}) ${primary}`,
      billingRole: sql<boolean>`bool_or(${contacts.roles} @> ARRAY['billing']::text[])`,
    })
    .from(contacts)
    .where(inArray(contacts.orgId, ids))
    .groupBy(contacts.orgId);
}

// portal_users.invited_at is a naive UTC `timestamp`; compare against a naive
// UTC clock rather than `now()` so the session time zone cannot shift the
// 7-day boundary.
function queryPendingInvitations(ids: string[]) {
  return db
    .select({ orgId: portalUsers.orgId, count: sql<string>`count(*)` })
    .from(portalUsers)
    .where(
      and(
        inArray(portalUsers.orgId, ids),
        ne(portalUsers.status, 'disabled'),
        isNull(portalUsers.lastLoginAt),
        sql`${portalUsers.invitedAt} < (now() AT TIME ZONE 'utc') - interval '7 days'`,
      ),
    )
    .groupBy(portalUsers.orgId);
}

function queryTicketCounts(ids: string[]) {
  return db
    .select({
      orgId: tickets.orgId,
      open: sql<string>`count(*)`,
      awaitingCustomer: sql<string>`count(*) FILTER (WHERE ${tickets.status} = 'pending')`,
      slaBreached: sql<string>`count(*) FILTER (WHERE ${tickets.slaBreachedAt} IS NOT NULL)`,
    })
    .from(tickets)
    .where(
      and(
        inArray(tickets.orgId, ids),
        isNull(tickets.deletedAt),
        sql`${tickets.status} in (${sqlStatusList(TICKET_OPEN_STATUSES)})`,
      ),
    )
    .groupBy(tickets.orgId);
}

function queryOverdueInvoices(ids: string[]) {
  return db
    .select({ orgId: invoices.orgId, count: sql<string>`count(*)` })
    .from(invoices)
    .where(
      and(
        inArray(invoices.orgId, ids),
        sql`${invoices.status} in (${sqlStatusList(INVOICE_OPEN_STATUSES)})`,
        sql`${invoices.dueDate} < CURRENT_DATE`,
      ),
    )
    .groupBy(invoices.orgId);
}

// ---------------------------------------------------------------------------
// Driver coercions. count()/count() FILTER come back as strings (bigint);
// bool_or as a boolean (kept tolerant of a 't'/'f' text form).
// ---------------------------------------------------------------------------

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toBool(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

// Matches a trailing UTC 'Z'/'z' or an explicit +HH:MM / +HHMM offset.
const HAS_TZ_OFFSET = /[Zz]$|[+-]\d\d:?\d\d$/;

// A raw timestamp string without an offset is parsed by ECMA-262 as HOST
// local time; every timestamp column here is written and read as UTC, so a
// naive date-time is given an explicit 'Z' before parsing (same rule as
// routes/orgSummary.ts).
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const raw = String(value);
  const needsUtcSuffix = !HAS_TZ_OFFSET.test(raw) && raw.includes(':');
  const date = new Date(needsUtcSuffix ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
