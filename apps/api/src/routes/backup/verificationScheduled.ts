import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withSystemDbAccessContextIsolated } from '../../db';
import { reportBackupDbFallback } from './dbFallbackReport';
import {
  backupJobs as backupJobsTable,
  deviceCommands,
  devices,
  backupVerifications as backupVerificationsTable,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../../db/schema';
import {
  backupJobs,
  backupVerifications,
  jobOrgById,
  verificationOrgById
} from './store';
import type { BackupJob, BackupVerification, BackupVerificationStatus } from './types';
import { recomputeRecoveryReadinessForDevice } from './readinessCalculator';
import {
  BACKUP_MAX_RECENT_VERIFICATIONS,
  BackupVerificationDispatchError,
  listBackupVerifications,
  persistVerificationToDb,
  runScheduledBackupVerification,
  safePublish
} from './verificationService';
import {
  recordBackupCommandTimeout,
  recordBackupVerificationResult,
  recordBackupVerificationSkip,
} from '../../services/backupMetrics';
import { normalizeBackupVerificationType } from './types';
import {
  LEGACY_VERIFICATION_TIMEOUT_REASON,
  VERIFICATION_TIMEOUT_REASON_CODE,
  VERIFICATION_TIMEOUT_GRACE_MS,
  isVerificationTimeoutDetails,
  shortestVerificationTimeoutMs,
  verificationCommandType,
  verificationDeadline,
  verificationTimeoutDetails,
  verificationTimeoutReason,
} from './verificationTimeout';
import { isCriticalBackupDevice } from './criticality';
import { backupVerificationStructuredResultSchema } from '../../services/agentCommandResultValidation';

import { terminalPayloadErasureSet } from '../../services/sensitiveCommandPayload';
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toEpoch(value?: string | Date | null): number {
  if (!value) return 0;
  const asDate = value instanceof Date ? value : new Date(value);
  const epoch = asDate.getTime();
  return Number.isNaN(epoch) ? 0 : epoch;
}

function isUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function pickRotatingWindow<T>(items: T[], windowSize: number, bucket: number): T[] {
  if (items.length <= windowSize) return items;
  const start = (bucket * windowSize) % items.length;
  const rotated = items.slice(start).concat(items.slice(0, start));
  return rotated.slice(0, windowSize);
}

function normalizeDbVerificationRow(row: typeof backupVerificationsTable.$inferSelect): BackupVerification {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    backupJobId: row.backupJobId,
    snapshotId: row.snapshotId,
    verificationType: normalizeBackupVerificationType(row.verificationType),
    status: row.status as BackupVerificationStatus,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    restoreTimeSeconds: row.restoreTimeSeconds,
    filesVerified: row.filesVerified ?? 0,
    filesFailed: row.filesFailed ?? 0,
    sizeBytes: row.sizeBytes as number | null,
    details: (row.details as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

async function listCompletedJobsFromDb(orgId?: string): Promise<Array<BackupJob & { orgId: string }> | null> {
  if (orgId && !isUuid(orgId)) return null;

  try {
    const conditions = [inArray(backupJobsTable.status, RESTORABLE_BACKUP_JOB_STATUSES)];
    if (orgId) conditions.push(eq(backupJobsTable.orgId, orgId));
    const rows = await withSystemDbAccessContextIsolated(() => db
      .select()
      .from(backupJobsTable)
      .where(and(...conditions))
      .orderBy(desc(backupJobsTable.completedAt), desc(backupJobsTable.createdAt)));

    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      type: row.type as BackupJob['type'],
      deviceId: row.deviceId,
      configId: row.configId,
      policyId: row.policyId,
      snapshotId: row.snapshotId,
      status: row.status as BackupJob['status'],
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      totalSize: row.totalSize as number | null,
      fileCount: row.fileCount as number | null,
      errorCount: row.errorCount as number | null,
      errorLog: row.errorLog,
    }));
  } catch (error) {
    reportBackupDbFallback('[backupVerification] DB completed job read failed; falling back to memory', error);
    return null;
  }
}

