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
import { eq, inArray } from 'drizzle-orm';
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
});
