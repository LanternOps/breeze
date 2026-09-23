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

import type { TicketSlaSummary } from '@breeze/shared';
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
      ${o.responseSla ?? null}, ${o.resolutionSla ?? null}, 0, ${o.deletedAt ?? null},
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

    // Detail rows: the same four tickets, newest first, none from excluded orgs.
    expect(result.rows).toHaveLength(4);
    expect(s.rows.map((r) => r.orgId).every((id) => id === f.orgA.id || id === f.orgB.id)).toBe(true);
    expect(s.rows.map((r) => r.createdAt)).toEqual([
      '2026-08-05T00:00:00.000Z', '2026-08-04T00:00:00.000Z', '2026-08-03T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
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
