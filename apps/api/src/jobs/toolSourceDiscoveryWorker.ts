/**
 * Tool source discovery worker — Tool Catalog W1 (#5215 / #5216), Task A6.
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.3.
 *
 * Thin BullMQ wrapper around `services/toolSources/discovery.ts`'s
 * `discoverSource` — this module owns queueing/dedupe/lifecycle only; all
 * reconciliation logic (tier proposal, revisions, removals) lives there.
 *
 * `discoverSource` itself does the DB-context / external-I/O sequencing
 * (system-scoped DB reads and writes, MCP calls entirely outside any
 * transaction) — this worker does not need to, and must not, wrap the job
 * processor in a DB context of its own.
 */
import { Worker, type Job } from 'bullmq';
import type { Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { toolSourcesEnabled } from '../config/env';
import { discoverSource } from '../services/toolSources/discovery';
import { attachWorkerObservability } from './workerObservability';

export const TOOL_SOURCE_DISCOVERY_QUEUE = 'tool-source-discovery';
export const TOOL_SOURCE_DISCOVERY_JOB_NAME = 'discover';

export interface ToolSourceDiscoveryJobData {
  sourceId: string;
}

/**
 * Stable per-source dedupe key — a source with a job already queued/active is not re-enqueued.
 * Must not contain ':' — BullMQ 5 throws "Custom Id cannot contain :" on Queue.add.
 */
function toolSourceDiscoveryJobId(sourceId: string): string {
  return `discover-${sourceId}`;
}

let discoveryQueue: Queue<ToolSourceDiscoveryJobData> | null = null;

export function getToolSourceDiscoveryQueue(): Queue<ToolSourceDiscoveryJobData> {
  if (!discoveryQueue) {
    discoveryQueue = createInstrumentedQueue<ToolSourceDiscoveryJobData>(TOOL_SOURCE_DISCOVERY_QUEUE);
  }
  return discoveryQueue;
}

export async function enqueueToolSourceDiscovery(sourceId: string): Promise<void> {
  await getToolSourceDiscoveryQueue().add(
    TOOL_SOURCE_DISCOVERY_JOB_NAME,
    { sourceId } satisfies ToolSourceDiscoveryJobData,
    {
      jobId: toolSourceDiscoveryJobId(sourceId),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  );
}

/**
 * The job body, exported for unit tests — the Worker below is a thin wrapper.
 * No-ops when `toolSourcesEnabled()` is false: the platform kill switch stops
 * discovery from running even if a job was queued while the flag was on (or
 * enqueued directly against Redis) — it never reaches the network or the DB.
 */
export async function processToolSourceDiscoveryJob(job: Job<ToolSourceDiscoveryJobData>): Promise<void> {
  if (!toolSourcesEnabled()) return;
  await discoverSource(job.data.sourceId);
}

export function createToolSourceDiscoveryWorker(): Worker<ToolSourceDiscoveryJobData> {
  const worker = new Worker<ToolSourceDiscoveryJobData>(
    TOOL_SOURCE_DISCOVERY_QUEUE,
    processToolSourceDiscoveryJob,
    {
      connection: getBullMQConnection(),
      concurrency: 2,
    },
  );
  attachWorkerObservability(worker, 'toolSourceDiscoveryWorker');

  worker.on('error', (error) => {
    console.error('[ToolSourceDiscoveryWorker] Worker error:', error);
  });
  worker.on('failed', (job, error) => {
    console.error('[ToolSourceDiscoveryWorker] discovery job failed', {
      jobId: job?.id,
      sourceId: (job?.data as ToolSourceDiscoveryJobData | undefined)?.sourceId,
      error,
    });
  });

  return worker;
}

let discoveryWorker: Worker<ToolSourceDiscoveryJobData> | null = null;

export async function initializeToolSourceDiscoveryWorkers(): Promise<void> {
  if (discoveryWorker) return;
  discoveryWorker = createToolSourceDiscoveryWorker();
  console.log('[ToolSourceDiscoveryWorker] initialized');
}

export async function shutdownToolSourceDiscoveryWorkers(): Promise<void> {
  if (discoveryWorker) {
    await discoveryWorker.close();
    discoveryWorker = null;
  }
  if (discoveryQueue) {
    await discoveryQueue.close();
    discoveryQueue = null;
  }
}
