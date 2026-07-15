import { z } from 'zod';

export const reportTypeSchema = z.enum([
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture'
]);

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
  includeCis: z.boolean().optional(),
  backupRequired: z.boolean().optional()
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
  ...securityCompliancePostureConfigFields
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
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(255),
  type: reportTypeSchema,
  config: reportConfigSchema.optional().default({}),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).default('one_time'),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv')
});

export const updateReportSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: reportConfigSchema.optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional(),
  format: z.enum(['csv', 'pdf', 'excel']).optional()
});

export const generateReportSchema = z.object({
  type: reportTypeSchema,
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
    ...securityCompliancePostureConfigFields
  }).optional().default({}),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv'),
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
