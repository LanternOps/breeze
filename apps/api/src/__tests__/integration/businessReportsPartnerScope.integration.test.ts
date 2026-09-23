/**
 * #3198 W02 business report generators against REAL Postgres, as the
 * forced-RLS `breeze_app` role (ruling P6 / generator-common rules).
 *
 * Every generator gets the same four proofs:
 *   1. partner fan-out across >= 2 orgs of the partner;
 *   2. isolation — another partner's data never appears;
 *   3. a SUSPENDED org of the same partner is excluded (the live org list is
 *      active/trial only, disclosed in the report notes);
 *   4. PARITY — the report generated under a real partner-scope RLS request
 *      context (built exactly like `authMiddleware` builds it, for an
 *      org_access='all' partner user) equals the one generated with no ambient
 *      context (system scope, the worker path) over the same fixtures.
 *
 * Shared fixture helpers live at the top of this file; Tasks 8 (time entries)
 * and 9 (invoices) add their own seeders and `describe` blocks below the
 * ticket SLA block, reusing `seedBusinessFixture`, `partnerRequestContext`,
 * `asPartnerRequest`, `livePartnerScope` and `withoutGeneratedAt`.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { ArAgingSummary, TechnicianTimeSummary, TicketSlaSummary } from '@breeze/shared';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { buildDbAccessContext, computeAccessibleOrgIds } from '../../middleware/auth';
import { generateReport, type ReportResult } from '../../services/reportGenerationService';
import {
  organizationScope,
  reportScopeFromAuthority,
  ReportScopeMismatchError,
  type ReportScope,
} from '../../services/reportScope';
import {
  resolveLivePartnerReportAuthority,
  type ReportExecutionAuthority,
  type ReportGenerationAuthority,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

// ---------------------------------------------------------------------------
// Shared fixture helpers (Tasks 7, 8, 9)
// ---------------------------------------------------------------------------

/** Permissions a partner user needs to be ABLE to run all three business
 *  reports. Route-level enforcement is Task 11; the live authority resolver
 *  needs `reports:read`. */
const BUSINESS_REPORT_PERMISSIONS = [
  { resource: 'reports', action: 'read' },
  { resource: 'tickets', action: 'read' },
  { resource: 'time_entries', action: 'read' },
  { resource: 'invoices', action: 'read' },
];

type BusinessFixture = Awaited<ReturnType<typeof seedBusinessFixture>>;

/**
 * Partner P with two active orgs (A, B) and one SUSPENDED org (S), plus an
 * unrelated partner Q with one active org (C). `user` is a P staff member with
 * org_access='all' and a role granting the business-report permissions.
 */
async function seedBusinessFixture() {
  const partner = await createPartner({});
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Globex' });
  const suspendedOrg = await createOrganization({ partnerId: partner.id, name: 'Suspended Co', status: 'suspended' });
  const otherPartner = await createPartner({});
  const otherOrg = await createOrganization({ partnerId: otherPartner.id, name: 'Initech' });

  const user = await createUser({
    partnerId: partner.id,
    name: 'Dana Tech',
    email: `business-reports-${randomUUID()}@example.com`,
  });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, BUSINESS_REPORT_PERMISSIONS);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');

  return { partner, orgA, orgB, suspendedOrg, otherPartner, otherOrg, user, role };
}

/** The RLS context `authMiddleware` opens for a partner-scope token of this
 *  user — same two helpers, same inputs. */
async function partnerRequestContext(f: BusinessFixture): Promise<DbAccessContext> {
  const { orgIds } = await computeAccessibleOrgIds('partner', f.partner.id, null, f.user.id);
  return buildDbAccessContext({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    partnerId: f.partner.id,
    userId: f.user.id,
  });
}

async function asPartnerRequest<T>(f: BusinessFixture, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(await partnerRequestContext(f), fn);
}

/** The real partner_wide authority + live org list, exactly as the routes and
 *  the worker derive them. Resolved outside any context (the resolver opens
 *  its own). */
async function livePartnerAuthority(f: BusinessFixture): Promise<UserReportExecutionAuthority> {
  const result = await resolveLivePartnerReportAuthority(f.user.id, f.partner.id, 'read');
  if (!result.ok) throw new Error(`partner authority refused: ${result.reason}`);
  return result.authority;
}

async function livePartnerScope(
  f: BusinessFixture,
  authority: ReportGenerationAuthority,
): Promise<ReportScope> {
  return reportScopeFromAuthority({ partnerId: f.partner.id }, authority);
}

function orgAuthority(orgId: string, userId: string): ReportExecutionAuthority {
  return {
    principalKind: 'user',
    principalUserId: userId,
    scope: { version: 1, kind: 'unrestricted', orgId },
    capturedAt: new Date(),
    fingerprint: 'f'.repeat(64),
  };
}

/** Two runs of the same report differ only in when they ran. */
function withoutGeneratedAt(result: ReportResult): unknown {
  const summary = { ...(result.summary ?? {}) } as Record<string, unknown>;
  delete summary.generatedAt;
  return { rows: result.rows, rowCount: result.rowCount, summary };
}

// ---------------------------------------------------------------------------
// Task 7 — ticket_sla_attainment
// ---------------------------------------------------------------------------

const AUGUST = { kind: 'custom' as const, start: '2026-08-01', end: '2026-08-31' };

type TicketSeed = {
  createdAt: string;
  firstResponseAt?: string | null;
  resolvedAt?: string | null;
  responseSla?: number | null;
  resolutionSla?: number | null;
  workKind?: 'support' | 'deliverable' | 'project_task';
  deletedAt?: string | null;
  slaBreachedAt?: string | null;
  assignedTo?: string | null;
  pausedMinutes?: number;
};

