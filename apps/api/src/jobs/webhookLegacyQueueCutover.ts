/**
 * Resumable cut-over from the retired Redis-list webhook queue (#10530).
 *
 * Before W1-B the delivery worker kept pending retries only in the Redis list
 * `breeze:webhooks:delivery` and moved exhausted jobs to `breeze:webhooks:dlq`.
 * Retry state now lives on the `webhook_deliveries` row, so on the first boot
 * after the upgrade this drains both lists; recovery resumes unfinished entries: queued deliveries are
 * re-driven through the BullMQ wake-up by delivery id, and DLQ entries become
 * `failed` rows (which the manual-retry route can replay) when their webhook
 * still exists. The DLQ held org payloads that org erasure could not reach;
 * after this runs they live only in Postgres, where erasure does reach them.
 * Safe to delete one release after it ships.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withSystemDbAccessContext } from '../db';
import { webhookDeliveries, webhooks } from '../db/schema';
import { getRedisConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { enqueueWebhookAttempt } from './webhookDeliveryQueue';

const LEGACY_DELIVERY_LIST = 'breeze:webhooks:delivery';
const LEGACY_DLQ_LIST = 'breeze:webhooks:dlq';
const DRAIN_LIMIT = 100_000;
const legacyJobSchema = z.object({
  id: z.string().uuid(),
  webhookId: z.string().uuid(),
  generation: z.number().int().min(0).optional(),
  attempts: z.number().int().min(0),
  nextRetryAt: z.string().optional(),
  payloadVersion: z.number().optional(),
  replayOf: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  event: z.object({
    id: z.string(), type: z.string(), payload: z.unknown(),
    metadata: z.object({ timestamp: z.unknown().optional() }).optional(),
  }).optional(),
});
type LegacyJob = z.infer<typeof legacyJobSchema>;
const dlqSchema = z.object({
  job: legacyJobSchema,
  lastResult: z.object({
    attempts: z.number().int().nullable().optional(),
    responseStatus: z.number().int().nullable().optional(),
    errorMessage: z.string().nullable().optional(),
  }).optional(),
  movedAt: z.string().optional(),
});

function parseEntry<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parsedDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

type DrainCause = 'drained' | 'drainRowGone' | 'drainResolved';

async function redriveLegacyJob(job: LegacyJob, now: Date): Promise<DrainCause> {
  const wake = await withSystemDbAccessContext(async () => {
    const [row] = await db.select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      errorMessage: webhookDeliveries.errorMessage,
      nextRetryAt: webhookDeliveries.nextRetryAt,
      webhookGeneration: webhookDeliveries.webhookGeneration,
      approvalGeneration: webhooks.approvalGeneration,
    }).from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(and(eq(webhookDeliveries.id, job.id), eq(webhookDeliveries.webhookId, job.webhookId)))
      .limit(1);
    if (!row) return 'drainRowGone' as const;
    if (row.status !== 'pending' && row.status !== 'scheduled'
      && (row.status !== 'failed' || row.attempts !== job.attempts || job.attempts < 1
        || row.errorMessage?.startsWith('superseded_by_edit:'))) return 'drainResolved' as const;

    const runAt = row.status === 'pending' ? now : new Date(Math.max(
      (row.status === 'scheduled' ? row.nextRetryAt?.getTime() : parsedDate(job.nextRetryAt)?.getTime()) ?? now.getTime(),
      now.getTime()
    ));
    const written = await db.update(webhookDeliveries)
      .set({
        ...(row.status === 'failed' ? { status: 'scheduled' as const, failedAt: null, nextRetryAt: runAt } : {}),
        webhookGeneration: sql`COALESCE(${webhookDeliveries.webhookGeneration}, ${job.generation ?? null})`,
      })
      .where(and(eq(webhookDeliveries.id, job.id), eq(webhookDeliveries.status, row.status), eq(webhookDeliveries.attempts, row.attempts)))
      .returning({ id: webhookDeliveries.id });
    if (!written.length) return 'drainResolved' as const;
    return {
      data: {
        deliveryId: job.id,
        webhookId: job.webhookId,
        // First preserve the row/job generation. Legacy NULL rows fall back to
        // the current webhook generation (the old behaviour).
        generation: row.webhookGeneration ?? job.generation ?? row.approvalGeneration,
        attemptsMade: row.attempts,
      },
      runAt,
    };
  }, 'webhookLegacyQueueCutover.redrive');
  if (typeof wake === 'string') return wake;
  // Commit before enqueuing. A failed enqueue keeps the Redis entry, and a
  // subsequent pass can re-drive the already-converted scheduled row.
  await enqueueWebhookAttempt(wake.data, wake.runAt);
  return 'drained';
}

async function ingestLegacyDlq(entry: z.infer<typeof dlqSchema>, now: Date): Promise<'dlqInserted' | 'dlqAlreadyPresent' | 'dlqWebhookGone' | 'malformed'> {
  const { job, lastResult } = entry;
  return withSystemDbAccessContext(async () => {
    const [webhook] = await db.select({ id: webhooks.id }).from(webhooks)
      .where(eq(webhooks.id, job.webhookId)).limit(1);
    if (!webhook) return 'dlqWebhookGone';
    const [existing] = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, job.id)).limit(1);
    if (existing) return 'dlqAlreadyPresent';
    if (!job.event || job.event.payload === undefined) return 'malformed';
    const inserted = await db.insert(webhookDeliveries).values({
      id: job.id,
      webhookId: job.webhookId,
      eventType: job.event.type,
      eventId: job.event.id,
      payload: job.event.payload ?? {},
      payloadVersion: job.payloadVersion === 2 ? 2 : 1,
      eventTimestamp: parsedDate(job.event.metadata?.timestamp),
      replayRootEventId: job.replayOf ?? null,
      status: 'failed',
      failedAt: parsedDate(entry.movedAt) ?? parsedDate(job.createdAt) ?? now,
      webhookGeneration: job.generation ?? null,
      attempts: Math.max(1, lastResult?.attempts ?? job.attempts + 1),
      responseStatus: lastResult?.responseStatus ?? null,
      errorMessage: lastResult?.errorMessage ?? 'Moved to the retired Redis dead-letter queue',
      createdAt: parsedDate(job.createdAt) ?? parsedDate(entry.movedAt) ?? now,
    }).onConflictDoNothing({ target: [webhookDeliveries.webhookId, webhookDeliveries.eventId] })
      .returning({ id: webhookDeliveries.id });
    return inserted.length ? 'dlqInserted' : 'dlqAlreadyPresent';
  }, 'webhookLegacyQueueCutover.ingestDlq');
}

const LEGACY_LISTS = [LEGACY_DELIVERY_LIST, LEGACY_DLQ_LIST] as const;
const processingKey = (key: string) => `${key}:cutover-processing`;

/** Redis deletes empty lists; include in-flight entries left by an interrupted boot. */
export async function legacyWebhookQueuesPending(): Promise<boolean> {
  return (await getRedisConnection().exists(...LEGACY_LISTS.flatMap(key => [key, processingKey(key)]))) > 0;
}

