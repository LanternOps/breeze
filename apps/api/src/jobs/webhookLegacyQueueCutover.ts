/**
 * One-time cut-over from the retired Redis-list webhook queue (#10530).
 *
 * Before W1-B the delivery worker kept pending retries only in the Redis list
 * `breeze:webhooks:delivery` and moved exhausted jobs to `breeze:webhooks:dlq`.
 * Retry state now lives on the `webhook_deliveries` row, so on the first boot
 * after the upgrade this drains both lists once: queued deliveries are
 * re-driven through the BullMQ wake-up by delivery id, and DLQ entries become
 * `failed` rows (which the manual-retry route can replay) when their webhook
 * still exists. The DLQ held org payloads that org erasure could not reach;
 * after this runs they live only in Postgres, where erasure does reach them.
 * Safe to delete one release after it ships.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, withSystemDbAccessContext } from '../db';
import { webhookDeliveries, webhooks } from '../db/schema';
import { getRedisConnection } from '../services/redis';
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

async function redriveLegacyJob(job: LegacyJob, now: Date): Promise<boolean> {
  const wake = await withSystemDbAccessContext(async () => {
    const [row] = await db.select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      errorMessage: webhookDeliveries.errorMessage,
      approvalGeneration: webhooks.approvalGeneration,
    }).from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(and(eq(webhookDeliveries.id, job.id), eq(webhookDeliveries.webhookId, job.webhookId)))
      .limit(1);
    if (!row) return null;
    const data = {
      deliveryId: job.id,
      webhookId: job.webhookId,
      generation: job.generation ?? row.approvalGeneration,
      attemptsMade: row.attempts,
    };
    if (row.status === 'pending') return { data, runAt: now };
    if (row.status !== 'failed' || row.attempts !== job.attempts || job.attempts < 1
      || row.errorMessage?.startsWith('superseded_by_edit:')) return null;

    const runAt = new Date(Math.max(parsedDate(job.nextRetryAt)?.getTime() ?? now.getTime(), now.getTime()));
    const written = await db.update(webhookDeliveries)
      .set({ status: 'scheduled', nextRetryAt: runAt })
      .where(and(eq(webhookDeliveries.id, job.id), eq(webhookDeliveries.status, 'failed'), eq(webhookDeliveries.attempts, job.attempts)))
      .returning({ id: webhookDeliveries.id });
    return written.length ? { data, runAt } : null;
  }, 'webhookLegacyQueueCutover.redrive');
  if (!wake) return false;
  // Commit the scheduled state before a worker can consume the replacement wake.
  await enqueueWebhookAttempt(wake.data, wake.runAt);
  return true;
}

async function ingestLegacyDlq(entry: z.infer<typeof dlqSchema>, now: Date): Promise<boolean> {
  const { job, lastResult } = entry;
  return withSystemDbAccessContext(async () => {
    const [webhook] = await db.select({ id: webhooks.id }).from(webhooks)
      .where(eq(webhooks.id, job.webhookId)).limit(1);
    if (!webhook) return false;
    const [existing] = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, job.id)).limit(1);
    if (existing) return true;
    if (!job.event || job.event.payload === undefined) return false;
    await db.insert(webhookDeliveries).values({
      id: job.id,
      webhookId: job.webhookId,
      eventType: job.event.type,
      eventId: job.event.id,
      payload: job.event.payload ?? {},
      payloadVersion: job.payloadVersion === 2 ? 2 : 1,
      eventTimestamp: parsedDate(job.event.metadata?.timestamp),
      replayRootEventId: job.replayOf ?? null,
      status: 'failed',
      attempts: Math.max(1, lastResult?.attempts ?? job.attempts + 1),
      responseStatus: lastResult?.responseStatus ?? null,
      errorMessage: lastResult?.errorMessage ?? 'Moved to the retired Redis dead-letter queue',
      createdAt: parsedDate(job.createdAt) ?? parsedDate(entry.movedAt) ?? now,
    }).onConflictDoNothing({ target: [webhookDeliveries.webhookId, webhookDeliveries.eventId] });
    return true;
  }, 'webhookLegacyQueueCutover.ingestDlq');
}

/**
 * RPOP consumes each legacy entry atomically across booting instances. Only
 * row references survive the cut-over; old embedded credentials are discarded.
 * Once emptied, Redis removes the lists and later boots do no work.
 */
export async function drainLegacyWebhookQueues(): Promise<{
  drained: number; drainDropped: number; dlqIngested: number; dlqDropped: number;
}> {
  const counts = { drained: 0, drainDropped: 0, dlqIngested: 0, dlqDropped: 0 };
  const redis = getRedisConnection();
  for (let i = 0; i < DRAIN_LIMIT; i += 1) {
    const raw = await redis.rpop(LEGACY_DELIVERY_LIST);
    if (raw === null) break;
    const job = parseEntry(raw, legacyJobSchema);
    if (job && await redriveLegacyJob(job, new Date())) counts.drained += 1;
    else counts.drainDropped += 1;
  }
  for (let i = 0; i < DRAIN_LIMIT; i += 1) {
    const raw = await redis.rpop(LEGACY_DLQ_LIST);
    if (raw === null) break;
    const entry = parseEntry(raw, dlqSchema);
    if (entry && await ingestLegacyDlq(entry, new Date())) counts.dlqIngested += 1;
    else counts.dlqDropped += 1;
  }
  if (Object.values(counts).some((count) => count > 0)) {
    console.warn(`[WebhookCutover] legacy-queues-drained ${JSON.stringify({ errorId: 'WEBHOOK_LEGACY_QUEUE_CUTOVER', ...counts })}`);
  }
  return counts;
}
