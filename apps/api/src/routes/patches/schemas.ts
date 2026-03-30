import { z } from 'zod';

export const listPatchesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  ringId: z.string().uuid().optional(),
  source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
  severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional()
});

export const patchIdParamSchema = z.object({
  id: z.string().uuid()
});

export const scanSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1),
  source: z.string().min(1).max(100).optional()
});

export const listSourcesSchema = z.object({
  os: z.enum(['windows', 'macos', 'linux']).optional()
});

export const listApprovalsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  ringId: z.string().uuid().optional(),
  status: z.enum(['approved', 'rejected', 'deferred', 'pending']).optional(),
  patchId: z.string().uuid().optional()
});

export const approvalActionSchema = z.object({
  orgId: z.string().uuid().optional(),
  ringId: z.string().uuid().optional(),
  note: z.string().max(1000).optional()
});

export const deferSchema = z.object({
  orgId: z.string().uuid().optional(),
  ringId: z.string().uuid().optional(),
  deferUntil: z.string().datetime(),
  note: z.string().max(1000).optional()
});

export const rollbackSchema = z.object({
  reason: z.string().max(2000).optional(),
  scheduleType: z.enum(['immediate', 'scheduled']).default('immediate'),
  scheduledTime: z.string().datetime().optional(),
  deviceIds: z.array(z.string().uuid()).optional()
}).superRefine((value, ctx) => {
  if (value.scheduleType === 'scheduled' && !value.scheduledTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduledTime'],
      message: 'scheduledTime is required when scheduleType is scheduled'
    });
  }
});

export const bulkApproveSchema = z.object({
  orgId: z.string().uuid().optional(),
  ringId: z.string().uuid().optional(),
  patchIds: z.array(z.string().uuid()).min(1),
  note: z.string().max(1000).optional()
});

export const complianceSchema = z.object({
  orgId: z.string().uuid().optional(),
  ringId: z.string().uuid().optional(),
  source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
  severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional()
});

export const complianceReportSchema = z.object({
  orgId: z.string().uuid().optional(),
  source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
  severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
  format: z.enum(['csv', 'pdf']).optional()
});

export const listJobsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['scheduled', 'running', 'completed', 'failed', 'cancelled']).optional()
});
