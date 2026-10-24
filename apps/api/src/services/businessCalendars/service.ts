/**
 * Business-hours calendars (#8973 W4, spec §4.1, §4.2, §4.5) — the service
 * behind routes/businessCalendars.ts and the list_business_calendars AI tool.
 *
 * Everything runs in the CALLER's DB context: RLS (<table>_isolation FOR ALL)
 * decides which rows a statement can target, so an org token that reads a
 * partner-wide calendar through <table>_partner_wide_select can never change
 * it. On top of that:
 *   - writes are partner/system only (an org token writes nothing);
 *   - every write to a PARTNER-WIDE calendar — create, update, archive,
 *     delete, set/clear default, holidays — is gated here, in the service, on
 *     canManagePartnerWidePolicies (a selected-access partner user can reach
 *     the row through RLS but must not administer it);
 *   - an org-owned calendar needs canAccessOrg on its org.
 *
 * An hours or time-zone edit never changes a revision: it writes revision
 * n+1, which applies to NEW tickets only (spec §4.5). Open tickets move to it
 * only through the D12 apply-revision action (applyRevision.ts). A future
 * holiday edit (date > today in the calendar's time zone) queues the
 * business-calendar-recompute job after commit.
 */
import { validateRevision, type CalendarInterval, type BusinessCalendarDto, type ResolvedBusinessCalendarDto, type CreateBusinessCalendarInput, type UpdateBusinessCalendarInput } from '@breeze/shared';
import { db, runAfterDbContextCommit } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { enqueueBusinessCalendarRecompute } from '../../jobs/businessCalendarRecomputeWorker';
import { captureException } from '../sentry';
import * as repo from './repository';
import { resolveBusinessCalendar } from './resolve';
import type { CalendarRow, Owner } from './repository';

export class BusinessCalendarError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409, readonly code: string) {
    super(message);
    this.name = 'BusinessCalendarError';
  }
}

export type CalendarAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'partnerOrgAccess' | 'accessibleOrgIds' | 'canAccessOrg'> & {
  user: { id: string; email?: string };
};

const notFound = () => new BusinessCalendarError('Business calendar not found', 404, 'NOT_FOUND');

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function assertWriter(auth: CalendarAuth): void {
  if (auth.scope !== 'partner' && auth.scope !== 'system') {
    throw new BusinessCalendarError('Business calendars are managed by partner staff', 403, 'ACCESS_DENIED');
  }
}

/** The write gate on an existing row. Rows outside the caller's reach read as missing. */
function assertCanWriteRow(auth: CalendarAuth, row: CalendarRow): void {
  assertWriter(auth);
  if (row.orgId === null) {
    if (auth.scope === 'partner' && row.partnerId !== auth.partnerId) throw notFound();
    if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
    return;
  }
  if (auth.scope === 'partner' && !auth.canAccessOrg(row.orgId)) throw notFound();
}

/** The calendar row under the caller's write gate (row-locked); exported for applyRevision.ts. */
export async function loadCalendarForWrite(auth: CalendarAuth, calendarId: string): Promise<CalendarRow> {
  return loadForWrite(auth, calendarId);
}

async function loadForWrite(auth: CalendarAuth, calendarId: string): Promise<CalendarRow> {
  assertWriter(auth);
  const row = await repo.findCalendar(calendarId, { forUpdate: true });
  if (!row) throw notFound();
  assertCanWriteRow(auth, row);
  return row;
}

async function resolveCreateOwner(auth: CalendarAuth, input: Pick<CreateBusinessCalendarInput, 'ownerScope' | 'orgId'>): Promise<Owner> {
  assertWriter(auth);
  if (input.ownerScope === 'partner') {
    if (input.orgId) throw new BusinessCalendarError('orgId cannot be combined with ownerScope "partner"', 400, 'VALIDATION_ERROR');
    if (!auth.partnerId) throw new BusinessCalendarError('A partner-wide calendar needs a partner context', 400, 'PARTNER_REQUIRED');
    if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
    return { orgId: null, partnerId: auth.partnerId };
  }
  if (!input.orgId) throw new BusinessCalendarError('orgId is required for an organization calendar', 400, 'VALIDATION_ERROR');
  if (auth.scope === 'partner' && !auth.canAccessOrg(input.orgId)) {
    throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  }
  const org = await repo.findOrg(input.orgId);
  if (!org) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  return { orgId: org.id, partnerId: null };
}

