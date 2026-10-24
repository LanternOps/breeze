import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  findCalendar: vi.fn(),
  findOrg: vi.fn(),
  listCalendarRows: vi.fn(),
  currentRevisions: vi.fn(),
  holidaysFor: vi.fn(),
  insertCalendar: vi.fn(),
  insertRevision: vi.fn(),
  updateCalendarRow: vi.fn(),
  clearPartnerDefaultRows: vi.fn(),
  deleteCalendarRow: vi.fn(),
  calendarReferencedByTickets: vi.fn(),
  calendarSelectedByOrgs: vi.fn(),
  insertHoliday: vi.fn(),
  deleteHoliday: vi.fn(),
  readOrgOverride: vi.fn(),
  writeOrgOverride: vi.fn(),
}));
const { runAfterCommit, enqueue } = vi.hoisted(() => ({ runAfterCommit: vi.fn(), enqueue: vi.fn() }));

vi.mock('./repository', () => repo);
vi.mock('../../db', () => ({ runAfterDbContextCommit: runAfterCommit }));
vi.mock('../../jobs/businessCalendarRecomputeWorker', () => ({ enqueueBusinessCalendarRecompute: enqueue }));

import {
  BusinessCalendarError,
  addHoliday,
  archiveCalendar,
  clearPartnerDefault,
  createCalendar,
  deleteCalendar,
  listCalendars,
  localDateIn,
  removeHoliday,
  setOrgCalendarOverride,
  setPartnerDefault,
  updateCalendar,
  type CalendarAuth,
} from './service';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';

const P = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const ORG = '00000000-0000-4000-8000-0000000000b1';
const ORG2 = '00000000-0000-4000-8000-0000000000b2';
const CAL = '00000000-0000-4000-8000-0000000000c1';

function auth(over: Partial<CalendarAuth> = {}): CalendarAuth {
  return {
    scope: 'partner', partnerId: P, orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: null,
    canAccessOrg: () => true, user: { id: 'u-1' }, ...over,
  } as CalendarAuth;
}
const selected = auth({ partnerOrgAccess: 'selected', accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG });
const orgToken = auth({ scope: 'organization', orgId: ORG, partnerOrgAccess: null, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG });

const now = new Date('2030-06-10T12:00:00Z');
const wide = { id: CAL, orgId: null, partnerId: P, name: 'Support', isPartnerDefault: false, archivedAt: null, createdAt: now, updatedAt: now };
const own = { ...wide, orgId: ORG, partnerId: null };
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));

beforeEach(() => {
  vi.clearAllMocks();
  repo.currentRevisions.mockResolvedValue(new Map([[CAL, {
    revision: { id: 'r-1', calendarId: CAL, revision: 1, timezone: 'America/New_York', createdAt: now },
    intervals: weekdays.map((i, n) => ({ id: `i-${n}`, revisionId: 'r-1', ...i })),
  }]]));
  repo.holidaysFor.mockResolvedValue([]);
  repo.updateCalendarRow.mockImplementation(async (_id: string, patch: object) => ({ ...wide, ...patch }));
  repo.findOrg.mockImplementation(async (id: string) => (id === ORG || id === ORG2 ? { id, partnerId: id === ORG ? P : P2 } : null));
});

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(BusinessCalendarError);
  expect(err).toMatchObject({ status, code });
}

describe('partner-wide writes are gated in the service (canManagePartnerWidePolicies)', () => {
  it('a selected-access partner user cannot create, edit, default, archive, delete or add holidays on a partner-wide calendar', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    await denied(createCalendar(selected, { ownerScope: 'partner', name: 'X', timezone: 'UTC', intervals: weekdays }));
    await denied(updateCalendar(selected, CAL, { name: 'Y' }));
    await denied(setPartnerDefault(selected, CAL));
    await denied(clearPartnerDefault(selected));
    await denied(archiveCalendar(selected, CAL, true));
    await denied(deleteCalendar(selected, CAL));
    await denied(addHoliday(selected, CAL, { date: '2030-12-25', name: 'X' }, now));
    await denied(removeHoliday(selected, CAL, 'h-1', now));
    expect(repo.insertCalendar).not.toHaveBeenCalled();
    expect(repo.updateCalendarRow).not.toHaveBeenCalled();
    expect(repo.clearPartnerDefaultRows).not.toHaveBeenCalled();
    expect(repo.deleteCalendarRow).not.toHaveBeenCalled();
    expect(repo.insertHoliday).not.toHaveBeenCalled();
    expect(repo.deleteHoliday).not.toHaveBeenCalled();
  });

  it('a selected-access user may still manage an org-owned calendar of an org they can reach', async () => {
    repo.findCalendar.mockResolvedValue(own);
    await updateCalendar(selected, CAL, { name: 'Renamed' });
    expect(repo.updateCalendarRow).toHaveBeenCalledWith(CAL, { name: 'Renamed' });
  });

  it("another partner's partner-wide calendar reads as missing", async () => {
    repo.findCalendar.mockResolvedValue({ ...wide, partnerId: P2 });
    await expectError(updateCalendar(auth(), CAL, { name: 'Y' }), 404, 'NOT_FOUND');
  });
});

