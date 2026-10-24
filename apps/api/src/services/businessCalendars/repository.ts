/**
 * Business-hours calendars (#8973 W4) — data access. Every function runs on
 * the CALLER's connection (the ambient DB context), so RLS decides what each
 * statement can see or target; the service layer adds the app-layer gates.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  businessCalendarHolidays,
  businessCalendarIntervals,
  businessCalendarRevisions,
  businessCalendars,
  orgTicketSettings,
  organizations,
  tickets,
} from '../../db/schema';

export type CalendarRow = typeof businessCalendars.$inferSelect;
export type RevisionRow = typeof businessCalendarRevisions.$inferSelect;
export type IntervalRow = typeof businessCalendarIntervals.$inferSelect;
export type HolidayRow = typeof businessCalendarHolidays.$inferSelect;
export type Owner = { orgId: string | null; partnerId: string | null };
export type IntervalValues = { weekday: number; startMinute: number; endMinute: number };

export async function findCalendar(id: string, opts: { forUpdate?: boolean } = {}): Promise<CalendarRow | null> {
  const q = db.select().from(businessCalendars).where(eq(businessCalendars.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for('update') : await q;
  return rows[0] ?? null;
}

/** org row needed to place an org-owned calendar or validate an override. */
export async function findOrg(orgId: string): Promise<{ id: string; partnerId: string } | null> {
  const rows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCalendarRows(filter: { orgIds: string[] | 'all' | null; partnerId: string | null; includeArchived: boolean }): Promise<CalendarRow[]> {
  const branches: SQL[] = [];
  if (filter.partnerId) branches.push(and(isNull(businessCalendars.orgId), eq(businessCalendars.partnerId, filter.partnerId))!);
  if (filter.orgIds === 'all') branches.push(sql`${businessCalendars.orgId} IS NOT NULL`);
  else if (filter.orgIds && filter.orgIds.length > 0) branches.push(inArray(businessCalendars.orgId, filter.orgIds));
  if (branches.length === 0) return [];
  const where = and(or(...branches), filter.includeArchived ? undefined : isNull(businessCalendars.archivedAt));
  return db.select().from(businessCalendars).where(where).orderBy(asc(businessCalendars.name), asc(businessCalendars.id));
}

/** The highest revision of each calendar (the current one), with its intervals. */
export async function currentRevisions(calendarIds: string[]): Promise<Map<string, { revision: RevisionRow; intervals: IntervalRow[] }>> {
  const out = new Map<string, { revision: RevisionRow; intervals: IntervalRow[] }>();
  if (calendarIds.length === 0) return out;
  const revs = await db
    .selectDistinctOn([businessCalendarRevisions.calendarId])
    .from(businessCalendarRevisions)
    .where(inArray(businessCalendarRevisions.calendarId, calendarIds))
    .orderBy(businessCalendarRevisions.calendarId, desc(businessCalendarRevisions.revision));
  if (revs.length === 0) return out;
  const ivals = await db
    .select()
    .from(businessCalendarIntervals)
    .where(inArray(businessCalendarIntervals.revisionId, revs.map((r) => r.id)))
    .orderBy(asc(businessCalendarIntervals.weekday), asc(businessCalendarIntervals.startMinute));
  for (const revision of revs) {
    out.set(revision.calendarId, { revision, intervals: ivals.filter((i) => i.revisionId === revision.id) });
  }
  return out;
}

export async function holidaysFor(calendarIds: string[]): Promise<HolidayRow[]> {
  if (calendarIds.length === 0) return [];
  return db
    .select()
    .from(businessCalendarHolidays)
    .where(inArray(businessCalendarHolidays.calendarId, calendarIds))
    .orderBy(asc(businessCalendarHolidays.holidayDate));
}

export async function insertCalendar(values: Owner & { name: string }): Promise<CalendarRow> {
  const [row] = await db.insert(businessCalendars).values(values).returning();
  return row!;
}

/** A new revision n+1. Callers hold the calendar row lock (findCalendar forUpdate). */
export async function insertRevision(calendar: CalendarRow, timezone: string, intervals: IntervalValues[], createdByUserId: string | null): Promise<RevisionRow> {
  const [max] = await db
    .select({ n: sql<number>`COALESCE(MAX(${businessCalendarRevisions.revision}), 0)::int` })
    .from(businessCalendarRevisions)
    .where(eq(businessCalendarRevisions.calendarId, calendar.id));
  const owner = { orgId: calendar.orgId, partnerId: calendar.partnerId };
  const [revision] = await db.insert(businessCalendarRevisions).values({
    calendarId: calendar.id, ...owner, revision: (max?.n ?? 0) + 1, timezone, createdByUserId,
  }).returning();
  await db.insert(businessCalendarIntervals).values(intervals.map((i) => ({ revisionId: revision!.id, ...owner, ...i })));
  return revision!;
}

export async function updateCalendarRow(id: string, patch: Partial<Pick<CalendarRow, 'name' | 'archivedAt' | 'isPartnerDefault'>>): Promise<CalendarRow | null> {
  const [row] = await db.update(businessCalendars).set({ ...patch, updatedAt: new Date() }).where(eq(businessCalendars.id, id)).returning();
  return row ?? null;
}

export async function clearPartnerDefaultRows(partnerId: string, exceptId?: string): Promise<void> {
  await db.update(businessCalendars)
    .set({ isPartnerDefault: false, updatedAt: new Date() })
    .where(and(
      eq(businessCalendars.partnerId, partnerId),
      isNull(businessCalendars.orgId),
      eq(businessCalendars.isPartnerDefault, true),
      exceptId ? sql`${businessCalendars.id} <> ${exceptId}` : undefined,
    ));
}

export async function deleteCalendarRow(id: string): Promise<boolean> {
  const rows = await db.delete(businessCalendars).where(eq(businessCalendars.id, id)).returning({ id: businessCalendars.id });
  return rows.length > 0;
}

/** True when any ticket snapshotted one of the calendar's revisions (tickets_sla_calendar_revision_idx). */
export async function calendarReferencedByTickets(calendarId: string): Promise<boolean> {
  const rows = await db.execute<{ used: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.sla_calendar_revision_id IN (SELECT r.id FROM business_calendar_revisions r WHERE r.calendar_id = ${calendarId})
    ) AS used`);
  const list = (rows as unknown as { rows?: Array<{ used: boolean }> }).rows ?? (rows as unknown as Array<{ used: boolean }>);
  return Boolean(list[0]?.used);
}

export async function calendarSelectedByOrgs(calendarId: string): Promise<boolean> {
  const rows = await db.select({ id: orgTicketSettings.id }).from(orgTicketSettings).where(eq(orgTicketSettings.businessCalendarId, calendarId)).limit(1);
  return rows.length > 0;
}

export async function insertHoliday(calendar: CalendarRow, date: string, name: string): Promise<HolidayRow> {
  const [row] = await db.insert(businessCalendarHolidays).values({
    calendarId: calendar.id, orgId: calendar.orgId, partnerId: calendar.partnerId, holidayDate: date, name,
  }).returning();
  return row!;
}

export async function deleteHoliday(calendarId: string, holidayId: string): Promise<HolidayRow | null> {
  const [row] = await db.delete(businessCalendarHolidays)
    .where(and(eq(businessCalendarHolidays.id, holidayId), eq(businessCalendarHolidays.calendarId, calendarId)))
    .returning();
  return row ?? null;
}

export async function readOrgOverride(orgId: string): Promise<string | null> {
  const rows = await db.select({ id: orgTicketSettings.businessCalendarId }).from(orgTicketSettings).where(eq(orgTicketSettings.orgId, orgId)).limit(1);
  return rows[0]?.id ?? null;
}

export async function writeOrgOverride(orgId: string, calendarId: string | null): Promise<void> {
  await db.insert(orgTicketSettings)
    .values({ orgId, businessCalendarId: calendarId })
    .onConflictDoUpdate({ target: orgTicketSettings.orgId, set: { businessCalendarId: calendarId, updatedAt: new Date() } });
}

// ---- D12 apply-revision (applyRevision.ts) ---------------------------------

const OPEN_TICKET_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

/** The clock + deadline columns apply-revision reads, via the typed builder (UTC-safe). */
const applySelection = {
  id: tickets.id,
  status: tickets.status,
  deletedAt: tickets.deletedAt,
  slaCalendarRevisionId: tickets.slaCalendarRevisionId,
  createdAt: tickets.createdAt,
  responseSlaMinutes: tickets.responseSlaMinutes,
  resolutionSlaMinutes: tickets.resolutionSlaMinutes,
  slaPausedAt: tickets.slaPausedAt,
  slaPausedBusinessMinutes: tickets.slaPausedBusinessMinutes,
  slaPausedMinutes: tickets.slaPausedMinutes,
  firstResponseAt: tickets.firstResponseAt,
  resolvedAt: tickets.resolvedAt,
  slaBreachReason: tickets.slaBreachReason,
  // The snapshot's calendar and revision number, re-checked under the row lock.
  revisionCalendarId: sql<string | null>`(SELECT r.calendar_id FROM business_calendar_revisions r WHERE r.id = ${tickets.slaCalendarRevisionId})`,
  revisionNumber: sql<number | null>`(SELECT r.revision FROM business_calendar_revisions r WHERE r.id = ${tickets.slaCalendarRevisionId})`,
};
export type ApplyCandidateRow = {
  id: string;
  status: string;
  deletedAt: Date | null;
  slaCalendarRevisionId: string | null;
  createdAt: Date;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
  slaPausedAt: Date | null;
  slaPausedBusinessMinutes: number;
  slaPausedMinutes: number | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaBreachReason: string | null;
  revisionCalendarId: string | null;
  revisionNumber: number | null;
};

const olderRevisionOf = (calendarId: string, target: { revision: number }) => sql`${tickets.slaCalendarRevisionId} IN (
  SELECT r.id FROM business_calendar_revisions r WHERE r.calendar_id = ${calendarId} AND r.revision < ${target.revision})`;

/** Open, live tickets on an OLDER revision of the calendar, id order (tickets_sla_calendar_revision_idx). */
export async function listApplyCandidates(
  calendarId: string,
  target: { id: string; revision: number },
  afterId: string | null,
  limit: number,
): Promise<ApplyCandidateRow[]> {
  return db.select(applySelection).from(tickets)
    .where(and(
      olderRevisionOf(calendarId, target),
      inArray(tickets.status, [...OPEN_TICKET_STATUSES]),
      isNull(tickets.deletedAt),
      isNull(tickets.mergedIntoTicketId),
      afterId ? sql`${tickets.id} > ${afterId}::uuid` : undefined,
    ))
    .orderBy(asc(tickets.id))
    .limit(limit);
}

/** Locks what it can of `ids` (FOR UPDATE SKIP LOCKED); the caller re-checks eligibility on the locked rows. */
export async function lockApplyBatch(_calendarId: string, _target: { id: string; revision: number }, ids: string[]): Promise<ApplyCandidateRow[]> {
  if (ids.length === 0) return [];
  return db.select(applySelection).from(tickets).where(inArray(tickets.id, ids)).for('update', { skipLocked: true });
}

export async function applyTicketRevision(ticketId: string, patch: Partial<typeof tickets.$inferInsert>): Promise<void> {
  await db.update(tickets).set(patch).where(eq(tickets.id, ticketId));
}
