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
  // CAREFUL — this field means two different things depending on what is being
  // parsed, because this schema is dual-use:
  //   * over a RAW AGENT payload (agentWs's provider-backed and orphaned-result
  //     handlers, hyperv.ts, mssql.ts) it is the agent's OWN terminal status
  //     (agent-side BackupJob.Status). That is the sole channel through which a
  //     `partial` run can be distinguished from a clean one (#3000), since the
  //     outer websocket CommandResult.status is only ever completed/failed.
  //   * over the QUEUE payload (backupWorker) it has already been overwritten
  //     with that outer completed/failed value, and the agent's own status
  //     rides the separate `agentStatus` key. See the NB in backupWorker.ts.
  //
  // Deliberately a permissive string rather than an enum: the agent's status
  // vocabulary is wider than the DB enum (it also emits `skipped`/`stopped`),
  // and an enum here would 400 the ENTIRE result — losing the snapshot id and
  // counters — over a status value we do not care about.
  //
  // NOTE: applyBackupCommandResultToJob does NOT read this field. Callers must
  // forward it explicitly as the `agentStatus` argument, which is where the
  // mapping to a DB enum value happens.
  status: z.string().optional(),
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
  // Windows VSS diagnostics (#3027), persisted to backup_jobs.vss_metadata.
  // Absent on non-Windows, on a run with VSS disabled, and on any run whose VSS
  // session failed to start outright — so absence is NOT evidence of a clean
  // snapshot. Shape as the agent emits it (vss.VSSMetadata, agent/internal/
  // backup/vss/types.go):
  //   { shadowCopyId, creationTime, writers: [{name,id,state,lastError}],
  //     exposedPaths: {volume: shadowPath}, unprotectedVolumes: [volume],
  //     warnings: [string], durationMs }
  //
  // DELIBERATELY `z.unknown()` rather than a modeled object. This field is pure
  // diagnostics riding the SAME payload as the snapshot id, and this schema's
  // parse outcome decides whether the whole run is recorded completed or failed
  // (`result.status === 'completed' && parsedBackup.success` in routes/agentWs.ts).
  // A typed schema here would let one malformed diagnostics field fail a backup
  // that actually succeeded — a strictly worse F13 than the one the manifest
  // comment above describes, because it flips the job status rather than merely
  // dropping a column. The shape is therefore validated, bounded and redacted
  // one hop later, field by field, where a bad value can only cost the bad
  // value: sanitizeVssMetadata in services/backupResultPersistence.ts.
  vssMetadata: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  snapshot: backupSnapshotResultSchema.optional(),
});

export type ParsedBackupCommandResult = z.infer<typeof backupCommandResultSchema>;