const HOURS_MESSAGES: Record<'NO_INTERVALS' | 'OVERLAP' | 'BAD_RANGE' | 'BAD_TIMEZONE', string> = {
  NO_INTERVALS: 'At least one open interval per week is required',
  OVERLAP: 'Intervals on the same weekday must not overlap',
  BAD_RANGE: 'An interval is out of range',
  BAD_TIMEZONE: 'Invalid IANA time zone',
};

/**
 * validateRevision → 400 with its code. The route's shared schema runs the
 * same check; this is the service-level gate for every other caller, and the
 * DB triggers (time zone, overlap) are the last line.
 */
function assertHours(timezone: string, intervals: repo.IntervalValues[]): void {
  const result = validateRevision({ timezone, intervals: intervals as CalendarInterval[] });
  if (!result.ok) throw new BusinessCalendarError(HOURS_MESSAGES[result.code], 400, result.code);
}

/**
 * Intl accepts any letter case ("europe/london"); the database check compares
 * exactly against pg_timezone_names, so store Intl's canonical spelling.
 */
function canonicalTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
}

/** Revision n+1 with the canonical zone; the DB time-zone check maps to a 400. */
async function insertHoursRevision(calendar: CalendarRow, timezone: string, intervals: repo.IntervalValues[], userId: string) {
  assertHours(timezone, intervals);
  try {
    return await repo.insertRevision(calendar, canonicalTimezone(timezone), intervals, userId);
  } catch (err) {
    if (pgConstraintIs(err, 'business_calendar_revisions_timezone_chk')) {
      throw new BusinessCalendarError(HOURS_MESSAGES.BAD_TIMEZONE, 400, 'BAD_TIMEZONE');
    }
    throw err;
  }
}

