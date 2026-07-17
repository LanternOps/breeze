import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, devices } from '../db/schema';
import { refreshDispatchedExpectation } from './agentWorkExpectation';

/**
 * A `running` (or `pending`, for the async started-ack path in Task 7) job is
 * still in-flight and may legitimately accept a progress update.
 */
const IN_FLIGHT_BACKUP_JOB_STATUSES = ['pending', 'running'] as const;

/**
 * Payload shape emitted by the agent's `backup_progress` WS message
 * (agent/internal/websocket/client.go:613-632). `current`/`total` are BYTES;
 * `filesDone`/`filesTotal` are counts. `phase` is always "uploading" today —
 * treat it as an opaque optional string, never branch on it.
 */
export const backupProgressPayloadSchema = z.object({
  phase: z.string().optional(),
  current: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  filesDone: z.number().nonnegative().optional(),
  filesTotal: z.number().nonnegative().optional(),
});

export type BackupProgressPayload = z.infer<typeof backupProgressPayloadSchema>;

export type ApplyBackupProgressResult =
  | { applied: true }
  | { applied: false; reason: 'invalid-payload' | 'not-found' | 'agent-mismatch' | 'terminal-status' };

/**
 * Apply an in-flight `backup_progress` WS message from the agent to the
 * corresponding `backup_jobs` row. Drops (no throw) on validation failure,
 * unknown job, agent mismatch, or terminal status — this is a best-effort
 * live-progress signal, not a source of truth for job completion.
 *
 * Keys only on `backup_jobs` rows: a `commandId` matching no backup job is
 * ignored, so restore progress continues to be handled/dropped exactly as
 * before this change.
 */
export async function applyBackupProgress(params: {
  agentId: string;
  commandId: string;
  progress: unknown;
}): Promise<ApplyBackupProgressResult> {
  const parsed = backupProgressPayloadSchema.safeParse(params.progress);
  if (!parsed.success) {
    return { applied: false, reason: 'invalid-payload' };
  }
  const progress = parsed.data;

  const [job] = await db
    .select({
      id: backupJobs.id,
      deviceId: backupJobs.deviceId,
      agentId: devices.agentId,
      status: backupJobs.status,
    })
    .from(backupJobs)
    .innerJoin(devices, eq(backupJobs.deviceId, devices.id))
    .where(eq(backupJobs.id, params.commandId))
    .limit(1);

  if (!job) {
    return { applied: false, reason: 'not-found' };
  }

  if (!job.agentId || job.agentId !== params.agentId) {
    return { applied: false, reason: 'agent-mismatch' };
  }

  if (!IN_FLIGHT_BACKUP_JOB_STATUSES.includes(job.status as (typeof IN_FLIGHT_BACKUP_JOB_STATUSES)[number])) {
    return { applied: false, reason: 'terminal-status' };
  }

  const now = new Date();
  const updateSet: Record<string, unknown> = {
    lastProgressAt: now,
    updatedAt: now,
  };
  if (progress.current !== undefined) {
    updateSet.transferredSize = progress.current;
  }
  // Only set totalSize when the agent reports a positive value — a 0 (or
  // omitted) total must not clobber a previously-reported total.
  if (progress.total !== undefined && progress.total > 0) {
    updateSet.totalSize = progress.total;
  }
  if (progress.filesDone !== undefined) {
    updateSet.fileCount = progress.filesDone;
  }
  if (progress.filesTotal !== undefined) {
    updateSet.totalFiles = progress.filesTotal;
  }

  const updated = await db
    .update(backupJobs)
    .set(updateSet)
    .where(and(eq(backupJobs.id, job.id), inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES)))
    .returning({ id: backupJobs.id });

  if (updated.length === 0) {
    // Concurrent terminal transition between the select and the update.
    return { applied: false, reason: 'terminal-status' };
  }

  // A multi-hour backup's final result must not be dropped by the dispatch
  // expectation's TTL: refresh it on every progress signal.
  await refreshDispatchedExpectation('backup', job.deviceId, job.id);

  return { applied: true };
}
