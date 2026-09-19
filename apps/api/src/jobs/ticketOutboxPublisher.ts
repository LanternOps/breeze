import { Job, Queue, Worker } from 'bullmq';
import { inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { ticketOutbox, type TicketOutboxEvent } from '../db/schema/ticketOutbox';
import { getBullMQConnection } from '../services/redis';
import { publishEvent, type EventType } from '../services/eventBus';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

/**
 * Drains the `ticket_outbox` transactional outbox (#3828 wave-6-3 task 2 —
 * docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md)
 * onto the generic eventBus (`publishEvent`), with id-only payloads. This is a
 * direct clone of `intentOutboxPublisher.ts`'s claim → enqueue → mark-published
 * shape (same #1105 DB-context discipline — see that file's doc comment for
 * the full rationale) with two differences:
 *
 *  1. The target is `publishEvent` (Redis Streams + local handler dispatch),
 *     not a dedicated BullMQ queue — `ticket_outbox` rows fan out to whichever
 *     eventBus subscribers exist (Task 3's durable ticket-helpdesk subscriber,
 *     webhookDelivery, automationWorker's wildcard handler, etc.), unlike
 *     intent_outbox's single named consumer.
 *  2. Only THREE of the six `ticket_outbox` event types are bridged onto the
 *     bus in this PR — `ticket.created`, `ticket.commented`,
 *     `ticket.status_changed` (the only three with `EventType` literals so
 *     far — see eventBus.ts). `ticket.updated` / `ticket.assigned` /
 *     `ticket.restored` rows are claimed and marked published exactly the
 *     same as the other three (the outbox always drains — a type with no
 *     bus mapping is not an error condition), but no `publishEvent` call is
 *     made for them: there is no subscriber need yet, and every additional
 *     type published widens what every wildcard eventBus subscriber
 *     (automationWorker, webhookDelivery) sees for free. Extending the
 *     mapping later is additive — a new EventType literal + an entry in
 *     TICKET_OUTBOX_EVENT_BUS_TYPES, no outbox/schema change.
 *
 * Payload shape: `{ ticketId, ...row.payload }`. `row.payload` was written
 * id-only by `ticketService.ts`'s `writeTicketOutbox` (structured ids/enum
 * labels only — commentId, assigneeId, from/to status — never
 * subject/description/resolutionNote/comment content), so this publisher
 * never needs to (and must never) fetch or forward ticket free-text itself.
 */

const REAPER_QUEUE_NAME = 'ticket-outbox-publisher';
const PUBLISH_INTERVAL_MS = 5 * 1000; // every 5s
const MAX_PUBLISH_PER_RUN = 200;
// Rows with publish_attempts > this are considered stuck: logged as an alarm
// and left alone rather than retried forever. Exported so
// ticketOutboxRetention.ts's prune cutoff stays in sync with this threshold
// instead of duplicating the magic number (#4210).
export const MAX_PUBLISH_ATTEMPTS = 5;

// The bounded subset of TicketOutboxEvent that currently has a corresponding
// eventBus EventType literal. See the file doc comment above for why the
// other three ticket_outbox event types are intentionally NOT mapped here.
const TICKET_OUTBOX_EVENT_BUS_TYPES: Partial<Record<TicketOutboxEvent, EventType>> = {
  'ticket.created': 'ticket.created',
  'ticket.commented': 'ticket.commented',
  'ticket.status_changed': 'ticket.status_changed',
};

type PublisherJobData = { type: 'publish-ticket-outbox'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[TicketOutboxPublisher] withSystemDbAccessContext not available — publisher cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

// #1105 — explicitly exits any DB access context before running `fn`. Used to
// wrap the enqueue loop so a Redis round-trip per row can never run while a
// pooled connection is pinned idle-in-transaction, even though `publishEvent`
// itself already does this internally (eventBus.ts's `publish()`) — belt and
// suspenders, matching the intentOutboxPublisher precedent exactly.
const runOutsideDbContext = <T>(fn: () => T): T => {
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof runOutside !== 'function') {
    return fn();
  }
  return runOutside(fn);
};

let reaperQueue: Queue<PublisherJobData> | null = null;
let reaperWorker: Worker<PublisherJobData> | null = null;

function getQueue(): Queue<PublisherJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<PublisherJobData>(REAPER_QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return reaperQueue;
}

type StuckOutboxRow = {
  id: number;
  ticket_id: string;
  event_type: string;
  publish_attempts: number;
};

type ClaimedOutboxRow = {
  id: number;
  org_id: string;
  ticket_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  publish_attempts: number;
};

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

export interface PublishOutboxResult {
  published: number;
  skipped: number;
}

interface ClaimResult {
  stuckRows: StuckOutboxRow[];
  claimedRows: ClaimedOutboxRow[];
}

/**
 * Phase 1 (CLAIM) — DB-only work. Runs inside its own short
 * `withSystemDbAccessContext` transaction (opened by the caller) so the held
 * connection covers only these two statements, never the enqueue loop.
 */
async function scanAndClaimOutboxRows(): Promise<ClaimResult> {
  // Read-only alarm scan — never locked, never mutated.
  const stuck = await db.execute<StuckOutboxRow>(sql`
    SELECT id, ticket_id, event_type, publish_attempts
    FROM ${ticketOutbox}
    WHERE ${ticketOutbox.publishedAt} IS NULL
      AND ${ticketOutbox.publishAttempts} > ${MAX_PUBLISH_ATTEMPTS}
    ORDER BY ${ticketOutbox.id} ASC
    LIMIT ${MAX_PUBLISH_PER_RUN}
  `);
  const stuckRows = extractRows<StuckOutboxRow>(stuck);
  for (const row of stuckRows) {
    const message =
      `[TicketOutboxPublisher] ticket_outbox row ${row.id} (ticket ${row.ticket_id}, `
      + `event ${row.event_type}) stuck at ${row.publish_attempts} publish attempts — skipping`;
    console.error(message);
    captureException(new Error(message));
  }

  // Atomically claim live rows and bump publish_attempts.
  const claimed = await db.execute<ClaimedOutboxRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${ticketOutbox}
      WHERE ${ticketOutbox.publishedAt} IS NULL
        AND ${ticketOutbox.publishAttempts} <= ${MAX_PUBLISH_ATTEMPTS}
      ORDER BY ${ticketOutbox.id} ASC
      LIMIT ${MAX_PUBLISH_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${ticketOutbox} AS o
    SET publish_attempts = o.publish_attempts + 1
    FROM due
    WHERE o.id = due.id
    RETURNING o.id, o.org_id, o.ticket_id, o.event_type, o.payload, o.publish_attempts;
  `);
  const claimedRows = extractRows<ClaimedOutboxRow>(claimed);

  return { stuckRows, claimedRows };
}

/**
 * Phase 2 (PUBLISH) — no DB context. Caller must invoke this via
 * `runOutsideDbContext` so the Redis round-trip never runs while a pooled
 * connection is pinned idle-in-transaction (#1105).
 */
async function publishClaimedRows(rows: ClaimedOutboxRow[]): Promise<number[]> {
  const publishedIds: number[] = [];
  for (const row of rows) {
    const busType = TICKET_OUTBOX_EVENT_BUS_TYPES[row.event_type as TicketOutboxEvent];
    if (!busType) {
      // No eventBus mapping for this outbox event type yet (ticket.updated /
      // ticket.assigned / ticket.restored) — the row still drains cleanly;
      // there is simply nothing to publish. See the file doc comment.
      publishedIds.push(row.id);
      continue;
    }
    try {
      // id-only by construction: ticketId + whatever id-only fields
      // ticketService.ts's writeTicketOutbox stored in row.payload (commentId,
      // assigneeId, from/to status labels — never subject/description/content).
      await publishEvent(
        busType,
        row.org_id,
        { ticketId: row.ticket_id, ...(row.payload ?? {}) },
        'ticket-outbox-publisher',
      );
      publishedIds.push(row.id);
    } catch (err) {
      console.error(`[TicketOutboxPublisher] Failed to publish outbox row ${row.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      // Leave published_at NULL — next pass retries; attempt already counted above.
    }
  }
  return publishedIds;
}

/**
 * Phase 3 (MARK PUBLISHED) — DB-only work, its own short
 * `withSystemDbAccessContext` transaction opened by the caller, entirely
 * separate from the claim transaction so it never overlaps the publish loop.
 */
async function markOutboxRowsPublished(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(ticketOutbox)
    .set({ publishedAt: sql`now()` })
    .where(inArray(ticketOutbox.id, ids));
}

/**
 * Single pass over `ticket_outbox`. Returns the number of rows successfully
 * published (including type-unmapped rows that were drained with no bus
 * publish) and the number of rows skipped as permanently stuck.
 *
 * Orchestrates its own DB-context boundaries (claim → publish → mark
 * published) so no caller may accidentally hold a DB transaction open across
 * the publish loop (#1105). Callers must invoke this directly, never wrapped
 * in an outer `withSystemDbAccessContext`.
 */
export async function publishOutboxRows(): Promise<PublishOutboxResult> {
  // Phase 1: claim, inside a short DB context that closes before we return.
  const { stuckRows, claimedRows } = await runWithSystemDbAccess(scanAndClaimOutboxRows);

  if (claimedRows.length === 0) {
    return { published: 0, skipped: stuckRows.length };
  }

  // Phase 2: publish, explicitly outside any DB context — the claiming
  // transaction from phase 1 has already committed, but we exit defensively
  // in case a future caller nests `publishOutboxRows` inside its own context.
  const publishedIds = await runOutsideDbContext(() => publishClaimedRows(claimedRows));

  // Phase 3: mark successfully-published rows published, in a second short
  // DB context that never overlaps the publish loop above.
  if (publishedIds.length > 0) {
    await runWithSystemDbAccess(() => markOutboxRowsPublished(publishedIds));
  }

  if (claimedRows.length === MAX_PUBLISH_PER_RUN) {
    console.warn(
      `[TicketOutboxPublisher] Hit ${MAX_PUBLISH_PER_RUN}-item cap — backlog may be growing`,
    );
  }

  return { published: publishedIds.length, skipped: stuckRows.length };
}

function createWorker(): Worker<PublisherJobData> {
  return new Worker<PublisherJobData>(
    REAPER_QUEUE_NAME,
    async (_job: Job<PublisherJobData>) => {
      try {
        // publishOutboxRows manages its own DB-context boundaries internally
        // (claim → publish → mark-published) — it must NOT be wrapped in an
        // outer withSystemDbAccessContext here, or the publish loop would run
        // inside a held transaction (#1105).
        const { published, skipped } = await publishOutboxRows();
        if (published > 0 || skipped > 0) {
          console.log(
            `[TicketOutboxPublisher] Published ${published} outbox row(s), ${skipped} stuck`,
          );
        }
        return { published, skipped };
      } catch (err) {
        console.error('[TicketOutboxPublisher] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'publish-ticket-outbox') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'publish-ticket-outbox',
    { type: 'publish-ticket-outbox', queuedAt: new Date().toISOString() },
    {
      jobId: 'ticket-outbox-publisher',
      repeat: { every: PUBLISH_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeTicketOutboxPublisher(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  attachWorkerObservability(reaperWorker, 'ticketOutboxPublisher');
  reaperWorker.on('error', (error) => {
    console.error('[TicketOutboxPublisher] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[TicketOutboxPublisher] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[TicketOutboxPublisher] Initialized');
}

export async function shutdownTicketOutboxPublisher(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[TicketOutboxPublisher] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[TicketOutboxPublisher] Error closing queue:', err);
    }
  }
}
