import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { restoreJobs } from '../db/schema';
import { redactSecretsFromOutput } from './secretRedaction';

export type RestoreCommandResultLike = {
  status: 'completed' | 'failed' | 'timeout';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  error?: string;
  result?: unknown;
};

function normalizeTargetConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function deriveRestoreStatus(
  commandStatus: RestoreCommandResultLike['status'],
  payloadStatus?: unknown
): 'completed' | 'failed' | 'partial' {
  if (commandStatus !== 'completed') return 'failed';
  if (payloadStatus === 'failed') return 'failed';
  if (payloadStatus === 'partial' || payloadStatus === 'degraded') return 'partial';
  return 'completed';
}

export function isMutableRestoreStatus(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * #3607 — a restore job that is `failed` ONLY because a server-side sweep gave
 * up on it, not because the device reported a failure.
 *
 * `propagateTimedOutDeviceCommand` (jobs/staleCommandReaper.ts) fails the
 * restore job in lockstep with the `device_commands` timeout and stamps
 * `targetConfig.result.timedOutBy = 'server'`. That stamp is the marker: the
 * agent never said anything, the server guessed.
 *
 * Before #3607 the guess was unfalsifiable — the widened `device_commands`
 * acceptance did not exist, so a late restore result was rejected at ingest and
 * both rows stayed consistently "timed out". Now the command row DOES accept
 * the real result, so without this the two rows disagree: `device_commands`
 * would read `completed` while `restore_jobs` still read `failed`, and the UI
 * reads the latter. Let the device's actual outcome supersede the guess, on the
 * same terms as the script path.
 *
 * Deliberately narrow: only the server's own timeout stamp qualifies. A restore
 * the AGENT reported as failed carries no `timedOutBy`, and stays final.
 */
export function isServerTimedOutRestoreJob(job: {
  status?: string | null;
  targetConfig?: unknown;
}): boolean {
  if (job.status !== 'failed') return false;
  const targetConfig = job.targetConfig as Record<string, unknown> | null | undefined;
  const result = targetConfig?.result as Record<string, unknown> | null | undefined;
  return result?.timedOutBy === 'server';
}

export function buildRestoreResultMetadata(
  commandType: string,
  result: RestoreCommandResultLike,
  restoreData: Record<string, unknown>
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    commandType,
    status: restoreData.status ?? result.status,
  };

  for (const key of [
    'snapshotId',
    'filesRestored',
    'bytesRestored',
    'filesFailed',
    'failedFiles',
    'stagingDir',
    'stateApplied',
    'driversInjected',
    'validated',
    'vmName',
    'newVmId',
    'vhdxPath',
    'durationMs',
    'bootTimeMs',
    'warnings',
    'error',
    'backgroundSyncActive',
    'syncProgress',
    'databaseName',
    'restoredAs',
  ]) {
    if (restoreData[key] !== undefined) {
      metadata[key] = restoreData[key];
    }
  }

  if (result.error && metadata.error === undefined) {
    metadata.error = result.error;
  }
  if (result.stderr && metadata.stderr === undefined) {
    metadata.stderr = result.stderr;
  }
  if (result.durationMs !== undefined && metadata.durationMs === undefined) {
    metadata.durationMs = result.durationMs;
  }

  // #2434: error/stderr/warnings are agent-supplied free text persisted into
  // restore_jobs.targetConfig.result and surfaced in the restore UI — redact
  // secrets before persistence (whichever source populated them above).
  if (typeof metadata.error === 'string') {
    metadata.error = redactSecretsFromOutput(metadata.error);
  }
  if (typeof metadata.stderr === 'string') {
    metadata.stderr = redactSecretsFromOutput(metadata.stderr);
  }
  if (Array.isArray(metadata.warnings)) {
    metadata.warnings = metadata.warnings.map((warning) =>
      typeof warning === 'string' ? redactSecretsFromOutput(warning) : warning
    );
  }

  return metadata;
}

function extractRestoreData(result: RestoreCommandResultLike): Record<string, unknown> {
  return result.result && typeof result.result === 'object' && !Array.isArray(result.result)
    ? result.result as Record<string, unknown>
    : {};
}

export async function updateRestoreJobFromResult(
  restoreJob: {
    id: string;
    status?: string | null;
    targetConfig?: unknown;
  },
  commandType: string,
  result: RestoreCommandResultLike
): Promise<boolean> {
  const recoveringServerTimeout = isServerTimedOutRestoreJob(restoreJob);
  if (!isMutableRestoreStatus(restoreJob.status ?? null) && !recoveringServerTimeout) {
    return false;
  }

  const restoreData = extractRestoreData(result);
  const nextTargetConfig = normalizeTargetConfig(restoreJob.targetConfig);
  nextTargetConfig.result = buildRestoreResultMetadata(commandType, result, restoreData);

  const restoredSize =
    typeof restoreData.bytesRestored === 'number' ? restoreData.bytesRestored : null;
  const restoredFiles =
    typeof restoreData.filesRestored === 'number' ? restoreData.filesRestored : null;

  const updated = await db
    .update(restoreJobs)
    .set({
      status: deriveRestoreStatus(result.status, restoreData.status),
      completedAt: new Date(),
      restoredSize,
      restoredFiles,
      targetConfig: nextTargetConfig,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(restoreJobs.id, restoreJob.id),
        // #3607: the compare-and-set must admit the same set the guard above
        // admitted, or the recovery is a silent 0-row no-op. Still keyed on
        // the server-timeout stamp via the `sql` predicate — re-checked here
        // rather than trusted from the earlier read, so a concurrent genuine
        // result that landed in between still wins.
        recoveringServerTimeout
          ? sql`(${restoreJobs.status} IN ('pending','running') OR (${restoreJobs.status} = 'failed' AND ${restoreJobs.targetConfig}->'result'->>'timedOutBy' = 'server'))`
          : inArray(restoreJobs.status, ['pending', 'running'])
      )
    )
    .returning({ id: restoreJobs.id });

  return updated.length > 0;
}

export async function updateRestoreJobByCommandId(params: {
  commandId: string;
  deviceId: string;
  commandType: string;
  result: RestoreCommandResultLike;
}): Promise<boolean> {
  const [restoreJob] = await db
    .select({
      id: restoreJobs.id,
      status: restoreJobs.status,
      targetConfig: restoreJobs.targetConfig,
    })
    .from(restoreJobs)
    .where(
      and(
        eq(restoreJobs.commandId, params.commandId),
        eq(restoreJobs.deviceId, params.deviceId)
      )
    )
    .limit(1);

  if (!restoreJob) {
    return false;
  }

  return updateRestoreJobFromResult(restoreJob, params.commandType, params.result);
}