/** Seeded as the superuser (no RLS), like every db-utils helper. */
async function seedTicket(orgId: string, partnerId: string, o: TicketSeed): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO tickets (id, org_id, partner_id, ticket_number, subject, status, priority,
      work_kind, created_at, first_response_at, resolved_at, response_sla_minutes,
      resolution_sla_minutes, sla_paused_minutes, deleted_at, sla_breached_at, assigned_to)
    VALUES (${id}, ${orgId}, ${partnerId}, ${`T-${id.slice(0, 12)}`}, 'seeded', 'open', 'high',
      ${o.workKind ?? 'support'}, ${o.createdAt}, ${o.firstResponseAt ?? null}, ${o.resolvedAt ?? null},
      ${o.responseSla ?? null}, ${o.resolutionSla ?? null}, ${o.pausedMinutes ?? 0}, ${o.deletedAt ?? null},
      ${o.slaBreachedAt ?? null}, ${o.assignedTo ?? null})`);
  return id;
}

/**
 * In period (August 2026, UTC), counted:
 *   A1 response met (30m vs 60m), resolution met (100m vs 240m), assigned to Dana
 *   A2 response missed (5h vs 60m), NOT stamped   -> recomputed-not-stamped
 *   B1 response met (10m vs 60m), STAMPED breached -> stamped-not-recomputed
 *   B2 no SLA target at all                         -> no_sla_tickets
 * Not counted: planned work in A, a soft-deleted ticket in A, a July ticket in
 * A, the suspended org's ticket, and the other partner's ticket.
 */
async function seedSlaTickets(f: BusinessFixture) {
  const p = f.partner.id;
  await seedTicket(f.orgA.id, p, {
    createdAt: '2026-08-02T00:00:00Z', firstResponseAt: '2026-08-02T00:30:00Z', responseSla: 60,
    resolvedAt: '2026-08-02T01:40:00Z', resolutionSla: 240, assignedTo: f.user.id,
  });
  await seedTicket(f.orgA.id, p, { createdAt: '2026-08-03T00:00:00Z', firstResponseAt: '2026-08-03T05:00:00Z', responseSla: 60 });
  await seedTicket(f.orgB.id, p, {
    createdAt: '2026-08-04T00:00:00Z', firstResponseAt: '2026-08-04T00:10:00Z', responseSla: 60,
    slaBreachedAt: '2026-08-04T02:00:00Z',
  });
  await seedTicket(f.orgB.id, p, { createdAt: '2026-08-05T00:00:00Z', firstResponseAt: '2026-08-05T09:00:00Z' });
  // Must NOT be counted:
  await seedTicket(f.orgA.id, p, { createdAt: '2026-08-06T00:00:00Z', firstResponseAt: '2026-08-06T09:00:00Z', responseSla: 60, workKind: 'deliverable' });
  await seedTicket(f.orgA.id, p, { createdAt: '2026-08-07T00:00:00Z', firstResponseAt: '2026-08-07T09:00:00Z', responseSla: 60, deletedAt: '2026-08-08T00:00:00Z' });
  await seedTicket(f.orgA.id, p, { createdAt: '2026-07-31T23:59:59Z', firstResponseAt: '2026-08-01T09:00:00Z', responseSla: 60 });
  await seedTicket(f.suspendedOrg.id, p, { createdAt: '2026-08-09T00:00:00Z', firstResponseAt: '2026-08-09T09:00:00Z', responseSla: 60 });
  await seedTicket(f.otherOrg.id, f.otherPartner.id, { createdAt: '2026-08-10T00:00:00Z', firstResponseAt: '2026-08-10T09:00:00Z', responseSla: 60 });
}

describe('ticket_sla_attainment — real Postgres (#3198 W02 Task 7)', () => {
  runDb('partner scope aggregates every active org of the partner, and nothing else', async () => {
    const f = await seedBusinessFixture();
    await seedSlaTickets(f);
    const authority = await livePartnerAuthority(f);
    const scope = await livePartnerScope(f, authority);
    expect(scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgIds: [f.orgA.id, f.orgB.id].sort() });

    const result = await generateReport('ticket_sla_attainment', scope,
      { period: AUGUST, groupBy: 'organization' }, authority);
    const s = result.summary as TicketSlaSummary;

    expect(s.overall.ticketsTotal).toBe(4);
    expect(s.overall.noSlaTickets).toBe(1);
    expect(s.overall.responseEligible).toBe(3);
    expect(s.overall.responseMet).toBe(2);
    expect(s.overall.responseAttainment).toBeCloseTo(2 / 3, 6);
    expect(s.overall.resolutionEligible).toBe(1);
    expect(s.overall.resolutionAttainment).toBe(1);
    expect(s.overall.breaches).toBe(1);
    expect(s.stampDiscrepancy).toEqual({ recomputedBreachNotStamped: 1, stampedNotRecomputedBreach: 1 });

    const byKey = new Map(s.groups.map((g) => [g.groupKey, g]));
    expect([...byKey.keys()].sort()).toEqual([f.orgA.id, f.orgB.id].sort());
    expect(byKey.get(f.orgA.id)).toMatchObject({ groupLabel: 'Acme', ticketsTotal: 2, responseMet: 1, responseEligible: 2 });
    expect(byKey.get(f.orgB.id)).toMatchObject({ groupLabel: 'Globex', ticketsTotal: 2, responseMet: 1, noSlaTickets: 1 });
    expect(s.worstGroupLabel).toBe('Acme');

    // Detail rows: the same four tickets, none from excluded orgs; the one
    // breach (A2, 08-03) first, then the rest newest first (fix round item 2).
    expect(result.rows).toHaveLength(4);
    expect(s.rows.map((r) => r.orgId).every((id) => id === f.orgA.id || id === f.orgB.id)).toBe(true);
    expect(s.rows.map((r) => r.createdAt)).toEqual([
      '2026-08-03T00:00:00.000Z', '2026-08-05T00:00:00.000Z', '2026-08-04T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
    ]);
    expect(s.detail).toEqual({ cap: 5000, stored: 4, available: 4, truncated: false });
    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
    expect(s.period).toMatchObject({ start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z', timeZone: 'UTC' });
    expect(s.notes.join(' ')).toMatch(/suspended.*excluded/i);
  });

  runDb('PARITY: a partner-scope RLS request context and the system context produce identical reports', async () => {
    const f = await seedBusinessFixture();
    await seedSlaTickets(f);
    const authority = await livePartnerAuthority(f);

    for (const groupBy of ['organization', 'technician', 'priority', 'category'] as const) {
      const config = { period: AUGUST, groupBy };
      const viaRequest = await asPartnerRequest(f, async () =>
        generateReport('ticket_sla_attainment', await livePartnerScope(f, authority), config, authority));
      const viaSystem = await generateReport('ticket_sla_attainment', await livePartnerScope(f, authority), config, authority);

      expect(withoutGeneratedAt(viaRequest), groupBy).toEqual(withoutGeneratedAt(viaSystem));
      expect((viaSystem.summary as TicketSlaSummary).overall.ticketsTotal, groupBy).toBe(4);
    }

    // The technician axis resolved the assignee's name under partner RLS too.
    const tech = await asPartnerRequest(f, async () => generateReport('ticket_sla_attainment',
      await livePartnerScope(f, authority), { period: AUGUST, groupBy: 'technician' }, authority));
    const labels = (tech.summary as TicketSlaSummary).groups.map((g) => g.groupLabel).sort();
    expect(labels).toEqual(['Dana Tech (current assignee)', 'Unassigned (current assignee)']);
  });

  // Fix round item 7: the outcome boundaries, pinned against real Postgres.
  runDb('SLA boundaries: deadline is inclusive, unresponded-past-deadline is missed, pause extends the deadline, period end is exclusive', async () => {
    const f = await seedBusinessFixture();
    const p = f.partner.id;
    // Met exactly AT the deadline (first_response_at = created_at + target: `<=`).
    await seedTicket(f.orgA.id, p, { createdAt: '2026-08-10T00:00:00Z', firstResponseAt: '2026-08-10T01:00:00Z', responseSla: 60 });
    // Never responded, deadline long past -> missed (not pending).
    await seedTicket(f.orgA.id, p, { createdAt: '2026-08-11T00:00:00Z', responseSla: 60 });
    // Never responded, deadline years away -> pending (not eligible).
    await seedTicket(f.orgA.id, p, { createdAt: '2026-08-12T00:00:00Z', responseSla: 60 * 24 * 365 * 5 });
    // Responded 80m in against a 60m target, but 30m paused -> deadline 90m -> met.
    await seedTicket(f.orgB.id, p, { createdAt: '2026-08-13T00:00:00Z', firstResponseAt: '2026-08-13T01:20:00Z', responseSla: 60, pausedMinutes: 30 });
    // Last second of the period: counted (met).
    await seedTicket(f.orgB.id, p, { createdAt: '2026-08-31T23:59:59Z', firstResponseAt: '2026-09-01T00:10:00Z', responseSla: 60 });
    // First instant after the period: NOT counted.
    await seedTicket(f.orgB.id, p, { createdAt: '2026-09-01T00:00:00Z', responseSla: 60 });

    const authority = await livePartnerAuthority(f);
    const s = (await generateReport('ticket_sla_attainment', await livePartnerScope(f, authority),
      { period: AUGUST, groupBy: 'organization' }, authority)).summary as TicketSlaSummary;

    expect(s.overall).toMatchObject({
      ticketsTotal: 5, noSlaTickets: 0,
      responseEligible: 4, responseMet: 3, resolutionEligible: 0, breaches: 1,
    });
    expect(s.overall.responseAttainment).toBeCloseTo(3 / 4, 6);
    const outcome = new Map(s.rows.map((r) => [r.createdAt, r.responseOutcome]));
    expect(Object.fromEntries(outcome)).toEqual({
      '2026-08-10T00:00:00.000Z': 'met',
      '2026-08-11T00:00:00.000Z': 'missed',
      '2026-08-12T00:00:00.000Z': 'pending',
      '2026-08-13T00:00:00.000Z': 'met',
      '2026-08-31T23:59:59.000Z': 'met',
    });
    expect(s.rows.find((r) => r.createdAt === '2026-08-13T00:00:00.000Z')!.slaPausedMinutes).toBe(30);
    // The breach sorts first.
    expect(s.rows[0]!.createdAt).toBe('2026-08-11T00:00:00.000Z');
  });

  runDb('org scope sees only its own org, under an org-token RLS context', async () => {
    const f = await seedBusinessFixture();
    await seedSlaTickets(f);

    const s = await withDbAccessContext(
      buildDbAccessContext({ scope: 'organization', orgId: f.orgA.id, accessibleOrgIds: [f.orgA.id], partnerId: f.partner.id, userId: f.user.id }),
      async () => (await generateReport('ticket_sla_attainment', organizationScope(f.orgA.id),
        { period: AUGUST }, orgAuthority(f.orgA.id, f.user.id))).summary as TicketSlaSummary,
    );

    expect(s.groupBy).toBe('priority');
    expect(s.overall.ticketsTotal).toBe(2);
    expect(s.rows.every((r) => r.orgId === f.orgA.id)).toBe(true);
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.orgA.id, orgName: 'Acme' });
  });

  runDb('an org context that cannot see the org is refused, not answered with zeros', async () => {
    const f = await seedBusinessFixture();
    await seedSlaTickets(f);

    await expect(withDbAccessContext(
      buildDbAccessContext({ scope: 'organization', orgId: f.orgB.id, accessibleOrgIds: [f.orgB.id], partnerId: f.partner.id, userId: f.user.id }),
      () => generateReport('ticket_sla_attainment', organizationScope(f.orgA.id),
        { period: AUGUST }, orgAuthority(f.orgA.id, f.user.id)),
    )).rejects.toBeInstanceOf(ReportScopeMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Task 8 — technician_time_billability
// ---------------------------------------------------------------------------

type TimeSeed = {
  userId: string;
  orgId: string | null;
  startedAt: string;
  minutes: number | null; // null = running timer (ended_at NULL)
  coverage?: 'billable' | 'included' | 'non_billable' | null;
  isBillable?: boolean;
  hourlyRate?: string | null;
  billingStatus?: 'not_billed' | 'billed' | 'no_charge' | 'contract';
  isApproved?: boolean;
  workTypeId?: string | null;
  /** Card rounding increment; billable_minutes is then the rounded-up
   *  quantity, exactly as time_entries_billable_minutes_chk requires. */
  roundingIncrement?: number;
};

/** Seeded as the superuser (no RLS). billable_minutes = duration, or the
 *  duration rounded up to `roundingIncrement` — either satisfies
 *  time_entries_billable_minutes_chk. */
async function seedTimeEntry(partnerId: string, o: TimeSeed): Promise<string> {
  const id = randomUUID();
  const started = new Date(o.startedAt);
  const ended = o.minutes === null ? null : new Date(started.getTime() + o.minutes * 60_000).toISOString();
  const increment = o.roundingIncrement ?? null;
  const billableMinutes = o.minutes === null || increment === null
    ? o.minutes
    : Math.ceil(o.minutes / increment) * increment;
  await getTestDb().execute(sql`
    INSERT INTO time_entries (id, partner_id, org_id, user_id, started_at, ended_at, duration_minutes,
      billable_minutes, rounding_increment_minutes, is_billable, coverage, hourly_rate, currency_code,
      billing_status, is_approved, work_type_id)
    VALUES (${id}, ${partnerId}, ${o.orgId}, ${o.userId}, ${o.startedAt}, ${ended}, ${o.minutes},
      ${billableMinutes}, ${increment}, ${o.isBillable ?? true}, ${o.coverage ?? null}, ${o.hourlyRate ?? null}, 'USD',
      ${o.billingStatus ?? 'not_billed'}, ${o.isApproved ?? false}, ${o.workTypeId ?? null})`);
  return id;
}

/**
 * Partner P technicians: Dana (fixture user, time_entries:read) and Idle Tech
 * (time_entries:read, logs nothing). NOT technicians: a P user whose role
 * grants only reports:read, and a DISABLED P user holding time_entries:read.
 *
 * August 2026 entries by Dana, counted at partner scope:
 *   A1 org A, 120m, coverage billable, $150 USD, billed + approved, work type "Onsite"
 *   N1 NO ORG, 60m, coverage NULL + is_billable → billable (fallback), $100 USD
 *   B1 org B, 30m, coverage included
 *   B2 org B, 45m, coverage NULL + NOT is_billable → non_billable (fallback)
 * Not counted: the suspended org's entry, a July entry, a running timer, and
 * the other partner's entry.
 */
async function seedTimeFixture(f: BusinessFixture) {
  const p = f.partner.id;
  const idle = await createUser({ partnerId: p, name: 'Idle Tech', email: `idle-${randomUUID()}@example.com` });
  const idleRole = await createRole({ scope: 'partner', partnerId: p });
  await grantRolePermissions(idleRole.id, [{ resource: 'time_entries', action: 'read' }]);
  await assignUserToPartner(idle.id, p, idleRole.id, 'all');

  const viewer = await createUser({ partnerId: p, name: 'Report Viewer', email: `viewer-${randomUUID()}@example.com` });
  const viewerRole = await createRole({ scope: 'partner', partnerId: p });
  await grantRolePermissions(viewerRole.id, [{ resource: 'reports', action: 'read' }]);
  await assignUserToPartner(viewer.id, p, viewerRole.id, 'all');

  const disabled = await createUser({ partnerId: p, name: 'Gone Tech', email: `gone-${randomUUID()}@example.com`, status: 'disabled' });
  await assignUserToPartner(disabled.id, p, idleRole.id, 'all');

  const otherTech = await createUser({ partnerId: f.otherPartner.id, name: 'Other Partner Tech', email: `other-${randomUUID()}@example.com` });

  const workTypeId = randomUUID();
  await getTestDb().execute(sql`INSERT INTO work_types (id, partner_id, name) VALUES (${workTypeId}, ${p}, 'Onsite')`);

  const u = f.user.id;
  await seedTimeEntry(p, { userId: u, orgId: f.orgA.id, startedAt: '2026-08-04T09:00:00Z', minutes: 120,
    coverage: 'billable', hourlyRate: '150.00', billingStatus: 'billed', isApproved: true, workTypeId });
  await seedTimeEntry(p, { userId: u, orgId: null, startedAt: '2026-08-05T09:00:00Z', minutes: 60,
    coverage: null, isBillable: true, hourlyRate: '100.00' });
  await seedTimeEntry(p, { userId: u, orgId: f.orgB.id, startedAt: '2026-08-06T09:00:00Z', minutes: 30, coverage: 'included' });
  await seedTimeEntry(p, { userId: u, orgId: f.orgB.id, startedAt: '2026-08-07T09:00:00Z', minutes: 45,
    coverage: null, isBillable: false });
  // Must NOT be counted:
  await seedTimeEntry(p, { userId: u, orgId: f.suspendedOrg.id, startedAt: '2026-08-10T09:00:00Z', minutes: 90, coverage: 'billable' });
  await seedTimeEntry(p, { userId: u, orgId: f.orgA.id, startedAt: '2026-07-31T09:00:00Z', minutes: 90, coverage: 'billable' });
  await seedTimeEntry(p, { userId: u, orgId: f.orgA.id, startedAt: '2026-08-11T09:00:00Z', minutes: null, coverage: 'billable' });
  await seedTimeEntry(f.otherPartner.id, { userId: otherTech.id, orgId: f.otherOrg.id, startedAt: '2026-08-12T09:00:00Z',
    minutes: 500, coverage: 'billable', hourlyRate: '999.00' });
  // Fix round item 9: the OTHER partner's org-less (internal) entry — the
  // org allowlist admits org_id NULL, so only the partner predicate keeps it out.
  await seedTimeEntry(f.otherPartner.id, { userId: otherTech.id, orgId: null, startedAt: '2026-08-13T09:00:00Z',
    minutes: 700, coverage: 'billable', hourlyRate: '777.00' });

  return { idle, viewer, disabled, otherTech, workTypeId };
}

describe('technician_time_billability — real Postgres (#3198 W02 Task 8)', () => {
  runDb('partner scope: org-less time counted, idle tech at 0%, other partners / suspended orgs / non-techs absent', async () => {
    const f = await seedBusinessFixture();
    const t = await seedTimeFixture(f);
    const authority = await livePartnerAuthority(f);
    const scope = await livePartnerScope(f, authority);

    const result = await generateReport('technician_time_billability', scope, { period: AUGUST }, authority);
    const s = result.summary as TechnicianTimeSummary;

    expect(s.groupBy).toBe('technician');
    expect(s.workingDays).toBe(21);
    expect(s.overall).toMatchObject({
      loggedMinutes: 255, billableMinutes: 180, includedMinutes: 30, nonBillableMinutes: 45, billedMinutes: 120,
      capacityMinutes: 2 * 21 * 8 * 60,
      billableValue: [{ currencyCode: 'USD', amount: '400.00' }],
      averageRate: [{ currencyCode: 'USD', amount: '125.00' }],
    });
    expect(s.overall.billingConversion).toBeCloseTo(120 / 180, 6);
    // Every billable entry in this fixture is priced; the other partner's
    // org-less 700m entry (item 9) is in neither figure.
    expect(s.unpricedBillable).toEqual({ minutes: 0, entries: 0 });

    // Exactly the two technicians: no viewer, no disabled user, no other partner.
    expect(s.groups.map((g) => g.groupKey).sort()).toEqual([f.user.id, t.idle.id].sort());
    const dana = s.groups.find((g) => g.groupKey === f.user.id)!;
    const idle = s.groups.find((g) => g.groupKey === t.idle.id)!;
    expect(dana).toMatchObject({ groupLabel: 'Dana Tech', loggedMinutes: 255, capacityMinutes: 10_080 });
    expect(dana.utilization).toBeCloseTo(255 / 10_080, 6);
    expect(idle).toMatchObject({ groupLabel: 'Idle Tech', loggedMinutes: 0, utilization: 0,
      billablePercent: null, billingConversion: null, billableValue: [] });
    expect(s.zeroTimeTechnicians).toBe(1);

    // The org-less entry is in the detail too — the whole reason for partner scope.
    expect(s.rows).toHaveLength(4);
    expect(s.rows.filter((r) => r.orgId === null)).toHaveLength(1);
    expect(s.rows.map((r) => r.coverage).sort()).toEqual(['billable', 'billable', 'included', 'non_billable']);
    expect(s.detail).toEqual({ cap: 5000, stored: 4, available: 4, truncated: false });
    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
  });

  runDb('groupBy organization and work_type: org-less → "No organization", untyped → "Unassigned", no idle-tech phantom rows', async () => {
    const f = await seedBusinessFixture();
    await seedTimeFixture(f);
    const authority = await livePartnerAuthority(f);
    const scope = await livePartnerScope(f, authority);

    const byOrg = (await generateReport('technician_time_billability', scope,
      { period: AUGUST, groupBy: 'organization' }, authority)).summary as TechnicianTimeSummary;
    expect(Object.fromEntries(byOrg.groups.map((g) => [g.groupLabel, g.loggedMinutes]))).toEqual({
      Acme: 120, Globex: 75, 'No organization': 60,
    });
    expect(byOrg.groups.every((g) => g.capacityMinutes === null && g.utilization === null)).toBe(true);
    expect(byOrg.zeroTimeTechnicians).toBe(1);

    const byType = (await generateReport('technician_time_billability', scope,
      { period: AUGUST, groupBy: 'work_type' }, authority)).summary as TechnicianTimeSummary;
    expect(Object.fromEntries(byType.groups.map((g) => [g.groupLabel, g.loggedMinutes]))).toEqual({
      Onsite: 120, Unassigned: 135,
    });
  });

  runDb('a disabled user and a user without time-entry access WHO LOGGED TIME appear on the technician axis, and every axis reconciles (#3198 W02 Task 13)', async () => {
    const f = await seedBusinessFixture();
    const t = await seedTimeFixture(f);
    // Gone Tech is disabled; Report Viewer's role grants only reports:read.
    await seedTimeEntry(f.partner.id, { userId: t.disabled.id, orgId: f.orgA.id, startedAt: '2026-08-13T09:00:00Z',
      minutes: 40, coverage: 'billable' });
    await seedTimeEntry(f.partner.id, { userId: t.viewer.id, orgId: null, startedAt: '2026-08-14T09:00:00Z',
      minutes: 20, coverage: 'non_billable', workTypeId: t.workTypeId });
    const authority = await livePartnerAuthority(f);
    const scope = await livePartnerScope(f, authority);
    const run = async (groupBy: 'technician' | 'organization' | 'work_type') =>
      (await generateReport('technician_time_billability', scope, { period: AUGUST, groupBy }, authority))
        .summary as TechnicianTimeSummary;
    const sum = (s: TechnicianTimeSummary, key: 'loggedMinutes' | 'billableMinutes' | 'nonBillableMinutes') =>
      s.groups.reduce((acc, g) => acc + g[key], 0);

    const byTech = await run('technician');
    expect(byTech.groups.map((g) => g.groupKey).sort())
      .toEqual([f.user.id, t.idle.id, t.disabled.id, t.viewer.id].sort());
    expect(byTech.groups.find((g) => g.groupKey === t.disabled.id)).toMatchObject({ loggedMinutes: 40, capacityMinutes: 10_080 });
    expect(byTech.groups.find((g) => g.groupKey === t.viewer.id)).toMatchObject({ loggedMinutes: 20, capacityMinutes: 10_080 });
    // Both add capacity (PARTNER_ROSTER_NOTE); the idle tech is still the only zero-time technician.
    expect(byTech.overall).toMatchObject({ loggedMinutes: 315, capacityMinutes: 4 * 10_080 });
    expect(byTech.zeroTimeTechnicians).toBe(1);
    expect(byTech.notes.join(' ')).toMatch(/disabled or without time-entry access/);

    const byOrg = await run('organization');
    const byType = await run('work_type');
    for (const [name, s] of [['technician', byTech], ['organization', byOrg], ['work_type', byType]] as const) {
      expect(s.overall.loggedMinutes, name).toBe(315);
      expect(sum(s, 'loggedMinutes'), name).toBe(315);
      expect(sum(s, 'billableMinutes'), name).toBe(s.overall.billableMinutes);
      expect(sum(s, 'nonBillableMinutes'), name).toBe(s.overall.nonBillableMinutes);
    }
    expect(Object.fromEntries(byOrg.groups.map((g) => [g.groupLabel, g.loggedMinutes]))).toEqual({
      Acme: 160, Globex: 75, 'No organization': 80,
    });
  });

  // Fix round items 3 + 8: billable value is billed QUANTITY (billable_minutes,
  // not duration) × rate, rounded per row; unpriced billable time is counted.
  runDb('billable value: billable_minutes not duration, per-row rounding, odd rate; unpriced billable time disclosed', async () => {
    const f = await seedBusinessFixture();
    const p = f.partner.id;
    // Two 7-minute entries rounded to 15 billable minutes, at $133.37/h:
    //   per row: ROUND(0.25 h × 133.37, 2) = 33.34 → 66.68 total
    //   (by duration it would be ROUND(0.12 × 133.37) = 16.00 each → 32.00;
    //    rounding the SUM instead would give 66.69).
    for (const day of ['2026-08-04', '2026-08-05']) {
      await seedTimeEntry(p, { userId: f.user.id, orgId: f.orgA.id, startedAt: `${day}T09:00:00Z`, minutes: 7,
        roundingIncrement: 15, coverage: 'billable', hourlyRate: '133.37' });
    }
    // Billable, but no rate: cannot be valued.
    await seedTimeEntry(p, { userId: f.user.id, orgId: f.orgB.id, startedAt: '2026-08-06T09:00:00Z', minutes: 30,
      coverage: 'billable', hourlyRate: null });

    const authority = await livePartnerAuthority(f);
    const s = (await generateReport('technician_time_billability', await livePartnerScope(f, authority),
      { period: AUGUST }, authority)).summary as TechnicianTimeSummary;

    expect(s.overall.billableValue).toEqual([{ currencyCode: 'USD', amount: '66.68' }]);
    expect(s.overall.averageRate).toEqual([{ currencyCode: 'USD', amount: '133.37' }]);
    // Billable % and minutes use DURATION: 7 + 7 + 30.
    expect(s.overall.billableMinutes).toBe(44);
    expect(s.unpricedBillable).toEqual({ minutes: 30, entries: 1 });
    expect(s.notes.join(' ')).toMatch(/30 billed minutes across 1 entry of billable time have no hourly rate or currency/);
  });

  runDb('PARITY: a partner-scope RLS request context and the system context produce identical reports', async () => {
    const f = await seedBusinessFixture();
    await seedTimeFixture(f);
    const authority = await livePartnerAuthority(f);

    for (const groupBy of ['technician', 'organization', 'work_type'] as const) {
      const config = { period: AUGUST, groupBy };
      const viaRequest = await asPartnerRequest(f, async () =>
        generateReport('technician_time_billability', await livePartnerScope(f, authority), config, authority));
      const viaSystem = await generateReport('technician_time_billability', await livePartnerScope(f, authority), config, authority);

      expect(withoutGeneratedAt(viaRequest), groupBy).toEqual(withoutGeneratedAt(viaSystem));
      expect((viaSystem.summary as TechnicianTimeSummary).overall.loggedMinutes, groupBy).toBe(255);
    }
  });

  runDb('org scope under a PARTNER context: only that org\'s time, no org-less entries, no idle techs', async () => {
    const f = await seedBusinessFixture();
    await seedTimeFixture(f);

    const s = await asPartnerRequest(f, async () => (await generateReport('technician_time_billability',
      organizationScope(f.orgA.id), { period: AUGUST }, orgAuthority(f.orgA.id, f.user.id))).summary as TechnicianTimeSummary);

    expect(s.overall.loggedMinutes).toBe(120);
    expect(s.groups.map((g) => g.groupKey)).toEqual([f.user.id]);
    expect(s.rows.every((r) => r.orgId === f.orgA.id)).toBe(true);
    expect(s.zeroTimeTechnicians).toBe(0);
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.orgA.id, orgName: 'Acme' });
    expect(s.notes.join(' ')).toMatch(/ticket-linked time only/);
  });

  // Since ruling F1 no route or worker path runs a business type under an
  // org-token context (org-scope callers are refused; the worker runs in
  // system context). Kept as the RLS backstop: were one to get here, the
  // partner-axis time_entries policy still returns nothing, without an error.
  runDb('org scope under an ORG-token context: time entries are partner-internal → empty, no error (RLS backstop; P7, superseded in routes by F1)', async () => {
    const f = await seedBusinessFixture();
    await seedTimeFixture(f);

    const s = await withDbAccessContext(
      buildDbAccessContext({ scope: 'organization', orgId: f.orgA.id, accessibleOrgIds: [f.orgA.id], partnerId: f.partner.id, userId: f.user.id }),
      async () => (await generateReport('technician_time_billability', organizationScope(f.orgA.id),
        { period: AUGUST }, orgAuthority(f.orgA.id, f.user.id))).summary as TechnicianTimeSummary,
    );

    expect(s.overall.loggedMinutes).toBe(0);
    expect(s.groups).toEqual([]);
    expect(s.rows).toEqual([]);
    // The org-token disclosure note was removed with ruling F1.
    expect(s.notes.join(' ')).not.toMatch(/sign-in/i);
  });
});

// ---------------------------------------------------------------------------
// Task 9 — ar_aging
// ---------------------------------------------------------------------------

const AS_OF = '2026-09-21';

type InvoiceSeed = {
  status: 'draft' | 'sent' | 'partially_paid' | 'overdue' | 'paid' | 'void';
  currency: string;
  dueDate: string | null;
  total: string;
  amountPaid?: string;
  balance: string;
  paidAt?: string | null;
  payments?: string[]; // received_at dates
};

/** Seeded as the superuser (no RLS). */
async function seedInvoice(orgId: string, partnerId: string, o: InvoiceSeed): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO invoices (id, partner_id, org_id, invoice_number, status, currency_code, issue_date, due_date,
      subtotal, total, amount_paid, balance, paid_at)
    VALUES (${id}, ${partnerId}, ${orgId}, ${`INV-${id.slice(0, 12)}`}, ${o.status}, ${o.currency}, '2026-06-01',
      ${o.dueDate}, ${o.total}, ${o.total}, ${o.amountPaid ?? '0.00'}, ${o.balance}, ${o.paidAt ?? null})`);
  for (const receivedAt of o.payments ?? []) {
    await getTestDb().execute(sql`
      INSERT INTO invoice_payments (invoice_id, org_id, amount, method, received_at)
      VALUES (${id}, ${orgId}, '25.00', 'bank_transfer', ${receivedAt})`);
  }
  return id;
}

