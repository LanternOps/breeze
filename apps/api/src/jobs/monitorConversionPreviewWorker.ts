import { Worker, type Queue } from 'bullmq';
import { db, withDbAccessContext } from '../db';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection, getRedis } from '../services/redis';
import { buildPolicyConversionPreview, ConversionError } from '../services/monitors/conversion/convert';
import {
  authorizePreview, previewFreshness, previewScopeHash, restorePreviewAuth,
  type PreviewAccessSnapshot,
} from '../services/monitors/conversion/previewScope';

export const MONITOR_CONVERSION_PREVIEW_QUEUE = 'monitor-conversion-preview';
export interface ConversionPreviewJobData {
  policyId: string;
  snapshot: PreviewAccessSnapshot;
  sourcesHash: string;
  scopeHash: string;
}
export const previewJobKey = (policyId: string, scopeHash: string, sourcesHash: string) =>
  `monitorconv:preview:${policyId}:${scopeHash}:${sourcesHash}`;

let previewQueue: Queue | null = null;
export function getMonitorConversionPreviewQueue(): Queue {
  if (!previewQueue) previewQueue = createInstrumentedQueue(MONITOR_CONVERSION_PREVIEW_QUEUE);
  return previewQueue;
}

export function createMonitorConversionPreviewWorker(): Worker<ConversionPreviewJobData> {
  return new Worker<ConversionPreviewJobData>(MONITOR_CONVERSION_PREVIEW_QUEUE, async (job) => {
    const data = job.data;
    const { policyId, scopeHash, sourcesHash } = data;
    const key = previewJobKey(policyId, scopeHash, sourcesHash);
    const redis = getRedis();
    if (!redis) throw new Error('Preview requires Redis');
    const startedAt = new Date().toISOString();
    const writeState = async (state: Record<string, unknown>) => {
      await redis.setex(key, 3600, JSON.stringify({ ...state, scopeHash, sourcesHash, startedAt }));
    };
    await writeState({ status: 'running', progress: { checked: 0, total: 0 } });
    try {
      return await withDbAccessContext(data.snapshot.dbContext, async () => {
        const auth = restorePreviewAuth(data.snapshot);
        await authorizePreview(policyId, auth);
        if (previewScopeHash(data.snapshot) !== scopeHash || await previewFreshness(policyId, db) !== sourcesHash) {
          throw new ConversionError('preview_stale', 'Preview inputs changed');
        }
        const result = await buildPolicyConversionPreview(policyId, {
          userId: auth.scope === 'system' ? null : auth.user.id, auth,
        }, {
          expectedFreshness: sourcesHash,
          onProgress: async (checked, total) => {
            await writeState({ status: 'running', progress: { checked, total } });
          },
        });
        await writeState({ status: 'done', result });
        return result;
      });
    } catch (error) {
      await writeState({ status: 'failed', error: 'preview_failed' });
      throw error;
    }
  }, { connection: getBullMQConnection(), concurrency: 2, lockDuration: 600_000 });
}

let activePreviewWorker: Worker<ConversionPreviewJobData> | null = null;
export async function initializeMonitorConversionPreviewWorker(): Promise<void> {
  if (!activePreviewWorker) activePreviewWorker = createMonitorConversionPreviewWorker();
}
export async function shutdownMonitorConversionPreviewWorker(): Promise<void> {
  if (activePreviewWorker) {
    await activePreviewWorker.close();
    activePreviewWorker = null;
  }
  if (previewQueue) {
    await previewQueue.close();
    previewQueue = null;
  }
}
