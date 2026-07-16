import { z } from 'zod';

// File/snapshot timestamps come straight from the agent's OS. File mtimes in
// particular carry a local UTC offset (e.g. Windows: ...-07:00), not a `Z`, so
// `.datetime()` (which requires Z) rejects them — and one bad modTime fails the
// whole result parse, so total_size / snapshot id / file_count silently never
// get recorded (F13). Accept an offset.
export const backupSnapshotFileResultSchema = z.object({
  sourcePath: z.string().min(1),
  backupPath: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
  modTime: z.string().datetime({ offset: true }).optional(),
});

export const backupSnapshotResultSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }).optional(),
  size: z.number().int().nonnegative().optional(),
  files: z.array(backupSnapshotFileResultSchema).optional(),
});

export const backupCommandResultSchema = z.object({
  jobId: z.string().optional(),
  snapshotId: z.string().optional(),
  filesBackedUp: z.number().int().nonnegative().optional(),
  bytesBackedUp: z.number().nonnegative().refine(Number.isInteger, 'expected integer').optional(),
  warning: z.string().optional(),
  backupType: z.enum(['file', 'system_image', 'database', 'application']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  snapshot: backupSnapshotResultSchema.optional(),
});

export type ParsedBackupCommandResult = z.infer<typeof backupCommandResultSchema>;
