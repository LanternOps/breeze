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
  maxAvDefinitionsAgeDays: z.number().int().min(1).max(365).optional().default(7)
});

const securityCompliancePostureConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  windowDays: z.number().int().min(1).max(365).optional(),
  minPasswordLength: z.number().int().min(1).max(64).optional(),
  maxLocalAdmins: z.number().int().min(0).max(50).optional(),
  maxAvDefinitionsAgeDays: z.number().int().min(1).max(365).optional()
};

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
    columns: z.array(z.string()).optional(),
    groupBy: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    ...securityCompliancePostureConfigFields
  }).optional().default({}),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).default('one_time'),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv')
});

export const updateReportSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.any().optional(),
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
