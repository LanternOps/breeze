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
  // `commandLabels` runs parallel to the queued order so a failing tuple can be
  // reported as the command that actually failed rather than a bare index the
  // on-call reader has to map back to this function by hand — the pipeline is 1
  // or 3 commands long depending on sampling, so the index alone is ambiguous.
  // Each push sits next to its queue call to keep the two from drifting apart.
  const commandLabels: string[] = [];
  pipeline.hincrby(`${SHADOW_COUNT_PREFIX}:${subscriberId}`, outcome, 1);
  commandLabels.push('hincrby:count');

  if (isShadowSampledEvent(event)) {
    const key = `${SHADOW_LOCAL_PREFIX}:${event.id}`;
    pipeline.hset(key, subscriberId, outcome);
    commandLabels.push('hset:detail');
    pipeline.expire(key, SHADOW_LOCAL_TTL_SECONDS);
    commandLabels.push('expire:detail');
  }

  // `exec()` REJECTS on a transport failure (connection gone) or an EXECABORT
  // (a command Redis refused at queue time) — the latter can't arise from these
  // three fixed, well-formed calls, and either way the rejection propagates to
  // the caller's `.catch()` in eventBus.ts, which is where it has always been
  // warned. A single command's RUNTIME error (WRONGTYPE, OOM, …) is the case
  // this fix is about: it RESOLVES, as an `[error, result]` tuple, so it
  // disappears entirely unless inspected here (#4125).
  reportShadowPipelineFailures(await pipeline.exec(), commandLabels, event, subscriberId, outcome);
}

/**
 * Surface per-command failures from `recordShadowLocalInvocation`'s coalesced
 * pipeline (#4125). Before the HINCRBY/HSET/EXPIRE were coalesced into one
 * `multi()` (#4085 final-review cost trim) each was awaited discretely, so any
 * failure rejected and the eventBus call site warned; coalescing silently
 * dropped that signal for everything short of a transport failure.
 *
 * Log-only, and never throws: this is shadow-comparison bookkeeping, explicitly
 * best-effort, and must not break the delivery path it is observing. No
 * `captureException` either — this runs once per local SUBSCRIBER invocation at
 * full event volume, so a persistently-broken shadow key (a WRONGTYPE, say)
 * would mean one Sentry event per subscriber invocation: worse than one per
 * published event on any event type with more than one local subscriber. The
 * structured `EVENT_DISPATCH_SHADOW_*` lines are the intended signal; they are
 * greppable and the shadow-comparison job's own mismatch output corroborates
 * them.
 */
function reportShadowPipelineFailures(
  results: [error: Error | null, result: unknown][] | null,
  commandLabels: readonly string[],
  event: BreezeEvent,
  subscriberId: SubscriberId,
  outcome: 'ok' | 'error',
): void {
  const context = {
    eventId: event.id,
    eventType: event.type,
    orgId: event.orgId,
    subscriberId,
    outcome,
  };

  // ioredis resolves `null` only when EXEC itself replies nil — the transaction
  // was discarded and NOTHING ran, strictly worse than one failed command. This
  // pipeline never WATCHes a key, so today that is unreachable; the branch is
  // here so a future WATCH (or a server-side discard) can't quietly reintroduce
  // the very silence this function exists to remove.
  if (results === null) {
    console.warn(
      '[EventDispatchQueue] shadow-record-discarded',
      JSON.stringify({ errorId: 'EVENT_DISPATCH_SHADOW_PIPELINE_DISCARDED', ...context }),
    );
    return;
  }

  // Error shape matches this file's `enqueue-failed` log and eventBus.ts's
  // `local-handler-failed`: keep the stack, it is the only evidence of where a
  // bad key type was introduced.
  const failures = results.flatMap(([error], index) =>
    error
      ? [
          {
            index,
            command: commandLabels[index] ?? 'unknown',
            error:
              error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error),
          },
        ]
      : [],
  );
  if (failures.length === 0) return;

  console.warn(
    '[EventDispatchQueue] shadow-record-command-failed',
    JSON.stringify({ errorId: 'EVENT_DISPATCH_SHADOW_COMMAND_FAILED', ...context, failures }),
  );
}