async function listTimedOutVerificationsFromDb(cutoff: Date): Promise<typeof backupVerifications> {
  try {
    const rows = await withSystemDbAccessContextIsolated(() => db
      .select()
      .from(backupVerificationsTable)
      .where(and(
        or(
          eq(backupVerificationsTable.status, 'pending'),
          eq(backupVerificationsTable.status, 'running'),
        )!,
        lte(backupVerificationsTable.startedAt, cutoff),
      )));

    return rows.map((row) => {
      const normalized = normalizeDbVerificationRow(row);
      verificationOrgById.set(normalized.id, normalized.orgId);
      return normalized;
    });
  } catch (error) {
    reportBackupDbFallback('[backupVerification] DB timeout scan failed; falling back to memory', error);
    return [];
  }
}

async function markVerificationFailedAndRefreshReadiness(params: {
  verification: BackupVerification;
  orgId: string;
  reason: string;
  /** Stable marker for lookups (#11813); omitted for every non-timeout failure. */
  reasonCode?: string;
  source: string;
}): Promise<void> {
  const { verification, orgId, reason, reasonCode, source } = params;
  verification.status = 'failed';
  verification.completedAt = new Date().toISOString();
  const details = (verification.details && typeof verification.details === 'object' && !Array.isArray(verification.details))
    ? verification.details as Record<string, unknown>
    : {};
  details.reason = reason;
  // A code left by an earlier timeout must not outlive the reason it explained.
  if (reasonCode) details.reasonCode = reasonCode;
  else delete details.reasonCode;
  verification.details = details;
  verificationOrgById.set(verification.id, orgId);

  await persistVerificationToDb(verification);
  recordBackupVerificationResult(verification.verificationType, 'failed');
  await safePublish(
    'backup.verification_failed',
    orgId,
    {
      verificationId: verification.id,
      deviceId: verification.deviceId,
      backupJobId: verification.backupJobId,
      verificationType: verification.verificationType,
      status: 'failed',
    },
    source
  );
  await recomputeRecoveryReadinessForDevice(orgId, verification.deviceId);
}

/** A verification's device command as the timeout scan observed it. */
type ObservedVerificationCommand = {
  id: string;
  status: string;
  executedAt: Date | null;
  completedAt: Date | null;
};

/**
 * One query for every candidate's command. `null` means the lookup itself
 * failed: the caller must skip the pass rather than treat every command as
 * missing (which would fail healthy verifications on a DB blip).
 */
async function loadVerificationCommands(
  commandIds: string[],
): Promise<Map<string, ObservedVerificationCommand> | null> {
  const ids = [...new Set(commandIds.filter((id) => isUuid(id)))];
  if (ids.length === 0) return new Map();
  try {
    const rows = await withSystemDbAccessContext(() => db
      .select({
        id: deviceCommands.id,
        status: deviceCommands.status,
        executedAt: deviceCommands.executedAt,
        completedAt: deviceCommands.completedAt,
      })
      .from(deviceCommands)
      .where(inArray(deviceCommands.id, ids)));
    return new Map(rows.map((row) => [row.id, row]));
  } catch (error) {
    console.error('[backupVerification] verification command lookup failed; skipping this timeout pass', error);
    return null;
  }
}

/**
 * Fail a verification's still-live command, as a compare-and-set on the
 * status and `executed_at` the scan OBSERVED (the reaper's #5128 fence). A
 * command claimed or answered between the scan and this write is left alone
 * and the caller must not fail the verification this pass: a result that
 * arrived in between wins.
 */
