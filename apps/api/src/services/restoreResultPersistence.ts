import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { restoreJobs } from '../db/schema';

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
    'vmName',
    'newVmId',
    'vhdxPath',
    'durationMs',
    'bootTimeMs',
    'warnings',
    'error',
    'backgroundSyncActive',
    'syncProgress',
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
  if (!isMutableRestoreStatus(restoreJob.status ?? null)) {
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
        inArray(restoreJobs.status, ['pending', 'running'])
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
