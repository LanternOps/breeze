import { z } from 'zod';
import { periodSchema } from '@breeze/shared';

/**
 * Per-report-type config schemas (#3198 spec §6). Moved here from
 * `routes/reports/schemas.ts` so the service layer — the generators and the
 * `REPORT_GENERATORS` registry — never imports the route layer, and so the
 * registry's import graph stays zod-only (no `db`). `routes/reports/schemas.ts`
 * re-exports the six per-type names for compatibility.
 *
 * Every per-type schema is `legacyReportConfigSchema.extend({...own keys})`:
 * the shared builder keys (`schedule`, `emailRecipients`, `dateRange`, …) keep
 * validating on every type, and the object stays LOOSE because the builder
 * round-trips undeclared presentation metadata through `config`.
 */

/**
 * Cadence detail + delivery config persisted inside `config`. The builder
 * writes these and reportScheduleWorker reads them; they must be declared here
 * because zod strips unknown object keys — before this schema existed, creates
 * silently dropped schedule times and email recipients (edits survived only
 * because update used z.any()).
 */
export const reportScheduleDetailSchema = z.object({
  // 24h "HH:MM"
  time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
  // weekday name; the worker lowercases, so accept any case
  day: z.string().max(16).optional(),
  // day-of-month "1".."31" as string (builder sends strings). z.coerce
  // tolerates legacy rows written while update used z.any() — some were
  // persisted with a numeric `date` — so editing them doesn't 400.
  date: z.coerce.string().regex(/^([1-9]|[12]\d|3[01])$/).optional()
});

/** The pre-#3198 shared keys. Every type that has no per-type schema of its own
 *  (the six original builder-driven types) uses this. Loose, because the builder
 *  round-trips undeclared presentation metadata through `config`. */
export const legacyReportConfigSchema = z.looseObject({
  dateRange: z.object({
    start: z.string().optional(),
    end: z.string().optional(),
    preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional()
  }).optional(),
  filters: z.object({
    siteIds: z.array(z.string().guid()).optional(),
    deviceIds: z.array(z.string().guid()).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    status: z.array(z.string()).optional(),
    severity: z.array(z.string()).optional()
  }).optional(),
  columns: z.array(z.string()).optional(),
  groupBy: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  schedule: reportScheduleDetailSchema.optional(),
  // Deliberately the SAME loose regex as ReportBuilder's chip-validation
  // (apps/web/src/components/reports/ReportBuilder.tsx) and the worker's
  // recipientsOf (apps/api/src/jobs/reportScheduleWorker.ts) — z.string().email()
  // is stricter than both, so persistence must never reject what the builder
  // already accepted as a chip.
  emailRecipients: z.array(z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).max(254)).max(50).optional(),
});

/** ai_org_narrative / ai_fleet_design: system-written configs nobody validates
 *  on the way in, because nobody submits one. Loose and empty. */
export const storedArtifactConfigSchema = z.looseObject({});

/** Config for the Security & Compliance Posture report. Thresholds drive the
 * pass/fail percentages; all optional with insurance-sensible defaults. */
export const securityCompliancePostureConfigSchema = legacyReportConfigSchema.extend({
  sites: z.array(z.string().guid()).optional().default([]),
  // window for elevation activity + (future) trend; days back from now.
  windowDays: z.number().int().min(1).max(365).optional().default(30),
  // password-complexity floor: a device passes if minLength >= this AND lockout is set.
  minPasswordLength: z.number().int().min(1).max(64).optional().default(8),
  // local-admin exposure: a device is flagged if it has MORE than this many local admins.
  maxLocalAdmins: z.number().int().min(0).max(50).optional().default(2),
  // AV definitions older than this many days count as stale.
  maxAvDefinitionsAgeDays: z.number().int().min(1).max(365).optional().default(7),
  // A device's security_status row (firewall/encryption) older than this many
  // days is treated as "unknown", not scored as a current pass or fail — an
  // offline device's stale last-known posture shouldn't count either way.
  maxSecurityStatusAgeDays: z.number().int().min(1).max(365).optional().default(30),
  // Include the CIS hardening section. Defaults on; renders "Not yet assessed"
  // until baseline scans exist, or is omitted entirely when set false.
  includeCis: z.boolean().optional().default(true),
  backupRequired: z.boolean().optional().default(true)
});

