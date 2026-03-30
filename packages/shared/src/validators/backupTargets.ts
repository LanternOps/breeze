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
    schedule: z.record(z.unknown()).optional(),
    retention: z.record(z.unknown()).optional(),
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
