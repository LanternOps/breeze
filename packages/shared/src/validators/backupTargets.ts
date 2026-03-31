import { z } from 'zod';

export const fileTargetsSchema = z.object({
  paths: z.array(z.string()).min(1),
  excludes: z.array(z.string()).optional(),
});

export const hypervTargetsSchema = z.object({
  consistencyType: z.enum(['application', 'crash']).default('application'),
  excludeVms: z.array(z.string()).default([]),
});

export const mssqlTargetsSchema = z.object({
  backupType: z.enum(['full', 'differential', 'log']).default('full'),
  excludeDatabases: z.array(z.string()).default([]),
});

export const systemImageTargetsSchema = z.object({
  includeSystemState: z.boolean().default(true),
});

export const backupModeSchema = z.enum([
  'file',
  'hyperv',
  'mssql',
  'system_image',
]);

export type BackupMode = z.infer<typeof backupModeSchema>;

export const backupScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

export const backupRetentionSchema = z.object({
  preset: z.enum(['standard', 'extended', 'compliance', 'custom']).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  maxVersions: z.number().int().min(1).max(100).optional(),
  keepDaily: z.number().int().min(1).max(365).optional(),
  keepWeekly: z.number().int().min(1).max(260).optional(),
  keepMonthly: z.number().int().min(1).max(120).optional(),
  keepYearly: z.number().int().min(1).max(25).optional(),
  weeklyDay: z.number().int().min(0).max(6).optional(),
});

const targetsMap = {
  file: fileTargetsSchema,
  hyperv: hypervTargetsSchema,
  mssql: mssqlTargetsSchema,
  system_image: systemImageTargetsSchema,
} as const;

export const backupInlineSettingsSchema = z
  .object({
    backupMode: backupModeSchema.default('file'),
    targets: z.record(z.unknown()).default({}),
    schedule: backupScheduleSchema.optional(),
    retention: backupRetentionSchema.optional(),
    paths: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    const schema = targetsMap[data.backupMode];
    const result = schema.safeParse(data.targets);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['targets', ...issue.path],
        });
      }
    }
  });

export type BackupInlineSettings = z.infer<typeof backupInlineSettingsSchema>;
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;
export type BackupRetention = z.infer<typeof backupRetentionSchema>;
