/**
 * Dispatch-queue ingress (wave 3.5c, #4085).
 *
 * `publish()` (eventBus.ts) snapshots the PUBLISHER's routing plan into a
 * durable BullMQ job at publish time — the router (task 6, eventDispatchWorker)
 * trusts this snapshot verbatim and never recomputes `partitionSubscribersForEvent`
 * itself. That matters because the subscriber cohort (registrations, the
 * EVENT_DISPATCH_QUEUE_SUBSCRIBERS csv) can change between publish and the
 * moment the router job runs; recomputing at dequeue time would let a
 * mid-flight config change silently redirect an already-published event.
 *
 * `enqueueRouteEvent` is intentionally infallible from the caller's point of
 * view: a Redis/BullMQ failure here must never fail `publish()`. The org's
 * Redis Stream XADD (already written before this call, see eventBus.ts) stays
 * the forensic record of the event; a dropped route-event job just means this
 * event is never durably routed/shadow-compared, which is the documented
 * not-an-outbox gap for wave 3.5c.
 */
import type { Queue } from 'bullmq';
import { createInstrumentedQueue } from './bullmqQueue';
import { getRedisConnection } from './redis';
import { captureException } from './sentry';
import { eventDispatchMode, type EventDispatchMode } from '../config/env';
import { partitionSubscribersForEvent } from './eventSubscriberRegistry';
import type { SubscriberId } from './eventSubscriberIds';
import type { BreezeEvent } from './eventBus';

export const EVENT_DISPATCH_QUEUE = 'event-dispatch';

export interface RouteEventJobData {
  v: 1;
  mode: 'shadow' | 'enforce';
  event: BreezeEvent;
  matchedSubscriberIds: SubscriberId[];
  queueSubscriberIds: SubscriberId[];
}

export interface DeliverEventJobData {
  v: 1;
  subscriberId: SubscriberId;
  event: BreezeEvent;
}

// Exported (rather than kept module-private) so the shadow-comparison job
// (Task 7, jobs/eventDispatchWorker.ts) reads the SAME key prefixes this
// module writes under, instead of a second hand-typed copy that could drift —
// the same "never duplicate the rule" concern as `isShadowSampledEvent` below.
export const SHADOW_COUNT_PREFIX = 'breeze:event-shadow:count';
export const SHADOW_LOCAL_PREFIX = 'breeze:event-shadow:local';
// Also exported: the shadow-comparison job clamps its lookback window to this
// TTL (a per-event local hash this old has already expired, so scanning past
// it can only produce spurious "missing locally" mismatches).
export const SHADOW_LOCAL_TTL_SECONDS = 7200;

let queue: Queue<RouteEventJobData | DeliverEventJobData> | null = null;

export function getEventDispatchQueue(): Queue {
  if (!queue) {
    queue = createInstrumentedQueue<RouteEventJobData | DeliverEventJobData>(EVENT_DISPATCH_QUEUE);
  }
  return queue;
}

export async function shutdownEventDispatchQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

/**
 * Snapshot the publisher's routing plan and enqueue a durable `route-event`
 * job. Computes its own `eventDispatchMode()` read (rather than trusting the
 * caller) so a direct call always reflects the current mode, including the
 * `off` no-op — `publish()` already gates the call site on mode !== 'off' as
 * a cheap fast-path, but this function stays correct even when called
 * directly (e.g. from tests, or a future caller that doesn't pre-check).
 *
 * NEVER throws: any failure (BullMQ down, serialization, etc.) is caught,
 * logged as a structured EVENT_DISPATCH_ENQUEUE_FAILED line, and reported to
 * Sentry. The org's Redis Stream XADD already happened before this is called
 * — that stays the forensic record. See the module docstring above.
 */
export async function enqueueRouteEvent(event: BreezeEvent): Promise<void> {
  const mode = eventDispatchMode();
  if (mode === 'off') return;

  try {
    const { matched, queue: queueSubs } = partitionSubscribersForEvent(event.type);
    const matchedSubscriberIds = [...matched].sort();
    const queueSubscriberIds =
      mode === 'shadow' ? matchedSubscriberIds : queueSubs.map((sub) => sub.id).sort();

    const jobData: RouteEventJobData = {
      v: 1,
      mode,
      event,
      matchedSubscriberIds,
      queueSubscriberIds,
    };

    await getEventDispatchQueue().add('route-event', jobData, {
      jobId: `event-route-${event.id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  } catch (error) {
    console.error(
      '[EventDispatchQueue] enqueue-failed',
      JSON.stringify({
        errorId: 'EVENT_DISPATCH_ENQUEUE_FAILED',
        eventId: event.id,
        eventType: event.type,
        orgId: event.orgId,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      }),
    );
    try {
      captureException(error);
    } catch {
      // Sentry must never break publish() — see the carried fix in eventBus.ts.
    }
  }
}

/**
 * Sampling rule (codex Q6): 100% for `alert.*`/`policy.*` event types — those
 * are the highest-stakes deliveries to get right before flipping to enforce —
 * else a deterministic ~10% by id hash (first byte of the UUID < 26/256). Pure
 * and side-effect-free so the shadow-comparison job (task 7) can call it with
 * the exact same rule this module uses to decide what it recorded.
 */
export function isShadowSampledEvent(event: BreezeEvent): boolean {
  if (event.type.startsWith('alert.') || event.type.startsWith('policy.')) return true;
  return parseInt(event.id.slice(0, 2), 16) < 26;
}

/**
 * Shadow-mode bookkeeping for the LOCAL (in-process) delivery path — called
 * from eventBus.ts's registry-aware `invokeLocalHandlers` loop once per local
 * subscriber, fire-and-forget (the caller does not await this before moving
 * to the next subscriber).
 *
 * No-ops entirely outside shadow mode. In shadow mode:
 *  (a) ALWAYS increments the per-subscriber/outcome counter — this is the
 *      aggregate the shadow-comparison job (task 7) diffs against the queue
 *      path's own counters to answer "would enforce mode have changed the
 *      outcome for this subscriber, in aggregate."
 *  (b) ONLY for sampled events (isShadowSampledEvent), also records the
 *      per-event outcome with a 2h TTL — a bounded detail view for spot
 *      comparison against what the queue path would have done for the SAME
 *      event, not just the aggregate.
 */
export async function recordShadowLocalInvocation(
  event: BreezeEvent,
  subscriberId: SubscriberId,
  outcome: 'ok' | 'error',
): Promise<void> {
  const mode: EventDispatchMode = eventDispatchMode();
  if (mode !== 'shadow') return;

  const redis = getRedisConnection();

  // Coalesced into ONE Redis round trip (final-review cost trim, #4085): this
  // runs once per local subscriber invocation, so at production event volume
  // three separate awaited commands means three round trips per invocation
  // instead of one. The counter increment is unconditional; the per-event
  // HSET+EXPIRE only queue when the event is sampled — same shape as before,
  // just pipelined rather than sequentially awaited.
  const pipeline = redis.multi();
  pipeline.hincrby(`${SHADOW_COUNT_PREFIX}:${subscriberId}`, outcome, 1);

  if (isShadowSampledEvent(event)) {
    const key = `${SHADOW_LOCAL_PREFIX}:${event.id}`;
    pipeline.hset(key, subscriberId, outcome);
    pipeline.expire(key, SHADOW_LOCAL_TTL_SECONDS);
  }

  await pipeline.exec();
}