describe('org-scope tokens write nothing', () => {
  it('refuses every write with 403 before touching a row', async () => {
    repo.findCalendar.mockResolvedValue(own);
    await expectError(createCalendar(orgToken, { ownerScope: 'organization', orgId: ORG, name: 'X', timezone: 'UTC', intervals: weekdays }), 403, 'ACCESS_DENIED');
    await expectError(updateCalendar(orgToken, CAL, { name: 'Y' }), 403, 'ACCESS_DENIED');
    await expectError(addHoliday(orgToken, CAL, { date: '2030-12-25', name: 'X' }, now), 403, 'ACCESS_DENIED');
    await expectError(setOrgCalendarOverride(orgToken, ORG, null), 403, 'ACCESS_DENIED');
    expect(repo.findCalendar).not.toHaveBeenCalled();
    expect(repo.writeOrgOverride).not.toHaveBeenCalled();
  });
});

describe('createCalendar', () => {
  it('creates a partner-wide calendar with revision 1 and its holidays', async () => {
    repo.insertCalendar.mockResolvedValue(wide);
    await createCalendar(auth(), { ownerScope: 'partner', name: ' Support ', timezone: 'America/New_York', intervals: weekdays, holidays: [{ date: '2030-12-25', name: 'Xmas' }] });
    expect(repo.insertCalendar).toHaveBeenCalledWith({ orgId: null, partnerId: P, name: 'Support' });
    expect(repo.insertRevision).toHaveBeenCalledWith(wide, 'America/New_York', weekdays, 'u-1');
    expect(repo.insertHoliday).toHaveBeenCalledWith(wide, '2030-12-25', 'Xmas');
  });

  it('creates an org-owned calendar owned by the org alone (XOR)', async () => {
    repo.insertCalendar.mockResolvedValue(own);
    await createCalendar(selected, { ownerScope: 'organization', orgId: ORG, name: 'Org hours', timezone: 'UTC', intervals: weekdays });
    expect(repo.insertCalendar).toHaveBeenCalledWith({ orgId: ORG, partnerId: null, name: 'Org hours' });
  });

  it('refuses an org the caller cannot reach', async () => {
    await expectError(createCalendar(selected, { ownerScope: 'organization', orgId: ORG2, name: 'X', timezone: 'UTC', intervals: weekdays }), 404, 'NOT_FOUND');
  });

  it('maps validateRevision failures to 400 codes', async () => {
    await expectError(createCalendar(auth(), { ownerScope: 'partner', name: 'X', timezone: 'Mars/Phobos', intervals: weekdays }), 400, 'BAD_TIMEZONE');
    await expectError(createCalendar(auth(), { ownerScope: 'partner', name: 'X', timezone: 'UTC', intervals: [] }), 400, 'NO_INTERVALS');
    await expectError(createCalendar(auth(), { ownerScope: 'partner', name: 'X', timezone: 'UTC', intervals: [
      { weekday: 1, startMinute: 0, endMinute: 600 }, { weekday: 1, startMinute: 500, endMinute: 700 },
    ] }), 400, 'OVERLAP');
    expect(repo.insertCalendar).not.toHaveBeenCalled();
  });

  it('stores the canonical IANA spelling of a time zone (the DB check is exact)', async () => {
    repo.insertCalendar.mockResolvedValue(wide);
    await createCalendar(auth(), { ownerScope: 'partner', name: 'X', timezone: 'europe/london', intervals: weekdays });
    expect(repo.insertRevision).toHaveBeenCalledWith(wide, 'Europe/London', weekdays, 'u-1');
  });

  it('a time zone the database rejects is 400 BAD_TIMEZONE, not a 500', async () => {
    repo.insertCalendar.mockResolvedValue(wide);
    repo.insertRevision.mockRejectedValueOnce(Object.assign(new Error('tz'), { code: '23514', constraint_name: 'business_calendar_revisions_timezone_chk' }));
    await expectError(createCalendar(auth(), { ownerScope: 'partner', name: 'X', timezone: 'UTC', intervals: weekdays }), 400, 'BAD_TIMEZONE');
  });

  it('a duplicate partner-wide name is 409 NAME_TAKEN', async () => {
    repo.insertCalendar.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'business_calendars_partner_name_uq' }));
    await expectError(createCalendar(auth(), { ownerScope: 'partner', name: 'X', timezone: 'UTC', intervals: weekdays }), 409, 'NAME_TAKEN');
  });
});

