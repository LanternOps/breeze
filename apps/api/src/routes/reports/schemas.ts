import { z } from 'zod';
import { REPORT_TYPES } from '@breeze/shared';

/**
 * Every value of the `report_type` pgEnum, INCLUDING the internal ones. Reads
 * need the full union: `GET /reports?type=ai_org_narrative` is a legitimate
 * filter, and `GET /reports/:id` returns the stored row's type verbatim.
 *
 * Derived from the canonical tuple (#3198 spec §6, `@breeze/shared`) rather
 * than hand-listed — the three-way TS/zod/web duplication is collapsed to one
 * source; see `packages/shared/src/reportTypes.ts` for the per-type notes.
 * The two WRITE schemas below still narrow it — see `internalReportType`.
 */
export const reportTypeSchema = z.enum(REPORT_TYPES);

/** #3198 W01: types that may be owned by a partner. W02 replaces this set with
 *  REPORT_GENERATORS[type].supportedScopes; until then these three exist as
 *  enum labels only, so a partner-owned definition of them can be created and
 *  scheduled but every generate answers unsupported_report_scope. */
export const PARTNER_SCOPE_REPORT_TYPES: ReadonlySet<string> = new Set([
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
]);

/**
 * #3198 W01 ownership axis (mirrors routes/security/schemas.ts). 'organization'
 * (default) = classic org report. 'partner' = partner-owned cross-org
 * aggregate; the server derives partner_id from the caller's own token — a
 * client-supplied partner id is NEVER read. Create-only.
 */
const ownerScopeSchema = z.enum(['organization', 'partner']).default('organization');

/** Report types a human may never create or generate on demand. */
export const INTERNAL_REPORT_TYPES = new Set(['ai_org_narrative', 'ai_fleet_design']);
const INTERNAL_REPORT_TYPE_MESSAGE = 'internal report type';

/** Applied to the CREATE and AD-HOC GENERATE schemas only — never to the read
 *  filter above. A 400 here is what keeps a technician from minting a second,
 *  human-owned "narrative" definition the agent scheduler would then ignore. */
const notInternalReportType = (type: string) => !INTERNAL_REPORT_TYPES.has(type);

/** Config for the Security & Compliance Posture report. Thresholds drive the
 * pass/fail percentages; all optional with insurance-sensible defaults. */
export const securityCompliancePostureConfigSchema = z.object({
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
 * The same posture keys as `securityCompliancePostureConfigSchema` but without
 * its `.default()`s — persistence stores only what the user actually set, and
 * generation applies defaults at read time. The two lists are hand-parallel;
 * `schemas.config.test.ts` holds them in sync, because a key missing here is
 * silently stripped on save and then reappears at generation as its default.
 */
export const securityCompliancePostureConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  windowDays: z.number().int().min(1).max(365).optional(),
  minPasswordLength: z.number().int().min(1).max(64).optional(),
  maxLocalAdmins: z.number().int().min(0).max(50).optional(),
  maxAvDefinitionsAgeDays: z.number().int().min(1).max(365).optional(),
  maxSecurityStatusAgeDays: z.number().int().min(1).max(365).optional(),
  includeCis: z.boolean().optional(),
  backupRequired: z.boolean().optional()
};

/**
 * Config for the Hardware Lifecycle report. `replaceAgeYears` is the planning
 * horizon after purchase (the warranty end wins when active coverage runs
 * longer); the two include flags decide whether hand-entered assets and
 * non-computer hardware appear at all.
 */
export const hardwareLifecycleConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  replaceAgeYears: z.number().int().min(1).max(15).optional().default(4),
  serverReplaceAgeYears: z.number().int().min(1).max(15).optional().default(5),
  includeManualAssets: z.boolean().optional().default(true),
  includeOtherEquipment: z.boolean().optional().default(true),
});

/** Same keys as `hardwareLifecycleConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two lists are
 *  hand-parallel and test-pinned. */
export const hardwareLifecycleConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  replaceAgeYears: z.number().int().min(1).max(15).optional(),
  serverReplaceAgeYears: z.number().int().min(1).max(15).optional(),
  includeManualAssets: z.boolean().optional(),
  includeOtherEquipment: z.boolean().optional(),
};

/**
 * Config for the Threat Detection Review report (#5784 W02). `topIncidents`
 * caps the incident table so one noisy month cannot produce a 400-page PDF; the
 * artifact states the cap and the number withheld rather than truncating
 * silently. `includeCarriedIn` controls the "opened before the period and still
 * unresolved" section.
 */
export const threatDetectionConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  includeCarriedIn: z.boolean().optional().default(true),
  topIncidents: z.number().int().min(1).max(1000).optional().default(100),
});

/** Same keys as `threatDetectionConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two are hand-parallel
 *  and test-pinned (schemas.config.test.ts). */
export const threatDetectionConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  includeCarriedIn: z.boolean().optional(),
  topIncidents: z.number().int().min(1).max(1000).optional(),
};

/**
 * Config for the Endpoint Management Review report (#5784 W03).
 * `staleEnrolmentDays` is judged against the 6 h Intune sync cadence, NOT
 * against the reporting period: a 29-day-old enrolment inside a monthly period
 * is stale. `trendDays` reads m365_posture_rollups, the only genuine time series
 * available — entity rows cannot supply history (see endpointManagementReport.ts).
 */
export const endpointManagementConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  staleEnrolmentDays: z.number().int().min(1).max(180).optional().default(14),
  trendDays: z.number().int().min(1).max(365).optional().default(30),
  includeLicences: z.boolean().optional().default(true),
});

/** Same keys as `endpointManagementConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two are hand-parallel and
 *  test-pinned (schemas.config.test.ts). */
