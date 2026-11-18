import { z } from 'zod';
import { validateRevision, type CalendarInterval } from '../utils/businessTime';
import { isValidIanaTimezone } from '../utils/timezone';

// Business-hours calendars (#8973 W4, spec §4.1). Shared by the API routes
// (zValidator) and the web Business hours card. Weekday 0 = Sunday … 6 =
// Saturday, minutes from local midnight, half-open [start, end) — the
// CalendarInterval shape of utils/businessTime.ts.

export const BUSINESS_CALENDAR_NAME_MAX = 100;
export const BUSINESS_CALENDAR_HOLIDAY_NAME_MAX = 100;
/** Generous bound: 7 days × a split shift every hour. */
export const BUSINESS_CALENDAR_MAX_INTERVALS = 168;
export const BUSINESS_CALENDAR_MAX_HOLIDAYS = 366;

export const businessCalendarIntervalSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
}).refine((v) => v.startMinute < v.endMinute, { message: 'An interval must end after it starts', path: ['endMinute'] });

const timezoneSchema = z.string().trim().min(1).max(64).refine(isValidIanaTimezone, 'Invalid IANA time zone');
const nameSchema = z.string().trim().min(1).max(BUSINESS_CALENDAR_NAME_MAX);

/** 'YYYY-MM-DD' that names a real calendar day. */
export const businessCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').refine((s) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}, 'Not a calendar date');

export const businessCalendarHolidaySchema = z.object({
  date: businessCalendarDateSchema,
  name: z.string().trim().min(1).max(BUSINESS_CALENDAR_HOLIDAY_NAME_MAX),
});
export type BusinessCalendarHolidayInput = z.infer<typeof businessCalendarHolidaySchema>;

const intervalsSchema = z.array(businessCalendarIntervalSchema).max(BUSINESS_CALENDAR_MAX_INTERVALS);

/** Overlap / emptiness check on a whole week, via the calculator's own validator. */
function hoursProblem(timezone: string, intervals: ReadonlyArray<{ weekday: number; startMinute: number; endMinute: number }>): string | null {
  const result = validateRevision({ timezone, intervals: intervals as readonly CalendarInterval[] });
  if (result.ok) return null;
  switch (result.code) {
    case 'NO_INTERVALS': return 'At least one open interval per week is required';
    case 'OVERLAP': return 'Intervals on the same weekday must not overlap';
    case 'BAD_TIMEZONE': return 'Invalid IANA time zone';
    default: return 'An interval is out of range';
  }
}

const baseCalendarSchema = z.object({
  ownerScope: z.enum(['organization', 'partner']),
  orgId: z.string().guid().optional(),
  name: nameSchema,
  timezone: timezoneSchema,
  intervals: intervalsSchema,
  holidays: z.array(businessCalendarHolidaySchema).max(BUSINESS_CALENDAR_MAX_HOLIDAYS).optional(),
});

export const createBusinessCalendarSchema = baseCalendarSchema.superRefine((v, ctx) => {
  if (v.ownerScope === 'partner' && v.orgId) {
    ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'orgId cannot be combined with ownerScope "partner"' });
  }
  if (v.ownerScope === 'organization' && !v.orgId) {
    ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'orgId is required for an organization calendar' });
  }
  const problem = hoursProblem(v.timezone, v.intervals);
  if (problem) ctx.addIssue({ code: 'custom', path: ['intervals'], message: problem });
  if (v.holidays && new Set(v.holidays.map((h) => h.date)).size !== v.holidays.length) {
    ctx.addIssue({ code: 'custom', path: ['holidays'], message: 'Holiday dates must be unique' });
  }
});
export type CreateBusinessCalendarInput = z.infer<typeof createBusinessCalendarSchema>;

/**
 * Partner-Wide First: an update can never change the owner, so both owner
 * fields are omitted (zod strips them). Hours are a revision — the time zone
 * and the intervals change together, as one new revision. Holidays have their
 * own endpoints.
 */
export const updateBusinessCalendarSchema = baseCalendarSchema
  .partial()
  .omit({ ownerScope: true, orgId: true, holidays: true })
  .superRefine((v, ctx) => {
    if (Object.keys(v).length === 0) {
      ctx.addIssue({ code: 'custom', path: [], message: 'At least one field is required' });
      return;
    }
    if ((v.timezone === undefined) !== (v.intervals === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['intervals'], message: 'An hours change sends both timezone and intervals' });
      return;
    }
    if (v.timezone !== undefined && v.intervals !== undefined) {
      const problem = hoursProblem(v.timezone, v.intervals);
      if (problem) ctx.addIssue({ code: 'custom', path: ['intervals'], message: problem });
    }
  });
export type UpdateBusinessCalendarInput = z.infer<typeof updateBusinessCalendarSchema>;

/** Org override (spec §4.2): a calendar id, or null to inherit the partner default. */
export const orgBusinessCalendarOverrideSchema = z.object({
  calendarId: z.string().guid().nullable(),
});
export type OrgBusinessCalendarOverrideInput = z.infer<typeof orgBusinessCalendarOverrideSchema>;

/** D12: apply the current revision to open, never-paused tickets on older ones. */
export const applyBusinessCalendarRevisionSchema = z.object({
  expectedRevisionId: z.string().guid(),
});
export type ApplyBusinessCalendarRevisionInput = z.infer<typeof applyBusinessCalendarRevisionSchema>;

export const listBusinessCalendarsQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

// ---- DTOs -----------------------------------------------------------------

export type BusinessCalendarIntervalDto = { weekday: number; startMinute: number; endMinute: number };
export type BusinessCalendarHolidayDto = { id: string; date: string; name: string };

export type BusinessCalendarDto = {
  id: string;
  name: string;
  ownerScope: 'organization' | 'partner';
  orgId: string | null;
  partnerId: string | null;
  isPartnerDefault: boolean;
  archivedAt: string | null;
  /** True when listed for an org and owned by its partner (spec §4.2 "inherited"). */
  inherited: boolean;
  currentRevision: {
    id: string;
    revision: number;
    timezone: string;
    intervals: BusinessCalendarIntervalDto[];
    createdAt: string;
  } | null;
  holidays: BusinessCalendarHolidayDto[];
  createdAt: string;
  updatedAt: string;
};

/** What a ticket created in `orgId` right now would snapshot (resolveBusinessCalendar). */
export type ResolvedBusinessCalendarDto = {
  source: 'org' | 'partner' | 'none';
  calendarId: string | null;
  revisionId: string | null;
  calendarName: string | null;
  /** The org override as stored (may name an archived calendar that no longer applies). */
  overrideCalendarId: string | null;
};

export type BusinessCalendarApplyPreviewDto = {
  revisionId: string;
  eligibleCount: number;
  immediatelyBreachedCount: number;
  skippedPausedCount: number;
};
