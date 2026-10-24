/**
 * #8973 W4 (spec §4.5) — the holiday recompute job against real Postgres.
 *
 *  - fan-out: a PARTNER-WIDE calendar's holiday moves the deadlines of
 *    tickets in two different orgs (tickets are found by revision, never by
 *    the calendar's org — tenancy-rls.md step 5);
 *  - a row held by a concurrent writer is skipped (FOR UPDATE SKIP LOCKED)
 *    and retried in a later chunk;
 *  - recompute vs the breach sweep never stamps an obsolete deadline.
 *
 * The calendar is open 24 hours every day in UTC, so the expected deadlines
 * are plain arithmetic: a holiday inside [created, due] moves due by 1 day.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  businessCalendarHolidays,
  businessCalendarIntervals,
  businessCalendarRevisions,
  businessCalendars,
  tickets,
} from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { addHoliday, type CalendarAuth } from '../../services/businessCalendars/service';
import { applyRevision, previewApplyRevision } from '../../services/businessCalendars/applyRevision';
import { runBusinessCalendarRecompute } from '../../jobs/businessCalendarRecomputeWorker';
import { sweepTicketSlaBreaches } from '../../jobs/ticketSlaWorker';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

async function fixture() {
  const partner = (await createPartner())!;
  const orgA = (await createOrganization({ partnerId: partner.id }))!;
  const orgB = (await createOrganization({ partnerId: partner.id }))!;
  const user = await createUser({ partnerId: partner.id, email: `bc-rc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com` });
  const { calendarId, revisionId } = await withSystemDbAccessContext(async () => {
    const [cal] = await db.insert(businessCalendars).values({ partnerId: partner.id, orgId: null, name: 'Always open', isPartnerDefault: true }).returning();
    const [rev] = await db.insert(businessCalendarRevisions).values({ calendarId: cal!.id, partnerId: partner.id, orgId: null, revision: 1, timezone: 'UTC' }).returning();
    await db.insert(businessCalendarIntervals).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      revisionId: rev!.id, partnerId: partner.id, orgId: null, weekday, startMinute: 0, endMinute: 1440,
    })));
    return { calendarId: cal!.id, revisionId: rev!.id };
  });
  const auth: CalendarAuth = {
    scope: 'partner', partnerId: partner.id, orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: null,
    canAccessOrg: () => true, user: { id: user.id },
  } as CalendarAuth;
  const ctx = buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id, orgB.id], partnerId: partner.id, userId: user.id });
  return { partner, orgA, orgB, calendarId, revisionId, auth, ctx };
}

async function seedTicket(f: Awaited<ReturnType<typeof fixture>>, orgId: string, extra: Record<string, unknown> = {}) {
  const createdAt = new Date(Date.now() - 60 * 60_000);
  const target = 4 * 1440; // four (24h) business days
  const [t] = await getTestDb().insert(tickets).values({
    orgId, partnerId: f.partner.id, ticketNumber: `RC-${Math.random().toString(36).slice(2, 10)}`, subject: 'recompute',
    source: 'manual', status: 'open', createdAt, slaCalendarRevisionId: f.revisionId,
    resolutionSlaMinutes: target,
    resolutionDueAt: new Date(createdAt.getTime() + target * 60_000),
    resolutionWarnAt: new Date(createdAt.getTime() + 0.8 * target * 60_000),
    ...extra,
  } as never).returning();
  return t as typeof tickets.$inferSelect;
}

const readDue = async (ids: string[]) => new Map((await getTestDb()
  .select({ id: tickets.id, due: tickets.resolutionDueAt, breach: tickets.slaBreachReason })
  .from(tickets).where(inArray(tickets.id, ids))).map((r) => [r.id, r]));

describe('business calendar holiday recompute (#8973 W4, spec §4.5)', () => {
  runDb("a partner-wide calendar's future holiday moves deadlines in two orgs", async () => {
    const f = await fixture();
    const a = await seedTicket(f, f.orgA.id);
    const b = await seedTicket(f, f.orgB.id);
    const resolved = await seedTicket(f, f.orgA.id, { status: 'resolved', resolvedAt: new Date() });

    const holiday = isoDate(new Date(Date.now() + 2 * DAY));
    const { recomputeQueued } = await withDbAccessContext(f.ctx, () => addHoliday(f.auth, f.calendarId, { date: holiday, name: 'Closed' }));
    expect(recomputeQueued).toBe(true);

    const res = await runBusinessCalendarRecompute(f.calendarId);
    expect(res.updated).toBe(2);

    const due = await readDue([a.id, b.id, resolved.id]);
    expect(due.get(a.id)!.due!.getTime()).toBe(a.resolutionDueAt!.getTime() + DAY);
    expect(due.get(b.id)!.due!.getTime()).toBe(b.resolutionDueAt!.getTime() + DAY);
    // A resolved (frozen) ticket keeps its deadline.
    expect(due.get(resolved.id)!.due!.getTime()).toBe(resolved.resolutionDueAt!.getTime());

    // Idempotent: a second run changes nothing.
    expect((await runBusinessCalendarRecompute(f.calendarId)).updated).toBe(0);
  });

  runDb('a ticket on another calendar is never touched', async () => {
    const f = await fixture();
    const g = await fixture();
    const mine = await seedTicket(f, f.orgA.id);
    const theirs = await seedTicket(g, g.orgA.id);
    await withSystemDbAccessContext(() => db.insert(businessCalendarHolidays).values({
      calendarId: f.calendarId, partnerId: f.partner.id, orgId: null, holidayDate: isoDate(new Date(Date.now() + 2 * DAY)), name: 'x',
    }));
    await runBusinessCalendarRecompute(f.calendarId);
    const due = await readDue([mine.id, theirs.id]);
    expect(due.get(mine.id)!.due!.getTime()).toBe(mine.resolutionDueAt!.getTime() + DAY);
    expect(due.get(theirs.id)!.due!.getTime()).toBe(theirs.resolutionDueAt!.getTime());
  });

  runDb('a row held by a concurrent writer is skipped, then retried and recomputed', async () => {
    const f = await fixture();
    const t = await seedTicket(f, f.orgA.id);
    await withSystemDbAccessContext(() => db.insert(businessCalendarHolidays).values({
      calendarId: f.calendarId, partnerId: f.partner.id, orgId: null, holidayDate: isoDate(new Date(Date.now() + 2 * DAY)), name: 'x',
    }));

    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const held = holder.begin(async (tx) => {
      await tx`SELECT id FROM tickets WHERE id = ${t.id} FOR UPDATE`;
      await released;
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const run = runBusinessCalendarRecompute(f.calendarId);
      setTimeout(() => release(), 120);
      const res = await run;
      await held;
      expect(res).toEqual({ processed: 1, updated: 1 });
      expect((await readDue([t.id])).get(t.id)!.due!.getTime()).toBe(t.resolutionDueAt!.getTime() + DAY);
    } finally {
      release();
      await held.catch(() => undefined);
      await holder.end();
    }
  });

  runDb('recompute vs sweep never stamps an obsolete deadline', async () => {
    const f = await fixture();
    // Due in ~1 day; a holiday tomorrow moves it a day later. Neither order
    // of sweep and recompute may stamp a breach: the edit only moves time
    // strictly after now, and the sweep stamps only now() >= due.
    const createdAt = new Date(Date.now() - 3 * DAY);
    const t = await seedTicket(f, f.orgA.id, {
      createdAt,
      resolutionSlaMinutes: 4 * 1440,
      resolutionDueAt: new Date(createdAt.getTime() + 4 * DAY),
      resolutionWarnAt: new Date(createdAt.getTime() + 3.2 * DAY),
    });
    await withSystemDbAccessContext(() => db.insert(businessCalendarHolidays).values({
      calendarId: f.calendarId, partnerId: f.partner.id, orgId: null, holidayDate: isoDate(new Date(Date.now() + DAY)), name: 'x',
    }));

    const [stampedBefore] = await Promise.all([
      withSystemDbAccessContext(() => sweepTicketSlaBreaches()),
      runBusinessCalendarRecompute(f.calendarId),
    ]);
    const stampedAfter = await withSystemDbAccessContext(() => sweepTicketSlaBreaches());

    expect([...stampedBefore, ...stampedAfter].filter((r) => r.id === t.id)).toEqual([]);
    const row = (await readDue([t.id])).get(t.id)!;
    expect(row.breach).toBeNull();
    expect(row.due!.getTime()).toBeGreaterThan(Date.now());
    expect(row.due!.getTime()).toBe(t.resolutionDueAt!.getTime() + DAY);

    const [after] = await getTestDb().select().from(tickets).where(eq(tickets.id, t.id));
    expect(after?.slaBreachedAt).toBeNull();
  });

  // D12 against real Postgres: preview counts, the stale-revision refusal,
  // and the chunked apply through its own caller-scoped transactions.
  runDb('D12 apply-revision moves never-paused open tickets to the current revision', async () => {
    const f = await fixture();
    const fresh = await seedTicket(f, f.orgA.id);
    const pausedHistory = await seedTicket(f, f.orgB.id, { slaPausedBusinessMinutes: 15, slaPausedMinutes: 15 });
    const resolved = await seedTicket(f, f.orgA.id, { status: 'resolved', resolvedAt: new Date() });
    // Revision 2: weekdays only (Mon–Fri all day), so deadlines move later.
    const rev2 = await withSystemDbAccessContext(async () => {
      const [r] = await db.insert(businessCalendarRevisions).values({
        calendarId: f.calendarId, partnerId: f.partner.id, orgId: null, revision: 2, timezone: 'UTC',
      }).returning();
      await db.insert(businessCalendarIntervals).values([1, 2, 3, 4, 5].map((weekday) => ({
        revisionId: r!.id, partnerId: f.partner.id, orgId: null, weekday, startMinute: 0, endMinute: 1440,
      })));
      return r!;
    });
    const auth = { ...f.auth, orgId: null, accessibleOrgIds: [f.orgA.id, f.orgB.id], principal: { kind: 'user' } } as never;

    const preview = await withDbAccessContext(f.ctx, () => previewApplyRevision(auth, f.calendarId));
    expect(preview).toEqual({ revisionId: rev2.id, eligibleCount: 1, immediatelyBreachedCount: 0, skippedPausedCount: 1 });

    const stale = await applyRevision(auth, f.calendarId, { expectedRevisionId: f.revisionId }).catch((e) => e);
    expect(stale).toMatchObject({ status: 409, code: 'REVISION_CHANGED' });

    expect(await applyRevision(auth, f.calendarId, { expectedRevisionId: rev2.id })).toEqual({ updated: 1, skippedLocked: 0 });
    const rows = new Map((await getTestDb().select().from(tickets).where(inArray(tickets.id, [fresh.id, pausedHistory.id, resolved.id]))).map((r) => [r.id, r]));
    expect(rows.get(fresh.id)?.slaCalendarRevisionId).toBe(rev2.id);
    expect(rows.get(fresh.id)!.resolutionDueAt!.getTime()).toBeGreaterThanOrEqual(fresh.resolutionDueAt!.getTime());
    expect(rows.get(pausedHistory.id)?.slaCalendarRevisionId).toBe(f.revisionId);
    expect(rows.get(resolved.id)?.slaCalendarRevisionId).toBe(f.revisionId);
  });

  // More than one APPLY_CHUNK (500): the id cursor must neither skip nor repeat
  // rows across chunks, and a soft-deleted ticket is never touched.
  runDb('D12 apply walks past the first 500-ticket chunk and skips soft-deleted tickets', async () => {
    const f = await fixture();
    const createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await getTestDb().execute(sql`
      INSERT INTO tickets (org_id, partner_id, ticket_number, subject, source, status, created_at, updated_at,
                           sla_calendar_revision_id, resolution_sla_minutes, resolution_due_at, resolution_warn_at)
      SELECT ${f.orgA.id}::uuid, ${f.partner.id}::uuid, 'BULK-' || g || '-' || substr(md5(random()::text), 1, 6), 'bulk', 'api', 'open',
             (${createdAt}::timestamptz AT TIME ZONE 'UTC'), (${createdAt}::timestamptz AT TIME ZONE 'UTC'), ${f.revisionId}::uuid, 5760, (${createdAt}::timestamptz AT TIME ZONE 'UTC'), (${createdAt}::timestamptz AT TIME ZONE 'UTC')
        FROM generate_series(1, 503) g`);
    const deleted = await seedTicket(f, f.orgA.id, { deletedAt: new Date() });
    const rev2 = await withSystemDbAccessContext(async () => {
      const [r] = await db.insert(businessCalendarRevisions).values({
        calendarId: f.calendarId, partnerId: f.partner.id, orgId: null, revision: 2, timezone: 'UTC',
      }).returning();
      await db.insert(businessCalendarIntervals).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        revisionId: r!.id, partnerId: f.partner.id, orgId: null, weekday, startMinute: 0, endMinute: 1440,
      })));
      return r!;
    });
    const auth = { ...f.auth, accessibleOrgIds: [f.orgA.id, f.orgB.id], principal: { kind: 'user' } } as never;

    expect(await applyRevision(auth, f.calendarId, { expectedRevisionId: rev2.id })).toEqual({ updated: 503, skippedLocked: 0 });
    const onRev2 = await getTestDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tickets WHERE org_id = ${f.orgA.id}::uuid AND sla_calendar_revision_id = ${rev2.id}::uuid`);
    expect([...onRev2][0]!.n).toBe(503);
    const [del] = await getTestDb().select().from(tickets).where(eq(tickets.id, deleted.id));
    expect(del?.slaCalendarRevisionId).toBe(f.revisionId);
  });
});
