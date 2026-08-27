/**
 * llmEgressRecorder — the audit sink behind both egress paths (#3922 phase 2,
 * Wave 2, Task 2.3).
 *
 * `buildGuardedLlmFetch` (one-shot clients) and `llmEgressProxy` (the Agent SDK
 * subprocess's CONNECT tunnel) both hand their attempts to a *synchronous,
 * fire-and-forget* recorder callback. Neither can await a database write: the
 * proxy is inside a socket event handler and the guarded fetch is on the LLM
 * request's own critical path, so a stalled Postgres must never turn into a
 * stalled — or failed — LLM call.
 *
 * So writes are queued in-process and drained by a single background loop:
 *
 *  - **Bounded, drop-oldest.** Above {@link LLM_EGRESS_QUEUE_LIMIT} pending
 *    events the oldest are shed. Unbounded growth during a DB outage would
 *    trade a lost audit row for an OOM'd API process, which is the worse
 *    failure — and the newest events are the ones describing the outage.
 *  - **Warn once.** A shedding recorder says so a single time per outage
 *    rather than once per dropped row.
 *  - **Never throws.** Insert failures are logged and sent to Sentry; the
 *    drain loop continues with the next event.
 *
 * The insert runs under a SYSTEM db context (`llm_egress_events` is RLS shape
 * 1 and the caller's request context may be long gone by drain time), reached
 * via `runOutsideDbContext` so a caller that is still holding a request
 * context does not nest one inside the other (#1105).
 */
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { llmEgressEvents, type LlmEgressSurface } from '../../db/schema/llmEgressEvents';
import { captureException } from '../sentry';

/** Pending events retained during a DB stall before the oldest are shed. */
export const LLM_EGRESS_QUEUE_LIMIT = 1000;

export interface LlmEgressEventInput {
  orgId: string;
  partnerId: string;
  surface: LlmEgressSurface;
  host: string;
  resolvedIp: string | null;
  blocked: boolean;
  catalogEntryId?: string | null;
  revisionId?: string | null;
  aiSessionId?: string | null;
}

let queue: LlmEgressEventInput[] = [];
let draining: Promise<void> | null = null;
let warnedAboutDrops = false;

async function writeOne(event: LlmEgressEventInput): Promise<void> {
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await db.insert(llmEgressEvents).values({
          orgId: event.orgId,
          partnerId: event.partnerId,
          surface: event.surface,
          host: event.host,
          resolvedIp: event.resolvedIp,
          blocked: event.blocked,
          catalogEntryId: event.catalogEntryId ?? null,
          revisionId: event.revisionId ?? null,
          aiSessionId: event.aiSessionId ?? null,
        });
      }),
    );
  } catch (err) {
    console.error(
      `[llmEgressRecorder] failed to persist an egress event for org ${event.orgId} ` +
        `(${event.surface} → ${event.host}, blocked=${event.blocked})`,
      err,
    );
    captureException(err, undefined, {
      service: 'llmEgressRecorder',
      orgId: event.orgId,
      surface: event.surface,
    });
  }
}

function startDrain(): void {
  if (draining) return;
  draining = (async () => {
    try {
      while (queue.length > 0) {
        const next = queue.shift()!;
        await writeOne(next);
      }
    } finally {
      draining = null;
      // A record() that landed while the `finally` was running would have seen
      // a non-null `draining` and skipped starting a loop — pick it up here.
      if (queue.length > 0) startDrain();
    }
  })();
}

/**
 * Queue one egress attempt. Returns immediately and never throws — the caller
 * is on the LLM request's critical path.
 */
export function recordLlmEgressEvent(event: LlmEgressEventInput): void {
  try {
    queue.push(event);
    if (queue.length > LLM_EGRESS_QUEUE_LIMIT) {
      const dropped = queue.length - LLM_EGRESS_QUEUE_LIMIT;
      queue = queue.slice(dropped);
      if (!warnedAboutDrops) {
        warnedAboutDrops = true;
        console.warn(
          `[llmEgressRecorder] egress audit queue exceeded ${LLM_EGRESS_QUEUE_LIMIT} pending ` +
            `events — shedding the oldest. The LLM egress audit trail has gaps until the ` +
            `database catches up.`,
        );
      }
    }
    startDrain();
  } catch (err) {
    // Belt and braces: a throw here would propagate into a socket handler.
    captureException(err, undefined, { service: 'llmEgressRecorder' });
  }
}

/** Awaits the in-flight drain. Used by tests and by graceful shutdown. */
export async function drainLlmEgressQueue(): Promise<void> {
  while (draining) await draining;
}

export function __resetLlmEgressRecorderForTests(): void {
  queue = [];
  draining = null;
  warnedAboutDrops = false;
}