async function failObservedVerificationCommand(
  command: ObservedVerificationCommand,
  reason: string,
): Promise<boolean> {
  const observedGuard = and(
    eq(deviceCommands.id, command.id),
    eq(deviceCommands.status, command.status),
    command.executedAt
      ? eq(deviceCommands.executedAt, command.executedAt)
      : isNull(deviceCommands.executedAt),
  );
  const updated = await withSystemDbAccessContext(() => db
    .update(deviceCommands)
    .set({
      status: 'failed',
      completedAt: new Date(),
      result: {
        status: 'timeout',
        error: reason,
        timedOutBy: 'verification-timeout-check',
      },
      ...terminalPayloadErasureSet(),
    })
    .where(observedGuard)
    .returning({ id: deviceCommands.id }));

  return updated.length > 0;
}

function verificationCommandIdOf(v: BackupVerification): string | null {
  if (!v.details || typeof v.details !== 'object' || Array.isArray(v.details)) return null;
  const commandId = (v.details as Record<string, unknown>).commandId;
  return typeof commandId === 'string' ? commandId : null;
}

async function findTimedOutVerificationByCommandId(commandId: string): Promise<BackupVerification | null> {
  if (!isUuid(commandId)) return null;

  try {
    const [row] = await withSystemDbAccessContextIsolated(() => db
      .select()
      .from(backupVerificationsTable)
      .where(and(
        sql`${backupVerificationsTable.details}->>'commandId' = ${commandId}`,
        eq(backupVerificationsTable.status, 'failed'),
        // #11813: key on the stable code. Rows failed before it existed carry
        // only the old literal text, so that still matches.
        or(
          sql`${backupVerificationsTable.details}->>'reasonCode' = ${VERIFICATION_TIMEOUT_REASON_CODE}`,
          sql`${backupVerificationsTable.details}->>'reason' = ${LEGACY_VERIFICATION_TIMEOUT_REASON}`,
        )!,
      ))
      .orderBy(desc(backupVerificationsTable.startedAt))
      .limit(1));

    if (!row) return null;

    const normalized = normalizeDbVerificationRow(row);
    verificationOrgById.set(normalized.id, normalized.orgId);
    const existing = backupVerifications.find((item) => item.id === normalized.id);
    if (existing) {
      Object.assign(existing, normalized);
      return existing;
    }
    backupVerifications.push(normalized);
    return normalized;
  } catch (error) {
    reportBackupDbFallback('[backupVerification] DB timed-out command lookup failed; falling back to memory', error);
    return backupVerifications.find((item) => (
      item.details
      && (item.details as Record<string, unknown>).commandId === commandId
      && item.status === 'failed'
      && isVerificationTimeoutDetails(item.details)
    )) ?? null;
  }
}

async function findPendingVerificationByCommandId(commandId: string): Promise<BackupVerification | null> {
  if (!isUuid(commandId)) return null;

  try {
    const [row] = await withSystemDbAccessContextIsolated(() => db
      .select()
      .from(backupVerificationsTable)
      .where(and(
        sql`${backupVerificationsTable.details}->>'commandId' = ${commandId}`,
        or(
          eq(backupVerificationsTable.status, 'pending'),
          eq(backupVerificationsTable.status, 'running'),
        )!,
      ))
      .orderBy(desc(backupVerificationsTable.startedAt))
      .limit(1));

    if (!row) return null;

    const normalized = normalizeDbVerificationRow(row);
    verificationOrgById.set(normalized.id, normalized.orgId);
    const existing = backupVerifications.find((item) => item.id === normalized.id);
    if (existing) {
      Object.assign(existing, normalized);
      return existing;
    }
    backupVerifications.push(normalized);
    return normalized;
  } catch (error) {
    reportBackupDbFallback('[backupVerification] DB command lookup failed; falling back to memory', error);
    return null;
  }
}