export const endpointManagementConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  staleEnrolmentDays: z.number().int().min(1).max(180).optional(),
  trendDays: z.number().int().min(1).max(365).optional(),
  includeLicences: z.boolean().optional(),
};

/**
 * Config for the Vulnerability Management report (#5784 W04, spec §3.4).
 * `severityFloor` filters the findings sections but NEVER the KEV / high-EPSS
 * callouts: an actively exploited medium is a different argument from a
 * theoretical critical, and hiding it behind a severity floor is how it gets
 * missed. `topN` caps the remediable table; the artifact discloses the number
 * withheld rather than truncating silently.
 */
export const vulnerabilityManagementConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  severityFloor: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
  topN: z.number().int().min(1).max(500).optional().default(25),
  includeAccepted: z.boolean().optional().default(true),
});

/** Same keys as `vulnerabilityManagementConfigSchema` without `.default()`s —
 *  see `securityCompliancePostureConfigFields` for why the two are hand-parallel
 *  and test-pinned (schemas.config.test.ts). */
export const vulnerabilityManagementConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  severityFloor: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  topN: z.number().int().min(1).max(500).optional(),
  includeAccepted: z.boolean().optional(),
};

/**
 * Config for the Identity & Access Review report (#5784 W06, spec §3.5.3).
 * NO `sites` key on purpose: M365 identity data has no site dimension, and a
 * site selector would promise a filter the data cannot deliver. A restricted
 * authority gets the zero-safe shape instead (OD-8 = A).
 * `homeCountries` are ISO-3166 alpha-2 codes; sign-ins from outside the set are
 * called out. An empty set means the section renders as "not configured", NOT as
 * "no foreign sign-ins".
 */
export const identityAccessConfigSchema = z.object({
  dormantDays: z.number().int().min(1).max(365).optional().default(45),
  homeCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).optional().default([]),
  adminDetail: z.boolean().optional().default(true),
});

/** Same keys as `identityAccessConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two are hand-parallel and
 *  test-pinned (schemas.config.test.ts). */
export const identityAccessConfigFields = {
  dormantDays: z.number().int().min(1).max(365).optional(),
  homeCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(50).optional(),
  adminDetail: z.boolean().optional(),
};

/**
 * Cadence detail + delivery config persisted inside `config`. The builder
 * writes these and reportScheduleWorker reads them; they must be declared here
 * because zod strips unknown object keys — before this schema existed, creates
 * silently dropped schedule times and email recipients (edits survived only
 * because update used z.any()).
 */
const reportScheduleDetailSchema = z.object({
  // 24h "HH:MM"
  time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
  // weekday name; the worker lowercases, so accept any case
  day: z.string().max(16).optional(),
  // day-of-month "1".."31" as string (builder sends strings). z.coerce
  // tolerates legacy rows written while update used z.any() — some were
  // persisted with a numeric `date` — so editing them doesn't 400.
  date: z.coerce.string().regex(/^([1-9]|[12]\d|3[01])$/).optional()
});

const reportConfigFields = {
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
  ...securityCompliancePostureConfigFields,
  ...hardwareLifecycleConfigFields,
  ...threatDetectionConfigFields,
  ...endpointManagementConfigFields,
  ...vulnerabilityManagementConfigFields,
  ...identityAccessConfigFields
};

// Loose: the builder round-trips presentation metadata (builderType, dataSource,
// filterConditions, aggregation, chartType, exportFormats, templateName…)
// through config; declared keys above are validated, unknown keys pass through.
export const reportConfigSchema = z.looseObject(reportConfigFields);

export const listReportsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().guid().optional(),
  type: reportTypeSchema.optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional()
});

export const createReportSchema = z.object({
  ownerScope: ownerScopeSchema,
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(255),
  type: reportTypeSchema.refine(notInternalReportType, INTERNAL_REPORT_TYPE_MESSAGE),
  config: reportConfigSchema.optional().default({}),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).default('one_time'),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv')
});

/**
 * Not derived from `createReportSchema` (it never carried `type`), so the
 * create-only ownership fields are refused explicitly rather than stripped:
 *  - `ownerScope` is create-only — any value is a 400 (#3198 W01). Silently
 *    stripping it would answer 200 to a caller who believes they re-homed the
 *    report.
 *  - `orgId` has always been accepted and ignored (the web builder sends it on
 *    every save); it stays accepted for an org-owned row and the handler
 *    refuses it on a partner-owned one (`report_ownership_immutable`).
 */
export const updateReportSchema = z.object({
  ownerScope: z.never().optional(),
  orgId: z.unknown().optional(),
  name: z.string().min(1).max(255).optional(),
  config: reportConfigSchema.optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional(),
  format: z.enum(['csv', 'pdf', 'excel']).optional()
});

export const generateReportSchema = z.object({
  type: reportTypeSchema.refine(notInternalReportType, INTERNAL_REPORT_TYPE_MESSAGE),
  config: z.object({
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
    ...securityCompliancePostureConfigFields,
    ...hardwareLifecycleConfigFields,
    ...threatDetectionConfigFields,
    ...endpointManagementConfigFields,
    ...vulnerabilityManagementConfigFields,
    ...identityAccessConfigFields
  }).optional().default({}),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv'),
  ownerScope: ownerScopeSchema,
  orgId: z.string().guid().optional()
});

export const listRunsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  reportId: z.string().guid().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional()
});

export const downloadQuerySchema = z.object({
  format: z.enum(['csv', 'pdf', 'excel', 'json']).optional()
});

export const dataQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

export const reportRecipientParamSchema = z.object({
  id: z.string().guid(),
  contactId: z.string().guid().optional(),
});

export const addReportRecipientSchema = z.object({
  contactId: z.string().guid(),
});

export const convertReportRecipientSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(255).optional(),
});
