import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, devices, IN_FLIGHT_BACKUP_JOB_STATUSES } from '../db/schema';
import { UUID_REGEX } from '../utils/uuid';
import { refreshDispatchedExpectation } from './agentWorkExpectation';

/**
 * Payload shape emitted by the agent's `backup_progress` WS message
 * (agent side: websocket.Client.SendBackupProgress in
 * agent/internal/websocket/client.go). `current`/`total` are BYTES;
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
  | {
      applied: false;
      reason: 'invalid-command-id' | 'invalid-payload' | 'not-found' | 'agent-mismatch' | 'terminal-status';
    };

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
  // Cheap pre-DB gate: backup_jobs.id is uuid-typed, so a non-UUID commandId
  // would raise Postgres 22P02 through the handler — and restore progress
  // (same WS message type, unthrottled per-file) plus any garbage commandId
  // must be droppable without spending a query.
  if (!UUID_REGEX.test(params.commandId)) {
    return { applied: false, reason: 'invalid-command-id' };
  }

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

// --- non-terminal `command_result` guards ---------------------------------
//
// An async backup_run agent (capability `backup_run_async`) reports two
// non-terminal signals through the normal command_result channel instead of
// (or in addition to) backup_progress: an immediate "started" ack, and — on
// old agents only — a false "timed out" result emitted by
// forwardToBackupHelper at exactly 10 minutes while the helper is still
// uploading. Both MUST be detected and handled BEFORE
// consumeDispatchedExpectation runs, because that consume is one-shot: using
// it up on a non-terminal signal would cause the real terminal result to be
// dropped later as a "replay".

/**
 * Tolerantly parse an agent command_result's structured payload. The agent
 * always sends this as a JSON *string* in `result.result` (or `result.stdout`
 * as a fallback), never a pre-parsed object. Returns `undefined` on missing
 * input or a parse failure rather than throwing.
 */
export function tryParseBackupResultPayload(resultResult: unknown, resultStdout: unknown): unknown {
  const raw = resultResult ?? resultStdout;
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * True when a parsed command_result payload is the async backup_run's
 * immediate "started" acknowledgement (`{"started": true}`), as opposed to a
 * terminal completion/failure payload.
 */
export function isBackupStartedAck(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).started === true
  );
}

/**
 * True when a non-completed command_result is the legacy (pre-async-capable)
 * agent's false "command timed out" result — `forwardToBackupHelper`
 * (agent/internal/heartbeat/backup_forwarder.go, timing out via sessionbroker
 * Session.SendCommand) surfaces this at exactly 10 minutes while the upload
 * helper is still running. Treating this as a real failure falsely fails every
 * backup over 10 minutes; the stale-backup-job reaper now owns deciding when a
 * silent job is actually dead.
 */
export function isLegacyBackupTimeoutResult(params: {
  status: string;
  error?: string | null;
  stderr?: string | null;
}): boolean {
  if (params.status === 'completed') {
    return false;
  }
  const message = params.error ?? params.stderr ?? '';
  return /command timed out/i.test(message);
}

/**
 * Apply the async started-ack as a progress ping: bumps lastProgressAt (and
 * refreshes the dispatch expectation TTL) on the job without touching status
 * or consuming the one-shot dispatch expectation. Mirrors applyBackupProgress
 * but doesn't require a `progress` payload (a plain started-ack carries none).
 */
export async function applyBackupStartedAck(params: {
  jobId: string;
  deviceId: string;
}): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(backupJobs)
    .set({ lastProgressAt: now, updatedAt: now })
    .where(and(eq(backupJobs.id, params.jobId), inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES)))
    .returning({ id: backupJobs.id });

  if (updated.length === 0) {
    return false;
  }

  await refreshDispatchedExpectation('backup', params.deviceId, params.jobId);
  return true;
}