function pgConstraintIs(err: unknown, constraint: string): boolean {
  const e = err as { constraint_name?: string; constraint?: string; cause?: { constraint_name?: string; constraint?: string } } | null;
  const name = e?.constraint_name ?? e?.constraint ?? e?.cause?.constraint_name ?? e?.cause?.constraint;
  return name === constraint;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const iso = (d: Date | string | null): string | null => (d == null ? null : new Date(d).toISOString());

/** Assembles DTOs with one revisions read and one holidays read for the whole page. */
async function toDtos(rows: CalendarRow[], forOrgId: string | null): Promise<BusinessCalendarDto[]> {
  const ids = rows.map((r) => r.id);
  const [revisions, holidays] = await Promise.all([repo.currentRevisions(ids), repo.holidaysFor(ids)]);
  return rows.map((row) => {
    const current = revisions.get(row.id) ?? null;
    return {
      id: row.id,
      name: row.name,
      ownerScope: row.orgId ? 'organization' : 'partner',
      orgId: row.orgId,
      partnerId: row.partnerId,
      isPartnerDefault: row.isPartnerDefault,
      archivedAt: iso(row.archivedAt),
      inherited: forOrgId !== null && row.orgId === null,
      currentRevision: current
        ? {
            id: current.revision.id,
            revision: current.revision.revision,
            timezone: current.revision.timezone,
            intervals: current.intervals.map((i) => ({ weekday: i.weekday, startMinute: i.startMinute, endMinute: i.endMinute })),
            createdAt: iso(current.revision.createdAt)!,
          }
        : null,
      holidays: holidays.filter((h) => h.calendarId === row.id).map((h) => ({ id: h.id, date: h.holidayDate, name: h.name })),
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    };
  });
}

async function toDto(row: CalendarRow): Promise<BusinessCalendarDto> {
  return (await toDtos([row], null))[0]!;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Calendars a caller may see. With `orgId`, the org's own calendars plus its
 * partner's partner-wide ones (`inherited: true`); without, a partner sees its
 * partner-wide calendars plus those of every org it can reach. Partner-wide
 * rows are filtered on the partner derived from the ORG ROW for org callers,
 * never on a token claim.
 */
export async function listCalendars(auth: CalendarAuth, opts: { orgId?: string; includeArchived?: boolean } = {}): Promise<BusinessCalendarDto[]> {
  const includeArchived = opts.includeArchived ?? false;
  let orgId: string | null = opts.orgId ?? null;
  if (auth.scope === 'organization') {
    if (orgId && orgId !== auth.orgId) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
    orgId = auth.orgId;
    if (!orgId) return [];
  } else if (orgId && auth.scope === 'partner' && !auth.canAccessOrg(orgId)) {
    throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  }

  if (orgId) {
    const org = await repo.findOrg(orgId);
    if (!org) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
    const rows = await repo.listCalendarRows({ orgIds: [orgId], partnerId: org.partnerId, includeArchived });
    return toDtos(rows, orgId);
  }

  if (auth.scope === 'partner') {
    const rows = await repo.listCalendarRows({ orgIds: auth.accessibleOrgIds ?? 'all', partnerId: auth.partnerId, includeArchived });
    return toDtos(rows, null);
  }
  // System scope without an org: RLS shows everything; list the partner-wide
  // calendars of the caller's partner when one is set, else every org's.
  const rows = await repo.listCalendarRows({ orgIds: 'all', partnerId: auth.partnerId, includeArchived });
  return toDtos(rows, null);
}

export async function getCalendar(auth: CalendarAuth, calendarId: string): Promise<BusinessCalendarDto> {
  const row = await repo.findCalendar(calendarId);
  if (!row) throw notFound();
  if (row.orgId) {
    if (auth.scope === 'organization' && row.orgId !== auth.orgId) throw notFound();
    if (auth.scope === 'partner' && !auth.canAccessOrg(row.orgId)) throw notFound();
  } else if (auth.scope !== 'system') {
    const ownerPartnerId = auth.scope === 'organization' && auth.orgId ? (await repo.findOrg(auth.orgId))?.partnerId : auth.partnerId;
    if (row.partnerId !== ownerPartnerId) throw notFound();
  }
  return toDto(row);
}

/**
 * What a ticket created in `orgId` right now would snapshot, plus the stored
 * override (spec §4.2 rule 4: blank = inherit, and the field shows the
 * inherited value and its source).
 */
export async function getResolvedCalendarForOrg(auth: CalendarAuth, orgId: string): Promise<ResolvedBusinessCalendarDto> {
  if (auth.scope === 'organization' && auth.orgId !== orgId) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  const org = await repo.findOrg(orgId);
  if (!org) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  const [resolved, overrideCalendarId] = await Promise.all([
    resolveBusinessCalendar(db, { partnerId: org.partnerId, orgId: org.id }),
    repo.readOrgOverride(org.id),
  ]);
  const calendarName = resolved.calendarId ? (await repo.findCalendar(resolved.calendarId))?.name ?? null : null;
  return { ...resolved, calendarName, overrideCalendarId };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createCalendar(auth: CalendarAuth, input: CreateBusinessCalendarInput): Promise<BusinessCalendarDto> {
  const owner = await resolveCreateOwner(auth, input);
  assertHours(input.timezone, input.intervals);
  let calendar: CalendarRow;
  try {
    calendar = await repo.insertCalendar({ ...owner, name: input.name.trim() });
  } catch (err) {
    if (isPgUniqueViolation(err, 'business_calendars_partner_name_uq')) {
      throw new BusinessCalendarError('A partner-wide calendar with this name already exists', 409, 'NAME_TAKEN');
    }
    throw err;
  }
  await insertHoursRevision(calendar, input.timezone, input.intervals, auth.user.id);
  for (const h of input.holidays ?? []) await repo.insertHoliday(calendar, h.date, h.name.trim());
  return toDto(calendar);
}

/**
 * Rename and/or new hours. Hours (time zone + intervals together) become
 * revision n+1 under the calendar row lock; open tickets keep theirs.
 */
export async function updateCalendar(auth: CalendarAuth, calendarId: string, input: UpdateBusinessCalendarInput): Promise<BusinessCalendarDto & { revisionCreated: boolean }> {
  let row = await loadForWrite(auth, calendarId);
  if (input.name !== undefined && input.name.trim() !== row.name) {
    try {
      row = (await repo.updateCalendarRow(row.id, { name: input.name.trim() })) ?? row;
    } catch (err) {
      if (isPgUniqueViolation(err, 'business_calendars_partner_name_uq')) {
        throw new BusinessCalendarError('A partner-wide calendar with this name already exists', 409, 'NAME_TAKEN');
      }
      throw err;
    }
  }
  let revisionCreated = false;
  if (input.timezone !== undefined && input.intervals !== undefined) {
    await insertHoursRevision(row, input.timezone, input.intervals, auth.user.id);
    row = (await repo.updateCalendarRow(row.id, {})) ?? row;
    revisionCreated = true;
  }
  return { ...(await toDto(row)), revisionCreated };
}

/** One default per partner (business_calendars_partner_default_uq); new tickets only. */
export async function setPartnerDefault(auth: CalendarAuth, calendarId: string): Promise<BusinessCalendarDto> {
  const row = await loadForWrite(auth, calendarId);
  if (row.orgId !== null || !row.partnerId) {
    throw new BusinessCalendarError('Only a partner-wide calendar can be the partner default', 409, 'NOT_PARTNER_WIDE');
  }
  if (row.archivedAt) throw new BusinessCalendarError('An archived calendar cannot be the partner default', 409, 'CALENDAR_ARCHIVED');
  await repo.clearPartnerDefaultRows(row.partnerId, row.id);
  try {
    const updated = (await repo.updateCalendarRow(row.id, { isPartnerDefault: true })) ?? row;
    return toDto(updated);
  } catch (err) {
    // Two set-default requests for different calendars of one partner: the
    // loser hits business_calendars_partner_default_uq.
    if (isPgUniqueViolation(err, 'business_calendars_partner_default_uq')) {
      throw new BusinessCalendarError('Another calendar was just made the default; reload and try again', 409, 'DEFAULT_CHANGED');
    }
    throw err;
  }
}

/** Back to 24×7 for every org that does not override. */
export async function clearPartnerDefault(auth: CalendarAuth): Promise<void> {
  assertWriter(auth);
  if (!auth.partnerId) throw new BusinessCalendarError('A partner context is required', 400, 'PARTNER_REQUIRED');
  if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
  await repo.clearPartnerDefaultRows(auth.partnerId);
}

export async function archiveCalendar(auth: CalendarAuth, calendarId: string, archived: boolean): Promise<BusinessCalendarDto> {
  const row = await loadForWrite(auth, calendarId);
  if (archived && row.isPartnerDefault) {
    throw new BusinessCalendarError('The partner default cannot be archived; choose another default first', 409, 'CALENDAR_IS_DEFAULT');
  }
  const updated = (await repo.updateCalendarRow(row.id, { archivedAt: archived ? (row.archivedAt ?? new Date()) : null })) ?? row;
  return toDto(updated);
}

/**
 * Hard delete, refused while any ticket snapshotted one of its revisions or an
 * org override selects it (the referencing FKs are ON DELETE SET NULL for
 * cascade ordering, so the guard lives here — spec §4.1). Archive instead.
 */
/** The owner of a calendar, for the route's audit row (org-owned events belong to the org). */
export type CalendarOwnerRef = { id: string; orgId: string | null; partnerId: string | null; name: string };
const ownerRef = (row: CalendarRow): CalendarOwnerRef => ({ id: row.id, orgId: row.orgId, partnerId: row.partnerId, name: row.name });

export async function deleteCalendar(auth: CalendarAuth, calendarId: string): Promise<CalendarOwnerRef> {
  const row = await loadForWrite(auth, calendarId);
  if (row.isPartnerDefault) {
    throw new BusinessCalendarError('The partner default cannot be deleted; choose another default first', 409, 'CALENDAR_IS_DEFAULT');
  }
  if (await repo.calendarReferencedByTickets(row.id)) {
    throw new BusinessCalendarError('Tickets use this calendar; archive it instead', 409, 'CALENDAR_IN_USE');
  }
  if (await repo.calendarSelectedByOrgs(row.id)) {
    throw new BusinessCalendarError('An organization uses this calendar as its override; clear it there first', 409, 'CALENDAR_IN_USE');
  }
  await repo.deleteCalendarRow(row.id);
  return ownerRef(row);
}

/** 'YYYY-MM-DD' of `now` in `timezone`. */
export function localDateIn(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Spec §4.5: a holiday strictly after today (in the calendar's current time
 * zone) moves the unfrozen deadlines of open tickets, so the recompute job is
 * queued after commit. Today or earlier is kept for the record only.
 */
async function queueRecomputeIfFuture(calendar: CalendarRow, date: string, reason: 'holiday_added' | 'holiday_removed', now: Date): Promise<boolean> {
  const current = (await repo.currentRevisions([calendar.id])).get(calendar.id);
  const timezone = current?.revision.timezone ?? 'UTC';
  if (date <= localDateIn(timezone, now)) return false;
  runAfterDbContextCommit('business-calendar-recompute', async () => {
    try {
      await enqueueBusinessCalendarRecompute({ calendarId: calendar.id, reason });
    } catch (err) {
      // The holiday is committed; only the deadline refresh is lost. Loud and
      // tagged so an operator can re-run it (re-saving the holiday re-queues).
      console.error(`[businessCalendars] holiday recompute NOT queued for calendar ${calendar.id}; open tickets keep their old deadlines`, err);
      captureException(err, undefined, { service: 'businessCalendars', calendarId: calendar.id, reason });
    }
  });
  return true;
}

export async function addHoliday(
  auth: CalendarAuth,
  calendarId: string,
  input: { date: string; name: string },
  now: Date = new Date(),
): Promise<{ holiday: { id: string; date: string; name: string }; recomputeQueued: boolean; calendar: CalendarOwnerRef }> {
  const calendar = await loadForWrite(auth, calendarId);
  let holiday: repo.HolidayRow;
  try {
    holiday = await repo.insertHoliday(calendar, input.date, input.name.trim());
  } catch (err) {
    if (isPgUniqueViolation(err, 'business_calendar_holidays_calendar_date_uq')) {
      throw new BusinessCalendarError('This calendar already has a holiday on that date', 409, 'HOLIDAY_EXISTS');
    }
    throw err;
  }
  const recomputeQueued = await queueRecomputeIfFuture(calendar, holiday.holidayDate, 'holiday_added', now);
  return { holiday: { id: holiday.id, date: holiday.holidayDate, name: holiday.name }, recomputeQueued, calendar: ownerRef(calendar) };
}

export async function removeHoliday(auth: CalendarAuth, calendarId: string, holidayId: string, now: Date = new Date()): Promise<{ recomputeQueued: boolean; calendar: CalendarOwnerRef }> {
  const calendar = await loadForWrite(auth, calendarId);
  const removed = await repo.deleteHoliday(calendar.id, holidayId);
  if (!removed) throw new BusinessCalendarError('Holiday not found', 404, 'NOT_FOUND');
  return { recomputeQueued: await queueRecomputeIfFuture(calendar, removed.holidayDate, 'holiday_removed', now), calendar: ownerRef(calendar) };
}

/**
 * The org override (spec §4.2): an org-owned calendar of this org or a
 * partner-wide calendar of its partner, not archived; null inherits. An
 * org-level setting, so canAccessOrg is the gate (not the partner-wide one).
 * New tickets only. org_ticket_settings_business_calendar_guard_trg backstops.
 */
export async function setOrgCalendarOverride(auth: CalendarAuth, orgId: string, calendarId: string | null): Promise<void> {
  assertWriter(auth);
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  const org = await repo.findOrg(orgId);
  if (!org) throw new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND');
  if (calendarId) {
    const cal = await repo.findCalendar(calendarId);
    const selectable = cal && !cal.archivedAt && (cal.orgId === org.id || (cal.orgId === null && cal.partnerId === org.partnerId));
    if (!selectable) {
      throw new BusinessCalendarError('That calendar cannot be selected for this organization', 400, 'CALENDAR_NOT_SELECTABLE');
    }
  }
  await repo.writeOrgOverride(org.id, calendarId);
}