/**
 * Config for the Hardware Lifecycle report. `replaceAgeYears` is the planning
 * horizon after purchase (the warranty end wins when active coverage runs
 * longer); the two include flags decide whether hand-entered assets and
 * non-computer hardware appear at all.
 */
export const hardwareLifecycleConfigSchema = legacyReportConfigSchema.extend({
  sites: z.array(z.string().guid()).optional().default([]),
  replaceAgeYears: z.number().int().min(1).max(15).optional().default(4),
  serverReplaceAgeYears: z.number().int().min(1).max(15).optional().default(5),
  includeManualAssets: z.boolean().optional().default(true),
  includeOtherEquipment: z.boolean().optional().default(true),
});

/**
 * Config for the Threat Detection Review report (#5784 W02). `topIncidents`
 * caps the incident table so one noisy month cannot produce a 400-page PDF; the
 * artifact states the cap and the number withheld rather than truncating
 * silently. `includeCarriedIn` controls the "opened before the period and still
 * unresolved" section.
 */
export const threatDetectionConfigSchema = legacyReportConfigSchema.extend({
  sites: z.array(z.string().guid()).optional().default([]),
  includeCarriedIn: z.boolean().optional().default(true),
  topIncidents: z.number().int().min(1).max(1000).optional().default(100),
});

/**
 * Config for the Endpoint Management Review report (#5784 W03).
 * `staleEnrolmentDays` is judged against the 6 h Intune sync cadence, NOT
 * against the reporting period: a 29-day-old enrolment inside a monthly period
 * is stale. `trendDays` reads m365_posture_rollups, the only genuine time series
 * available — entity rows cannot supply history (see endpointManagementReport.ts).
 */
export const endpointManagementConfigSchema = legacyReportConfigSchema.extend({
  sites: z.array(z.string().guid()).optional().default([]),
  staleEnrolmentDays: z.number().int().min(1).max(180).optional().default(14),
  trendDays: z.number().int().min(1).max(365).optional().default(30),
  includeLicences: z.boolean().optional().default(true),
});

/**
 * Config for the Vulnerability Management report (#5784 W04, spec §3.4).
 * `severityFloor` filters the findings sections but NEVER the KEV / high-EPSS
 * callouts: an actively exploited medium is a different argument from a
 * theoretical critical, and hiding it behind a severity floor is how it gets
 * missed. `topN` caps the remediable table; the artifact discloses the number
 * withheld rather than truncating silently.
 */
export const vulnerabilityManagementConfigSchema = legacyReportConfigSchema.extend({
  sites: z.array(z.string().guid()).optional().default([]),
  severityFloor: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
  topN: z.number().int().min(1).max(500).optional().default(25),
  includeAccepted: z.boolean().optional().default(true),
});

/**
 * Config for the Identity & Access Review report (#5784 W06, spec §3.5.3).
 * NO `sites` key on purpose: M365 identity data has no site dimension, and a
 * site selector would promise a filter the data cannot deliver. A restricted
 * authority gets the zero-safe shape instead (OD-8 = A).
 * `homeCountries` are ISO-3166 alpha-2 codes; sign-ins from outside the set are
 * called out. An empty set means the section renders as "not configured", NOT as
 * "no foreign sign-ins".
 */
export const identityAccessConfigSchema = legacyReportConfigSchema.extend({
  dormantDays: z.number().int().min(1).max(365).optional().default(45),
  homeCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).optional().default([]),
  adminDetail: z.boolean().optional().default(true),
});

/** Does a stored selector value actually select something? An empty array or
 *  an object whose every value selects nothing (`filters: {}`,
 *  `filters: { siteIds: [] }`) does not; any other present value does. */
function selectsSomething(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(selectsSomething);
  return true;
}

/**
 * #3198 W02 fix round (item 6). A business type selects by its own `period`
 * and its owner scope (ruling T3e) — never by the legacy builder selectors.
 * Declared (overriding the legacy shape) so a selector that selects something
 * is a 400 naming the key on create, PUT and ad-hoc generate, on both
 * ownership arms, instead of being stored and silently ignored by the
 * generator. Overriding keys via `.extend` keeps the schema a plain object:
 * `.shape` and further `.extend` keep working (no object-level refinement).
 */
