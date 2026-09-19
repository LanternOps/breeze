import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, devices, IN_FLIGHT_BACKUP_JOB_STATUSES } from '../db/schema';
// Imported from the leaf module, not the `../db/schema` barrel: that barrel is
// vi.mock'd with hand-written factories across dozens of suites, so a new named
// export there breaks them all at import time. See backupConstants.ts.
import { BACKUP_SNAPSHOT_ID_MAX_LENGTH } from '../db/schema/backupConstants';
import { UUID_REGEX } from '../utils/uuid';
import { refreshDispatchedExpectation } from './agentWorkExpectation';

/**
 * Payload shape emitted by the agent's `backup_progress` WS message
 * (agent side: websocket.Client.SendBackupProgress in
 * agent/internal/websocket/client.go). `current`/`total` are BYTES;
 * `filesDone`/`filesTotal` are counts. Queue-capable helpers emit `queued`
 * liveness and `starting` on execution admission; other phases carry counters.
 *
 * `snapshotId` (#3006) is the snapshot the agent is currently writing. It is
 * absent on emissions that predate snapshot creation (the pre-scan keepalive
 * and the "scanning done" totals notice) and on restore progress. Bounded to
 * the width of backup_jobs.snapshot_id so an over-long value cannot raise a
 * Postgres 22001 out of a fire-and-forget WS handler.
 */
export const backupProgressPayloadSchema = z.object({
  phase: z.string().optional(),
  current: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  filesDone: z.number().nonnegative().optional(),
  filesTotal: z.number().nonnegative().optional(),
  snapshotId: z.string().min(1).max(BACKUP_SNAPSHOT_ID_MAX_LENGTH).optional(),
});

export type BackupProgressPayload = z.infer<typeof backupProgressPayloadSchema>;

export type ApplyBackupProgressResult =
  | {
      applied: true;
      /**
       * The payload carried a `snapshotId` this server could not store, so the
       * counters were applied without it and the #3006 mid-run registration is
       * inert for this run. Callers should surface this loudly — see
       * `parseBackupProgressPayload`.
       */
      snapshotIdDropped?: true;
    }
  | {
      applied: false;
      reason: 'invalid-command-id' | 'invalid-payload' | 'not-found' | 'agent-mismatch' | 'terminal-status';
    };

/**
 * Parse a progress payload, degrading gracefully when only `snapshotId` is
 * unusable.
 *
 * `snapshotId` is best-effort recovery metadata; `current`/`filesDone` and the
 * `lastProgressAt` bump they carry are load-bearing for job liveness — the
 * stale reaper kills a job whose `last_progress_at` goes cold, and
 * `refreshDispatchedExpectation` keeps the eventual terminal result from being
 * dropped as a replay. Letting the optional field veto the load-bearing ones
 * would invert that priority: a snapshot-id format change that outgrew the
 * column would reap every in-flight backup fleet-wide AND suppress the very
 * registration this field exists to provide — reproducing #3006 at scale.
 *
 * So a bad `snapshotId` is dropped, not the payload. Same rule as
 * `reconcileManifestSchema` and the per-file `modTime` sanitizing in
 * backupSnapshotReconcile.ts: one malformed optional field must never cost the
 * whole record.
 */
function parseBackupProgressPayload(
  progress: unknown
): { ok: true; payload: BackupProgressPayload; snapshotIdDropped: boolean } | { ok: false } {
  const parsed = backupProgressPayloadSchema.safeParse(progress);
  if (parsed.success) {
    return { ok: true, payload: parsed.data, snapshotIdDropped: false };
  }

  if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
    const retry = backupProgressPayloadSchema.safeParse({
      ...(progress as Record<string, unknown>),
      snapshotId: undefined,
    });
    if (retry.success) {
      return { ok: true, payload: retry.data, snapshotIdDropped: true };
    }
  }

  return { ok: false };
}

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

  const parsed = parseBackupProgressPayload(params.progress);
  if (!parsed.ok) {
    return { applied: false, reason: 'invalid-payload' };
  }
  const progress = parsed.payload;

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
  // Queue messages are liveness, not execution. Only the first signal can
  // undo the legacy dispatch-time running marker. A delayed queued ping must
  // never demote a workload that has already emitted its starting signal.
  if (progress.phase === 'queued') {
    updateSet.status = sql`CASE WHEN ${backupJobs.lastProgressAt} IS NULL THEN 'pending'::backup_status ELSE ${backupJobs.status} END`;
    updateSet.startedAt = sql`CASE WHEN ${backupJobs.lastProgressAt} IS NULL THEN NULL ELSE ${backupJobs.startedAt} END`;
  } else {
    // Legacy helpers report uploading/scanning without an explicit starting
    // signal. Their actual execution progress must also win the dispatch race.
    updateSet.status = 'running';
    updateSet.startedAt = sql`CASE WHEN ${backupJobs.status} = 'pending' OR ${backupJobs.lastProgressAt} IS NULL THEN ${now.toISOString()}::timestamptz ELSE ${backupJobs.startedAt} END`;
  }
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
  // #3006: record the snapshot ID the moment the agent reports it, instead of
  // waiting for the terminal result. A result lost in transit (#3001 oversized
  // payload, #2998 helper death) used to leave the job with snapshot_id NULL,
  // so the objects already uploaded to the customer's bucket had nothing
  // linking them to a restore point — neither restorable nor visible to
  // retention. With the ID on the row, the reconcile path can adopt them.
  //
  // The agent is authoritative for the run it is currently executing (its
  // identity was verified above) and a run keeps ONE snapshot ID for its whole
  // life — including across a journal resume — so a later value simply
  // overwrites an earlier one. The UPDATE below is guarded on the job still
  // being in-flight, so this can never clobber an ID written by a terminal
  // result.
  if (progress.snapshotId !== undefined) {
    updateSet.snapshotId = progress.snapshotId;
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

  return parsed.snapshotIdDropped ? { applied: true, snapshotIdDropped: true } : { applied: true };
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

/** Queue admission is non-terminal and must preserve the dispatch expectation. */
export function isBackupQueuedAck(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    && (payload as Record<string, unknown>).queued === true;
}

/** Legacy asynchronous helpers acknowledge execution with {started:true}. */
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
 * Apply admission without consuming the terminal dispatch expectation. Queued
 * admission clears the dispatch-time start marker only before any lifecycle
 * signal. Legacy started acknowledgements promote a pending job to running.
 */
export async function applyBackupStartedAck(params: {
  jobId: string;
  deviceId: string;
  queued?: boolean;
}): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(backupJobs)
    .set({
      lastProgressAt: now,
      updatedAt: now,
      ...(params.queued ? {
        status: sql`CASE WHEN ${backupJobs.lastProgressAt} IS NULL THEN 'pending'::backup_status ELSE ${backupJobs.status} END`,
        startedAt: sql`CASE WHEN ${backupJobs.lastProgressAt} IS NULL THEN NULL ELSE ${backupJobs.startedAt} END`,
      } : {
        status: 'running' as const,
        startedAt: sql`COALESCE(${backupJobs.startedAt}, ${now.toISOString()}::timestamptz)`,
      }),
    })
    .where(and(eq(backupJobs.id, params.jobId), inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES)))
    .returning({ id: backupJobs.id });

  if (updated.length === 0) {
    return false;
  }

  await refreshDispatchedExpectation('backup', params.deviceId, params.jobId);
  return true;
}