async function collectDevicesToRecompute(orgId?: string, allowedSiteIds?: readonly string[]): Promise<Map<string, string> | null> {
  if (orgId && !isUuid(orgId)) return null;
  if (allowedSiteIds?.length === 0) return new Map();
  try {
    // One savepoint with the reads in sequence: one catch covers both, and
    // savepoints beside each other on one connection fail together (#11203).
    const [jobRows, verificationRows] = await withSystemDbAccessContextIsolated(async () => {
      const jobs = await db
        .select({ orgId: backupJobsTable.orgId, deviceId: backupJobsTable.deviceId })
        .from(backupJobsTable)
        .where(and(
          orgId ? eq(backupJobsTable.orgId, orgId) : undefined,
          allowedSiteIds ? sql`exists (select 1 from ${devices} where ${devices.id} = ${backupJobsTable.deviceId} and ${devices.orgId} = ${backupJobsTable.orgId} and ${inArray(devices.siteId, [...allowedSiteIds])})` : undefined,
        ));
      const verifications = await db
        .select({ orgId: backupVerificationsTable.orgId, deviceId: backupVerificationsTable.deviceId })
        .from(backupVerificationsTable)
        .where(and(
          orgId ? eq(backupVerificationsTable.orgId, orgId) : undefined,
          allowedSiteIds ? sql`exists (select 1 from ${devices} where ${devices.id} = ${backupVerificationsTable.deviceId} and ${devices.orgId} = ${backupVerificationsTable.orgId} and ${inArray(devices.siteId, [...allowedSiteIds])})` : undefined,
        ));
      return [jobs, verifications] as const;
    });

    const map = new Map<string, string>();
    for (const row of [...jobRows, ...verificationRows]) {
      if (!map.has(row.deviceId)) map.set(row.deviceId, row.orgId);
    }
    return map;
  } catch (error) {
    reportBackupDbFallback('[backupVerification] DB readiness scan failed; falling back to memory', error);
    if (allowedSiteIds) return new Map();
    return null;
  }
}

// ---- Async result processing ----

/**
 * Process an async backup verification result from the agent.
 * Called from agentWs.ts when a backup_verify or backup_test_restore command completes.
 */
/**
 * Build a human-readable reason for a non-passing verification the agent did
 * not explain itself (#6561). Counts only, never file paths.
 */
