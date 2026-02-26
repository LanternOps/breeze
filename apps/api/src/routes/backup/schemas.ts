import { z } from 'zod';

const queryBoolean = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return value;
}, z.boolean());

export const configSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['s3', 'local']),
  enabled: z.boolean().optional(),
  details: z.record(z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional()
});

export const configUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  details: z.record(z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional()
});

export const policyTargetsSchema = z.object({
  deviceIds: z.array(z.string()).optional(),
  siteIds: z.array(z.string()).optional(),
  groupIds: z.array(z.string()).optional()
});

export const policyScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional()
});

export const policyRetentionSchema = z.object({
  keepDaily: z.number().int().min(1).optional(),
  keepWeekly: z.number().int().min(1).optional(),
  keepMonthly: z.number().int().min(1).optional()
});

export const policySchema = z.object({
  name: z.string().min(1),
  configId: z.string().min(1),
  enabled: z.boolean().optional(),
  targets: policyTargetsSchema.optional(),
  schedule: policyScheduleSchema,
  retention: policyRetentionSchema.optional()
});

export const policyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  configId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  targets: policyTargetsSchema.partial().optional(),
  schedule: policyScheduleSchema.partial().optional(),
  retention: policyRetentionSchema.partial().optional()
});

export const jobListSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
  device: z.string().optional(),
  deviceId: z.string().optional(),
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

export const snapshotListSchema = z.object({
  deviceId: z.string().optional(),
  configId: z.string().optional()
});

export const usageHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(3).max(90).optional()
});

export const restoreSchema = z.object({
  snapshotId: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  targetPath: z.string().optional()
});

export const verificationRunSchema = z.object({
  deviceId: z.string().min(1),
  backupJobId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  verificationType: z.enum(['integrity', 'test_restore', 'full_recovery']).optional(),
  highImpactApproved: z.boolean().optional()
});

export const verificationListSchema = z.object({
  deviceId: z.string().optional(),
  backupJobId: z.string().optional(),
  verificationType: z.enum(['integrity', 'test_restore', 'full_recovery']).optional(),
  status: z.enum(['passed', 'failed', 'partial']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

export const backupHealthQuerySchema = z.object({
  refresh: queryBoolean.optional()
});

export const recoveryReadinessQuerySchema = z.object({
  refresh: queryBoolean.optional(),
  deviceId: z.string().optional()
});
