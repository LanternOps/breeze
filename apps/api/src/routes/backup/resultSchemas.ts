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

// system_image (Windows/macOS/Linux system-state) backups return a manifest
// describing the collected OS artifacts plus an optional hardware profile. It
// is stored verbatim as JSONB and read back by BMR restore, so we keep the
// shape permissive (.passthrough(), every field optional) — a manifest field
// we don't model must never fail the whole result parse and silently drop the
// snapshot id / size (same F13 lesson as the file mtimes above).
export const backupSystemStateManifestResultSchema = z
  .object({
    platform: z.string().optional(),
    osVersion: z.string().optional(),
    hostname: z.string().optional(),
    collectedAt: z.string().optional(),
    artifacts: z.array(z.record(z.string(), z.unknown())).optional(),
    hardwareProfile: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const backupCommandResultSchema = z.object({
  jobId: z.string().optional(),
  snapshotId: z.string().optional(),
  filesBackedUp: z.number().int().nonnegative().optional(),
  bytesBackedUp: z.number().nonnegative().refine(Number.isInteger, 'expected integer').optional(),
  warning: z.string().optional(),
  // Per-file upload failures in a PARTIALLY successful run (agent-side
  // BackupJob.ErrorCount): the job completes, but N files were skipped /
  // stalled / retry-exhausted. Persisted to backup_jobs.error_count so a
  // partial snapshot never shows as a green job with zero errors.
  errorCount: z.number().int().nonnegative().optional(),
  // Incremental-backup dedup stats (agent-side reference decision engine):
  // files/bytes referenced from a prior snapshot instead of re-uploaded this
  // run. Omitted (not zero) by legacy agents and by full backups that
  // referenced nothing — persistence must only write the columns when these
  // are defined (see applyBackupCommandResultToJob).
  referencedBytes: z.number().nonnegative().refine(Number.isInteger, 'expected integer').optional(),
  referencedFiles: z.number().int().nonnegative().optional(),
  backupType: z.enum(['file', 'system_image', 'database', 'application']).optional(),
  systemStateManifest: backupSystemStateManifestResultSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  snapshot: backupSnapshotResultSchema.optional(),
});

export type ParsedBackupCommandResult = z.infer<typeof backupCommandResultSchema>;
