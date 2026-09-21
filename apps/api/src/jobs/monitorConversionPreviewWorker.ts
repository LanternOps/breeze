import { Worker, type Queue } from 'bullmq';
import { db, withDbAccessContext } from '../db';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { attachWorkerObservability } from './workerObservability';
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
  const worker = new Worker<ConversionPreviewJobData>(MONITOR_CONVERSION_PREVIEW_QUEUE, async (job) => {
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
      // No withDbAccessContext wrapper here on purpose. buildPolicyConversionPreview
      // opens its OWN repeatable-read transaction (isolation cannot be set on an
      // already-started one) and re-runs authorizePreview inside it. Wrapping it
      // would make that a SECOND pooled connection held behind this one — the
      // #1105 / #2417 double-hold — and withDbAccessContext now refuses it.
      // The freshness check also belongs inside that snapshot: expectedFreshness
      // is re-checked against the same transaction the preview is built from,
      // so a separate pre-read here would only prove a different snapshot.
      const auth = restorePreviewAuth(data.snapshot);
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
    } catch (error) {
      // Carry the attempt count forward: the reader stops re-enqueueing (and
      // starts reporting the failure) once it reaches MAX_PREVIEW_ATTEMPTS.
      // The raw error is deliberately not cached — it reaches Sentry through
      // attachWorkerObservability instead.
      let attempts = 1;
      try {
        const prior = await redis.get(key);
        if (prior) attempts = (JSON.parse(prior).attempts ?? 0) + 1;
      } catch { /* a malformed prior entry just restarts the count */ }
      await writeState({ status: 'failed', error: 'preview_failed', attempts });
      throw error;
    }
  }, { connection: getBullMQConnection(), concurrency: 2, lockDuration: 600_000 });
  attachWorkerObservability(worker, 'monitorConversionPreviewWorker');
  return worker;
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
