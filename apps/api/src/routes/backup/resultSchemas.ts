import { z } from 'zod';

export const backupSnapshotFileResultSchema = z.object({
  sourcePath: z.string().min(1),
  backupPath: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  modTime: z.string().datetime().optional(),
});

export const backupSnapshotResultSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime().optional(),
  size: z.number().int().nonnegative().optional(),
  files: z.array(backupSnapshotFileResultSchema).optional(),
});

export const backupCommandResultSchema = z.object({
  jobId: z.string().optional(),
  snapshotId: z.string().optional(),
  filesBackedUp: z.number().int().nonnegative().optional(),
  bytesBackedUp: z.number().int().nonnegative().optional(),
  warning: z.string().optional(),
  backupType: z.enum(['file', 'system_image', 'database', 'application']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  snapshot: backupSnapshotResultSchema.optional(),
});

export type ParsedBackupCommandResult = z.infer<typeof backupCommandResultSchema>;