/**
 * As of 2026-09-21. Org A (Acme) bills USD, org B (Globex) bills EUR.
 *   A: OVERDUE due 08-21 (31d) 100 → d31_60   — the §1 trap: status 'overdue' MUST count
 *      partially_paid due 09-20 (1d) 150 → d1_30, two payments (last 09-10)
 *      sent due 09-21 (0d) 75 → current
 *      sent, NO due date, 20 → no_due_date (never current)
 *      overdue due 06-22 (91d) 300 → d90_plus
 *      DRAFT with a residual 40 → otherOpenBalance, in no bucket
 *      paid 500 on 09-05, balance 0 → only in the includePaidInPeriod note
 *   B: overdue due 07-23 (60d) 60 → d31_60 ; overdue due 07-22 (61d) 61 → d61_90
 *      sent due 08-22 (30d) 30 → d1_30     ; overdue due 06-23 (90d) 90 → d61_90
 * Not counted: the suspended org's overdue invoice, the other partner's.
 */
async function seedArFixture(f: BusinessFixture) {
  const p = f.partner.id;
  const a = f.orgA.id;
  const b = f.orgB.id;
  const overdueA = await seedInvoice(a, p, { status: 'overdue', currency: 'USD', dueDate: '2026-08-21', total: '100.00', balance: '100.00' });
  const partialA = await seedInvoice(a, p, { status: 'partially_paid', currency: 'USD', dueDate: '2026-09-20',
    total: '200.00', amountPaid: '50.00', balance: '150.00', payments: ['2026-09-02', '2026-09-10'] });
  await seedInvoice(a, p, { status: 'sent', currency: 'USD', dueDate: '2026-09-21', total: '75.00', balance: '75.00' });
  const noDueA = await seedInvoice(a, p, { status: 'sent', currency: 'USD', dueDate: null, total: '20.00', balance: '20.00' });
  await seedInvoice(a, p, { status: 'overdue', currency: 'USD', dueDate: '2026-06-22', total: '300.00', balance: '300.00' });
  const draftA = await seedInvoice(a, p, { status: 'draft', currency: 'USD', dueDate: '2026-08-01', total: '40.00', balance: '40.00' });
  await seedInvoice(a, p, { status: 'paid', currency: 'USD', dueDate: '2026-09-01', total: '500.00', amountPaid: '500.00',
    balance: '0.00', paidAt: '2026-09-05T15:00:00Z' });
  await seedInvoice(b, p, { status: 'overdue', currency: 'EUR', dueDate: '2026-07-23', total: '60.00', balance: '60.00' });
  await seedInvoice(b, p, { status: 'overdue', currency: 'EUR', dueDate: '2026-07-22', total: '61.00', balance: '61.00' });
  await seedInvoice(b, p, { status: 'sent', currency: 'EUR', dueDate: '2026-08-22', total: '30.00', balance: '30.00' });
  await seedInvoice(b, p, { status: 'overdue', currency: 'EUR', dueDate: '2026-06-23', total: '90.00', balance: '90.00' });
  // Must NOT be counted:
  await seedInvoice(f.suspendedOrg.id, p, { status: 'overdue', currency: 'USD', dueDate: '2026-08-01', total: '999.00', balance: '999.00' });
  await seedInvoice(f.otherOrg.id, f.otherPartner.id, { status: 'overdue', currency: 'USD', dueDate: '2026-08-01', total: '888.00', balance: '888.00' });
  return { overdueA, partialA, noDueA, draftA };
}