function refusedBusinessSelector(key: string) {
  return z.unknown().superRefine((value, ctx) => {
    if (selectsSomething(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `${key} is not supported for business reports; they select by period and owner scope`,
      });
    }
  }).optional();
}

const BUSINESS_SELECTOR_REFUSALS = {
  dateRange: refusedBusinessSelector('dateRange'),
  filters: refusedBusinessSelector('filters'),
  sites: refusedBusinessSelector('sites'),
  orgId: refusedBusinessSelector('orgId'),
  orgIds: refusedBusinessSelector('orgIds'),
  siteIds: refusedBusinessSelector('siteIds'),
  deviceIds: refusedBusinessSelector('deviceIds'),
};

/**
 * #3198 W02 R1 — Ticket SLA attainment (spec §3.3 R1).
 *
 * - `groupBy` has NO `.default()`: the default depends on the scope
 *   (`organization` at partner scope, `priority` at org scope) and is applied
 *   in the generator. It narrows the legacy free-text `groupBy`.
 * - `includeNoSla` (default true, applied in the generator) filters DETAIL rows
 *   only; it never moves an aggregate.
 * - Declares no org/site/device selector keys (ruling T3e): at partner scope
 *   the org set comes from the live org list, never from config.
 */
export const ticketSlaConfigSchema = legacyReportConfigSchema.extend({
  ...BUSINESS_SELECTOR_REFUSALS,
  period: periodSchema.optional(),
  groupBy: z.enum(['organization', 'priority', 'technician', 'category']).optional(),
  includeNoSla: z.boolean().optional(),
});
export type TicketSlaConfig = z.infer<typeof ticketSlaConfigSchema>;

/**
 * #3198 W02 R2 — Technician time & billability (spec §3.3 R2).
 *
 * - `groupBy` (default `technician`, applied in the generator) narrows the
 *   legacy free-text `groupBy`.
 * - `weeklyCapacityHours` (default 40, applied in the generator) is the
 *   uniform per-technician capacity, prorated over working days. No per-tech
 *   capacity table exists in Phase 1 (Open Decision 3).
 * - No `.default()` anywhere (parseStoredReportConfig filters defaults
 *   top-level only) and no org/site/device selector keys (ruling T3e).
 */
export const technicianTimeConfigSchema = legacyReportConfigSchema.extend({
  ...BUSINESS_SELECTOR_REFUSALS,
  period: periodSchema.optional(),
  groupBy: z.enum(['technician', 'organization', 'work_type']).optional(),
  weeklyCapacityHours: z.number().min(1).max(80).optional(),
});
export type TechnicianTimeConfig = z.infer<typeof technicianTimeConfigSchema>;

/**
 * #3198 W02 R3 — AR aging (spec §3.3 R3).
 *
 * - `asOf` is a calendar DATE (`YYYY-MM-DD`), not a timestamp: `invoices.
 *   due_date` is a PG `date`, so days overdue is `date - date` with no timezone
 *   left in it. Absent = "today" in the report owner's resolved timezone,
 *   applied in the generator.
 * - `groupBy` (default `organization`, applied in the generator) narrows the
 *   legacy free-text `groupBy`.
 * - `includePaidInPeriod` (default false) adds an informational "invoices
 *   fully paid month-to-date" note; it never moves a bucket.
 * - No `.default()` anywhere (parseStoredReportConfig filters defaults
 *   top-level only) and no org/site/device selector keys (ruling T3e).
 */
export const arAgingConfigSchema = legacyReportConfigSchema.extend({
  ...BUSINESS_SELECTOR_REFUSALS,
  asOf: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be a YYYY-MM-DD date')
    .refine((value) => {
      const [y, m, d] = value.split('-').map(Number) as [number, number, number];
      const date = new Date(Date.UTC(y, m - 1, d));
      return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
    }, 'asOf must be a real calendar date')
    .optional(),
  groupBy: z.enum(['organization', 'currency']).optional(),
  includePaidInPeriod: z.boolean().optional(),
});
export type ArAgingConfig = z.infer<typeof arAgingConfigSchema>;
