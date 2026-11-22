/**
 * #11018 W1: `ticket_sla_performance` against REAL Postgres, as the forced-RLS
 * `breeze_app` role.
 *
 *  1. Tenancy: an org-scoped staff context sees only its org, and the explicit
 *     org predicate fences another org even under a system context.
 *  2. Decided-period counting: consecutive months partition every decided
 *     outcome exactly once.
 *  3. The SLA clock: a calendar ticket's elapsed time, measured from stored
 *     deadlines written by `computeSlaDeadlines`, counts business minutes only.
 *  4. Eligibility: planned, merged and deleted tickets are excluded.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { TicketSlaPerformanceSummary } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  businessCalendarIntervals,
  businessCalendarRevisions,
  businessCalendars,
  tickets,
} from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { generateReport } from '../../services/reportGenerationService';
import { organizationScope, ReportScopeMismatchError } from '../../services/reportScope';
import type { ReportExecutionAuthority } from '../../services/siteScope';
import { computeSlaDeadlines, slaClockRowOf, type TicketCalendar } from '../../services/ticketSlaDeadlines';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const SEPTEMBER = { kind: 'custom' as const, start: '2026-09-01', end: '2026-09-30' };
const OCTOBER = { kind: 'custom' as const, start: '2026-10-01', end: '2026-10-31' };
const at = (iso: string) => new Date(iso);

async function fixture() {
  const partner = (await createPartner({}))!;
  const orgA = (await createOrganization({ partnerId: partner.id, name: 'Acme' }))!;
  const orgB = (await createOrganization({ partnerId: partner.id, name: 'Globex' }))!;
  const user = await createUser({ partnerId: partner.id, email: `sla-perf-${randomUUID()}@example.com` });
  return { partner, orgA, orgB, user };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function authority(orgId: string, userId: string): ReportExecutionAuthority {
  return {
    principalKind: 'user',
    principalUserId: userId,
    scope: { version: 1, kind: 'unrestricted', orgId },
    capturedAt: new Date(),
    fingerprint: 'f'.repeat(64),
  };
}

/** The RLS context `authMiddleware` opens for an org-scope staff token. */
function orgContext(f: Fixture, orgId: string) {
  return buildDbAccessContext({
    scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId: f.partner.id, userId: f.user.id,
  });
}

type Seed = {
  createdAt: string;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  responseSla?: number | null;
  resolutionSla?: number | null;
  firstResponseAt?: string | null;
  resolvedAt?: string | null;
  workKind?: 'support' | 'deliverable' | 'project_task';
  deletedAt?: string | null;
  mergedIntoTicketId?: string | null;
  subject?: string;
  /** A pre-#8973 row: a target but no stored deadline. */
  noStoredDeadline?: boolean;
  pausedMinutes?: number;
  calendar?: { revisionId: string; snapshot: TicketCalendar };
};

/** Seeded as the superuser. Stored deadlines are written the way the write
 *  points write them: `computeSlaDeadlines` on the ticket's calendar. */
async function seedTicket(f: Fixture, orgId: string, o: Seed): Promise<string> {
  const id = randomUUID();
  const createdAt = at(o.createdAt);
  const responseSla = o.responseSla === undefined ? 60 : o.responseSla;
  const resolutionSla = o.resolutionSla === undefined ? 480 : o.resolutionSla;
  const paused = o.pausedMinutes ?? 0;
  const patch = computeSlaDeadlines(slaClockRowOf({
    createdAt,
    responseSlaMinutes: responseSla,
    resolutionSlaMinutes: resolutionSla,
    slaPausedAt: null,
    slaPausedBusinessMinutes: paused,
    firstResponseAt: null,
    resolvedAt: null,
    slaBreachReason: null,
  }), o.calendar?.snapshot ?? null);
  await getTestDb().insert(tickets).values({
    id,
    orgId,
    partnerId: f.partner.id,
    ticketNumber: `SLA-${id.slice(0, 8)}`,
    subject: o.subject ?? 'Printer offline',
    source: 'manual',
    status: o.resolvedAt ? 'resolved' : 'open',
    priority: o.priority ?? 'normal',
    createdAt,
    responseSlaMinutes: responseSla,
    resolutionSlaMinutes: resolutionSla,
    responseDueAt: o.noStoredDeadline ? null : (patch.responseDueAt ?? null),
    resolutionDueAt: o.noStoredDeadline ? null : (patch.resolutionDueAt ?? null),
    slaPausedMinutes: paused,
    slaPausedBusinessMinutes: paused,
    firstResponseAt: o.firstResponseAt ? at(o.firstResponseAt) : null,
    resolvedAt: o.resolvedAt ? at(o.resolvedAt) : null,
    workKind: o.workKind ?? 'support',
    deletedAt: o.deletedAt ? at(o.deletedAt) : null,
    mergedIntoTicketId: o.mergedIntoTicketId ?? null,
    // tickets_merged_pair_chk: a merged tombstone carries its merge stamp.
    mergedAt: o.mergedIntoTicketId ? at(o.createdAt) : null,
    slaCalendarRevisionId: o.calendar?.revisionId ?? null,
  } as never);
  return id;
}