const ZERO = '0.00';
const USD_BUCKETS = { current: '75.00', d1_30: '150.00', d31_60: '100.00', d61_90: ZERO, d90_plus: '300.00', no_due_date: '20.00' };
const EUR_BUCKETS = { current: ZERO, d1_30: '30.00', d31_60: '60.00', d61_90: '151.00', d90_plus: ZERO, no_due_date: ZERO };

describe('ar_aging — real Postgres (#3198 W02 Task 9)', () => {
  runDb('partner scope: overdue-status invoices counted, exact bucket boundaries, per currency, reconciling', async () => {
    const f = await seedBusinessFixture();
    const ids = await seedArFixture(f);
    const authority = await livePartnerAuthority(f);
    const scope = await livePartnerScope(f, authority);

    const result = await generateReport('ar_aging', scope, { asOf: AS_OF }, authority);
    const s = result.summary as ArAgingSummary;

    expect(s.asOf).toBe(AS_OF);
    expect(s.groupBy).toBe('organization');
    expect(s.byCurrency.map((r) => ({ c: r.currencyCode, b: r.buckets, t: r.openTotal, n: r.invoiceCount }))).toEqual([
      { c: 'EUR', b: EUR_BUCKETS, t: '241.00', n: 4 },
      { c: 'USD', b: USD_BUCKETS, t: '645.00', n: 5 },
    ]);
    // Reconciliation: buckets + other open = total open AR (USD 645 + 40 draft).
    expect(s.otherOpenBalance).toEqual([{ currencyCode: 'USD', amount: '40.00' }]);
    expect(s.notes.join(' ')).toMatch(/outside the AR-open set/);

    // Both orgs of the partner, one row each (single-currency orgs); nothing else.
    expect(s.groups.map((g) => [g.groupKey, g.groupLabel, g.currencyCode, g.openTotal])).toEqual([
      [f.orgA.id, 'Acme', 'USD', '645.00'],
      [f.orgB.id, 'Globex', 'EUR', '241.00'],
    ]);

    // Detail: the 9 AR-open invoices, no-due-date first then oldest debt first.
    expect(s.rows.map((r) => r.daysOverdue)).toEqual([null, 91, 90, 61, 60, 31, 30, 1, 0]);
    expect(s.rows.map((r) => r.bucket)).toEqual(
      ['no_due_date', 'd90_plus', 'd61_90', 'd61_90', 'd31_60', 'd31_60', 'd1_30', 'd1_30', 'current']);
    expect(s.rows.every((r) => r.orgId === f.orgA.id || r.orgId === f.orgB.id)).toBe(true);
    expect(s.rows.map((r) => r.invoiceId)).not.toContain(ids.draftA);
    const overdue = s.rows.find((r) => r.invoiceId === ids.overdueA)!;
    expect(overdue).toMatchObject({ status: 'overdue', bucket: 'd31_60', balance: '100.00', lastPaymentAt: null });
    const partial = s.rows.find((r) => r.invoiceId === ids.partialA)!;
    expect(partial).toMatchObject({ amountPaid: '50.00', balance: '150.00', dueDate: '2026-09-20', lastPaymentAt: '2026-09-10' });
    expect(s.rows.find((r) => r.invoiceId === ids.noDueA)).toMatchObject({ dueDate: null, bucket: 'no_due_date' });
    expect(s.detail).toEqual({ cap: 5000, stored: 9, available: 9, truncated: false });
    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
    expect(s.notes.join(' ')).toMatch(/suspended.*excluded/i);
  });

  runDb('groupBy currency and includePaidInPeriod (month-to-date note, buckets unchanged)', async () => {
    const f = await seedBusinessFixture();
    await seedArFixture(f);
    const authority = await livePartnerAuthority(f);
    const scope = await livePartnerScope(f, authority);

    const s = (await generateReport('ar_aging', scope,
      { asOf: AS_OF, groupBy: 'currency', includePaidInPeriod: true }, authority)).summary as ArAgingSummary;
    expect(s.groups.map((g) => [g.groupKey, g.openTotal])).toEqual([['EUR', '241.00'], ['USD', '645.00']]);
    expect(s.byCurrency.map((r) => r.openTotal)).toEqual(['241.00', '645.00']);
    expect(s.notes.join(' ')).toMatch(/Invoices fully paid month-to-date \(2026-09-01 to 2026-09-21\): 1 invoice, invoice totals 500\.00 USD/);
  });

  runDb('PARITY: a partner-scope RLS request context and the system context produce identical reports', async () => {
    const f = await seedBusinessFixture();
    await seedArFixture(f);
    const authority = await livePartnerAuthority(f);

    for (const groupBy of ['organization', 'currency'] as const) {
      const config = { asOf: AS_OF, groupBy, includePaidInPeriod: true };
      const viaRequest = await asPartnerRequest(f, async () =>
        generateReport('ar_aging', await livePartnerScope(f, authority), config, authority));
      const viaSystem = await generateReport('ar_aging', await livePartnerScope(f, authority), config, authority);

      expect(withoutGeneratedAt(viaRequest), groupBy).toEqual(withoutGeneratedAt(viaSystem));
      expect((viaSystem.summary as ArAgingSummary).rows, groupBy).toHaveLength(9);
      // last payment is read through invoice_payments RLS on the request path too
      expect((viaRequest.summary as ArAgingSummary).rows.some((r) => r.lastPaymentAt === '2026-09-10'), groupBy).toBe(true);
    }
  });

  runDb('org scope under an org-token context sees only its own invoices', async () => {
    const f = await seedBusinessFixture();
    await seedArFixture(f);

    const s = await withDbAccessContext(
      buildDbAccessContext({ scope: 'organization', orgId: f.orgB.id, accessibleOrgIds: [f.orgB.id], partnerId: f.partner.id, userId: f.user.id }),
      async () => (await generateReport('ar_aging', organizationScope(f.orgB.id),
        { asOf: AS_OF }, orgAuthority(f.orgB.id, f.user.id))).summary as ArAgingSummary,
    );

    expect(s.byCurrency.map((r) => [r.currencyCode, r.openTotal])).toEqual([['EUR', '241.00']]);
    expect(s.otherOpenBalance).toEqual([]);
    expect(s.rows.every((r) => r.orgId === f.orgB.id)).toBe(true);
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.orgB.id, orgName: 'Globex' });
  });
});
