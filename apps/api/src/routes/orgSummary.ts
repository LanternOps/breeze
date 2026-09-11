/**
 * Organization record page summary (#5075 W01, wave-5076).
 *
 * A single aggregate endpoint backing the org detail page's overview cards.
 * Mounted separately under `/orgs`, mirroring the sibling-router pattern
 * established by orgArchive.ts — it owns the same auth middleware as the
 * main organization router.
 *
 * Each optional section is present ONLY when the caller holds the matching
 * `<resource>:read` permission — a caller without e.g. billing visibility
 * never learns an org's invoice counts through this endpoint. `sites` and
 * `contacts` ride along with the `organizations:read` permission the whole
 * route is already gated on (`requireOrgRead` below), so they are always
 * present. There is no dedicated "portal" permission in the catalogue
 * (packages/shared/src/constants/permissions.ts) — portal_users are a
 * customer-facing kind of org user, so `portalUsers` is gated on the same
 * `users:read` grant search.ts already uses to gate a users-list result.
 * `lastActivityAt` is gated on `audit:read`, mirroring `GET /audit-logs/logs`
 * (routes/auditLogs.ts) — it is derived straight from `audit_logs.timestamp`,
 * so it carries the same visibility requirement as the audit trail itself.
 */
import { Hono } from 'hono';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { INVOICE_STATUSES } from '@breeze/shared';
import { db } from '../db';
import {
  organizations,
  devices,
  alerts,
  tickets,
  contracts,
  invoices,
  sites,
  contacts,
  portalUsers,
  auditLogs,
} from '../db/schema';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { PG_UUID_REGEX } from '../utils/uuid';

export interface OrgSummary {
  orgId: string;
  devices?: { total: number; online: number; offline: number };
  alerts?: { open: number; critical: number; high: number };
  tickets?: { open: number; awaitingCustomer: number };
  contracts?: { active: number; nextRenewalAt: string | null };
  invoices?: { outstanding: string; currencyCode: string | null; nextDueAt: string | null; overdueCount: number };
  sites: { count: number };
  contacts?: {
    count: number;
    primary: { id: string; name: string; email: string | null; phone: string | null } | null;
  };
  portalUsers?: { count: number };
  lastActivityAt?: string | null;
}

export const orgSummaryRoutes = new Hono();

orgSummaryRoutes.use('*', authMiddleware);

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

// Mirrors OPEN_STATUSES in routes/tickets/tickets.ts. Kept local — that
// constant scopes the ticketing queue routes, and importing that whole
// module here for one array would be a needless coupling.
const TICKET_OPEN_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