export interface LegacyWebhookQueueDrainSummary {
  drained: number;
  drainRowGone: number;
  drainResolved: number;
  dlqInserted: number;
  dlqAlreadyPresent: number;
  dlqWebhookGone: number;
  malformed: number;
  failed: number;
  truncated: boolean;
}

/**
 * Keep each entry in a processing list until its DB/enqueue work succeeds.
 * Interrupted entries are restored on the next pass, while failures move to
 * the far end of the source list so the remaining entries can still progress.
 */
export async function drainLegacyWebhookQueues(): Promise<LegacyWebhookQueueDrainSummary> {
  const counts: LegacyWebhookQueueDrainSummary = {
    drained: 0, drainRowGone: 0, drainResolved: 0,
    dlqInserted: 0, dlqAlreadyPresent: 0, dlqWebhookGone: 0,
    malformed: 0, failed: 0, truncated: false,
  };
  const redis = getRedisConnection();
  let consecutiveFailures = 0;
  lists: for (const key of LEGACY_LISTS) {
    const processing = processingKey(key);
    while (await redis.lmove(processing, key, 'RIGHT', 'RIGHT') !== null) { /* restore interrupted entries */ }
    // Bound this pass to the entries present at its start. Requeued failures
    // must remain for a later sweep instead of hot-looping after other successes.
    const length = await redis.llen(key);
    const limit = Math.min(length, DRAIN_LIMIT);
    for (let i = 0; i < limit; i += 1) {
      const raw = await redis.lmove(key, processing, 'RIGHT', 'LEFT');
      if (raw === null) break;
      const job = key === LEGACY_DELIVERY_LIST ? parseEntry(raw, legacyJobSchema) : null;
      const entry = key === LEGACY_DLQ_LIST ? parseEntry(raw, dlqSchema) : null;
      try {
        const cause = job ? await redriveLegacyJob(job, new Date())
          : entry ? await ingestLegacyDlq(entry, new Date()) : 'malformed';
        await redis.lrem(processing, 1, raw);
        counts[cause] += 1;
        consecutiveFailures = 0;
      } catch (error) {
        captureException(error instanceof Error ? error : new Error(String(error)));
        console.error(`[WebhookCutover] entry-failed ${JSON.stringify({
          errorId: 'WEBHOOK_LEGACY_QUEUE_ENTRY_FAILED', key,
          deliveryId: job?.id ?? entry?.job.id,
          error: error instanceof Error ? error.message : String(error),
        })}`);
        await redis.lmove(processing, key, 'LEFT', 'LEFT');
        counts.failed += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          console.error(`[WebhookCutover] aborted ${JSON.stringify({
            errorId: 'WEBHOOK_LEGACY_QUEUE_CUTOVER_ABORTED', key, consecutiveFailures,
          })}`);
          break lists;
        }
      }
      if (i === DRAIN_LIMIT - 1 && length > DRAIN_LIMIT) counts.truncated = true;
    }
  }
  if (Object.values(counts).some(Boolean)) {
    console.warn(`[WebhookCutover] legacy-queues-drained ${JSON.stringify({ errorId: 'WEBHOOK_LEGACY_QUEUE_CUTOVER', ...counts })}`);
  }
  return counts;
}