async function run(f: Fixture, orgId: string, config: Record<string, unknown>) {
  const result = await generateReport('ticket_sla_performance', organizationScope(orgId), config, authority(orgId, f.user.id));
  return { result, summary: result.summary as unknown as TicketSlaPerformanceSummary };
}

describe('ticket_sla_performance against real Postgres (#11018)', () => {
  runDb('the report_type enum carries the new label', async () => {
    const rows = await getTestDb().execute(sql`SELECT 'ticket_sla_performance'::report_type AS t`);
    expect((rows as unknown as Array<{ t: string }>)[0]?.t).toBe('ticket_sla_performance');
  });

  runDb("org B's tickets never appear in org A's report under an org-scoped staff context", async () => {
    const f = await fixture();
    await seedTicket(f, f.orgA.id, { createdAt: '2026-09-10T09:00:00Z', firstResponseAt: '2026-09-10T09:20:00Z' });
    await seedTicket(f, f.orgB.id, {
      createdAt: '2026-09-11T09:00:00Z', firstResponseAt: '2026-09-11T11:00:00Z', subject: 'Globex secret',
    });

    const asOrgA = await withDbAccessContext(orgContext(f, f.orgA.id), () => run(f, f.orgA.id, { period: SEPTEMBER, includeSubjects: true }));
    expect(asOrgA.summary.org).toEqual({ orgId: f.orgA.id, orgName: 'Acme' });
    expect(asOrgA.summary.overall.responseMeasured).toBe(1);
    expect(asOrgA.summary.overall.ticketsOpened).toBe(1);
    expect(JSON.stringify(asOrgA.result)).not.toContain('Globex secret');

    // The same report with no ambient context (the worker path) is identical.
    const asSystem = await run(f, f.orgA.id, { period: SEPTEMBER, includeSubjects: true });
    expect(asSystem.summary.priorities).toEqual(asOrgA.summary.priorities);

    // An org context asked for another org refuses rather than reading zero rows.
    await expect(withDbAccessContext(orgContext(f, f.orgA.id), () => run(f, f.orgB.id, { period: SEPTEMBER })))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
  });

  runDb('consecutive months partition outcomes', async () => {
    const f = await fixture();
    // Answered on time Sep 30, resolved on time Oct 2: response in September,
    // resolution in October.
    await seedTicket(f, f.orgA.id, {
      createdAt: '2026-09-30T10:00:00Z', responseSla: 60, resolutionSla: 3 * 1440,
      firstResponseAt: '2026-09-30T10:30:00Z', resolvedAt: '2026-10-02T09:00:00Z',
    });
    // Never answered: decided at its due time, Sep 29 11:00, as a miss.
    await seedTicket(f, f.orgA.id, { createdAt: '2026-09-29T10:00:00Z', resolutionSla: null });
    // Answered late on Oct 2: decided when its deadline passed, Oct 1 10:00.
    await seedTicket(f, f.orgA.id, {
      createdAt: '2026-10-01T09:00:00Z', resolutionSla: null, firstResponseAt: '2026-10-02T09:00:00Z',
    });
    // Pre-#8973 row: due = created + target + paused = 10:00 + 90 min, answered at +80.
    await seedTicket(f, f.orgA.id, {
      createdAt: '2026-10-05T10:00:00Z', resolutionSla: null, pausedMinutes: 30, noStoredDeadline: true,
      firstResponseAt: '2026-10-05T11:20:00Z',
    });

    const sep = (await run(f, f.orgA.id, { period: SEPTEMBER })).summary;
    const oct = (await run(f, f.orgA.id, { period: OCTOBER })).summary;

    expect(sep.overall).toMatchObject({ responseMeasured: 2, responseMet: 1, responseMissed: 1, responseMissedOpen: 1, resolutionMeasured: 0 });
    expect(oct.overall).toMatchObject({ responseMeasured: 2, responseMet: 1, responseMissed: 1, resolutionMeasured: 1, resolutionMet: 1 });
    // Five decided targets were seeded; the two months count each exactly once.
    const measured = (s: TicketSlaPerformanceSummary) => s.overall.responseMeasured + s.overall.resolutionMeasured;
    expect(measured(sep) + measured(oct)).toBe(5);
    // Volume stays on the created basis.
    expect(sep.overall.ticketsOpened).toBe(2);
    expect(oct.overall.ticketsOpened).toBe(2);
    // The legacy row was judged on its fallback due and timed against it: 80 minutes.
    expect(oct.breaches.rows.map((b) => b.target)).toEqual(['response']);
    expect(sep.breaches.rows[0]).toMatchObject({ target: 'response', completedAt: null, elapsedSlaMinutes: null });
  });

  runDb("a calendar ticket's elapsed equals target minus business minutes remaining", async () => {
    const f = await fixture();
    const { revisionId, snapshot } = await withSystemDbAccessContext(async () => {
      const [cal] = await db.insert(businessCalendars).values({ partnerId: f.partner.id, orgId: null, name: 'Office hours', isPartnerDefault: false }).returning();
      const [rev] = await db.insert(businessCalendarRevisions).values({ calendarId: cal!.id, partnerId: f.partner.id, orgId: null, revision: 1, timezone: 'UTC' }).returning();
      const intervals = ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
      await db.insert(businessCalendarIntervals).values(intervals.map((i) => ({ ...i, revisionId: rev!.id, partnerId: f.partner.id, orgId: null })));
      return { revisionId: rev!.id, snapshot: { revision: { timezone: 'UTC', intervals }, holidays: [] } as TicketCalendar };
    });
    // Created Mon 2026-10-05 16:00 with a 2-hour target: 1 hour Monday, 1 hour
    // Tuesday, so the stored due is Tue 10:00. Answered Tue 09:30 = 90 business
    // minutes, not the 17.5 wall-clock hours.
    await seedTicket(f, f.orgA.id, {
      createdAt: '2026-10-05T16:00:00Z', responseSla: 120, resolutionSla: null,
      firstResponseAt: '2026-10-06T09:30:00Z', calendar: { revisionId, snapshot },
    });
    const due = await getTestDb().execute(sql`SELECT to_char(response_due_at, 'YYYY-MM-DD"T"HH24:MI') AS d FROM tickets WHERE org_id = ${f.orgA.id}`);
    expect((due as unknown as Array<{ d: string }>)[0]?.d).toBe('2026-10-06T10:00');

    const oct = (await run(f, f.orgA.id, { period: OCTOBER })).summary;
    expect(oct.overall).toMatchObject({ responseMeasured: 1, responseMet: 1, responseTimedSample: 1, responseMedianMinutes: 90 });
    expect(oct.unmeasuredDurations).toBe(0);
  });

  runDb('planned and merged tickets are excluded', async () => {
    const f = await fixture();
    const kept = await seedTicket(f, f.orgA.id, { createdAt: '2026-09-10T09:00:00Z', firstResponseAt: '2026-09-10T09:20:00Z' });
    await seedTicket(f, f.orgA.id, { createdAt: '2026-09-10T09:00:00Z', workKind: 'project_task' });
    await seedTicket(f, f.orgA.id, { createdAt: '2026-09-10T09:00:00Z', mergedIntoTicketId: kept });
    await seedTicket(f, f.orgA.id, { createdAt: '2026-09-10T09:00:00Z', deletedAt: '2026-09-11T00:00:00Z' });

    const { summary, result } = await run(f, f.orgA.id, { period: SEPTEMBER });
    expect(summary.overall.ticketsOpened).toBe(1);
    expect(summary.overall.responseMeasured).toBe(1);
    expect(summary.overall.resolutionMeasured).toBe(1); // the kept ticket's unanswered resolution
    expect(summary.breaches.available).toBe(1);
    // No subject unless the definition opted in.
    expect(JSON.stringify(result)).not.toContain('Printer offline');
  });
});
