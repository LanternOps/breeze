import { z } from 'zod';

export const listReportsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  type: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']).optional(),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional()
});

export const createReportSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']),
  config: z.object({
    dateRange: z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional()
    }).optional(),
    filters: z.object({
      siteIds: z.array(z.string().uuid()).optional(),
      deviceIds: z.array(z.string().uuid()).optional(),
      osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
      status: z.array(z.string()).optional(),
      severity: z.array(z.string()).optional()
    }).optional(),
    columns: z.array(z.string()).optional(),
    groupBy: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional()
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
  type: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']),
  config: z.object({
    dateRange: z.object({
      start: z.string().optional(),
      end: z.string().optional(),
      preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional()
    }).optional(),
    filters: z.object({
      siteIds: z.array(z.string().uuid()).optional(),
      deviceIds: z.array(z.string().uuid()).optional(),
      osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
      status: z.array(z.string()).optional(),
      severity: z.array(z.string()).optional()
    }).optional()
  }).optional().default({}),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv'),
  orgId: z.string().uuid().optional()
});

export const listRunsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  reportId: z.string().uuid().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional()
});

export const dataQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});