// Every invoice status the billing program still considers "outstanding" —
// i.e. everything except the two terminal states (paid, void) and the
// pre-issuance draft state.
const INVOICE_OPEN_STATUSES = INVOICE_STATUSES.filter(
  (status) => status !== 'draft' && status !== 'paid' && status !== 'void',
);
const invoiceOpenStatusesSql = sql.join(
  INVOICE_OPEN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

// Matches a trailing UTC 'Z'/'z' or an explicit +HH:MM / +HHMM offset.
const HAS_TZ_OFFSET = /[Zz]$|[+-]\d\d:?\d\d$/;

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  // Every raw `sql` aggregate above (MIN/MAX FILTER) skips Drizzle's own
  // column-type mapping, so Postgres hands back plain, offset-less text for
  // both `timestamp` and `date` columns — e.g. "2026-08-15 12:00:00" for
  // auditLogs.timestamp, "2027-06-01" for contracts.endDate /
  // invoices.dueDate. A bare DATE string is parsed as UTC midnight by the
  // JS spec, but a bare DATE-TIME string (one with a time component and no
  // offset) is parsed as the HOST's LOCAL time — an ECMA-262 quirk that
  // silently shifts `lastActivityAt` by the server's UTC offset. Every
  // timestamp/date column here is written and read as UTC, so a naive
  // date-time string is normalized to carry an explicit 'Z' before parsing;
  // a bare date is left alone (it is already unambiguous).
  const raw = String(value);
  const needsUtcSuffix = !HAS_TZ_OFFSET.test(raw) && raw.includes(':');
  const date = new Date(needsUtcSuffix ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Postgres `count()`/`sum()` come back through the driver as strings (bigint
// / numeric are not safely representable as JS numbers in general), so every
// aggregate that feeds an integer field on the response must be coerced.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

orgSummaryRoutes.get(
  '/organizations/:id/summary',
  requireScope('partner', 'system'),
  requireOrgRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id')!;

    // Shape-check BEFORE any DB access — mirrors GET /organizations/:id
    // (routes/orgs.ts) and the archive routes: a non-UUID path segment would
    // reach a uuid column and raise Postgres 22P02, an uncaught 500.
    if (!PG_UUID_REGEX.test(id)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    // No archived special-case here (unlike GET /organizations/:id): this is
    // a read-only aggregate view, not the archive detail surface, so an
    // archive-lifecycle org that fails canAccessOrg simply 404s like any
    // other inaccessible id.
    if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const [organization] = await db
      .select({ id: organizations.id, currencyCode: organizations.currencyCode })
      .from(organizations)
      .where(and(eq(organizations.id, id), isNull(organizations.deletedAt)))
      .limit(1);

    if (!organization) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const can = (grant: { resource: string; action: string }) =>
      Boolean(permissions && hasPermission(permissions, grant.resource, grant.action));

    const summary: OrgSummary = {
      orgId: id,
      sites: { count: 0 },
    };

    if (can(PERMISSIONS.DEVICES_READ)) {
      const [row] = await db
        .select({
          total: sql<string>`count(*)`,
          online: sql<string>`count(*) FILTER (WHERE ${devices.status} = 'online')`,
          offline: sql<string>`count(*) FILTER (WHERE ${devices.status} <> 'online')`,
        })
        .from(devices)
        // Removed (decommissioned) devices are excluded from EVERY count here,
        // not just `offline` (#5315). The record page's own Devices tab lists
        // `GET /devices`, which drops decommissioned rows by default — with the
        // exclusion applied only to `offline`, the Overview tile reported a
        // higher total than the tab it sits next to ("Devices 6" vs 5 rows).
        // Filtering in the WHERE keeps `total`, `online` and `offline` on one
        // population, so the tile's "N of M online" sub-label stays coherent.
        .where(and(eq(devices.orgId, id), ne(devices.status, 'decommissioned')));
      summary.devices = {
        total: toCount(row?.total),
        online: toCount(row?.online),
        offline: toCount(row?.offline),
      };
    }

    if (can(PERMISSIONS.ALERTS_READ)) {
      const [row] = await db
        .select({
          open: sql<string>`count(*) FILTER (WHERE ${alerts.status} IN ('active', 'acknowledged'))`,
          critical: sql<string>`count(*) FILTER (WHERE ${alerts.status} IN ('active', 'acknowledged') AND ${alerts.severity} = 'critical')`,
          high: sql<string>`count(*) FILTER (WHERE ${alerts.status} IN ('active', 'acknowledged') AND ${alerts.severity} = 'high')`,
        })
        .from(alerts)
        .where(eq(alerts.orgId, id));
      summary.alerts = {
        open: toCount(row?.open),
        critical: toCount(row?.critical),
        high: toCount(row?.high),
      };
    }

    if (can(PERMISSIONS.TICKETS_READ)) {
      const openStatusesSql = sql.join(
        TICKET_OPEN_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      );
      const [row] = await db
        .select({
          open: sql<string>`count(*) FILTER (WHERE ${tickets.status} IN (${openStatusesSql}))`,
          awaitingCustomer: sql<string>`count(*) FILTER (WHERE ${tickets.status} = 'pending')`,
        })
        .from(tickets)
        .where(and(eq(tickets.orgId, id), isNull(tickets.deletedAt)));
      summary.tickets = {
        open: toCount(row?.open),
        awaitingCustomer: toCount(row?.awaitingCustomer),
      };
    }

    if (can(PERMISSIONS.CONTRACTS_READ)) {
      const [row] = await db
        .select({
          active: sql<string>`count(*) FILTER (WHERE ${contracts.status} = 'active')`,
          nextRenewalAt: sql<string | null>`MIN(${contracts.endDate}) FILTER (WHERE ${contracts.status} = 'active' AND ${contracts.endDate} >= CURRENT_DATE)`,
        })
        .from(contracts)
        .where(eq(contracts.orgId, id));
      summary.contracts = {
        active: toCount(row?.active),
        nextRenewalAt: toIsoOrNull(row?.nextRenewalAt),
      };
    }

    if (can(PERMISSIONS.INVOICES_READ)) {
      const [row] = await db
        .select({
          outstanding: sql<string>`COALESCE(SUM(${invoices.total} - ${invoices.amountPaid}) FILTER (WHERE ${invoices.status} IN (${invoiceOpenStatusesSql})), 0)::text`,
          nextDueAt: sql<string | null>`MIN(${invoices.dueDate}) FILTER (WHERE ${invoices.status} IN (${invoiceOpenStatusesSql}))`,
          overdueCount: sql<string>`count(*) FILTER (WHERE ${invoices.status} IN (${invoiceOpenStatusesSql}) AND ${invoices.dueDate} < CURRENT_DATE)`,
        })
        .from(invoices)
        .where(eq(invoices.orgId, id));
      summary.invoices = {
        outstanding: row?.outstanding ?? '0',
        currencyCode: organization.currencyCode ?? null,
        nextDueAt: toIsoOrNull(row?.nextDueAt),
        overdueCount: toCount(row?.overdueCount),
      };
    }

    const [siteRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(sites)
      .where(eq(sites.orgId, id));
    summary.sites = { count: toCount(siteRow?.count) };

    const [contactCountRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(contacts)
      .where(eq(contacts.orgId, id));
    const [primaryContactRow] = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
        phone: contacts.phone,
      })
      .from(contacts)
      .where(and(eq(contacts.orgId, id), eq(contacts.isPrimary, true), isNull(contacts.siteId)))
      .limit(1);
    summary.contacts = {
      count: toCount(contactCountRow?.count),
      primary: primaryContactRow
        ? {
            id: primaryContactRow.id,
            // contacts.name is nullable in the schema (an address-only
            // contact is a real row — see db/schema/contacts.ts), but this
            // response shape commits to a non-null display name.
            name: primaryContactRow.name ?? '',
            email: primaryContactRow.email ?? null,
            phone: primaryContactRow.phone ?? null,
          }
        : null,
    };

    if (can(PERMISSIONS.USERS_READ)) {
      const [row] = await db
        .select({ count: sql<string>`count(*) FILTER (WHERE ${portalUsers.status} <> 'disabled')` })
        .from(portalUsers)
        .where(eq(portalUsers.orgId, id));
      summary.portalUsers = { count: toCount(row?.count) };
    }

    if (can(PERMISSIONS.AUDIT_READ)) {
      const [activityRow] = await db
        .select({ lastActivityAt: sql<string | null>`MAX(${auditLogs.timestamp})` })
        .from(auditLogs)
        .where(eq(auditLogs.orgId, id));
      summary.lastActivityAt = toIsoOrNull(activityRow?.lastActivityAt);
    }

    return c.json(summary);
  },
);