function deriveVerificationReason(params: {
  status: BackupVerificationStatus;
  filesFailed: number;
  filesIncomplete: number;
}): string | null {
  const { status, filesFailed, filesIncomplete } = params;
  if (status === 'passed') return null;
  // Both counters can be non-zero at once (some stored objects failed AND the
  // backup run never uploaded others), so report both rather than the first.
  const parts: string[] = [];
  if (filesFailed > 0) {
    parts.push(`${filesFailed} file(s) failed verification`);
  }
  if (filesIncomplete > 0) {
    parts.push(`${filesIncomplete} file(s) never uploaded during the backup run and are absent from this snapshot`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Agent result codes persisted to `details.reasonCode`. Only codes a consumer
 * keys on are kept; any other code the agent reports is dropped, as before.
 * `storage_session_lost`: the run stopped because its brokered storage session
 * ended (revoked or expired); the files it did not reach are counted in
 * `details.filesUnchecked`, not failed — distinct from corruption.
 * `verification_queue_expired` (#11813): the verification waited on the
 * agent's verification lane until too little of its budget was left for a
 * useful run, so the agent failed it without starting it. It arrives as the
 * failed command's `errorCode`, not in a verification body.
 */
const PERSISTED_AGENT_VERIFICATION_CODES = new Set(['storage_session_lost', 'verification_queue_expired']);

function nonNegativeIntOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function processBackupVerificationResult(
  commandId: string,
  commandResult: { status: string; stdout?: string; error?: string; errorCode?: string }
): Promise<void> {
  let pending = await findPendingVerificationByCommandId(commandId);
  if (!pending) {
    pending = backupVerifications.find(
      (v) =>
        v.details &&
        (v.details as Record<string, unknown>).commandId === commandId &&
        (v.status === 'pending' || v.status === 'running')
    ) ?? await findTimedOutVerificationByCommandId(commandId);
  }
  if (!pending) {
    console.warn(`[backupVerification] No pending verification found for command ${commandId}`);
    return;
  }

  const orgId = verificationOrgById.get(pending.id) ?? pending.orgId;
  if (!orgId) return;
  verificationOrgById.set(pending.id, orgId);

  const resultNow = new Date().toISOString();

  if (commandResult.status !== 'completed' || !commandResult.stdout) {
    const errorCode = commandResult.errorCode ?? '';
    await markVerificationFailedAndRefreshReadiness({
      verification: pending,
      orgId,
      reason: commandResult.error || 'Agent command failed',
      reasonCode: PERSISTED_AGENT_VERIFICATION_CODES.has(errorCode) ? errorCode : undefined,
      source: 'agent.result',
    });
    return;
  }

  // Parse the agent result
  let agentResult: Record<string, unknown>;
  try {
    const parsed = JSON.parse(commandResult.stdout) as Record<string, unknown>;
    agentResult = backupVerificationStructuredResultSchema.parse(parsed) as Record<string, unknown>;
  } catch (parseErr) {
    console.error(`[backupVerification] Failed to parse agent result for command ${commandId}:`, parseErr);
    await markVerificationFailedAndRefreshReadiness({
      verification: pending,
      orgId,
      reason: parseErr instanceof Error
        ? `Malformed verification result payload: ${parseErr.message}`
        : 'Failed to parse agent result',
      source: 'agent.result',
    });
    return;
  }

  // Map agent fields to verification record — validate status against allowed values
  const VALID_STATUSES = new Set<BackupVerificationStatus>(['passed', 'failed', 'partial']);
  const agentStatus = typeof agentResult.status === 'string' && VALID_STATUSES.has(agentResult.status as BackupVerificationStatus)
    ? (agentResult.status as BackupVerificationStatus)
    : 'failed';
  pending.status = agentStatus;
  pending.completedAt = resultNow;
  pending.filesVerified = (agentResult.filesVerified as number) ?? 0;
  pending.filesFailed = (agentResult.filesFailed as number) ?? 0;
  pending.sizeBytes = (agentResult.sizeBytes as number) ?? null;
  pending.restoreTimeSeconds = (agentResult.restoreTimeSeconds as number) ?? null;
  const details = pending.details as Record<string, unknown>;
  details.failedFiles = agentResult.failedFiles || [];
  // #6350: `filesIncomplete` counts files the backup run never uploaded. They
  // are missing from the snapshot manifest, so filesFailed (a count of objects
  // that failed verification) is legitimately 0 while the restore point is
  // incomplete — persist the count and the agent's warnings so the reason is
  // visible instead of only the downgraded status.
  const filesIncomplete = (agentResult.filesIncomplete as number) ?? 0;
  details.filesIncomplete = filesIncomplete;
  // Files the run never reached (time budget, or a lost storage session):
  // neither verified nor failed. Always overwritten so an earlier attempt's
  // count cannot outlive this result.
  details.filesUnchecked = (agentResult.filesUnchecked as number) ?? 0;
  details.warnings = agentResult.warnings || [];
  // How many failedFiles / warnings entries the agent or the validator left
  // out to fit the result limits; the only sign of a trimmed list when the
  // warnings arrived as one string. Always overwritten, like filesUnchecked.
  details.failedFilesOmitted = nonNegativeIntOrZero(agentResult.failedFilesOmitted);
  details.warningsOmitted = nonNegativeIntOrZero(agentResult.warningsOmitted);
  details.cleanedUp = agentResult.cleanedUp;
  details.restorePath = agentResult.restorePath;
  // #6561: the agent explains an immediate failure (`no files in snapshot`,
  // `manifest not found: …`) in `error`. Without copying it onto the row, the
  // history shows `failed` with 0/0 counts and no reason at all — only the
  // timeout path used to populate `details.reason`. Mirror the timeout shape
  // so the UI's reason column renders for agent-reported failures too.
  const agentError = typeof agentResult.error === 'string' ? agentResult.error.trim() : '';
  // The agent only fills `error` on the early-return paths (missing manifest,
  // empty snapshot). Its "every file failed" and "some files failed" branches
  // set a non-passing status and nothing else, so derive a count-only reason
  // for those rather than leaving the row unexplained again. Counts only —
  // failed/missing file NAMES are deliberately withheld from list consumers
  // (see toVerificationListItem).
  const reason = agentError || deriveVerificationReason({
    status: agentStatus,
    filesFailed: pending.filesFailed,
    filesIncomplete,
  });
  if (reason) {
    details.reason = reason;
    details.source = 'agent.result';
  } else {
    // This result is authoritative for the row, so a reason carried over from
    // an earlier attempt must not outlive it.
    delete details.reason;
  }
  // Nor may a timeout marker: this row is now answered by the agent (#11813).
  // The agent's own code replaces it only when it is one consumers key on.
  const agentCode = typeof agentResult.code === 'string' ? agentResult.code : '';
  if (PERSISTED_AGENT_VERIFICATION_CODES.has(agentCode)) details.reasonCode = agentCode;
  else delete details.reasonCode;

  await persistVerificationToDb(pending);
  recordBackupVerificationResult(pending.verificationType, pending.status);

  // Publish event
  const eventName =
    pending.status === 'passed' ? 'backup.verification_passed' : 'backup.verification_failed';
  await safePublish(
    eventName,
    orgId,
    {
      verificationId: pending.id,
      deviceId: pending.deviceId,
      backupJobId: pending.backupJobId,
      verificationType: pending.verificationType,
      status: pending.status,
      filesVerified: pending.filesVerified,
      filesFailed: pending.filesFailed,
    },
    'agent.result'
  );

  // Recompute readiness
  await recomputeRecoveryReadinessForDevice(orgId, pending.deviceId);
}


/**
 * Mark stale pending/running verifications as failed.
 * Called by the verification-timeout-check BullMQ job.
 */
export async function timeoutStaleVerifications(): Promise<number> {
  // Each verification's deadline comes from verificationDeadline: its
  // command's claim (executed_at) + its own scaled budget + grace, or, for a
  // command never delivered, started_at + the 2h undelivered limit + grace.
  // The SQL pre-filter on started_at uses the shortest possible deadline, so
  // it is a superset; the per-row check below is exact.
  const now = Date.now();
  const cutoffDate = new Date(now - shortestVerificationTimeoutMs());
  const isCandidate = (v: BackupVerification): boolean =>
    (v.status === 'pending' || v.status === 'running')
    && new Date(v.startedAt).getTime() <= cutoffDate.getTime();
  let timedOut = 0;

  const dbRows = await listTimedOutVerificationsFromDb(cutoffDate);
  const pendingRows = (dbRows.length > 0 ? dbRows : backupVerifications).filter(isCandidate);
  if (pendingRows.length === 0) return 0;

  const commands = await loadVerificationCommands(
    pendingRows.map(verificationCommandIdOf).filter((id): id is string => id !== null),
  );
  if (!commands) return 0;

  for (const v of pendingRows) {
    if (v.status !== 'pending' && v.status !== 'running') continue;
    const commandId = verificationCommandIdOf(v);
    const command = commandId ? commands.get(commandId) ?? null : null;
    const { deadlineMs, budgetMs } = verificationDeadline({
      verificationType: v.verificationType,
      startedAt: v.startedAt,
      details: v.details,
      command,
    });
    if (now < deadlineMs) continue;

    const reason = verificationTimeoutReason(budgetMs);
    if (command && (command.status === 'pending' || command.status === 'sent')) {
      // Lost the CAS: the command was claimed or answered after the scan.
      // Leave the verification for the next pass, which re-reads both.
      if (!(await failObservedVerificationCommand(command, reason))) continue;
      recordBackupCommandTimeout(verificationCommandType(v.verificationType), 'verification_timeout');
    } else if (
      command?.status === 'completed'
      && command.completedAt
      && now - command.completedAt.getTime() < VERIFICATION_TIMEOUT_GRACE_MS
    ) {
      // The agent answered moments ago and its result is still being applied
      // to this verification. Give it the grace; after that the result was
      // lost and the row is settled below so it does not stay pending forever.
      continue;
    }
    // Otherwise the command is terminal (failed by the server reaper or the
    // agent, completed long ago) or missing: settle the verification as before.

    const orgId = verificationOrgById.get(v.id) ?? v.orgId;
    if (orgId) {
      await markVerificationFailedAndRefreshReadiness({
        verification: v,
        orgId,
        reason,
        reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
        source: 'timeout-check',
      });
    } else {
      // No orgId available — still handle command timeout and persist failure.
      console.warn(`[backupVerification] Verification ${v.id} timed out but has no orgId; persisting failure without readiness recompute`);
      v.status = 'failed';
      v.completedAt = new Date().toISOString();
      const details = (v.details && typeof v.details === 'object' && !Array.isArray(v.details))
        ? v.details as Record<string, unknown>
        : {};
      Object.assign(details, verificationTimeoutDetails(budgetMs));
      v.details = details;
      await persistVerificationToDb(v);
      recordBackupVerificationResult(v.verificationType, 'failed');
    }
    timedOut++;
  }
  return timedOut;
}

// ---- Scheduled job entry points ----

export async function ensurePostBackupIntegrityChecks(orgId?: string): Promise<number> {
  const dbCandidates = await listCompletedJobsFromDb(orgId);
  const candidates = dbCandidates ?? backupJobs
    .filter((job) => (!orgId || jobOrgById.get(job.id) === orgId))
    .filter((job) => (RESTORABLE_BACKUP_JOB_STATUSES as readonly string[]).includes(job.status));

  let created = 0;
  for (const job of candidates) {
    const effectiveOrgId = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id) ?? null;
    if (!effectiveOrgId) continue;
    const existing = await listBackupVerifications(effectiveOrgId, { backupJobId: job.id, verificationType: 'integrity', limit: 1 });
    if (existing.length > 0) continue;

    try {
      await runScheduledBackupVerification({
        orgId: effectiveOrgId,
        deviceId: job.deviceId,
        verificationType: 'integrity',
        backupJobId: job.id,
        source: 'post-backup-integrity-check'
      });
      created += 1;
    } catch (error) {
      if (error instanceof BackupVerificationDispatchError) {
        recordBackupVerificationSkip('integrity', error.message.startsWith('Device is ') ? 'device_offline' : 'dispatch_failed');
        console.info('[backupVerification] Skipping post-backup integrity check because dispatch could not start', {
          orgId: effectiveOrgId,
          deviceId: job.deviceId,
          backupJobId: job.id,
          error: error.message,
        });
      } else {
        console.warn('[backupVerification] Integrity check hook failed:', error);
      }
    }
  }

  return created;
}

export async function runWeeklyTestRestore(orgId?: string): Promise<number> {
  const now = Date.now();
  const latestByDevice = new Map<string, BackupJob>();

  const dbCandidates = await listCompletedJobsFromDb(orgId);
  const jobsToScan = dbCandidates ?? backupJobs;

  for (const job of jobsToScan) {
    if (!(RESTORABLE_BACKUP_JOB_STATUSES as readonly string[]).includes(job.status) || !job.snapshotId) continue;
    if (!dbCandidates && orgId && jobOrgById.get(job.id) !== orgId) continue;
    const current = latestByDevice.get(job.deviceId);
    const jobTime = toEpoch(job.completedAt ?? job.startedAt ?? job.updatedAt);
    const currentTime = current ? toEpoch(current.completedAt ?? current.startedAt ?? current.updatedAt) : 0;
    if (!current || jobTime > currentTime) latestByDevice.set(job.deviceId, job);
  }

  const allCandidates = Array.from(latestByDevice.values())
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const criticalCandidates = allCandidates.filter((job) => {
    const targetOrg = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id);
    return !!targetOrg && (!orgId || targetOrg === orgId);
  });
  const criticalFlags = await Promise.all(
    criticalCandidates.map((job) => {
      const targetOrg = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id);
      return targetOrg ? isCriticalBackupDevice(targetOrg, job.deviceId) : Promise.resolve(false);
    })
  );
  const prioritizedCritical = criticalCandidates.filter((_job, index) => criticalFlags[index]);
  const rotationBucket = Math.floor(now / (7 * DAY_MS));
  const candidates = prioritizedCritical.length > 0
    ? prioritizedCritical
    : pickRotatingWindow(allCandidates, 10, rotationBucket);

  let queued = 0;
  for (const job of candidates) {
    const targetOrg = (job as BackupJob & { orgId?: string }).orgId ?? orgId ?? jobOrgById.get(job.id);
    if (!targetOrg) continue;

    const recent = await listBackupVerifications(targetOrg, {
      deviceId: job.deviceId,
      limit: BACKUP_MAX_RECENT_VERIFICATIONS,
      excludeSimulated: true,
    });
    const hasRecentRestoreTest = recent.some((row) => (
      row.verificationType === 'test_restore'
      && (now - toEpoch(row.completedAt ?? row.startedAt)) <= (7 * DAY_MS)
    ));
    if (hasRecentRestoreTest) continue;

    try {
      await runScheduledBackupVerification({
        orgId: targetOrg,
        deviceId: job.deviceId,
        verificationType: 'test_restore',
        backupJobId: job.id,
        source: 'weekly-test-restore'
      });
      queued += 1;
    } catch (error) {
      if (error instanceof BackupVerificationDispatchError) {
        recordBackupVerificationSkip('test_restore', error.message.startsWith('Device is ') ? 'device_offline' : 'dispatch_failed');
        console.info('[backupVerification] Skipping weekly restore test because dispatch could not start', {
          orgId: targetOrg,
          deviceId: job.deviceId,
          backupJobId: job.id,
          error: error.message,
        });
      } else {
        console.warn('[backupVerification] Weekly restore test failed:', error);
      }
    }
  }

  return queued;
}

export async function recalculateReadinessScores(orgId?: string, allowedSiteIds?: readonly string[]): Promise<number> {
  const devicesToOrg = await collectDevicesToRecompute(orgId, allowedSiteIds) ?? new Map<string, string>();

  if (devicesToOrg.size === 0 && allowedSiteIds === undefined) {
    for (const job of backupJobs) {
      const targetOrg = jobOrgById.get(job.id);
      if (!targetOrg || !UUID_RE.test(targetOrg)) {
        if (targetOrg) {
          console.warn('[backupVerification] Skipping job with non-UUID orgId during readiness recompute', {
            jobId: job.id,
            deviceId: job.deviceId,
            targetOrg,
          });
        }
        continue;
      }
      if (orgId && targetOrg !== orgId) continue;
      if (!devicesToOrg.has(job.deviceId)) devicesToOrg.set(job.deviceId, targetOrg);
    }

    for (const verification of backupVerifications) {
      const targetOrg = verificationOrgById.get(verification.id) ?? verification.orgId;
      if (!targetOrg || !UUID_RE.test(targetOrg)) {
        if (targetOrg) {
          console.warn('[backupVerification] Skipping verification with non-UUID orgId during readiness recompute', {
            verificationId: verification.id,
            deviceId: verification.deviceId,
            targetOrg,
          });
        }
        continue;
      }
      if (orgId && targetOrg !== orgId) continue;
      if (!devicesToOrg.has(verification.deviceId)) devicesToOrg.set(verification.deviceId, targetOrg);
    }
  }

  let computed = 0;
  for (const [deviceId, targetOrg] of devicesToOrg.entries()) {
    await recomputeRecoveryReadinessForDevice(targetOrg, deviceId);
    computed += 1;
  }

  return computed;
}