describe('updateCalendar', () => {
  it('an hours edit writes a NEW revision and never touches the old one', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    const res = await updateCalendar(auth(), CAL, { timezone: 'Europe/London', intervals: weekdays });
    expect(repo.findCalendar).toHaveBeenCalledWith(CAL, { forUpdate: true });
    expect(repo.insertRevision).toHaveBeenCalledWith(wide, 'Europe/London', weekdays, 'u-1');
    expect(res.revisionCreated).toBe(true);
  });

  it('a rename alone writes no revision', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    const res = await updateCalendar(auth(), CAL, { name: 'New name' });
    expect(repo.insertRevision).not.toHaveBeenCalled();
    expect(res.revisionCreated).toBe(false);
  });
});

describe('defaults, archive and delete', () => {
  it('set-default clears the previous default first, then marks this one', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    await setPartnerDefault(auth(), CAL);
    expect(repo.clearPartnerDefaultRows).toHaveBeenCalledWith(P, CAL);
    expect(repo.updateCalendarRow).toHaveBeenCalledWith(CAL, { isPartnerDefault: true });
    expect(repo.clearPartnerDefaultRows.mock.invocationCallOrder[0]).toBeLessThan(repo.updateCalendarRow.mock.invocationCallOrder[0]!);
  });

  it('a concurrent set-default that loses the unique race is 409 DEFAULT_CHANGED', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    repo.updateCalendarRow.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'business_calendars_partner_default_uq' }));
    await expectError(setPartnerDefault(auth(), CAL), 409, 'DEFAULT_CHANGED');
  });

  it('an org-owned or archived calendar cannot become the default', async () => {
    repo.findCalendar.mockResolvedValue(own);
    await expectError(setPartnerDefault(auth(), CAL), 409, 'NOT_PARTNER_WIDE');
    repo.findCalendar.mockResolvedValue({ ...wide, archivedAt: now });
    await expectError(setPartnerDefault(auth(), CAL), 409, 'CALENDAR_ARCHIVED');
  });

  it('the partner default cannot be archived or deleted', async () => {
    repo.findCalendar.mockResolvedValue({ ...wide, isPartnerDefault: true });
    await expectError(archiveCalendar(auth(), CAL, true), 409, 'CALENDAR_IS_DEFAULT');
    await expectError(deleteCalendar(auth(), CAL), 409, 'CALENDAR_IS_DEFAULT');
  });

  it('delete is refused while a ticket references one of its revisions (spec §12)', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    repo.calendarReferencedByTickets.mockResolvedValue(true);
    await expectError(deleteCalendar(auth(), CAL), 409, 'CALENDAR_IN_USE');
    expect(repo.deleteCalendarRow).not.toHaveBeenCalled();
  });

  it('delete is refused while an org override selects it', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    repo.calendarReferencedByTickets.mockResolvedValue(false);
    repo.calendarSelectedByOrgs.mockResolvedValue(true);
    await expectError(deleteCalendar(auth(), CAL), 409, 'CALENDAR_IN_USE');
  });

  it('an unused calendar is deleted', async () => {
    repo.findCalendar.mockResolvedValue(wide);
    repo.calendarReferencedByTickets.mockResolvedValue(false);
    repo.calendarSelectedByOrgs.mockResolvedValue(false);
    await deleteCalendar(auth(), CAL);
    expect(repo.deleteCalendarRow).toHaveBeenCalledWith(CAL);
  });
});

describe('holidays and the recompute job (spec §4.5)', () => {
  beforeEach(() => {
    repo.findCalendar.mockResolvedValue(wide);
    repo.insertHoliday.mockImplementation(async (_c: unknown, date: string, name: string) => ({ id: 'h-1', holidayDate: date, name }));
    repo.deleteHoliday.mockImplementation(async () => ({ id: 'h-1', holidayDate: '2030-06-10', name: 'x' }));
  });

  it('a holiday dated today or earlier (calendar time zone) queues nothing', async () => {
    // 2030-06-10T12:00Z is 08:00 on 2030-06-10 in New York.
    expect((await addHoliday(auth(), CAL, { date: '2030-06-10', name: 'Today' }, now)).recomputeQueued).toBe(false);
    expect((await addHoliday(auth(), CAL, { date: '2030-01-01', name: 'Past' }, now)).recomputeQueued).toBe(false);
    expect((await removeHoliday(auth(), CAL, 'h-1', now)).recomputeQueued).toBe(false);
    expect(runAfterCommit).not.toHaveBeenCalled();
  });

  it('a future holiday queues the recompute job after commit', async () => {
    const res = await addHoliday(auth(), CAL, { date: '2030-06-11', name: 'Tomorrow' }, now);
    expect(res).toEqual({
      holiday: { id: 'h-1', date: '2030-06-11', name: 'Tomorrow' }, recomputeQueued: true,
      calendar: { id: CAL, orgId: null, partnerId: P, name: 'Support' },
    });
    expect(runAfterCommit).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    await runAfterCommit.mock.calls[0]![1]();
    expect(enqueue).toHaveBeenCalledWith({ calendarId: CAL, reason: 'holiday_added' });
  });

  it("'today' follows the calendar's time zone, not UTC", () => {
    const lateUtc = new Date('2030-06-11T02:00:00Z');
    expect(localDateIn('UTC', lateUtc)).toBe('2030-06-11');
    expect(localDateIn('America/New_York', lateUtc)).toBe('2030-06-10');
  });

  it('a duplicate date is 409 HOLIDAY_EXISTS', async () => {
    repo.insertHoliday.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'business_calendar_holidays_calendar_date_uq' }));
    await expectError(addHoliday(auth(), CAL, { date: '2030-12-25', name: 'X' }, now), 409, 'HOLIDAY_EXISTS');
  });
});

describe('setOrgCalendarOverride', () => {
  it("accepts the org's own calendar and its partner's partner-wide calendar, and null", async () => {
    repo.findCalendar.mockResolvedValueOnce(own).mockResolvedValueOnce(wide);
    await setOrgCalendarOverride(selected, ORG, CAL);
    await setOrgCalendarOverride(selected, ORG, CAL);
    await setOrgCalendarOverride(selected, ORG, null);
    expect(repo.writeOrgOverride.mock.calls).toEqual([[ORG, CAL], [ORG, CAL], [ORG, null]]);
  });

  it("refuses another org's or another partner's calendar, and an archived one", async () => {
    for (const cal of [{ ...own, orgId: ORG2 }, { ...wide, partnerId: P2 }, { ...wide, archivedAt: now }, null]) {
      repo.findCalendar.mockResolvedValueOnce(cal);
      await expectError(setOrgCalendarOverride(auth(), ORG, CAL), 400, 'CALENDAR_NOT_SELECTABLE');
    }
    expect(repo.writeOrgOverride).not.toHaveBeenCalled();
  });

  it('refuses an org the caller cannot reach', async () => {
    await expectError(setOrgCalendarOverride(selected, ORG2, null), 404, 'NOT_FOUND');
  });
});

describe('listCalendars', () => {
  it("an org token lists its org's calendars plus its partner's partner-wide ones, filtered on the ORG ROW's partner", async () => {
    repo.listCalendarRows.mockResolvedValue([wide]);
    const out = await listCalendars({ ...orgToken, partnerId: P2 } as CalendarAuth);
    expect(repo.listCalendarRows).toHaveBeenCalledWith({ orgIds: [ORG], partnerId: P, includeArchived: false });
    expect(out[0]).toMatchObject({ id: CAL, ownerScope: 'partner', inherited: true, currentRevision: { id: 'r-1', revision: 1, timezone: 'America/New_York' } });
  });

  it('an org token cannot list another org', async () => {
    await expectError(listCalendars(orgToken, { orgId: ORG2 }), 404, 'NOT_FOUND');
  });

  it('a selected-access partner lists partner-wide + the orgs it reaches; DTOs use one revisions and one holidays read', async () => {
    repo.listCalendarRows.mockResolvedValue([wide, { ...own, id: 'c-2' }]);
    await listCalendars(selected);
    expect(repo.listCalendarRows).toHaveBeenCalledWith({ orgIds: [ORG], partnerId: P, includeArchived: false });
    expect(repo.currentRevisions).toHaveBeenCalledTimes(1);
    expect(repo.holidaysFor).toHaveBeenCalledTimes(1);
  });
});
